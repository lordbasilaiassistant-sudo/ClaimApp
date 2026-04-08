// src/sources/bankr/claimer.js
// Claim Doppler V4 pool fees via DECAY.collectFees(poolId).
//
// collectFees is permissionless — anyone can call it, and the fees go to
// the registered beneficiaries per the pool's share configuration. So a
// user can claim their own fees directly from any wallet that has gas,
// not just from the pool's deployer.

import { ethers } from '../../vendor/ethers.js';
import { BANKR } from './config.js';
import { DECAY_ABI } from './abis.js';

/**
 * Claim fees for a single Bankr pool.
 * @param {Object} item — from bankr scanner, must have meta.poolId
 * @param {ethers.Wallet} signer
 */
export async function claimItem(item, signer) {
  const poolId = item?.meta?.poolId;
  if (!poolId) {
    return { ok: false, txs: [], error: 'missing poolId for Bankr claim' };
  }
  try {
    const decay = new ethers.Contract(BANKR.decay, DECAY_ABI, signer);
    const tx = await decay.collectFees(poolId);
    const receipt = await tx.wait();
    return {
      ok: true,
      txs: [{ label: 'collectFees', hash: tx.hash, block: receipt.blockNumber }],
    };
  } catch (e) {
    const msg = e.shortMessage || e.message || 'claim failed';
    const friendly = /revert|no.?fees|zero|nothing/i.test(msg)
      ? 'No fees available to claim on this pool right now.'
      : msg;
    return { ok: false, txs: [], error: friendly };
  }
}
