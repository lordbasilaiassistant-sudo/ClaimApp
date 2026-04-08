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
import { runPool, runWithRetry } from '../../services/rpc-throttle.js';
import { CLANKER } from './config.js';
import {
  FEE_LOCKER_ABI,
  ERC20_ABI,
  CLANKER_V4_FACTORY_ABI,
  CLANKER_V3_FACTORY_ABI,
} from './abis.js';

const feeLockerIface = new ethers.Interface(FEE_LOCKER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

/**
 * Scan factory events in chunks to find all TokenCreated events where
 * tokenAdmin matches the target address. Chunks run through runPool with
 * bounded concurrency and per-chunk retry.
 *
 * @param {ethers.Contract} factory — Contract instance with the factory ABI
 * @param {string} tokenAdmin — checksummed wallet address to filter by
 * @param {bigint} fromBlock
 * @param {bigint} toBlock
 * @param {(msg: string) => void} [onLog] — progress logger
 * @returns {Promise<Array<{tokenAddress: string, tokenAdmin: string, name: string, symbol: string, launchBlock: number, txHash: string}>>}
 */
async function scanFactoryForAdmin(factory, tokenAdmin, fromBlock, toBlock, onLog) {
  const chunkSize = CLANKER.logScanChunkSize;

  // Build the filter: TokenCreated event with tokenAdmin as the 3rd indexed param.
  // ethers v6 resolves topic[2] automatically from the named param.
  const filter = factory.filters.TokenCreated(null, null, tokenAdmin);

  // Build chunk task list.
  const chunks = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    chunks.push({ start: Number(start), end: Number(end) });
  }

  onLog?.(`  ${chunks.length} chunks × ${chunkSize} blocks`);

  const tasks = chunks.map((chunk) => async () => {
    return runWithRetry(
      () => factory.queryFilter(filter, chunk.start, chunk.end),
      { retries: 3, baseDelay: 400 },
    );
  });

  // Bounded concurrency. The multi-RPC router in src/services/rpc/ spreads
  // these across ~14 public providers, each with maxConcurrent ≈ 4.
  // 20 in-flight is comfortable and gives ~200ms/chunk throughput.
  const results = await runPool(tasks, {
    concurrency: 20,
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) {
        onLog?.(`    chunks ${done}/${total}`);
      }
    },
  });

  const launches = [];
  let failedChunks = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      failedChunks++;
      continue;
    }
    for (const log of r.result) {
      const args = log.args || {};
      launches.push({
        tokenAddress: args.tokenAddress,
        tokenAdmin: args.tokenAdmin,
        name: args.tokenName || '',
        symbol: args.tokenSymbol || '',
        launchBlock: log.blockNumber,
        txHash: log.transactionHash,
      });
    }
  }

  if (failedChunks > 0) {
    onLog?.(`  ⚠ ${failedChunks}/${chunks.length} chunks failed (RPC limits)`);
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

    const abi = version === 'v4' ? CLANKER_V4_FACTORY_ABI : CLANKER_V3_FACTORY_ABI;
    const factory = new ethers.Contract(cfg.factory, abi, provider);
    const startBlock = deepScan && cfg.deepStartBlock ? cfg.deepStartBlock : cfg.startBlock;

    onLog(`[${version}] scanning ${cfg.factory}`);
    onLog(`  range: ${startBlock} → ${latestBlock}`);

    const launches = await scanFactoryForAdmin(
      factory,
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
