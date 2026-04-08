// src/sources/clanker/scanner.js
// Discovers all Clanker v4 tokens the wallet has any stake in, via TWO
// parallel scan paths:
//
//   A) FeeLocker StoreTokens events filtered by feeOwner == wallet
//      → catches every token where fees have been deposited to the user,
//        regardless of whether the user launched it. This is the PRIMARY
//        discovery path because it's what users actually care about:
//        "which tokens have rewards waiting for me?"
//
//   B) Factory TokenCreated events filtered by tokenAdmin == wallet
//      → catches tokens the user launched themselves but for which nobody
//        has called LpLocker.collectRewards() yet (so no fees in FeeLocker).
//        Without this path, freshly-launched tokens would be invisible
//        until someone collects.
//
// Union the two paths, dedupe by token address, then query current
// FeeLocker balances via Multicall3.
//
// Legacy Clanker versions (v3, v3_1, v2) use a different locker contract
// and are not yet supported for discovery OR claims.

import { ethers } from '../../vendor/ethers.js';
import { getProvider } from '../../services/provider.js';
import { multicallRead } from '../../services/multicall.js';
import { fetchLogs } from '../../services/rpc/log-fetcher.js';
import { CLANKER } from './config.js';
import {
  FEE_LOCKER_ABI,
  ERC20_ABI,
  CLANKER_V4_FACTORY_ABI,
} from './abis.js';

const feeLockerIface = new ethers.Interface(FEE_LOCKER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const v4FactoryIface = new ethers.Interface(CLANKER_V4_FACTORY_ABI);

// Cached topic hashes for event filters.
const STORE_TOKENS_TOPIC = feeLockerIface.getEvent('StoreTokens').topicHash;
const TOKEN_CREATED_TOPIC = v4FactoryIface.getEvent('TokenCreated').topicHash;

/**
 * Path A — scan FeeLocker StoreTokens events.
 * Catches tokens where the wallet has actually received fees.
 */
async function scanFeeLockerDeposits(walletAddress, fromBlock, toBlock, onLog) {
  const paddedFeeOwner = ethers.zeroPadValue(ethers.getAddress(walletAddress), 32);
  const filter = {
    address: CLANKER.v4.feeLocker,
    topics: [STORE_TOKENS_TOPIC, paddedFeeOwner, null],
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
  };

  onLog?.(`  [A] scanning FeeLocker StoreTokens (feeOwner=wallet)…`);
  const { logs, failedRanges } = await fetchLogs(filter, onLog);

  const tokens = new Map(); // lowercase addr → {address, firstBlock, firstTx, source}
  for (const raw of logs) {
    try {
      const parsed = feeLockerIface.parseLog({ topics: raw.topics, data: raw.data });
      if (!parsed || parsed.name !== 'StoreTokens') continue;
      const tokenAddr = parsed.args.token;
      const key = tokenAddr.toLowerCase();
      if (tokens.has(key)) continue;
      tokens.set(key, {
        address: tokenAddr,
        firstBlock: parseInt(raw.blockNumber, 16),
        firstTx: raw.transactionHash,
        source: 'recipient',
      });
    } catch {
      /* skip */
    }
  }
  onLog?.(`  [A] found ${tokens.size} token${tokens.size === 1 ? '' : 's'} with fee deposits`);
  return { tokens, failedRanges };
}

/**
 * Path B — scan v4 factory TokenCreated events.
 * Catches tokens the wallet launched itself.
 */
async function scanFactoryLaunches(walletAddress, fromBlock, toBlock, onLog) {
  const paddedAdmin = ethers.zeroPadValue(ethers.getAddress(walletAddress), 32);
  // v4 TokenCreated: topic[0]=eventSig, topic[1]=tokenAddress, topic[2]=tokenAdmin
  const filter = {
    address: CLANKER.v4.factory,
    topics: [TOKEN_CREATED_TOPIC, null, paddedAdmin],
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
  };

  onLog?.(`  [B] scanning v4 factory TokenCreated (tokenAdmin=wallet)…`);
  const { logs, failedRanges } = await fetchLogs(filter, onLog);

  const tokens = new Map();
  for (const raw of logs) {
    try {
      const parsed = v4FactoryIface.parseLog({ topics: raw.topics, data: raw.data });
      if (!parsed || parsed.name !== 'TokenCreated') continue;
      const tokenAddr = parsed.args.tokenAddress;
      const key = tokenAddr.toLowerCase();
      if (tokens.has(key)) continue;
      tokens.set(key, {
        address: tokenAddr,
        firstBlock: parseInt(raw.blockNumber, 16),
        firstTx: raw.transactionHash,
        source: 'admin',
        // Factory event gives us name/symbol for free — grab them for display
        name: parsed.args.tokenName || '',
        symbol: parsed.args.tokenSymbol || '',
      });
    } catch {
      /* skip */
    }
  }
  onLog?.(`  [B] found ${tokens.size} token${tokens.size === 1 ? '' : 's'} admin'd by wallet`);
  return { tokens, failedRanges };
}

/**
 * Discover all Clanker v4 tokens the wallet has any stake in.
 * Runs paths A and B in parallel, merges, dedupes.
 *
 * @param {string} walletAddress
 * @param {Object} [options]
 * @param {(msg: string) => void} [options.onLog]
 * @returns {Promise<{launches: Array, failedRanges: Array}>}
 */
export async function discoverLaunches(walletAddress, options = {}) {
  const onLog = options.onLog || (() => {});
  const provider = getProvider();

  const latestBlock = BigInt(await provider.getBlockNumber());
  const startBlock = CLANKER.v4.startBlock;

  onLog(`[v4] scanning ${startBlock} → ${latestBlock}`);

  // Run both scan paths in parallel — they hit different contracts so
  // they don't compete for the same provider slots.
  const [feeLockerResult, factoryResult] = await Promise.all([
    scanFeeLockerDeposits(walletAddress, startBlock, latestBlock, onLog),
    scanFactoryLaunches(walletAddress, startBlock, latestBlock, onLog),
  ]);

  // Merge both maps — preferring factory results for display fields
  // (since they include name/symbol from the launch event).
  const merged = new Map();
  for (const [key, val] of feeLockerResult.tokens) {
    merged.set(key, val);
  }
  for (const [key, val] of factoryResult.tokens) {
    const existing = merged.get(key);
    if (existing) {
      // Merge: keep factory name/symbol, mark as both admin AND recipient
      merged.set(key, {
        ...existing,
        name: val.name || existing.name,
        symbol: val.symbol || existing.symbol,
        source: 'admin+recipient',
      });
    } else {
      merged.set(key, val);
    }
  }

  onLog(`[v4] merged: ${merged.size} unique tokens (A=${feeLockerResult.tokens.size}, B=${factoryResult.tokens.size})`);

  const launches = [...merged.values()].map((t) => ({
    version: 'v4',
    tokenAddress: t.address,
    tokenAdmin: null,
    name: t.name || '',
    symbol: t.symbol || '',
    launchBlock: t.firstBlock || 0,
    txHash: t.firstTx || '',
    discoverySource: t.source, // 'recipient' | 'admin' | 'admin+recipient'
  }));

  // Sort newest-first.
  launches.sort((a, b) => b.launchBlock - a.launchBlock);

  return {
    launches,
    failedRanges: [...feeLockerResult.failedRanges, ...factoryResult.failedRanges],
  };
}

/**
 * Query FeeLocker for current claimable balances and ERC20 metadata
 * for every discovered token. One Multicall3 roundtrip.
 *
 * @param {string} walletAddress
 * @param {Array} launches
 * @returns {Promise<{items: Array, wethClaimable: bigint}>}
 */
export async function queryClaimables(walletAddress, launches) {
  if (launches.length === 0) return { items: [], wethClaimable: 0n };

  const calls = [
    // [0] WETH availableFees — shared across all tokens
    {
      target: CLANKER.v4.feeLocker,
      iface: feeLockerIface,
      method: 'availableFees',
      args: [walletAddress, CLANKER.weth],
    },
  ];
  for (const l of launches) {
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
    calls.push({
      target: l.tokenAddress,
      iface: erc20Iface,
      method: 'name',
      args: [],
    });
  }

  const results = await multicallRead(calls);

  const wethRes = results[0];
  const wethClaimable = wethRes?.success ? BigInt(wethRes.result) : 0n;

  const items = [];
  for (let i = 0; i < launches.length; i++) {
    const l = launches[i];
    const base = 1 + i * 4;
    const availRes = results[base];
    const symRes = results[base + 1];
    const decRes = results[base + 2];
    const nameRes = results[base + 3];

    const claimable = availRes?.success ? BigInt(availRes.result) : 0n;
    // Prefer the launch event's symbol/name if we have them, otherwise use
    // the ERC20 reads. Fall back to '???' for tokens that don't expose them.
    const symbol = (symRes?.success && symRes.result)
      ? String(symRes.result)
      : l.symbol || '???';
    const decimals = decRes?.success ? Number(decRes.result) : 18;
    const name = (nameRes?.success && nameRes.result)
      ? String(nameRes.result)
      : l.name || symbol;

    items.push({
      source: 'clanker',
      id: `v4:${l.tokenAddress.toLowerCase()}`,
      version: 'v4',
      name,
      symbol,
      tokenAddress: l.tokenAddress,
      claimable: claimable > 0n
        ? [{ token: l.tokenAddress, symbol, amount: claimable, decimals }]
        : [],
      meta: {
        launchBlock: l.launchBlock,
        txHash: l.txHash,
        discoverySource: l.discoverySource,
      },
    });
  }

  return { items, wethClaimable };
}
