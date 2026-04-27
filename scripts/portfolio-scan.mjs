#!/usr/bin/env node
// scripts/portfolio-scan.mjs
//
// PURE READ-ONLY: scans every wallet in scan-results/wallet-inventory.json
// across both source modules (Clanker v4 + Bankr) and writes a consolidated
// portfolio report to scan-results/portfolio.json.
//
// Never loads private keys. Only addresses go through.
//
// Usage:  node scripts/portfolio-scan.mjs [--legacy]

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

const wallet = await import(`file://${ROOT}/src/services/wallet.js`);
const { SOURCES } = await import(`file://${ROOT}/src/sources/index.js`);
const { formatAmount } = await import(`file://${ROOT}/src/utils/format.js`);

const includeLegacy = process.argv.includes('--legacy');

const invPath = resolve(ROOT, 'scan-results/wallet-inventory.json');
if (!existsSync(invPath)) {
  console.error('Run scripts/wallet-inventory.mjs first.');
  process.exit(1);
}
const inventory = JSON.parse(readFileSync(invPath, 'utf8'));

const portfolio = {
  scannedAt: new Date().toISOString(),
  walletCount: inventory.length,
  totals: {
    items: 0,
    itemsWithClaimable: 0,
    wethClaimable: '0',
  },
  wallets: [],
};

let totalWeth = 0n;

for (const w of inventory) {
  console.log(`\n=== ${w.address}  ${w.label} ===`);
  wallet.setReadOnlyAddress(w.address);

  const walletReport = {
    address: w.address,
    label: w.label,
    sources: {},
    items: [],
    wethClaimable: '0',
  };

  let walletWeth = 0n;

  for (const source of SOURCES) {
    const start = Date.now();
    const result = await source.scan(w.address, { includeLegacy });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const withClaim = result.items.filter(
      (i) => i.claimable && i.claimable.some((c) => c.amount > 0n),
    );

    walletReport.sources[source.id] = {
      itemCount: result.items.length,
      itemsWithClaimable: withClaim.length,
      complete: result.complete,
      failedRanges: result.failedRanges?.length || 0,
      wethClaimable: (result.wethClaimable || 0n).toString(),
      elapsedSec: elapsed,
      error: result.error || null,
    };

    walletWeth += result.wethClaimable || 0n;

    for (const item of withClaim) {
      walletReport.items.push({
        source: source.id,
        symbol: item.symbol,
        name: item.name,
        tokenAddress: item.tokenAddress,
        id: item.id,
        claimable: item.claimable.map((c) => ({
          token: c.token,
          symbol: c.symbol,
          amount: c.amount.toString(),
          decimals: c.decimals,
          formatted: formatAmount(c.amount, c.decimals),
        })),
      });
    }

    console.log(
      `  ${source.id.padEnd(8)} ${result.items.length} items, ${withClaim.length} with claim, ${(result.wethClaimable || 0n) === 0n ? '0' : formatAmount(result.wethClaimable, 18)} WETH (${elapsed}s)${result.complete ? '' : ' [INCOMPLETE]'}`,
    );
  }

  walletReport.wethClaimable = walletWeth.toString();
  portfolio.totals.items += walletReport.items.length;
  portfolio.totals.itemsWithClaimable += walletReport.items.length;
  totalWeth += walletWeth;
  portfolio.wallets.push(walletReport);
}

portfolio.totals.wethClaimable = totalWeth.toString();
portfolio.totals.wethClaimableFormatted = formatAmount(totalWeth, 18);

const outPath = resolve(ROOT, 'scan-results/portfolio.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(portfolio, null, 2));

console.log('\n=== Portfolio summary ===');
console.log(`  wallets:           ${portfolio.walletCount}`);
console.log(`  items w/ claim:    ${portfolio.totals.itemsWithClaimable}`);
console.log(`  WETH total:        ${portfolio.totals.wethClaimableFormatted}`);
console.log(`  written to:        ${outPath}`);
