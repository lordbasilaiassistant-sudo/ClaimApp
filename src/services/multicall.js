// src/services/multicall.js
// Batch on-chain read calls through Multicall3. Every batch goes through the
// multi-RPC router via getProvider(), so we inherit failover + 429 cooldown
// + per-provider concurrency caps automatically.
//
// Used by every source adapter for balance scans.

import { ethers } from '../vendor/ethers.js';
import { BASE } from '../config/chains.js';
import { MULTICALL3_ABI } from '../sources/clanker/abis.js';
import { getProvider } from './provider.js';
import { runPool } from './rpc-throttle.js';

// Public RPCs cap aggregate3 at ~100 calls per batch. Stay safely under.
const BATCH_SIZE = 100;
// Max in-flight Multicall batches. The router itself caps per-provider slots,
// but keeping this low prevents us from queueing up too many pending requests.
const BATCH_CONCURRENCY = 3;

/**
 * Execute a list of read calls in parallel batches via Multicall3.
 *
 * @param {Array<{target: string, iface: ethers.Interface, method: string, args: any[]}>} calls
 * @returns {Promise<Array<{success: boolean, result: any, error?: string}>>}
 */
export async function multicallRead(calls) {
  if (calls.length === 0) return [];

  const provider = getProvider();
  const multicall = new ethers.Contract(
    BASE.contracts.multicall3,
    MULTICALL3_ABI,
    provider,
  );

  // Chunk into batches of BATCH_SIZE
  const batches = [];
  for (let i = 0; i < calls.length; i += BATCH_SIZE) {
    batches.push({ start: i, calls: calls.slice(i, i + BATCH_SIZE) });
  }

  // One task per batch — run them through runPool for bounded concurrency.
  const tasks = batches.map((batch) => async () => {
    const encoded = batch.calls.map((c) => ({
      target: c.target,
      allowFailure: true,
      callData: c.iface.encodeFunctionData(c.method, c.args),
    }));
    // staticCall goes through the router — it'll retry + fail over internally.
    return multicall.aggregate3.staticCall(encoded);
  });

  const batchResults = await runPool(tasks, { concurrency: BATCH_CONCURRENCY });

  // Stitch results back into a flat array matching the original `calls` order.
  const results = new Array(calls.length);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const br = batchResults[b];
    if (!br.ok) {
      // Entire batch failed — mark every call as failed.
      for (let j = 0; j < batch.calls.length; j++) {
        results[batch.start + j] = {
          success: false,
          result: null,
          error: br.error?.message || 'batch failed',
        };
      }
      continue;
    }
    const raw = br.result;
    for (let j = 0; j < raw.length; j++) {
      const r = raw[j];
      const call = batch.calls[j];
      if (!r.success) {
        results[batch.start + j] = { success: false, result: null, error: 'call reverted' };
        continue;
      }
      try {
        const decoded = call.iface.decodeFunctionResult(call.method, r.returnData);
        results[batch.start + j] = {
          success: true,
          result: decoded.length === 1 ? decoded[0] : decoded,
        };
      } catch (e) {
        results[batch.start + j] = { success: false, result: null, error: 'decode failed' };
      }
    }
  }

  return results;
}
