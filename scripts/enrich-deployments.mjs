#!/usr/bin/env node
// scripts/enrich-deployments.mjs
//
// Walks scan-results/deployment-scans/<addr>.json and enriches each
// claim-shaped contract with:
//   - on-chain name() via the verified ABI when present
//   - native ETH balance (eth_getBalance)
//   - WETH balance (token balanceOf) for quick THRYX-stack inspection
//   - the contract's reported name from BlockScout metadata
//
// This turns "list of contracts with claim-shaped functions" into
// "list of contracts with their current ETH/WETH value parked in them" —
// which is what you actually need to decide where money sits.
//
// Usage:
//   node scripts/enrich-deployments.mjs                   # all wallets
//   node scripts/enrich-deployments.mjs 0x<addr>          # one wallet

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
const { getProvider } = await import(`file://${ROOT}/src/services/provider.js`);
const provider = getProvider();

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function name() view returns (string)', 'function symbol() view returns (string)'];
const weth = new ethers.Contract(WETH_BASE, ERC20, provider);

async function fetchContractMeta(addr) {
  try {
    const res = await fetch(`${BLOCKSCOUT}/smart-contracts/${addr}`);
    if (!res.ok) return null;
    const j = await res.json();
    return { name: j.name || null, isVerified: !!j.is_verified };
  } catch {
    return null;
  }
}

async function readContractName(addr) {
  try {
    const c = new ethers.Contract(addr, ERC20, provider);
    return await c.name();
  } catch {
    return null;
  }
}

async function enrichWallet(walletAddr) {
  const path = resolve(ROOT, `scan-results/deployment-scans/${walletAddr.toLowerCase()}.json`);
  if (!existsSync(path)) {
    console.log(`  no deployment-scan for ${walletAddr} — skip`);
    return null;
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const claims = data.claimables || [];
  console.log(`\n=== ${walletAddr} ===`);
  console.log(`  ${claims.length} claim-shaped contracts to enrich`);

  const enriched = [];
  let totalEth = 0n;
  let totalWeth = 0n;

  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    if (i > 0 && i % 10 === 0) console.log(`  …${i}/${claims.length}`);
    const [meta, ethBal, wethBal] = await Promise.all([
      fetchContractMeta(c.contract),
      provider.getBalance(c.contract).catch(() => 0n),
      weth.balanceOf(c.contract).catch(() => 0n),
    ]);
    let onChainName = meta?.name;
    if (!onChainName) onChainName = await readContractName(c.contract);
    totalEth += ethBal;
    totalWeth += wethBal;
    enriched.push({
      contract: c.contract,
      name: onChainName,
      ethBalance: ethBal.toString(),
      ethBalanceFormatted: ethers.formatEther(ethBal),
      wethBalance: wethBal.toString(),
      wethBalanceFormatted: ethers.formatEther(wethBal),
      claimFunctions: c.claimFunctions.map((f) => f.name),
      pendingChecks: c.pendingChecks,
    });
  }

  enriched.sort((a, b) => {
    const va = BigInt(a.ethBalance) + BigInt(a.wethBalance);
    const vb = BigInt(b.ethBalance) + BigInt(b.wethBalance);
    return vb > va ? 1 : -1;
  });

  console.log(`\n  Top-value contracts:`);
  let shown = 0;
  for (const c of enriched) {
    const eth = Number(c.ethBalanceFormatted);
    const wEth = Number(c.wethBalanceFormatted);
    if (eth === 0 && wEth === 0) continue;
    if (shown >= 10) break;
    const fns = c.claimFunctions.slice(0, 3).join(', ') || '(view-only)';
    console.log(`    ${c.contract}  ${(c.name || '?').slice(0, 24).padEnd(24)} ETH=${eth.toFixed(6)}  WETH=${wEth.toFixed(6)}  fns: ${fns}`);
    shown++;
  }

  console.log(`\n  TOTAL across ${enriched.length} claim-shaped contracts:`);
  console.log(`    ETH:  ${ethers.formatEther(totalEth)}`);
  console.log(`    WETH: ${ethers.formatEther(totalWeth)}`);

  data.enrichedAt = new Date().toISOString();
  data.totals = {
    ethTotalWei: totalEth.toString(),
    ethTotalFormatted: ethers.formatEther(totalEth),
    wethTotalWei: totalWeth.toString(),
    wethTotalFormatted: ethers.formatEther(totalWeth),
  };
  data.claimables = enriched;
  writeFileSync(path, JSON.stringify(data, null, 2));
  return data.totals;
}

const cliArg = process.argv[2];
let targets;
if (cliArg && cliArg.startsWith('0x') && cliArg.length === 42) {
  targets = [cliArg];
} else {
  const dir = resolve(ROOT, 'scan-results/deployment-scans');
  if (!existsSync(dir)) {
    console.error('No deployment-scans dir. Run scripts/scan-deployments.mjs first.');
    process.exit(1);
  }
  targets = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== '_summary.json')
    .map((f) => f.replace('.json', ''));
}

let grandEth = 0n;
let grandWeth = 0n;
for (const addr of targets) {
  const t = await enrichWallet(addr);
  if (t) {
    grandEth += BigInt(t.ethTotalWei);
    grandWeth += BigInt(t.wethTotalWei);
  }
}

console.log(`\n=== GRAND TOTAL across all wallets ===`);
console.log(`  ETH parked in claim-shaped contracts:  ${ethers.formatEther(grandEth)}`);
console.log(`  WETH parked in claim-shaped contracts: ${ethers.formatEther(grandWeth)}`);
