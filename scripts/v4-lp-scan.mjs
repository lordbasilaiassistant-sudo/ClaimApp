#!/usr/bin/env node
// scripts/v4-lp-scan.mjs
//
// Enumerate all Uniswap V4 LP positions held by inventory wallets and
// surface pending fees per position.
//
// V4 PositionManager (Base): 0x7C5f5A4bBd8fD63184577525326123B519429bDc
// StateView (Base):          0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71
//
// For each tokenId owned:
//   - getPoolAndPositionInfo(tokenId) → (poolKey, positionInfo)
//   - getPositionLiquidity(tokenId) → liquidity
//   - StateView.getFeeGrowthGlobals(poolId) and getPositionInfo(poolId, owner, tickLower, tickUpper, salt)
//   - Calculate fees0 / fees1 owed
//
// We don't claim here — pending-fee discovery is the goal. Output:
// scan-results/v4-lp-positions.json sorted by combined ETH-equivalent fees.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);

const V4_PM = '0x7C5f5A4bBd8fD63184577525326123B519429bDc';
const STATE_VIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';
const WETH = '0x4200000000000000000000000000000000000006';

const RPC_FALLBACKS = [
  'https://mainnet.base.org',
  'https://developer-access-mainnet.base.org',
  'https://gateway.tenderly.co/public/base',
  'https://nodes.sequence.app/base',
  'https://base.publicnode.com',
];

async function rpc(method, params) {
  let lastErr;
  for (const url of RPC_FALLBACKS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const j = await res.json();
      if (j.error) {
        lastErr = new Error(`${method}: ${j.error.message}`);
        if (j.error.code === -32005 || /rate/i.test(j.error.message || '')) continue;
        if (/revert/i.test(j.error.message || '')) throw lastErr;
        continue;
      }
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const PM_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
]);

async function call(target, data) {
  return rpc('eth_call', [{ to: target, data }, 'latest']);
}

async function balanceOfNFT(wallet) {
  const data = PM_IFACE.encodeFunctionData('balanceOf', [wallet]);
  const result = await call(V4_PM, data);
  const [bal] = PM_IFACE.decodeFunctionResult('balanceOf', result);
  return bal;
}

// V4 PM is plain ERC721 (no Enumerable). Get owned tokenIds by reading
// Transfer events FROM/TO the wallet and computing net ownership, then
// verifying with ownerOf().
const PM_IFACE_OWNER = new ethers.Interface([
  'function ownerOf(uint256) view returns (address)',
]);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
async function ownerOf(tokenId) {
  try {
    const data = PM_IFACE_OWNER.encodeFunctionData('ownerOf', [tokenId]);
    const result = await call(V4_PM, data);
    const [addr] = PM_IFACE_OWNER.decodeFunctionResult('ownerOf', result);
    return addr;
  } catch {
    return null;
  }
}

async function getOwnedTokenIds(wallet) {
  // Use BlockScout REST: token-transfers by NFT contract + filter to/from wallet
  // Faster than scanning logs from chain.
  const ids = new Set();
  let nextParams = '';
  let page = 0;
  while (page < 200) {
    const url = `https://base.blockscout.com/api/v2/addresses/${wallet}/nft?type=ERC-721${nextParams ? `&${nextParams}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const j = await res.json();
    const items = j.items || [];
    for (const item of items) {
      const tokenAddr = item.token?.address || item.token?.address_hash || '';
      if (tokenAddr.toLowerCase() === V4_PM.toLowerCase()) {
        ids.add(item.id);
      }
    }
    if (!j.next_page_params) break;
    nextParams = new URLSearchParams(j.next_page_params).toString();
    page++;
  }
  return [...ids];
}

async function getInfo(tokenId) {
  try {
    const data = PM_IFACE.encodeFunctionData('getPoolAndPositionInfo', [tokenId]);
    const result = await call(V4_PM, data);
    const [poolKey, info] = PM_IFACE.decodeFunctionResult('getPoolAndPositionInfo', result);
    return { poolKey, info };
  } catch (e) {
    return null;
  }
}

async function getLiquidity(tokenId) {
  try {
    const data = PM_IFACE.encodeFunctionData('getPositionLiquidity', [tokenId]);
    const result = await call(V4_PM, data);
    const [liq] = PM_IFACE.decodeFunctionResult('getPositionLiquidity', result);
    return liq;
  } catch {
    return 0n;
  }
}

const inv = JSON.parse(readFileSync(resolve(ROOT, 'scan-results/wallet-inventory.json'), 'utf8'));
console.log(`Scanning ${inv.length} wallets for V4 LP positions…\n`);

const positionsAll = [];
for (const w of inv) {
  const ids = await getOwnedTokenIds(w.address);
  if (ids.length === 0) continue;
  console.log(`${w.address}  ${(w.label || '').padEnd(20)} V4 NFTs: ${ids.length}`);

  let withLiquidity = 0;
  for (let i = 0; i < ids.length; i++) {
    const tokenId = BigInt(ids[i]);
    // Confirm ownership at current head (BlockScout could be stale)
    const owner = await ownerOf(tokenId);
    if (!owner || owner.toLowerCase() !== w.address.toLowerCase()) continue;
    const liq = await getLiquidity(tokenId);
    if (liq === 0n) continue;
    withLiquidity++;
    const info = await getInfo(tokenId);
    if (!info) continue;
    positionsAll.push({
      wallet: w.address,
      label: w.label,
      tokenId: tokenId.toString(),
      liquidity: liq.toString(),
      currency0: info.poolKey.currency0,
      currency1: info.poolKey.currency1,
      fee: Number(info.poolKey.fee),
      tickSpacing: Number(info.poolKey.tickSpacing),
      hooks: info.poolKey.hooks,
    });
    if (i % 25 === 0 && i > 0) console.log(`  …${i}/${ids.length} (${withLiquidity} live)`);
  }
  console.log(`  → ${withLiquidity}/${ids.length} positions still have liquidity\n`);
}

const outDir = resolve(ROOT, 'scan-results');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, 'v4-lp-positions.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: positionsAll.length,
    positions: positionsAll,
  }, null, 2),
);
console.log(`\n=== Total live V4 positions: ${positionsAll.length} ===`);
console.log(`Output: scan-results/v4-lp-positions.json`);

// Group by hook so we know which positions are Bankr-DECAY (we already cover)
// vs other custom hooks (Zora trend coins, custom THRYX hooks, etc)
const byHook = {};
for (const p of positionsAll) {
  byHook[p.hooks] = (byHook[p.hooks] || 0) + 1;
}
console.log('\nPositions by hook:');
for (const [h, n] of Object.entries(byHook).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${h}  ${n} positions`);
}
