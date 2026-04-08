#!/usr/bin/env node
// test/ping-router.mjs
// Quick smoke test for the RPC router: get blockNumber, chainId, and one
// known contract read. Runs in ~3s if healthy.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);
const { getProvider, getRpcStats } = await import(`file://${ROOT}/src/services/provider.js`);
const { CLANKER } = await import(`file://${ROOT}/src/sources/clanker/config.js`);
const { FEE_LOCKER_ABI } = await import(`file://${ROOT}/src/sources/clanker/abis.js`);

console.log('=== Router ping test ===');

const provider = getProvider();

const t0 = Date.now();
const blockNum = await provider.getBlockNumber();
console.log(`  blockNumber:  ${blockNum}  (${Date.now() - t0}ms)`);

const t1 = Date.now();
const net = await provider.getNetwork();
console.log(`  chainId:      ${net.chainId}  (${Date.now() - t1}ms)`);

// Read the treasury's WETH claimable from FeeLocker
const treasury = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';
const feeLocker = new ethers.Contract(CLANKER.v4.feeLocker, FEE_LOCKER_ABI, provider);

const t2 = Date.now();
const wethAvail = await feeLocker.availableFees(treasury, CLANKER.weth);
console.log(`  WETH available: ${ethers.formatEther(wethAvail)} WETH  (${Date.now() - t2}ms)`);

console.log('');
console.log('=== Router stats ===');
const stats = getRpcStats();
console.log(`  total: ${stats.total}  success: ${stats.success}  errors: ${stats.errors}  retries: ${stats.retries}  rateLimits: ${stats.rateLimits}`);
console.log('  providers:');
for (const p of stats.providers) {
  if (p.success > 0 || p.errors > 0) {
    console.log(`    ${p.name.padEnd(20)} ${p.success} ok, ${p.errors} err, ${p.latency}ms avg`);
  }
}

console.log('');
console.log('Ping test OK.');
