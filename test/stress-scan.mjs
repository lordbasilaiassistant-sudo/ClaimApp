#!/usr/bin/env node
// Stress-test scan determinism: run N scans back-to-back and report any drift.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = { getItem: (k) => _store.get(k) || null, setItem: (k, v) => _store.set(k, String(v)), removeItem: (k) => _store.delete(k) };
}
if (typeof globalThis.window === 'undefined') globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);
const clanker = (await import(`file://${ROOT}/src/sources/clanker/index.js`)).default;

const target = process.argv[2]
  || (process.env.THRYXTREASURY_PRIVATE_KEY ? new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY).address : '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334');
const N = parseInt(process.argv[3] || '10', 10);

console.log(`Stress test: ${N} scans of ${target}`);
console.log('');

const runs = [];
for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  const r = await clanker.scan(target);
  const ms = Date.now() - t0;
  const addrs = new Set(r.items.map((x) => x.tokenAddress.toLowerCase()));
  runs.push({ count: r.items.length, addrs, ms, complete: r.complete, failed: r.failedRanges?.length || 0 });
  const flag = r.complete ? ' ' : '⚠';
  console.log(`  run ${String(i).padStart(2)}: ${flag} ${r.items.length} launches  ${ms}ms  ${r.failedRanges?.length || 0} failed chunks`);
}

// Compare
const allAddrs = new Set();
for (const r of runs) for (const a of r.addrs) allAddrs.add(a);

console.log('');
console.log(`  union: ${allAddrs.size} unique launches across all runs`);

const drift = [];
for (const a of allAddrs) {
  const present = runs.map((r, i) => (r.addrs.has(a) ? i + 1 : null)).filter((x) => x !== null);
  if (present.length < runs.length) {
    drift.push({ addr: a, present });
  }
}

if (drift.length === 0) {
  console.log('  ✓ all runs returned identical launch sets — DETERMINISTIC');
  process.exit(0);
} else {
  console.log(`  ✗ ${drift.length} launches inconsistent across runs:`);
  for (const d of drift.slice(0, 20)) {
    console.log(`    ${d.addr}  present in runs: ${d.present.join(',')}`);
  }
  if (drift.length > 20) console.log(`    ... and ${drift.length - 20} more`);
  process.exit(1);
}
