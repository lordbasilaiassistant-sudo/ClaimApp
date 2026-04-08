// src/services/rpc/log-fetcher.js
// Browser-reliable eth_getLogs fetcher with adaptive chunk sizing.
//
// Strategy:
//   Pass 1 — LARGE chunks (200k blocks) routed to LARGE_RANGE_LOG_PROVIDERS.
//     Currently that's tenderly-public only. Fast path: 65 chunks for a
//     full v4 range, ~500-1000ms each. Total ~3-5 seconds.
//
//   Pass 2 — For any chunks that failed in pass 1, split each into 20 ×
//     10k sub-chunks and route through SMALL_RANGE_LOG_PROVIDERS
//     (base-developer, base-official, sequence, 1rpc). Slower but covers
//     the gaps when tenderly has a hiccup.
//
//   Pass 3 — Any 10k chunks STILL failing after pass 2 get one more retry
//     after a cooldown, just in case of transient 429s.
//
// All browser CORS verified via test/bench-cors.mjs. Providers that work
// in node but fail CORS preflight (like merkle) MUST NOT be included.
//
// Deduplication: results are deduped by (transactionHash, logIndex) so
// overlapping retry responses don't double-count.

import {
  LARGE_RANGE_LOG_PROVIDERS,
  SMALL_RANGE_LOG_PROVIDERS,
} from './providers.js';

// Shorter timeouts = faster recovery from stuck chunks. 10k-block queries
// resolve in <1s when the provider is healthy, so 5s is plenty. Large-range
// queries (200k) resolve in <2s normally.
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_RETRIES_PER_CHUNK = 2;
const SECOND_PASS_DELAY_MS = 800;
const THIRD_PASS_DELAY_MS = 1_500;

// Concurrency scales with provider slot budget.
function totalSlots(providers) {
  return providers.reduce((s, p) => s + (p.maxConcurrent || 1), 0);
}

/**
 * Fetch all logs matching `filter` over a block range, with adaptive
 * chunking and multi-pass recovery.
 *
 * @param {{address: string, topics: any[], fromBlock: number, toBlock: number}} filter
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{logs: any[], failedRanges: Array<{from: number, to: number}>}>}
 */
export async function fetchLogs(filter, onLog) {
  if (LARGE_RANGE_LOG_PROVIDERS.length === 0 && SMALL_RANGE_LOG_PROVIDERS.length === 0) {
    throw new Error('No eth_getLogs providers configured');
  }

  const allLogs = [];
  let failedRanges = [];

  // ===== Pass 1: LARGE chunks through large-range providers =====
  if (LARGE_RANGE_LOG_PROVIDERS.length > 0) {
    const chunkSize = Math.min(...LARGE_RANGE_LOG_PROVIDERS.map((p) => p.maxLogBlockRange));
    const chunks = buildChunks(filter.fromBlock, filter.toBlock, chunkSize);
    onLog?.(`    pass 1: ${chunks.length} chunks × ${chunkSize} blocks (${LARGE_RANGE_LOG_PROVIDERS.length} provider)`);

    const { logs, failed } = await runChunks(
      chunks,
      filter,
      LARGE_RANGE_LOG_PROVIDERS,
      totalSlots(LARGE_RANGE_LOG_PROVIDERS),
      onLog,
      '    pass 1',
    );
    allLogs.push(...logs);
    failedRanges = failed;

    // Pass 1.5: retry failed LARGE chunks via the same provider at lower
    // concurrency. Sub-dividing into 10k pieces is expensive — if tenderly
    // just hit a brief rate limit, a quick retry at low load often recovers
    // the whole 200k chunk in one call.
    if (failedRanges.length > 0 && failedRanges.length <= 10) {
      onLog?.(`    pass 1 failed ${failedRanges.length}, quick-retry at low load…`);
      await sleep(500);
      const retryResult = await runChunks(
        failedRanges,
        filter,
        LARGE_RANGE_LOG_PROVIDERS,
        Math.max(2, Math.floor(totalSlots(LARGE_RANGE_LOG_PROVIDERS) / 2)),
        onLog,
        '    pass 1.5',
      );
      allLogs.push(...retryResult.logs);
      failedRanges = retryResult.failed;
    }
  } else {
    failedRanges = [{ from: filter.fromBlock, to: filter.toBlock }];
  }

  // ===== Pass 2: split failed ranges into 10k chunks and route via small-range providers =====
  if (failedRanges.length > 0 && SMALL_RANGE_LOG_PROVIDERS.length > 0) {
    onLog?.(`    pass 1 failed ${failedRanges.length} ranges, waiting ${SECOND_PASS_DELAY_MS}ms…`);
    await sleep(SECOND_PASS_DELAY_MS);

    const smallChunkSize = Math.min(...SMALL_RANGE_LOG_PROVIDERS.map((p) => p.maxLogBlockRange));
    const subChunks = [];
    for (const range of failedRanges) {
      subChunks.push(...buildChunks(range.from, range.to, smallChunkSize));
    }
    onLog?.(`    pass 2: ${subChunks.length} sub-chunks × ${smallChunkSize} blocks (${SMALL_RANGE_LOG_PROVIDERS.length} providers)`);

    const { logs, failed } = await runChunks(
      subChunks,
      filter,
      SMALL_RANGE_LOG_PROVIDERS,
      totalSlots(SMALL_RANGE_LOG_PROVIDERS),
      onLog,
      '    pass 2',
    );
    allLogs.push(...logs);
    failedRanges = failed;
  }

  // ===== Pass 3: retry any remaining failures one more time =====
  if (failedRanges.length > 0 && SMALL_RANGE_LOG_PROVIDERS.length > 0) {
    onLog?.(`    pass 2 failed ${failedRanges.length} chunks, waiting ${THIRD_PASS_DELAY_MS}ms for pass 3…`);
    await sleep(THIRD_PASS_DELAY_MS);

    const { logs, failed } = await runChunks(
      failedRanges,
      filter,
      SMALL_RANGE_LOG_PROVIDERS,
      Math.min(totalSlots(SMALL_RANGE_LOG_PROVIDERS), 10), // lower concurrency on pass 3
      onLog,
      '    pass 3',
    );
    allLogs.push(...logs);
    failedRanges = failed;

    if (failedRanges.length > 0) {
      onLog?.(`    ⚠ pass 3 still missing ${failedRanges.length} chunks — results incomplete`);
    } else {
      onLog?.(`    ✓ pass 3 recovered all remaining chunks`);
    }
  }

  // ===== Dedupe logs by (txHash, logIndex) =====
  const seen = new Set();
  const deduped = [];
  for (const log of allLogs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(log);
  }
  if (deduped.length !== allLogs.length) {
    onLog?.(`    deduped ${allLogs.length - deduped.length} duplicate log entries`);
  }

  return { logs: deduped, failedRanges };
}

// ===== Helpers =====

function buildChunks(fromBlock, toBlock, chunkSize) {
  const chunks = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    chunks.push({ from: start, to: end });
  }
  return chunks;
}

/**
 * Run an array of chunks against the given provider set with bounded
 * concurrency. Returns collected logs + any still-failed ranges.
 */
async function runChunks(chunks, baseFilter, providers, concurrency, onLog, progressLabel) {
  const logs = [];
  const failed = [];
  let processed = 0;
  const totalChunks = chunks.length;

  // Per-provider in-flight counters
  const slots = new Map();
  for (const p of providers) {
    slots.set(p.name, { max: p.maxConcurrent, inflight: 0 });
  }

  // Round-robin cursor (fresh per runChunks call so consecutive passes
  // don't inherit stale state)
  let rrCursor = 0;

  function pickProvider(excludeNames) {
    for (let i = 0; i < providers.length; i++) {
      rrCursor = (rrCursor + 1) % providers.length;
      const p = providers[rrCursor];
      if (excludeNames.has(p.name)) continue;
      const s = slots.get(p.name);
      if (s.inflight < s.max) {
        s.inflight++;
        return p;
      }
    }
    return null;
  }

  function releaseProvider(name) {
    const s = slots.get(name);
    if (s) s.inflight = Math.max(0, s.inflight - 1);
  }

  async function fetchOnce(chunk, excludeNames) {
    let provider = pickProvider(excludeNames);
    while (!provider) {
      await sleep(20);
      provider = pickProvider(excludeNames);
    }

    const body = {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'eth_getLogs',
      params: [{
        address: baseFilter.address,
        topics: baseFilter.topics,
        fromBlock: '0x' + chunk.from.toString(16),
        toBlock: '0x' + chunk.to.toString(16),
      }],
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        return { ok: false, provider: provider.name, reason: '429' };
      }
      if (!res.ok) {
        return { ok: false, provider: provider.name, reason: `HTTP ${res.status}` };
      }
      const json = await res.json();
      if (json.error) {
        return { ok: false, provider: provider.name, reason: json.error.message || 'rpc error' };
      }
      return { ok: true, logs: json.result || [], provider: provider.name };
    } catch (e) {
      return { ok: false, provider: provider.name, reason: e.message || 'network error' };
    } finally {
      clearTimeout(timer);
      releaseProvider(provider.name);
    }
  }

  async function fetchWithRetry(chunk) {
    const excludeNames = new Set();
    for (let attempt = 0; attempt < MAX_RETRIES_PER_CHUNK; attempt++) {
      const r = await fetchOnce(chunk, excludeNames);
      if (r.ok) return r.logs;
      excludeNames.add(r.provider);
      if (excludeNames.size >= providers.length) {
        excludeNames.clear();
        await sleep(250);
      }
    }
    return null;
  }

  let queueIdx = 0;
  async function worker() {
    while (true) {
      const i = queueIdx++;
      if (i >= chunks.length) return;
      const chunk = chunks[i];
      const result = await fetchWithRetry(chunk);
      if (result === null) {
        failed.push(chunk);
      } else {
        logs.push(...result);
      }
      processed++;
      if (processed % 10 === 0 || processed === totalChunks) {
        onLog?.(`${progressLabel} ${processed}/${totalChunks}`);
      }
    }
  }

  const workerCount = Math.min(concurrency, totalChunks);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { logs, failed };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
