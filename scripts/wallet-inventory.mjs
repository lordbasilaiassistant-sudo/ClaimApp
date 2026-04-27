#!/usr/bin/env node
// scripts/wallet-inventory.mjs
//
// Build a local-only inventory of usable wallets from a JSON file you maintain
// outside this repo. Outputs to scan-results/wallet-inventory.json (gitignored).
// Never logs private keys.
//
// JSON shape expected (an array of these):
//   [{ "address": "0x...", "label": "main", "privateKey": "0x..." }, ...]
//
// Set the file path via the WALLETS_JSON env var, e.g.:
//   WALLETS_JSON=/path/to/your/wallets.json node scripts/wallet-inventory.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const WALLETS_PATH = process.env.WALLETS_JSON;
if (!WALLETS_PATH) {
  console.error('Set WALLETS_JSON=/path/to/wallets.json before running this script.');
  console.error('See file header for expected JSON shape.');
  process.exit(1);
}
if (!existsSync(WALLETS_PATH)) {
  console.error(`No wallets file at ${WALLETS_PATH}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(WALLETS_PATH, 'utf8'));
const inventory = [];
const seen = new Set();

for (const w of raw) {
  if (!w.privateKey || !w.address) continue;
  let addr;
  try {
    addr = ethers.getAddress(w.address);
  } catch {
    continue;
  }
  if (seen.has(addr.toLowerCase())) continue;
  seen.add(addr.toLowerCase());

  let derived;
  try {
    derived = new ethers.Wallet(w.privateKey).address;
  } catch (e) {
    console.warn(`  ${addr} bad private key: ${e.message}`);
    continue;
  }
  if (derived.toLowerCase() !== addr.toLowerCase()) {
    console.warn(`  ${addr} key mismatch (derived ${derived}) - skipping`);
    continue;
  }

  inventory.push({
    address: addr,
    label: w.label || '',
    keySource: 'WALLETS_JSON',
    canSign: true,
  });
}

const outDir = resolve(ROOT, 'scan-results');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'wallet-inventory.json');
writeFileSync(outPath, JSON.stringify(inventory, null, 2));

console.log('=== Wallet inventory ===');
for (const w of inventory) {
  console.log(`  ${w.address}  ${w.label}`);
}
console.log(`\n${inventory.length} wallets, written to ${outPath}`);
