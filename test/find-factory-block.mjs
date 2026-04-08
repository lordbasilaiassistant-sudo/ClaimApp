#!/usr/bin/env node
// Find when the Clanker v4 factory was deployed by probing eth_getCode backwards.
// Binary search between blocks 20_000_000 and current.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = { getItem: (k) => _store.get(k) || null, setItem: (k, v) => _store.set(k, String(v)), removeItem: (k) => _store.delete(k) };
}
if (typeof globalThis.window === 'undefined') globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const { getProvider } = await import(`file://${ROOT}/src/services/provider.js`);
const { CLANKER } = await import(`file://${ROOT}/src/sources/clanker/config.js`);

const provider = getProvider();
const V4 = CLANKER.v4.factory;
const V3_1 = CLANKER.v3_1.factory;

async function hasCodeAt(addr, block) {
  const code = await provider.getCode(addr, block);
  return code && code !== '0x';
}

async function findDeployBlock(addr, low, high) {
  // Binary search for the first block where code exists at `addr`.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const has = await hasCodeAt(addr, mid);
      if (has) high = mid;
      else low = mid + 1;
    } catch (e) {
      // Some public RPCs reject very old blocks — step forward
      low = mid + 1;
    }
  }
  return low;
}

const latest = await provider.getBlockNumber();
console.log(`current block: ${latest}`);
console.log('');

// Sanity: does code exist at current block?
console.log(`v4 factory has code at latest: ${await hasCodeAt(V4, latest)}`);
console.log(`v3_1 factory has code at latest: ${await hasCodeAt(V3_1, latest)}`);
console.log('');

console.log('Searching v4 factory deploy block…');
const v4Deploy = await findDeployBlock(V4, 20_000_000, latest);
console.log(`  v4 factory deployed around block ${v4Deploy}`);

console.log('Searching v3_1 factory deploy block…');
const v31Deploy = await findDeployBlock(V3_1, 12_000_000, latest);
console.log(`  v3_1 factory deployed around block ${v31Deploy}`);
