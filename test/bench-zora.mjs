#!/usr/bin/env node
// test/bench-zora.mjs
// Probe ZORA ProtocolRewards balance across every wallet in the inventory
// (or against a specific address). One Multicall3 call per wallet —
// cheap and definitive. Tells us instantly whether any wallet has unclaimed
// Zora creator rewards before we invest in building a full source module.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => null, setItem: () => {}, removeItem: () => {},
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);
const { getProvider } = await import(`file://${ROOT}/src/services/provider.js`);

const ZORA_PROTOCOL_REWARDS = '0x7777777f279eba3d3ad8f4e708545291a6fdba8b';
const ABI = ['function balanceOf(address account) view returns (uint256)'];

const cliArg = process.argv[2];
let targets;
if (cliArg && cliArg.startsWith('0x') && cliArg.length === 42) {
  targets = [{ address: cliArg, label: '' }];
} else {
  const invPath = resolve(ROOT, 'scan-results/wallet-inventory.json');
  if (!existsSync(invPath)) {
    console.error('No inventory. Run scripts/wallet-inventory.mjs first.');
    process.exit(1);
  }
  targets = JSON.parse(readFileSync(invPath, 'utf8'));
}

const provider = getProvider();
const zora = new ethers.Contract(ZORA_PROTOCOL_REWARDS, ABI, provider);

console.log(`ZORA ProtocolRewards (${ZORA_PROTOCOL_REWARDS}) balances:\n`);
let total = 0n;
for (const t of targets) {
  const bal = await zora.balanceOf(t.address);
  total += bal;
  const fmt = bal === 0n ? '0' : ethers.formatEther(bal);
  console.log(`  ${t.address}  ${t.label.padEnd(20)} ${fmt} ETH`);
}
console.log(`\n  total across ${targets.length} wallet(s): ${ethers.formatEther(total)} ETH`);
