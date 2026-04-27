#!/usr/bin/env node
// scripts/wallet-balances.mjs
// Quick native ETH + WETH balance probe across every wallet in the inventory.
// Used to confirm the "starting state" before running grab-all consolidation.

import { readFileSync } from 'node:fs';
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

const inv = JSON.parse(readFileSync(resolve(ROOT, 'scan-results/wallet-inventory.json'), 'utf8'));

let totalEth = 0n;
let totalWeth = 0n;
console.log('Per-wallet native ETH + WETH balances:\n');
for (const w of inv) {
  const [eth, wbal] = await Promise.all([
    provider.getBalance(w.address),
    weth.balanceOf(w.address),
  ]);
  totalEth += eth;
  totalWeth += wbal;
  const label = (w.label || '').padEnd(20);
  console.log(`  ${w.address}  ${label} ETH=${ethers.formatEther(eth)}  WETH=${ethers.formatEther(wbal)}`);
}
console.log('\n---');
console.log(`TOTAL native ETH:  ${ethers.formatEther(totalEth)}`);
console.log(`TOTAL WETH:        ${ethers.formatEther(totalWeth)}`);
console.log(`TOTAL combined:    ${ethers.formatEther(totalEth + totalWeth)} ETH-equivalent`);
