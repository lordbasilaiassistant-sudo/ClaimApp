#!/usr/bin/env node
// test/scan-treasury.mjs
//
// Live smoke test: runs the same scanner logic as the browser app against
// the THRYX treasury wallet to confirm we discover all Clanker launches and
// read the correct claimable balances.
//
// Usage:
//   node test/scan-treasury.mjs                   # scan default wallet
//   node test/scan-treasury.mjs 0x<addr>          # scan arbitrary wallet
//
// This file is Node-only (uses stdio + fs), not shipped to the browser.
// It imports the real src/ modules via a minimal browser shim below.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ===== Browser shim =====
// The src/ modules import from '../vendor/ethers.js' which is a browser ESM
// bundle. Node can import it directly because ethers v6 ships isomorphic ESM.
// We just need to mock sessionStorage + window for wallet.js.
if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

// Dynamic import so the shim is in place first.
const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);
const clanker = (await import(`file://${ROOT}/src/sources/clanker/index.js`)).default;
const { CLANKER } = await import(`file://${ROOT}/src/sources/clanker/config.js`);
const wallet = await import(`file://${ROOT}/src/services/wallet.js`);
const { formatAmount } = await import(`file://${ROOT}/src/utils/format.js`);

// ===== Target wallet =====
// 1. CLI arg takes precedence
// 2. THRYXTREASURY_PRIVATE_KEY env (derive address)
// 3. Fallback: known treasury address
const cliArg = process.argv[2];
let targetAddress;

if (cliArg && cliArg.startsWith('0x') && cliArg.length === 42) {
  targetAddress = ethers.getAddress(cliArg);
} else if (process.env.THRYXTREASURY_PRIVATE_KEY) {
  const w = new ethers.Wallet(process.env.THRYXTREASURY_PRIVATE_KEY);
  targetAddress = w.address;
  console.log('[info] Derived address from THRYXTREASURY_PRIVATE_KEY');
} else {
  // Anthony's deployer wallet from CLAUDE.md
  targetAddress = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';
  console.log('[info] No CLI arg or env var — using default treasury address');
}

wallet.setReadOnlyAddress(targetAddress);

console.log('');
console.log('=== ClaimApp smoke test ===');
console.log('  Target wallet:', targetAddress);
console.log('  Versions:', CLANKER.defaultScanVersions.join(', '));
console.log('');

// ===== Run the same scan the browser runs =====
const start = Date.now();
const onLog = (msg) => {
  const t = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`[+${t}s] ${msg}\n`);
};
const result = await clanker.scan(targetAddress, { onLog });
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`Scan complete in ${elapsed}s`);
if (result.error) {
  console.error('⚠ scan error:', result.error);
}
console.log('');

const v4Items = result.items.filter((i) => i.version === 'v4');
const legacyItems = result.items.filter((i) => i.version !== 'v4');

console.log(`Launches found: ${result.items.length} total`);
console.log(`  v4:     ${v4Items.length}`);
console.log(`  legacy: ${legacyItems.length}`);
console.log('');

console.log(`=== WETH aggregate claimable ===`);
console.log(`  ${formatAmount(result.wethClaimable, 18)} WETH`);
console.log('');

if (v4Items.length > 0) {
  console.log(`=== v4 launches ===`);
  for (const item of v4Items) {
    const claim = item.claimable[0];
    const claimStr = claim
      ? `${formatAmount(claim.amount, claim.decimals)} ${claim.symbol}`
      : '0';
    console.log(
      `  ${item.symbol.padEnd(8)} ${item.tokenAddress}  claim: ${claimStr}`,
    );
  }
  console.log('');
}

if (legacyItems.length > 0) {
  console.log(`=== Legacy launches (${legacyItems.length}) ===`);
  for (const item of legacyItems.slice(0, 20)) {
    console.log(`  ${item.version.padEnd(6)} ${item.symbol.padEnd(8)} ${item.tokenAddress}`);
  }
  if (legacyItems.length > 20) {
    console.log(`  … and ${legacyItems.length - 20} more`);
  }
  console.log('');
}

// ===== Cross-check against Agent0 registry if available =====
const agent0Registry = resolve(process.env.USERPROFILE || '', 'OneDrive/Desktop/Agent0/state/launched-tokens.json');
try {
  const raw = readFileSync(agent0Registry, 'utf8');
  const reg = JSON.parse(raw);
  // Walk the registry for any entries matching this wallet
  const matches = [];
  const walk = (obj, path = '') => {
    if (!obj) return;
    if (typeof obj === 'object') {
      if (obj.tokenAddress && typeof obj.tokenAddress === 'string' && obj.tokenAddress.startsWith('0x')) {
        matches.push({ ...obj, _path: path });
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    }
  };
  walk(reg);
  console.log(`[cross-check] Agent0 registry has ${matches.length} token entries total`);
} catch (e) {
  // Registry not present or unreadable — that's fine, it's optional.
}

console.log('');
console.log('Smoke test complete.');
