#!/usr/bin/env node
// Smoke test the Bankr source module against the known Bankr creator wallet
// from BankrRewards/scan-and-claim.js.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = { getItem: (k) => _store.get(k) || null, setItem: (k, v) => _store.set(k, String(v)), removeItem: (k) => _store.delete(k) };
}
if (typeof globalThis.window === 'undefined') globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const bankr = (await import(`file://${ROOT}/src/sources/bankr/index.js`)).default;
const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);

const TARGET = process.argv[2] || '0x8f9ec800972258e48d7ebc2640ea0b5e245c2cf5';

console.log(`Bankr smoke test — scanning ${TARGET}`);
console.log('');

const t0 = Date.now();
const onLog = (msg) => process.stdout.write(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
const result = await bankr.scan(TARGET, { onLog });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log('');
console.log(`Scan complete in ${elapsed}s`);
console.log(`  items:        ${result.items.length}`);
console.log(`  failedRanges: ${result.failedRanges.length}`);
console.log(`  complete:     ${result.complete}`);
if (result.error) console.log(`  error:        ${result.error}`);

const withPending = result.items.filter((i) => (i.claimable || []).length > 0);
console.log(`  with pending fees: ${withPending.length}`);
console.log('');

for (const item of result.items.slice(0, 10)) {
  const claim = item.claimable.length > 0
    ? item.claimable.map((c) => `${ethers.formatUnits(c.amount, c.decimals)} ${c.symbol}`).join(' + ')
    : 'none pending';
  console.log(`  ${item.symbol.padEnd(12)} ${item.tokenAddress}  ${claim}`);
}
if (result.items.length > 10) console.log(`  … and ${result.items.length - 10} more`);
