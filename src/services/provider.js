// src/services/provider.js
// Returns a singleton ethers provider backed by the multi-RPC router.
// Every read goes through RpcRouter → failover → 429 cooldown → concurrency cap.
// See src/services/rpc/ for the underlying aggregator.

import { MultiRpcProvider } from './rpc/ethers-adapter.js';
import { getRouter, resetRouter } from './rpc/router.js';

let _provider = null;

/**
 * Get the lazy-initialized provider. Subsequent calls return the cached instance.
 */
export function getProvider() {
  if (_provider) return _provider;
  _provider = new MultiRpcProvider();
  return _provider;
}

/**
 * Reset the provider. Call after changing the RPC endpoint list.
 */
export function resetProvider() {
  _provider = null;
  resetRouter();
}

/**
 * Expose router stats (in-flight, latency, failures) for the UI settings panel.
 */
export function getRpcStats() {
  return getRouter().getStats();
}
