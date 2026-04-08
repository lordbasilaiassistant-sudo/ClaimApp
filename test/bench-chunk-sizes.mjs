#!/usr/bin/env node
// Test how large a block range each working provider can handle
// for filtered eth_getLogs. Binary search from 10k up to 500k.

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

const TOP_BLOCK = 44_400_000;
const FACTORY = CLANKER.v4.factory;
// TokenCreated event topic[0] so we actually filter by a real event
const TOKEN_CREATED_TOPIC = '0x9299d1d1a88d71ba1b2ba4aaf8b41e4ef2a3b5e4f0c4ebf34e2b56f7fa89d4a9';
// ^ placeholder — ethers-encoded in real scanner. For bench we use address filter only.

const SIZES = [9_999, 49_999, 99_999, 199_999, 499_999, 999_999];

async function call(url, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, latency: Date.now() - start };
    const json = await res.json();
    if (json.error) return { ok: false, reason: json.error.message, latency: Date.now() - start };
    const logCount = Array.isArray(json.result) ? json.result.length : 0;
    return { ok: true, latency: Date.now() - start, logCount };
  } catch (e) {
    return { ok: false, reason: e.message, latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

for (const p of BASE_PROVIDERS) {
  console.log(`\n=== ${p.name} — ${p.url} ===`);
  for (const size of SIZES) {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{
        fromBlock: '0x' + (TOP_BLOCK - size).toString(16),
        toBlock: '0x' + TOP_BLOCK.toString(16),
        address: FACTORY,
      }],
    };
    const r = await call(p.url, body);
    if (r.ok) {
      console.log(`  ${String(size).padStart(8)} blocks  ✓ ${r.latency.toString().padStart(5)}ms  ${r.logCount} logs`);
    } else {
      console.log(`  ${String(size).padStart(8)} blocks  ✗ ${r.latency.toString().padStart(5)}ms  ${r.reason.slice(0, 80)}`);
    }
  }
}
