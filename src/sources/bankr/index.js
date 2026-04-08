// src/sources/bankr/index.js
// Bankr / Doppler V4 source adapter. Live — no longer a stub.
//
// Discovery: Release events on DECAY filtered by beneficiary.
// Claim: DECAY.collectFees(poolId). Permissionless.
// See scanner.js and claimer.js for implementation details.

import { BANKR } from './config.js';
import { scan as scanBankr } from './scanner.js';
import { claimItem } from './claimer.js';

const bankr = {
  id: 'bankr',
  name: 'Bankr / Doppler V4',
  chainId: BANKR.chainId,
  description:
    'Discover and claim LP fees from your Bankr / Doppler V4 launches on Base.',

  /**
   * Scan a wallet for Bankr pools where it has received rewards.
   * Only catches pools that have been claimed from at least once.
   * New launches (never claimed) won't appear yet.
   */
  async scan(address, options = {}) {
    try {
      const result = await scanBankr(address, options.onLog);
      return result;
    } catch (e) {
      return {
        source: 'bankr',
        address,
        items: [],
        wethClaimable: 0n,
        failedRanges: [],
        complete: false,
        error: e.shortMessage || e.message || 'bankr scan failed',
      };
    }
  },

  claimItem,
};

export default bankr;
