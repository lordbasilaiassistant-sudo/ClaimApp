// src/sources/clanker/scanner.js
// Discovers all Clanker tokens admin'd by a wallet via factory event logs,
// then queries claimable fee balances from the FeeLocker.
//
// Design notes:
//   * Event filter by `tokenAdmin` (indexed) lets RPC do the work — we don't
//     download every launch event. Public Base RPC is fine for this.
//   * We chunk eth_getLogs to stay under public RPC limits (~10k blocks/call).
//   * Chunks run through rpc-throttle for bounded concurrency + retry —
//     public RPCs are a shared resource and abusing them hurts all users.
//   * We check WETH once per wallet (shared across all launches) and the
//     token side per-token in a single Multicall3 batch.
//   * Legacy versions (v3, v3_1) don't use FeeLocker — they pay out via their
//     own lpLocker.collectRewards() directly. We scan their factories for
//     discovery but claimable balance queries are v4-only for now.

import { ethers } from '../../vendor/ethers.js';
import { getProvider } from '../../services/provider.js';
import { multicallRead } from '../../services/multicall.js';
import { fetchLogs } from '../../services/rpc/log-fetcher.js';
import { CLANKER } from './config.js';
import {
  FEE_LOCKER_ABI,
  ERC20_ABI,
  CLANKER_V4_FACTORY_ABI,
  CLANKER_V3_FACTORY_ABI,
} from './abis.js';

const feeLockerIface = new ethers.Interface(FEE_LOCKER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const v4FactoryIface = new ethers.Interface(CLANKER_V4_FACTORY_ABI);
const v3FactoryIface = new ethers.Interface(CLANKER_V3_FACTORY_ABI);

/**
 * Scan factory events for all TokenCreated events where tokenAdmin matches
 * the target address. Uses the fast log-fetcher which routes through
 * large-range providers (merkle, tenderly) with 200k-block chunks.
 *
 * @param {string} factoryAddress
 * @param {ethers.Interface} iface
 * @param {string} tokenAdmin — checksummed wallet
 * @param {bigint} fromBlock
 * @param {bigint} toBlock
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<Array>}
 */
async function scanFactoryForAdmin(factoryAddress, iface, tokenAdmin, fromBlock, toBlock, onLog) {
  // Build the raw eth_getLogs filter. topic[0] = event signature hash,
  // topic[2] = tokenAdmin (indexed). topic[1] is tokenAddress (indexed)
  // which we leave as null to match any token.
  const eventFragment = iface.getEvent('TokenCreated');
  const topic0 = eventFragment.topicHash;
  // Pad the address to 32 bytes for topic encoding
  const paddedAdmin = ethers.zeroPadValue(ethers.getAddress(tokenAdmin), 32);

  const filter = {
    address: factoryAddress,
    topics: [topic0, null, paddedAdmin],
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
  };

  const { logs, failedRanges } = await fetchLogs(filter, onLog);

  if (failedRanges.length > 0) {
    onLog?.(`  ⚠ ${failedRanges.length} block ranges failed (results may be incomplete)`);
  }

  // Decode each log via the factory interface.
  const launches = [];
  for (const raw of logs) {
    try {
      const parsed = iface.parseLog({ topics: raw.topics, data: raw.data });
      if (!parsed || parsed.name !== 'TokenCreated') continue;
      const args = parsed.args;
      launches.push({
        tokenAddress: args.tokenAddress,
        tokenAdmin: args.tokenAdmin,
        name: args.tokenName || '',
        symbol: args.tokenSymbol || '',
        launchBlock: parseInt(raw.blockNumber, 16),
        txHash: raw.transactionHash,
      });
    } catch {
      /* skip logs we can't decode — likely from a different event shape */
    }
  }

  return launches;
}

/**
 * Discover all Clanker tokens admin'd by `walletAddress` across all configured
 * factory versions. Versions are scanned sequentially (not in parallel) to
 * respect public RPC rate limits.
 *
 * @param {string} walletAddress — checksummed address
 * @param {Object} options
 * @param {string[]} [options.versions] — which versions to scan (default: CLANKER.defaultScanVersions)
 * @param {boolean} [options.deepScan=false] — expand legacy ranges further back
 * @param {(msg: string) => void} [options.onLog] — progress logger
 * @returns {Promise<Array<{version: string, tokenAddress: string, name: string, symbol: string, launchBlock: number, txHash: string}>>}
 */
export async function discoverLaunches(walletAddress, options = {}) {
  const provider = getProvider();
  const versions = options.versions || CLANKER.defaultScanVersions;
  const deepScan = options.deepScan === true;
  const onLog = options.onLog || (() => {});

  const latestBlock = BigInt(await provider.getBlockNumber());
  const all = [];

  // Sequential across versions — avoid stacking load on public RPCs.
  for (const version of versions) {
    const cfg = CLANKER[version];
    if (!cfg || !cfg.factory) continue;

    const iface = version === 'v4' ? v4FactoryIface : v3FactoryIface;
    const startBlock = deepScan && cfg.deepStartBlock ? cfg.deepStartBlock : cfg.startBlock;

    onLog(`[${version}] scanning ${cfg.factory}`);
    onLog(`  range: ${startBlock} → ${latestBlock}`);

    const launches = await scanFactoryForAdmin(
      cfg.factory,
      iface,
      walletAddress,
      startBlock,
      latestBlock,
      onLog,
    );
    onLog(`[${version}] found ${launches.length} launch${launches.length === 1 ? '' : 'es'}`);

    for (const l of launches) all.push({ version, ...l });
  }

  // Sort newest-first.
  all.sort((a, b) => b.launchBlock - a.launchBlock);
  return all;
}

/**
 * Query FeeLocker for claimable balances on every discovered token,
 * plus WETH once (shared across all launches).
 *
 * Only v4 launches use the FeeLocker — v3/v3_1 have their own locker.collectRewards()
 * that pays out directly. For v3_1 tokens we include them in the result with
 * claimable=[] and a note; users can still see them listed.
 *
 * @param {string} walletAddress
 * @param {Array<{version: string, tokenAddress: string, name: string, symbol: string}>} launches
 * @returns {Promise<{items: Array, wethClaimable: bigint}>}
 */
export async function queryClaimables(walletAddress, launches) {
  if (launches.length === 0) return { items: [], wethClaimable: 0n };

  const v4Launches = launches.filter((l) => l.version === 'v4');
  const nonV4 = launches.filter((l) => l.version !== 'v4');

  // Build multicall read set:
  //   1. WETH claimable (once)
  //   2. Per-v4-token: availableFees(wallet, token), symbol, decimals
  const calls = [];

  // [0] WETH availableFees — shared across all v4 launches
  calls.push({
    target: CLANKER.v4.feeLocker,
    iface: feeLockerIface,
    method: 'availableFees',
    args: [walletAddress, CLANKER.weth],
  });

  // Per-token reads: availableFees + symbol + decimals (3 calls each)
  for (const l of v4Launches) {
    calls.push({
      target: CLANKER.v4.feeLocker,
      iface: feeLockerIface,
      method: 'availableFees',
      args: [walletAddress, l.tokenAddress],
    });
    calls.push({
      target: l.tokenAddress,
      iface: erc20Iface,
      method: 'symbol',
      args: [],
    });
    calls.push({
      target: l.tokenAddress,
      iface: erc20Iface,
      method: 'decimals',
      args: [],
    });
  }

  const results = await multicallRead(calls);

  const wethRes = results[0];
  const wethClaimable = wethRes?.success ? BigInt(wethRes.result) : 0n;

  const items = [];

  // v4 items with claimables
  for (let i = 0; i < v4Launches.length; i++) {
    const l = v4Launches[i];
    const base = 1 + i * 3;
    const availRes = results[base];
    const symRes = results[base + 1];
    const decRes = results[base + 2];

    const tokenClaimable = availRes?.success ? BigInt(availRes.result) : 0n;
    const symbol = symRes?.success ? String(symRes.result) : l.symbol || '???';
    const decimals = decRes?.success ? Number(decRes.result) : 18;

    items.push({
      source: 'clanker',
      id: `v4:${l.tokenAddress.toLowerCase()}`,
      version: 'v4',
      name: l.name || symbol,
      symbol,
      tokenAddress: l.tokenAddress,
      claimable: tokenClaimable > 0n
        ? [{ token: l.tokenAddress, symbol, amount: tokenClaimable, decimals }]
        : [],
      meta: {
        launchBlock: l.launchBlock,
        txHash: l.txHash,
      },
    });
  }

  // Non-v4 items — listed but marked as unsupported-for-now for claims
  for (const l of nonV4) {
    items.push({
      source: 'clanker',
      id: `${l.version}:${l.tokenAddress.toLowerCase()}`,
      version: l.version,
      name: l.name || l.symbol || '???',
      symbol: l.symbol || '???',
      tokenAddress: l.tokenAddress,
      claimable: [],
      meta: {
        launchBlock: l.launchBlock,
        txHash: l.txHash,
        note: `${l.version} uses a legacy claim flow — not yet supported in the UI`,
      },
    });
  }

  return { items, wethClaimable };
}
