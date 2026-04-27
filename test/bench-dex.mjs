#!/usr/bin/env node
// test/bench-dex.mjs
// Smoke test for src/services/dex aggregator stack. Quotes a few token sizes
// against multiple DEX aggregators and reports best route + per-aggregator
// status.
//
// Usage:
//   node test/bench-dex.mjs                       # default: KENM 13021
//   node test/bench-dex.mjs <token> <amount>      # arbitrary token + raw amount

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { getBestQuote } = await import(`file://${ROOT}/src/services/dex/index.js`);

const KENM = '0x3E9fA140b52c9a9F5327e67EC8759B1f3D3B23c2';
const KENM_DECIMALS = 18n;

const tokenIn = process.argv[2] || KENM;
const humanAmount = process.argv[3] || '13021.287611';

const [whole, frac = ''] = humanAmount.split('.');
const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
const amount = BigInt(whole + fracPadded);

console.log(`Quoting ${humanAmount} of ${tokenIn} → ETH on Base mainnet…\n`);

const result = await getBestQuote({
  tokenIn,
  amount,
  taker: '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334',
});

if (result.bestQuote) {
  console.log(`=== Best quote: ${result.bestQuote.aggregator} ===`);
  console.log(`  amountOutEth: ${result.bestQuote.amountOutEth}`);
  if (result.bestQuote.amountOutUsd !== undefined) {
    console.log(`  amountOutUsd: $${result.bestQuote.amountOutUsd.toFixed(6)}`);
  }
  if (result.bestQuote.txRequest) {
    console.log(`  txRequest:    ready (router=${result.bestQuote.txRequest.to})`);
  }
} else {
  console.log('=== No aggregator returned a quote ===');
}

console.log('\n=== Per-aggregator ===');
for (const q of result.allQuotes) {
  console.log(`  ${q.aggregator.padEnd(10)}  ${q.amountOutEth} ETH${q.amountOutUsd ? `  $${q.amountOutUsd.toFixed(6)}` : ''}`);
}
for (const e of result.errors) {
  console.log(`  ${e.aggregator.padEnd(10)}  ERR: ${e.error}`);
}
