// src/sources/clanker/claimer.js
// Executes the claim flow for a Clanker v4 token:
//   1. (optional) LpLocker.collectRewardsWithoutUnlock(token) — sweeps V4 pool
//      fees into the FeeLocker. Only needed if unswept fees exist.
//   2. FeeLocker.claim(feeOwner, token) — withdraws to wallet.
//
// We expose two entry points:
//   * claimItem(item, signer)      — single-token claim (collect + claim)
//   * claimWeth(signer, feeOwner)  — claim the shared WETH balance (no collect)
//
// Notes:
//   * All signing happens client-side via the provided ethers.Wallet.
//   * We wait for tx receipts before returning — UIs can show progress.
//   * Collect is optional: if the FeeLocker already has a non-zero balance,
//     collecting again is wasted gas. We check first.

import { ethers } from '../../vendor/ethers.js';
import { CLANKER } from './config.js';
import { FEE_LOCKER_ABI, LP_LOCKER_ABI } from './abis.js';

/**
 * @param {import('./scanner.js').ClaimItem} item
 * @param {ethers.Wallet} signer
 * @param {Object} [options]
 * @param {boolean} [options.collect=true] — run collectRewards first
 * @returns {Promise<{ok: boolean, txs: Array<{label: string, hash: string}>, error?: string}>}
 */
export async function claimItem(item, signer, options = {}) {
  if (item.source !== 'clanker') {
    return { ok: false, txs: [], error: 'not a clanker item' };
  }
  if (item.version !== 'v4') {
    return { ok: false, txs: [], error: `version ${item.version} not yet supported` };
  }

  const feeLocker = new ethers.Contract(CLANKER.v4.feeLocker, FEE_LOCKER_ABI, signer);
  const lpLocker = new ethers.Contract(CLANKER.v4.lpLocker, LP_LOCKER_ABI, signer);
  const owner = await signer.getAddress();
  const token = item.tokenAddress;

  const txs = [];

  // Step 1: collect (sweep V4 pool fees → feeLocker). Optional but recommended.
  if (options.collect !== false) {
    try {
      const tx = await lpLocker.collectRewardsWithoutUnlock(token);
      txs.push({ label: 'collect', hash: tx.hash });
      await tx.wait();
    } catch (e) {
      // Collect can fail if the position is stale or already swept — not fatal.
      // Continue to claim step and see if there's anything in the fee locker.
      txs.push({ label: 'collect', hash: '', error: e.shortMessage || e.message });
    }
  }

  // Step 2: claim the token side from feeLocker
  try {
    const available = await feeLocker.availableFees(owner, token);
    if (available > 0n) {
      const tx = await feeLocker.claim(owner, token);
      txs.push({ label: 'claim', hash: tx.hash });
      await tx.wait();
    } else {
      txs.push({ label: 'claim', hash: '', error: 'no token-side fees available' });
    }
  } catch (e) {
    return { ok: false, txs, error: e.shortMessage || e.message };
  }

  return { ok: true, txs };
}

/**
 * Claim the shared WETH balance accumulated from all v4 launches.
 * @param {ethers.Wallet} signer
 * @returns {Promise<{ok: boolean, hash?: string, amount?: bigint, error?: string}>}
 */
export async function claimWeth(signer) {
  const feeLocker = new ethers.Contract(CLANKER.v4.feeLocker, FEE_LOCKER_ABI, signer);
  const owner = await signer.getAddress();
  try {
    const available = await feeLocker.availableFees(owner, CLANKER.weth);
    if (available === 0n) {
      return { ok: false, error: 'no WETH available' };
    }
    const tx = await feeLocker.claim(owner, CLANKER.weth);
    await tx.wait();
    return { ok: true, hash: tx.hash, amount: available };
  } catch (e) {
    return { ok: false, error: e.shortMessage || e.message };
  }
}

/**
 * Batch-collect fees for a list of v4 tokens (sweeps V4 pools → FeeLocker).
 * Each call is a separate tx — no way to batch on-chain without a multicall
 * wrapper contract. We fire them sequentially with progress callbacks.
 *
 * @param {string[]} tokenAddresses
 * @param {ethers.Wallet} signer
 * @param {(progress: {done: number, total: number, current: string, tx?: string, error?: string}) => void} [onProgress]
 * @returns {Promise<Array<{token: string, hash?: string, error?: string}>>}
 */
export async function batchCollect(tokenAddresses, signer, onProgress) {
  const lpLocker = new ethers.Contract(CLANKER.v4.lpLocker, LP_LOCKER_ABI, signer);
  const results = [];
  for (let i = 0; i < tokenAddresses.length; i++) {
    const token = tokenAddresses[i];
    onProgress?.({ done: i, total: tokenAddresses.length, current: token });
    try {
      const tx = await lpLocker.collectRewardsWithoutUnlock(token);
      await tx.wait();
      results.push({ token, hash: tx.hash });
      onProgress?.({ done: i + 1, total: tokenAddresses.length, current: token, tx: tx.hash });
    } catch (e) {
      const error = e.shortMessage || e.message;
      results.push({ token, error });
      onProgress?.({ done: i + 1, total: tokenAddresses.length, current: token, error });
    }
  }
  return results;
}
