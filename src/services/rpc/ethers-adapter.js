// src/services/rpc/ethers-adapter.js
// Custom ethers.js provider that delegates JSON-RPC calls to our multi-RPC
// router. The rest of the app uses standard ethers APIs — Contract, Wallet,
// queryFilter, aggregate3 — and they transparently get multi-provider failover,
// 429 cooldowns, and concurrency caps.
//
// ethers v6's JsonRpcApiProvider exposes a `_send(payload)` hook that is
// called for every RPC request. We override it to route through RpcRouter.

import { ethers } from '../../vendor/ethers.js';
import { getRouter } from './router.js';
import { BASE_CHAIN_ID } from './providers.js';

/**
 * A JsonRpcApiProvider subclass that routes every RPC request through our
 * multi-provider router instead of a single URL.
 */
export class MultiRpcProvider extends ethers.JsonRpcApiProvider {
  constructor(chainId = BASE_CHAIN_ID) {
    // Pass a fixed Network so ethers doesn't try to detect it.
    const network = new ethers.Network('base', BigInt(chainId));
    super(network, { staticNetwork: network, batchMaxCount: 1 });
    this._router = getRouter();
  }

  /**
   * ethers calls this for every JSON-RPC request. It expects an array of
   * responses because JsonRpcApiProvider batches. We disable batching above
   * (batchMaxCount: 1), so we always receive a single-element payload array.
   *
   * @param {Array<{method: string, params: any[]}>} payload
   * @returns {Promise<Array<{result?: any, error?: any}>>}
   */
  async _send(payload) {
    // ethers may send either a single object or an array. Normalize to array.
    const requests = Array.isArray(payload) ? payload : [payload];

    // Send each request through the router. Router returns the result directly
    // and throws on error — we convert back to ethers' expected shape.
    const responses = await Promise.all(
      requests.map(async (req) => {
        try {
          const result = await this._router.send({
            method: req.method,
            params: req.params || [],
          });
          return { id: req.id, result };
        } catch (e) {
          return {
            id: req.id,
            error: {
              code: e.code || -32603,
              message: e.message || 'router error',
              data: e.data,
            },
          };
        }
      }),
    );

    return responses;
  }
}
