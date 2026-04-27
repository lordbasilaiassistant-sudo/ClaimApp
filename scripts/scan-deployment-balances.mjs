#!/usr/bin/env node
// scripts/scan-deployment-balances.mjs
//
// For every contract deployed by every wallet (435 total across the
// inventory), check its native ETH and WETH balance — regardless of
// verification status. Many of these contracts are unverified and don't
// expose ABIs to BlockScout, so the targeted scan-deployments.mjs misses
// them. eth_getBalance works regardless.
//
// Output: scan-results/contract-balances.json with the full sorted list
// of any deployed contract holding > 0 ETH/WETH.
//
// Usage:  node scripts/scan-deployment-balances.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
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

const WETH_BASE = '0x4200000000000000000000000000000000000006';
const weth = new ethers.Contract(
  WETH_BASE,
  ['function balanceOf(address) view returns (uint256)'],
  provider,
);

const discoveryDir = resolve(ROOT, 'scan-results/discovery');
if (!existsSync(discoveryDir)) {
  console.error('Run scripts/discover.mjs first.');
  process.exit(1);
}

const inventory = JSON.parse(readFileSync(resolve(ROOT, 'scan-results/wallet-inventory.json'), 'utf8'));
const labelLookup = Object.fromEntries(inventory.map((w) => [w.address.toLowerCase(), w.label]));

// Gather every deployment from every wallet's discovery file.
const deployments = [];
for (const file of readdirSync(discoveryDir)) {
  if (!file.endsWith('.json') || file === '_summary.json') continue;
  const data = JSON.parse(readFileSync(resolve(discoveryDir, file), 'utf8'));
  for (const d of (data.deployments || [])) {
    deployments.push({
      contract: d.address,
      deployer: data.address,
      deployerLabel: labelLookup[data.address.toLowerCase()] || '',
      blockNumber: d.blockNumber,
    });
  }
}
console.log(`Scanning ${deployments.length} deployed contracts for ETH+WETH balance…\n`);

const PARALLELISM = 6;
const enriched = new Array(deployments.length);
let i = 0;
async function worker() {
  while (true) {
    const idx = i++;
    if (idx >= deployments.length) return;
    const d = deployments[idx];
    if (idx > 0 && idx % 50 === 0) console.log(`  …${idx}/${deployments.length}`);
    try {
      const [ethBal, wbal] = await Promise.all([
        provider.getBalance(d.contract),
        weth.balanceOf(d.contract),
      ]);
      enriched[idx] = {
        ...d,
        ethBalance: ethBal.toString(),
        wethBalance: wbal.toString(),
        ethFormatted: ethers.formatEther(ethBal),
        wethFormatted: ethers.formatEther(wbal),
      };
    } catch (e) {
      enriched[idx] = { ...d, error: e.message };
    }
  }
}
await Promise.all(Array.from({ length: PARALLELISM }, worker));

const withBalance = enriched.filter((c) => {
  const e = BigInt(c.ethBalance || '0');
  const w = BigInt(c.wethBalance || '0');
  return e + w > 0n;
});

withBalance.sort((a, b) => {
  const va = BigInt(a.ethBalance) + BigInt(a.wethBalance);
  const vb = BigInt(b.ethBalance) + BigInt(b.wethBalance);
  return vb > va ? 1 : -1;
});

let totalEth = 0n;
let totalWeth = 0n;
for (const c of withBalance) {
  totalEth += BigInt(c.ethBalance);
  totalWeth += BigInt(c.wethBalance);
}

console.log(`\n=== Contracts with non-zero balance: ${withBalance.length} of ${deployments.length} ===`);
for (const c of withBalance.slice(0, 30)) {
  console.log(
    `  ${c.contract}  ` +
    `eth=${parseFloat(c.ethFormatted).toFixed(8)} weth=${parseFloat(c.wethFormatted).toFixed(8)}  ` +
    `deployer=${c.deployerLabel || c.deployer.slice(0, 8)}`
  );
}
console.log(`\n  TOTAL: ${ethers.formatEther(totalEth)} ETH + ${ethers.formatEther(totalWeth)} WETH`);
console.log(`         = ${ethers.formatEther(totalEth + totalWeth)} ETH-equivalent`);

const outDir = resolve(ROOT, 'scan-results');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, 'contract-balances.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDeploymentsScanned: deployments.length,
    withBalanceCount: withBalance.length,
    totals: {
      ethWei: totalEth.toString(),
      wethWei: totalWeth.toString(),
      ethFormatted: ethers.formatEther(totalEth),
      wethFormatted: ethers.formatEther(totalWeth),
    },
    contractsWithBalance: withBalance,
  }, null, 2),
);
console.log(`\n  → scan-results/contract-balances.json`);
