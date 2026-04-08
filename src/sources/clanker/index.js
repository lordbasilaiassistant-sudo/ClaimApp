// src/sources/clanker/index.js
// Clanker source adapter — implements the SourceAdapter contract defined
// in src/sources/index.js. Keeps all Clanker-specific logic isolated so
// future platforms plug in as siblings.

import { CLANKER } from './config.js';
import { discoverLaunches, queryClaimables } from './scanner.js';
import { claimItem, claimWeth, batchCollect } from './claimer.js';

const clanker = {
  id: 'clanker',
  name: 'Clanker',
  chainId: CLANKER.chainId,
  description:
    'Discover all Clanker tokens admin\'d by your wallet and claim accumulated LP fees from Uniswap V4 pools.',

  /**
   * Read-only scan: discover launches + query claimable balances.
   * @param {string} address — checksummed wallet
   * @param {Object} [options]
   * @param {boolean} [options.deepScan=false] — scan legacy versions too
   * @param {(msg: string) => void} [options.onLog] — progress logger
   * @returns {Promise<{source, address, items, wethClaimable, error?}>}
   */
  async scan(address, options = {}) {
    try {
      const { launches, failedRanges } = await discoverLaunches(address, options);
      if (launches.length === 0) {
        return {
          source: 'clanker',
          address,
          items: [],
          wethClaimable: 0n,
          failedRanges,
          complete: failedRanges.length === 0,
        };
      }
      options.onLog?.(`querying claimable balances for ${launches.length} tokens…`);
      const { items, wethClaimable } = await queryClaimables(address, launches);
      return {
        source: 'clanker',
        address,
        items,
        wethClaimable,
        failedRanges,
        complete: failedRanges.length === 0,
      };
    } catch (e) {
      return {
        source: 'clanker',
        address,
        items: [],
        wethClaimable: 0n,
        failedRanges: [],
        complete: false,
        error: e.shortMessage || e.message || 'scan failed',
      };
    }
  },

  claimItem,
  claimWeth,
  batchCollect,
};

export default clanker;
