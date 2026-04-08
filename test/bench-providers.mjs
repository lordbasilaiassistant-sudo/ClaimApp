#!/usr/bin/env node
// test/bench-providers.mjs
// Benchmark each configured RPC provider with realistic workloads:
//   1. 3x eth_blockNumber (sanity + latency)
//   2. 3x eth_getLogs on a 9999-block window filtered by tokenAdmin
// Reports: success rate, avg latency, 429 count per provider.
//
// Use this output to trim dead/slow providers from rpc/providers.js.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = { getItem: (k) => _store.get(k) || null, setItem: (k, v) => _store.set(k, String(v)), removeItem: (k) => _store.delete(k) };
}
if (typeof globalThis.window === 'undefined') globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const { BASE_PROVIDERS } = await import(`file://${ROOT}/src/services/rpc/providers.js`);
const { CLANKER } = await import(`file://${ROOT}/src/sources/clanker/config.js`);

const TIMEOUT_MS = 8000;
const LOG_FROM = 44_400_000;
const LOG_TO = LOG_FROM + 9_999;

// Clanker v4 TokenCreated topic[0] (keccak256 of the event signature)
// We don't need an address filter — a real-world range query.
const CLANKER_V4_FACTORY = CLANKER.v4.factory;

async function call(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const status = res.status;
    if (status === 429) return { ok: false, reason: '429', latency: Date.now() - start, status };
    if (!res.ok) return { ok: false, reason: `HTTP ${status}`, latency: Date.now() - start, status };
    const json = await res.json();
    if (json.error) return { ok: false, reason: json.error.message || 'rpc error', latency: Date.now() - start, status };
    return { ok: true, latency: Date.now() - start, status };
  } catch (e) {
    return { ok: false, reason: e.message || 'network error', latency: Date.now() - start, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function benchProvider(p) {
  const trials = [];
  // Trial set: 3 blockNumber, 3 eth_getLogs
  const calls = [
    ...Array.from({ length: 3 }, () => ({ method: 'eth_blockNumber', params: [] })),
    ...Array.from({ length: 3 }, () => ({
      method: 'eth_getLogs',
      params: [{
        fromBlock: '0x' + LOG_FROM.toString(16),
        toBlock: '0x' + LOG_TO.toString(16),
        address: CLANKER_V4_FACTORY,
      }],
    })),
  ];

  for (const c of calls) {
    const body = { jsonrpc: '2.0', id: 1, method: c.method, params: c.params };
    const r = await call(p.url, body);
    trials.push({ method: c.method, ...r });
  }

  const ok = trials.filter((t) => t.ok);
  const rate429 = trials.filter((t) => t.reason === '429').length;
  const avgLatency = ok.length > 0
    ? Math.round(ok.reduce((s, t) => s + t.latency, 0) / ok.length)
    : Infinity;

  return {
    name: p.name,
    successRate: ok.length / trials.length,
    successes: ok.length,
    total: trials.length,
    avgLatency,
    rate429,
    sampleErrors: trials.filter((t) => !t.ok).map((t) => t.reason).slice(0, 2),
  };
}

console.log('=== Provider benchmark ===');
console.log(`Target: 3× eth_blockNumber + 3× eth_getLogs (9999 blocks filtered by ${CLANKER_V4_FACTORY})`);
console.log('');

const results = [];
for (const p of BASE_PROVIDERS) {
  process.stdout.write(`  ${p.name.padEnd(20)} `);
  const r = await benchProvider(p);
  results.push(r);
  const emoji = r.successRate === 1 ? '✓' : r.successRate >= 0.8 ? '~' : '✗';
  console.log(`${emoji} ${(r.successRate * 100).toFixed(0)}% (${r.successes}/${r.total})  ${r.avgLatency}ms  429s:${r.rate429}  ${r.sampleErrors.join(' | ')}`);
}

console.log('');
console.log('=== Summary (best → worst) ===');
results.sort((a, b) => {
  if (a.successRate !== b.successRate) return b.successRate - a.successRate;
  return a.avgLatency - b.avgLatency;
});
for (const r of results) {
  const verdict = r.successRate >= 0.9 ? 'KEEP' : r.successRate >= 0.5 ? 'WATCH' : 'DROP';
  console.log(`  [${verdict}] ${r.name.padEnd(20)} ${(r.successRate * 100).toFixed(0)}%  ${r.avgLatency}ms`);
}
