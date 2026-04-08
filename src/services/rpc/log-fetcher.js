// src/services/rpc/log-fetcher.js
// Fast-path eth_getLogs fetcher that uses only large-range providers.
//
// Why this exists:
//   Discovery scans (finding all TokenCreated events for a wallet) need to
//   query multi-million block ranges. Most public RPCs cap eth_getLogs at
//   10k blocks, forcing us to chunk into 1,000+ requests. But TWO providers
//   (merkle, tenderly) handle 200k-500k blocks per call — two orders of
//   magnitude fewer requests.
//
//   This module bypasses the generic multi-RPC router and routes eth_getLogs
//   directly to large-range providers, using their max block windows.
//   Result: scans that took 80+ seconds now complete in 5-10 seconds.
//
// Contract:
//   * `fetchLogs(filter)` returns raw eth_getLogs response objects (not decoded).
//   * Caller is responsible for decoding with ethers.Interface.parseLog().
//   * Concurrency is bounded per provider to avoid overloading them.
//   * Failed chunks retry on a different large-range provider.

import { LARGE_RANGE_LOG_PROVIDERS } from './providers.js';

const REQUEST_TIMEOUT_MS = 20_000; // Large ranges can take longer — give them time
const MAX_RETRIES = 5; // per chunk, within a single pass
const SECOND_PASS_DELAY_MS = 1500; // wait before retrying failed chunks

/**
 * Round-robin counter for provider selection.
 */
let _rrIndex = 0;

/**
 * Fetch all logs for `filter` across a block range, chunking based on each
 * provider's max supported range. Routes through LARGE_RANGE_LOG_PROVIDERS.
 *
 * Correctness contract:
 *   * First pass runs all chunks with per-chunk retry across providers.
 *   * Any failed chunks get a SECOND pass with a fresh retry budget and a
 *     cooldown — this catches transient network blips and 429s that resolve
 *     after the rate-limit window expires.
 *   * If any chunks still fail after the second pass, the return value
 *     includes them in `failedRanges`. Callers MUST treat a non-empty
 *     `failedRanges` as "results are incomplete" and warn the user.
 *   * Deduplication by (txHash, logIndex) — merkle and tenderly can both
 *     serve the same chunks on retries, so we might see duplicate logs.
 *
 * @param {{address: string, topics: (string | null | string[])[], fromBlock: number, toBlock: number}} filter
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{logs: any[], failedRanges: Array<{from: number, to: number}>}>}
 */
export async function fetchLogs(filter, onLog) {
  // Pick the smallest maxLogBlockRange across available providers — that's
  // our chunk size. Using the MINIMUM means all providers can handle every
  // chunk, so we can fail over freely.
  const chunkSize = Math.min(...LARGE_RANGE_LOG_PROVIDERS.map((p) => p.maxLogBlockRange));

  // Build chunks
  const chunks = [];
  for (let start = filter.fromBlock; start <= filter.toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, filter.toBlock);
    chunks.push({ from: start, to: end });
  }
  onLog?.(`  fast-path: ${chunks.length} chunks × ${chunkSize} blocks (${LARGE_RANGE_LOG_PROVIDERS.length} providers)`);

  const allLogs = [];
  const failedRanges = [];
  let processed = 0;

  // Per-provider concurrency slots — each provider gets its own semaphore.
  const slots = new Map();
  for (const p of LARGE_RANGE_LOG_PROVIDERS) {
    slots.set(p.name, { max: p.maxConcurrent, inflight: 0 });
  }

  // Total concurrency = sum of slots
  const totalSlots = [...slots.values()].reduce((sum, s) => sum + s.max, 0);

  let queueIdx = 0;

  async function pickProvider(excludeNames = new Set()) {
    // Simple round-robin across providers with free slots and not in the
    // exclude set. Tries every provider in a cycle.
    for (let i = 0; i < LARGE_RANGE_LOG_PROVIDERS.length; i++) {
      _rrIndex = (_rrIndex + 1) % LARGE_RANGE_LOG_PROVIDERS.length;
      const p = LARGE_RANGE_LOG_PROVIDERS[_rrIndex];
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

  async function fetchChunkOnce(chunk, excludeNames) {
    // Pick a provider with free slots. If none, wait a beat and retry.
    let provider = await pickProvider(excludeNames);
    while (!provider) {
      await sleep(20);
      provider = await pickProvider(excludeNames);
    }

    const body = {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'eth_getLogs',
      params: [{
        address: filter.address,
        topics: filter.topics,
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

  async function fetchChunkWithRetry(chunk) {
    const excludeNames = new Set();
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const r = await fetchChunkOnce(chunk, excludeNames);
      if (r.ok) return r.logs;
      excludeNames.add(r.provider);
      // If we've excluded every provider, reset and wait briefly.
      if (excludeNames.size >= LARGE_RANGE_LOG_PROVIDERS.length) {
        excludeNames.clear();
        await sleep(500);
      }
    }
    return null; // All attempts failed
  }

  // Worker pool. Concurrency cap = totalSlots (each provider gets its own
  // slot quota, so we can freely spawn up to totalSlots workers).
  const CONCURRENCY = Math.min(totalSlots, chunks.length);

  async function worker() {
    while (true) {
      const i = queueIdx++;
      if (i >= chunks.length) return;
      const chunk = chunks[i];
      const logs = await fetchChunkWithRetry(chunk);
      if (logs === null) {
        failedRanges.push(chunk);
      } else {
        allLogs.push(...logs);
      }
      processed++;
      if (processed % 5 === 0 || processed === chunks.length) {
        onLog?.(`    fast-path ${processed}/${chunks.length}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // ===== Second pass: retry any failed ranges =====
  if (failedRanges.length > 0) {
    onLog?.(`    ⚠ first pass: ${failedRanges.length} chunks failed, retrying in ${SECOND_PASS_DELAY_MS}ms…`);
    await sleep(SECOND_PASS_DELAY_MS);

    const secondPassQueue = [...failedRanges];
    failedRanges.length = 0;
    let secondPassIdx = 0;

    async function secondPassWorker() {
      while (true) {
        const i = secondPassIdx++;
        if (i >= secondPassQueue.length) return;
        const chunk = secondPassQueue[i];
        const logs = await fetchChunkWithRetry(chunk);
        if (logs === null) {
          failedRanges.push(chunk);
        } else {
          allLogs.push(...logs);
        }
      }
    }

    const secondPassWorkers = Array.from(
      { length: Math.min(CONCURRENCY, secondPassQueue.length) },
      () => secondPassWorker(),
    );
    await Promise.all(secondPassWorkers);

    if (failedRanges.length > 0) {
      onLog?.(`    ⚠ second pass: ${failedRanges.length} chunks STILL failed — results incomplete`);
    } else {
      onLog?.(`    ✓ second pass recovered all failed chunks`);
    }
  }

  // ===== Deduplicate logs by (transactionHash, logIndex) =====
  // If merkle and tenderly both served overlapping requests (possible on
  // retry paths), we'd have duplicate log entries. Dedupe so the caller
  // always sees each on-chain event exactly once.
  const seen = new Set();
  const dedupedLogs = [];
  for (const log of allLogs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedLogs.push(log);
  }
  if (dedupedLogs.length !== allLogs.length) {
    onLog?.(`    deduped ${allLogs.length - dedupedLogs.length} duplicate log entries`);
  }

  return { logs: dedupedLogs, failedRanges };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
