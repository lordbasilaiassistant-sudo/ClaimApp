// src/services/rpc-throttle.js
// Public RPC etiquette: bounded concurrency + exponential backoff.
//
// Rationale:
//   * Public Base RPCs (mainnet.base.org, llamarpc, publicnode) rate-limit
//     aggressive scanners. Exceeding limits causes 429s, "could not coalesce
//     error", and in extreme cases IP blocks.
//   * We MUST respect these endpoints because our users share them — if we
//     get blocked, every ClaimApp user suffers.
//   * Strategy:
//       1. Cap in-flight requests to a small number (default 3).
//       2. On failure, retry with exponential backoff (250ms, 500ms, 1s).
//       3. Small base delay between requests to smooth bursts.
//
// All on-chain reads in the app should route through runWithRetry() or the
// concurrency-limited pool below. Direct contract calls are fine for one-off
// reads; chunked scans MUST use the pool.

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;

/**
 * Retry an async function with exponential backoff on failure.
 * Only retries on transient errors — validation errors propagate immediately.
 */
export async function runWithRetry(fn, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY_MS;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Classify: retriable vs permanent.
      if (!isRetriableError(e)) throw e;
      if (attempt === retries) break;
      // Exponential backoff with jitter: 250ms, 500ms, 1000ms (+ random 0-150ms)
      const delay = baseDelay * 2 ** attempt + Math.random() * 150;
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Run a list of async tasks with a max in-flight concurrency cap.
 * Returns results in the same order as the input.
 *
 * @param {Array<() => Promise<T>>} tasks
 * @param {Object} [options]
 * @param {number} [options.concurrency=3]
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<Array<{ok: boolean, result?: T, error?: any}>>}
 */
export async function runPool(tasks, options = {}) {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const results = new Array(tasks.length);
  let nextIdx = 0;
  let completed = 0;

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= tasks.length) return;
      try {
        const result = await tasks[i]();
        results[i] = { ok: true, result };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
      completed++;
      options.onProgress?.(completed, tasks.length);
    }
  });

  await Promise.all(workers);
  return results;
}

function isRetriableError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  // ethers v6 error codes
  if (e?.code === 'TIMEOUT') return true;
  if (e?.code === 'NETWORK_ERROR') return true;
  if (e?.code === 'SERVER_ERROR') return true;
  // Common message patterns from public RPCs
  return (
    msg.includes('coalesce') ||
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up')
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
