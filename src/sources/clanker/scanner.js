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
  CLANKER_V3_FACTORY_ABI,
} from './abis.js';

const feeLockerIface = new ethers.Interface(FEE_LOCKER_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const v4FactoryIface = new ethers.Interface(CLANKER_V4_FACTORY_ABI);
const v3FactoryIface = new ethers.Interface(CLANKER_V3_FACTORY_ABI);

// Cached topic hashes for event filters.
const STORE_TOKENS_TOPIC = feeLockerIface.getEvent('StoreTokens').topicHash;
const TOKEN_CREATED_TOPIC = v4FactoryIface.getEvent('TokenCreated').topicHash;
const V3_TOKEN_CREATED_TOPIC = v3FactoryIface.getEvent('TokenCreated').topicHash;

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
 * Path C — scan legacy v2/v3/v3_1 factories for TokenCreated events.
 * Legacy versions use `factory.claimRewards(token)` to withdraw fees —
 * no FeeLocker, so we can't scan for StoreTokens. Discovery is via the
 * TokenCreated event filtered by creatorAdmin (topic[2] in the v3 event).
 *
 * Returns one map entry per (version, token) pair so the UI can dispatch
 * claims to the correct factory.
 */
async function scanLegacyFactory(version, walletAddress, fromBlock, toBlock, onLog) {
  const cfg = CLANKER[version];
  if (!cfg || !cfg.factory) return { tokens: new Map(), failedRanges: [] };

  const paddedAdmin = ethers.zeroPadValue(ethers.getAddress(walletAddress), 32);
  // v3 / v3_1 / v2 event: topic[1]=tokenAddress, topic[2]=creatorAdmin, topic[3]=interfaceAdmin
  const filter = {
    address: cfg.factory,
    topics: [V3_TOKEN_CREATED_TOPIC, null, paddedAdmin, null],
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
  };

  onLog?.(`  [legacy ${version}] scanning ${cfg.factory} (creatorAdmin=wallet)…`);
  const { logs, failedRanges } = await fetchLogs(filter, onLog);

  const tokens = new Map();
  for (const raw of logs) {
    try {
      const parsed = v3FactoryIface.parseLog({ topics: raw.topics, data: raw.data });
      if (!parsed || parsed.name !== 'TokenCreated') continue;
      const tokenAddr = parsed.args.tokenAddress;
      const key = `${version}:${tokenAddr.toLowerCase()}`;
      if (tokens.has(key)) continue;
      tokens.set(key, {
        address: tokenAddr,
        firstBlock: parseInt(raw.blockNumber, 16),
        firstTx: raw.transactionHash,
        source: 'legacy-admin',
        version,
        factoryAddress: cfg.factory,
        name: parsed.args.name || '',
        symbol: parsed.args.symbol || '',
      });
    } catch {
      /* skip */
    }
  }
  onLog?.(`  [legacy ${version}] found ${tokens.size} token${tokens.size === 1 ? '' : 's'}`);
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
 * Discover all Clanker tokens the wallet has any stake in.
 * Runs each scan path sequentially to respect tenderly rate limits.
 *
 * Legacy v3/v3_1 scanning is OFF by default because it adds ~230 extra
 * chunks per scan (v3 factory has been around since block 14M). Most
 * users only have v4 launches — the legacy scan is dead weight for them.
 * Opt in via `options.includeLegacy = true` or wire a "Deep scan" toggle
 * in the UI.
 *
 * @param {string} walletAddress
 * @param {Object} [options]
 * @param {boolean} [options.includeLegacy=false] — scan v3_1/v3 factories too
 * @param {(msg: string) => void} [options.onLog]
 * @returns {Promise<{launches: Array, failedRanges: Array}>}
 */
export async function discoverLaunches(walletAddress, options = {}) {
  const onLog = options.onLog || (() => {});
  const includeLegacy = options.includeLegacy === true;
  const provider = getProvider();

  const latestBlock = BigInt(await provider.getBlockNumber());
  const v4StartBlock = CLANKER.v4.startBlock;

  onLog(`[v4] scanning ${v4StartBlock} → ${latestBlock}`);

  // ===== v4 paths (sequential to avoid tenderly rate-limit spike) =====
  const feeLockerResult = await scanFeeLockerDeposits(walletAddress, v4StartBlock, latestBlock, onLog);
  const factoryResult = await scanFactoryLaunches(walletAddress, v4StartBlock, latestBlock, onLog);

  // Merge v4 results — preferring factory for display fields
  const v4Merged = new Map();
  for (const [key, val] of feeLockerResult.tokens) {
    v4Merged.set(key, { ...val, version: 'v4' });
  }
  for (const [key, val] of factoryResult.tokens) {
    const existing = v4Merged.get(key);
    if (existing) {
      v4Merged.set(key, {
        ...existing,
        name: val.name || existing.name,
        symbol: val.symbol || existing.symbol,
        source: 'admin+recipient',
      });
    } else {
      v4Merged.set(key, { ...val, version: 'v4' });
    }
  }
  onLog(`[v4] merged: ${v4Merged.size} unique tokens (A=${feeLockerResult.tokens.size}, B=${factoryResult.tokens.size})`);

  // ===== Legacy paths (v3_1, v3) =====
  // Run serially after v4 to keep load manageable on the single large-range provider.
  const legacyResults = { tokens: new Map(), failedRanges: [] };
  if (includeLegacy) {
    for (const version of ['v3_1', 'v3']) {
      const cfg = CLANKER[version];
      if (!cfg || !cfg.factory) continue;
      const result = await scanLegacyFactory(version, walletAddress, cfg.startBlock, latestBlock, onLog);
      for (const [key, val] of result.tokens) {
        legacyResults.tokens.set(key, val);
      }
      legacyResults.failedRanges.push(...result.failedRanges);
    }
  }

  // ===== Combine v4 + legacy into a single launches array =====
  const launches = [];
  for (const t of v4Merged.values()) {
    launches.push({
      version: 'v4',
      tokenAddress: t.address,
      tokenAdmin: null,
      name: t.name || '',
      symbol: t.symbol || '',
      launchBlock: t.firstBlock || 0,
      txHash: t.firstTx || '',
      discoverySource: t.source,
      factoryAddress: CLANKER.v4.factory,
    });
  }
  for (const t of legacyResults.tokens.values()) {
    launches.push({
      version: t.version,
      tokenAddress: t.address,
      tokenAdmin: null,
      name: t.name || '',
      symbol: t.symbol || '',
      launchBlock: t.firstBlock || 0,
      txHash: t.firstTx || '',
      discoverySource: t.source,
      factoryAddress: t.factoryAddress,
    });
  }

  // Sort newest-first.
  launches.sort((a, b) => b.launchBlock - a.launchBlock);

  return {
    launches,
    failedRanges: [
      ...feeLockerResult.failedRanges,
      ...factoryResult.failedRanges,
      ...legacyResults.failedRanges,
    ],
  };
}

/**
 * Query FeeLocker for v4 claimable balances + ERC20 metadata for every
 * discovered token (v4 and legacy). Legacy tokens use a placeholder
 * "unknown" claimable since there's no view function on the legacy
 * factory — users have to call claimRewards to find out.
 *
 * @param {string} walletAddress
 * @param {Array} launches
 * @returns {Promise<{items: Array, wethClaimable: bigint}>}
 */
export async function queryClaimables(walletAddress, launches) {
  if (launches.length === 0) return { items: [], wethClaimable: 0n };

  // Split v4 from legacy — we only query FeeLocker for v4.
  const v4Launches = launches.filter((l) => l.version === 'v4');
  const legacyLaunches = launches.filter((l) => l.version !== 'v4');

  // Build multicall: WETH for v4 + per-token availableFees for v4 + per-token
  // ERC20 metadata (symbol/decimals/name) for ALL tokens (v4 and legacy).
  const calls = [
    {
      target: CLANKER.v4.feeLocker,
      iface: feeLockerIface,
      method: 'availableFees',
      args: [walletAddress, CLANKER.weth],
    },
  ];
  // v4 gets 4 calls per token: availableFees + symbol + decimals + name
  for (const l of v4Launches) {
    calls.push({ target: CLANKER.v4.feeLocker, iface: feeLockerIface, method: 'availableFees', args: [walletAddress, l.tokenAddress] });
    calls.push({ target: l.tokenAddress, iface: erc20Iface, method: 'symbol', args: [] });
    calls.push({ target: l.tokenAddress, iface: erc20Iface, method: 'decimals', args: [] });
    calls.push({ target: l.tokenAddress, iface: erc20Iface, method: 'name', args: [] });
  }
  // Legacy gets 3 calls per token: symbol + decimals + name (no fee balance)
  for (const l of legacyLaunches) {
    calls.push({ target: l.tokenAddress, iface: erc20Iface, method: 'symbol', args: [] });
    calls.push({ target: l.tokenAddress, iface: erc20Iface, method: 'decimals', args: [] });
    calls.push({ target: l.tokenAddress, iface: erc20Iface, method: 'name', args: [] });
  }

  const results = await multicallRead(calls);

  const wethRes = results[0];
  const wethClaimable = wethRes?.success ? BigInt(wethRes.result) : 0n;

  // Soft length caps on token metadata — a malicious ERC20 contract could
  // return arbitrary-length strings from name/symbol. createTextNode is
  // XSS-safe but an absurdly long symbol would break row layout.
  const capStr = (s, max) => {
    const str = String(s || '').replace(/[\x00-\x1F\x7F]/g, '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  };

  const items = [];
  let resultIdx = 1;

  // v4 items (4 results each)
  for (const l of v4Launches) {
    const availRes = results[resultIdx++];
    const symRes = results[resultIdx++];
    const decRes = results[resultIdx++];
    const nameRes = results[resultIdx++];
    const claimable = availRes?.success ? BigInt(availRes.result) : 0n;
    const symbol = capStr((symRes?.success && symRes.result) || l.symbol || '???', 16) || '???';
    const decimals = decRes?.success ? Math.min(Number(decRes.result) || 18, 36) : 18;
    const name = capStr((nameRes?.success && nameRes.result) || l.name || symbol, 64);

    items.push({
      source: 'clanker',
      id: `v4:${l.tokenAddress.toLowerCase()}`,
      version: 'v4',
      name,
      symbol,
      tokenAddress: l.tokenAddress,
      claimable: claimable > 0n ? [{ token: l.tokenAddress, symbol, amount: claimable, decimals }] : [],
      meta: {
        launchBlock: l.launchBlock,
        txHash: l.txHash,
        discoverySource: l.discoverySource,
        factoryAddress: l.factoryAddress,
      },
    });
  }

  // Legacy items (3 results each, no claimable balance read)
  for (const l of legacyLaunches) {
    const symRes = results[resultIdx++];
    const decRes = results[resultIdx++];
    const nameRes = results[resultIdx++];
    const symbol = capStr((symRes?.success && symRes.result) || l.symbol || '???', 16) || '???';
    const decimals = decRes?.success ? Math.min(Number(decRes.result) || 18, 36) : 18;
    const name = capStr((nameRes?.success && nameRes.result) || l.name || symbol, 64);

    items.push({
      source: 'clanker',
      id: `${l.version}:${l.tokenAddress.toLowerCase()}`,
      version: l.version,
      name,
      symbol,
      tokenAddress: l.tokenAddress,
      // Legacy tokens have no view function for pending fees. Mark claimable
      // as 'unknown' so the UI can show a "Try Claim" button instead of a
      // balance. The actual claim will revert if nothing is available.
      claimable: [],
      legacyUnknownBalance: true,
      meta: {
        launchBlock: l.launchBlock,
        txHash: l.txHash,
        discoverySource: l.discoverySource,
        factoryAddress: l.factoryAddress,
      },
    });
  }

  return { items, wethClaimable };
}
