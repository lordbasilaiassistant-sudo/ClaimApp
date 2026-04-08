// src/sources/bankr/scanner.js
// Discover Bankr/Doppler V4 pools where a wallet is a fee beneficiary,
// then query pending fees via Multicall3.
//
// DISCOVERY STRATEGY: Scan Release events on DECAY filtered by beneficiary.
// This catches every pool where the wallet has EVER received rewards.
//
// Known limitation (inherited from BankrRewards/scan-and-claim.js):
// Release is emitted on CLAIM, not on launch. So pools the wallet has
// never claimed from will not appear in this scan. For those, the user
// currently needs to trigger a first claim via the Bankr UI/CLI. We
// document this in the UI so expectations are clear.

import { ethers } from '../../vendor/ethers.js';
import { multicallRead } from '../../services/multicall.js';
import { fetchLogs } from '../../services/rpc/log-fetcher.js';
import { BANKR } from './config.js';
import { DECAY_ABI, ERC20_ABI } from './abis.js';

const decayIface = new ethers.Interface(DECAY_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const RELEASE_TOPIC = decayIface.getEvent('Release').topicHash;

/**
 * Step 1: scan Release events to find pools the wallet has received from.
 * Returns a de-duped list of poolIds.
 */
async function discoverPoolIds(walletAddress, onLog) {
  const paddedBeneficiary = ethers.zeroPadValue(ethers.getAddress(walletAddress), 32);
  const filter = {
    address: BANKR.decay,
    topics: [RELEASE_TOPIC, null, paddedBeneficiary],
    fromBlock: Number(BANKR.startBlock),
    toBlock: 'latest', // log-fetcher will resolve this
  };

  // fetchLogs needs a numeric toBlock — we'll resolve via provider first.
  const provider = (await import('../../services/provider.js')).getProvider();
  const latest = await provider.getBlockNumber();
  filter.toBlock = latest;

  onLog?.(`  [bankr] scanning DECAY Release events…`);
  const { logs, failedRanges } = await fetchLogs(filter, onLog);

  const poolMap = new Map(); // poolId → firstBlock/firstTx
  for (const raw of logs) {
    const poolId = raw.topics?.[1];
    if (!poolId) continue;
    if (poolMap.has(poolId)) continue;
    poolMap.set(poolId, {
      poolId,
      firstBlock: parseInt(raw.blockNumber, 16),
      firstTx: raw.transactionHash,
    });
  }
  onLog?.(`  [bankr] found ${poolMap.size} pool${poolMap.size === 1 ? '' : 's'} with rewards to wallet`);

  return { poolMap, failedRanges };
}

/**
 * Step 2: resolve poolId → (token0, token1) via getPoolKey.
 * For each pool we figure out which currency is the launched token
 * (the non-WETH one) so we can display its symbol/name.
 */
async function resolvePoolTokens(poolIds, onLog) {
  if (poolIds.length === 0) return [];
  onLog?.(`  [bankr] resolving ${poolIds.length} pool keys…`);

  const keyCalls = poolIds.map((pid) => ({
    target: BANKR.decay,
    iface: decayIface,
    method: 'getPoolKey',
    args: [pid],
  }));
  const keyResults = await multicallRead(keyCalls);

  // For each pool: pick the non-WETH side as the "launched token"
  const resolved = [];
  for (let i = 0; i < poolIds.length; i++) {
    const r = keyResults[i];
    if (!r?.success) continue;
    const [currency0, currency1] = r.result;
    const wethLower = BANKR.weth.toLowerCase();
    const launched = currency0.toLowerCase() === wethLower ? currency1 : currency0;
    const paired = currency0.toLowerCase() === wethLower ? currency0 : currency1;
    resolved.push({
      poolId: poolIds[i],
      tokenAddress: launched,
      pairedToken: paired,
      token0: currency0,
      token1: currency1,
    });
  }

  // Now batch fetch ERC20 metadata for each launched token
  const metaCalls = [];
  for (const r of resolved) {
    metaCalls.push({ target: r.tokenAddress, iface: erc20Iface, method: 'name', args: [] });
    metaCalls.push({ target: r.tokenAddress, iface: erc20Iface, method: 'symbol', args: [] });
    metaCalls.push({ target: r.tokenAddress, iface: erc20Iface, method: 'decimals', args: [] });
  }
  const metaResults = await multicallRead(metaCalls);
  // Soft length caps on token metadata — a malicious ERC20 contract could
  // return arbitrary-length strings from name/symbol. createTextNode is
  // XSS-safe but an absurdly long symbol would break row layout.
  const capStr = (s, max) => {
    const str = String(s || '').replace(/[\x00-\x1F\x7F]/g, '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  };
  for (let i = 0; i < resolved.length; i++) {
    const base = i * 3;
    const nameRes = metaResults[base];
    const symRes = metaResults[base + 1];
    const decRes = metaResults[base + 2];
    resolved[i].name = nameRes?.success ? capStr(nameRes.result, 64) : '';
    resolved[i].symbol = symRes?.success ? capStr(symRes.result, 16) : '???';
    if (!resolved[i].symbol) resolved[i].symbol = '???';
    resolved[i].decimals = decRes?.success ? Math.min(Number(decRes.result) || 18, 36) : 18;
  }

  return resolved;
}

/**
 * Step 3: for each pool, query pending fees via Multicall.
 * 5 read calls per pool: getShares, getCumulatedFees0/1, getLastCumulatedFees0/1.
 * Pending ≈ (cumulated - lastCumulated) per side (simplified — doesn't
 * divide by total shares because total shares isn't exposed cheaply).
 */
async function queryPendingFees(walletAddress, resolvedPools, onLog) {
  if (resolvedPools.length === 0) return [];
  onLog?.(`  [bankr] querying pending fees for ${resolvedPools.length} pool${resolvedPools.length === 1 ? '' : 's'}…`);

  const calls = [];
  for (const p of resolvedPools) {
    calls.push({ target: BANKR.decay, iface: decayIface, method: 'getShares',              args: [p.poolId, walletAddress] });
    calls.push({ target: BANKR.decay, iface: decayIface, method: 'getCumulatedFees0',      args: [p.poolId] });
    calls.push({ target: BANKR.decay, iface: decayIface, method: 'getCumulatedFees1',      args: [p.poolId] });
    calls.push({ target: BANKR.decay, iface: decayIface, method: 'getLastCumulatedFees0',  args: [p.poolId, walletAddress] });
    calls.push({ target: BANKR.decay, iface: decayIface, method: 'getLastCumulatedFees1',  args: [p.poolId, walletAddress] });
  }
  const results = await multicallRead(calls);

  const items = [];
  let totalWethPending = 0n;
  for (let i = 0; i < resolvedPools.length; i++) {
    const base = i * 5;
    const shares = results[base]?.success ? BigInt(results[base].result) : 0n;
    const cum0   = results[base + 1]?.success ? BigInt(results[base + 1].result) : 0n;
    const cum1   = results[base + 2]?.success ? BigInt(results[base + 2].result) : 0n;
    const last0  = results[base + 3]?.success ? BigInt(results[base + 3].result) : 0n;
    const last1  = results[base + 4]?.success ? BigInt(results[base + 4].result) : 0n;

    // Approximate pending: delta since last claim. This is an overestimate
    // because it doesn't divide by total shares, but it's a clear signal
    // for whether there's anything to claim at all. Users see the exact
    // amount after actually calling collectFees.
    const pending0 = cum0 > last0 ? cum0 - last0 : 0n;
    const pending1 = cum1 > last1 ? cum1 - last1 : 0n;

    const p = resolvedPools[i];
    const claimable = [];
    // Token side
    if (pending0 > 0n && p.token0.toLowerCase() !== BANKR.weth.toLowerCase()) {
      claimable.push({ token: p.tokenAddress, symbol: p.symbol, amount: pending0, decimals: p.decimals });
    }
    if (pending1 > 0n && p.token1.toLowerCase() !== BANKR.weth.toLowerCase()) {
      claimable.push({ token: p.tokenAddress, symbol: p.symbol, amount: pending1, decimals: p.decimals });
    }
    // WETH side (tracked as a per-pool amount — not aggregated across pools
    // because collectFees only pays out for a single pool at a time)
    const wethPending = p.token0.toLowerCase() === BANKR.weth.toLowerCase() ? pending0 : pending1;
    if (wethPending > 0n) {
      claimable.push({ token: BANKR.weth, symbol: 'WETH', amount: wethPending, decimals: 18 });
      totalWethPending += wethPending;
    }

    items.push({
      source: 'bankr',
      id: `bankr:${p.poolId}`,
      version: 'doppler-v4',
      name: p.name || p.symbol,
      symbol: p.symbol,
      tokenAddress: p.tokenAddress,
      claimable,
      meta: {
        poolId: p.poolId,
        shares: shares.toString(),
        note: 'Pending amount is an approximation (cumulated delta). Exact split is applied on-chain at claim time.',
      },
    });
  }

  return { items, totalWethPending };
}

/**
 * Main scan entry point — compose the 3 steps above.
 *
 * @param {string} walletAddress
 * @param {(msg: string) => void} [onLog]
 */
export async function scan(walletAddress, onLog = () => {}) {
  const { poolMap, failedRanges } = await discoverPoolIds(walletAddress, onLog);
  const poolIds = [...poolMap.keys()];
  if (poolIds.length === 0) {
    return {
      source: 'bankr',
      address: walletAddress,
      items: [],
      wethClaimable: 0n,
      failedRanges,
      complete: failedRanges.length === 0,
    };
  }
  const resolved = await resolvePoolTokens(poolIds, onLog);
  // Preserve launch metadata from the event scan
  for (const r of resolved) {
    const meta = poolMap.get(r.poolId);
    r.firstBlock = meta?.firstBlock || 0;
    r.firstTx = meta?.firstTx || '';
  }
  const { items, totalWethPending } = await queryPendingFees(walletAddress, resolved, onLog);
  return {
    source: 'bankr',
    address: walletAddress,
    items,
    // Per-pool WETH amounts are inside each item.claimable. We don't expose
    // a separate "aggregate WETH" at the source level because Bankr pays
    // out per-pool, not into a shared locker like Clanker v4.
    wethClaimable: 0n,
    failedRanges,
    complete: failedRanges.length === 0,
    totalWethPending,
  };
}
