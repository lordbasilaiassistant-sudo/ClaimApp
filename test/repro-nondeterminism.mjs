#!/usr/bin/env node
// Reproduce non-determinism: scan the same wallet 5 times and compare results.
// Also separately probe merkle and tenderly with identical queries to see
// if they return different answers.

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
const { CLANKER } = await import(`file://${ROOT}/src/sources/clanker/config.js`);
const { CLANKER_V4_FACTORY_ABI } = await import(`file://${ROOT}/src/sources/clanker/abis.js`);

const TARGET = new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY).address;

console.log(`Target: ${TARGET}`);
console.log('');

// ===== Test 1: Run the full scan 5 times =====
console.log('=== Test 1: Full scan × 5 ===');
const runResults = [];
for (let i = 1; i <= 5; i++) {
  const t0 = Date.now();
  const r = await clanker.scan(TARGET);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const addrs = new Set(r.items.map((x) => x.tokenAddress.toLowerCase()));
  runResults.push(addrs);
  console.log(`  run ${i}: ${r.items.length} launches (${elapsed}s)`);
}

// Diff the runs
const allSeen = new Set();
for (const set of runResults) for (const a of set) allSeen.add(a);
console.log(`  union: ${allSeen.size} unique launches across all 5 runs`);
const dropped = [...allSeen].filter((a) => runResults.some((s) => !s.has(a)));
if (dropped.length > 0) {
  console.log(`  ⚠ ${dropped.length} launches missed in at least one run:`);
  for (const a of dropped) {
    const present = runResults.map((s, i) => (s.has(a) ? i + 1 : '-')).filter((x) => x !== '-').join(',');
    console.log(`    ${a}  (present in runs: ${present})`);
  }
} else {
  console.log('  ✓ all runs returned identical sets');
}

console.log('');

// ===== Test 2: Probe merkle and tenderly individually with same query =====
console.log('=== Test 2: Merkle vs Tenderly — do they return the same data? ===');

const iface = new ethers.Interface(CLANKER_V4_FACTORY_ABI);
const eventFragment = iface.getEvent('TokenCreated');
const topic0 = eventFragment.topicHash;
const paddedAdmin = ethers.zeroPadValue(ethers.getAddress(TARGET), 32);

const latestBlock = 44_436_000; // fixed so both providers query identical range
const fromBlock = Number(CLANKER.v4.startBlock);

const filterBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_getLogs',
  params: [{
    address: CLANKER.v4.factory,
    topics: [topic0, null, paddedAdmin],
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: '0x' + latestBlock.toString(16),
  }],
};

async function probe(url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filterBody),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, reason: json.error.message };
    return { ok: true, logs: json.result || [] };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Single-shot query across the entire v4 range — only providers that support
// large ranges will succeed. Both merkle and tenderly should.
console.log(`  range: ${fromBlock} → ${latestBlock} (${(latestBlock - fromBlock).toLocaleString()} blocks)`);
console.log('  This will probably fail — too large for a single call. Falling back to 200k chunks.');
console.log('');

// Instead: test a FIXED 200k chunk window and compare results between providers
const TEST_FROM = 43_000_000;
const TEST_TO = 43_199_999;
const testBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_getLogs',
  params: [{
    address: CLANKER.v4.factory,
    topics: [topic0, null, paddedAdmin],
    fromBlock: '0x' + TEST_FROM.toString(16),
    toBlock: '0x' + TEST_TO.toString(16),
  }],
};

async function probeFixed(url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testBody),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, reason: json.error.message };
    return { ok: true, logs: json.result || [] };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

console.log(`  fixed chunk: ${TEST_FROM} → ${TEST_TO}`);
const merkleRes = await probeFixed('https://base.merkle.io');
const tenderlyRes = await probeFixed('https://gateway.tenderly.co/public/base');

if (merkleRes.ok) {
  const txHashes = new Set(merkleRes.logs.map((l) => l.transactionHash));
  console.log(`    merkle:    ${merkleRes.logs.length} logs (${txHashes.size} unique txs)`);
} else {
  console.log(`    merkle:    FAIL — ${merkleRes.reason}`);
}
if (tenderlyRes.ok) {
  const txHashes = new Set(tenderlyRes.logs.map((l) => l.transactionHash));
  console.log(`    tenderly:  ${tenderlyRes.logs.length} logs (${txHashes.size} unique txs)`);
} else {
  console.log(`    tenderly:  FAIL — ${tenderlyRes.reason}`);
}

if (merkleRes.ok && tenderlyRes.ok) {
  const mSet = new Set(merkleRes.logs.map((l) => `${l.transactionHash}:${l.logIndex}`));
  const tSet = new Set(tenderlyRes.logs.map((l) => `${l.transactionHash}:${l.logIndex}`));
  const onlyMerkle = [...mSet].filter((x) => !tSet.has(x));
  const onlyTenderly = [...tSet].filter((x) => !mSet.has(x));
  if (onlyMerkle.length === 0 && onlyTenderly.length === 0) {
    console.log('    ✓ merkle and tenderly returned IDENTICAL log sets');
  } else {
    console.log(`    ⚠ DIVERGENCE:`);
    console.log(`       only in merkle:   ${onlyMerkle.length}`);
    console.log(`       only in tenderly: ${onlyTenderly.length}`);
  }
}
