#!/usr/bin/env node
// test/bench-balances.mjs
// Smoke test: getWalletBalances against treasury or any address.
//
// Usage:
//   node test/bench-balances.mjs                  # default treasury
//   node test/bench-balances.mjs 0x<addr>
//   node test/bench-balances.mjs 0x<addr> --no-price

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

const { getWalletBalances } = await import(`file://${ROOT}/src/services/balances/index.js`);

const cliArg = process.argv[2];
const address =
  cliArg && cliArg.startsWith('0x') && cliArg.length === 42
    ? cliArg
    : '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';
const priceTokens = !process.argv.includes('--no-price');

console.log(`Scanning balances for ${address} (priceTokens=${priceTokens})…`);

const start = Date.now();
const result = await getWalletBalances(address, {
  priceTokens,
  onLog: (msg) => console.log(`  [${((Date.now() - start) / 1000).toFixed(1)}s] ${msg}`),
});
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n=== Results (${elapsed}s) ===`);
console.log(`  ETH balance:        ${result.ethBalanceFormatted}`);
console.log(`  ERC-20 holdings:    ${result.tokenCount}`);
console.log(`  Priced & sellable:  ${result.sellableTokenCount}`);
console.log(`  Token value (ETH):  ${(Number(result.tokenValueWei) / 1e18).toFixed(6)}`);
console.log(`  TOTAL value (ETH):  ${result.totalValueFormatted}`);

if (priceTokens && result.tokens.length > 0) {
  console.log(`\n=== Top 15 holdings by sellable ETH value ===`);
  for (const t of result.tokens.slice(0, 15)) {
    const bal = (Number(t.balance) / 10 ** t.decimals).toLocaleString(undefined, { maximumFractionDigits: 6 });
    const val = (Number(t.valueWei) / 1e18).toFixed(8);
    const tag = t.priced ? '' : ' [unpriced]';
    console.log(`  ${t.symbol.padEnd(10)} ${bal.padStart(16)}  →  ${val} ETH${tag}`);
  }
}
