#!/usr/bin/env node
// scripts/basescan-history.mjs
//
// Download full on-chain history for a wallet using the BlockScout
// Etherscan-compatible API at https://base.blockscout.com/api.
//
// Why BlockScout instead of Etherscan V2? Etherscan V2 free tier explicitly
// excludes Base ("Free API access is not supported for this chain. Please
// upgrade your api plan for full chain coverage."). BlockScout is free,
// open-source, and the Etherscan-compat shape is identical for the
// endpoints we need.
//
// Endpoints downloaded per wallet:
//   - txlist               (normal txs)
//   - txlistinternal       (internal txs)
//   - tokentx              (ERC-20 transfers)
//   - tokennfttx           (ERC-721 transfers)
//   - token1155tx          (ERC-1155 transfers)
//
// Output:  tx-history/<address>/<endpoint>.json   (gitignored)
// Plus a flat CSV per endpoint for spreadsheet review.
//
// Usage:
//   node scripts/basescan-history.mjs                       # all wallets in inventory
//   node scripts/basescan-history.mjs 0x<addr>              # specific wallet

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BASE_URL = 'https://base.blockscout.com/api';
const RATE_LIMIT_MS = 250;  // BlockScout is generous; stay polite
const PAGE_SIZE = 10_000;
const MAX_PAGES = 200; // BlockScout v2 returns 50 items per page; treasury can have 5k+ ERC-20 transfers

// Etherscan-compat endpoints that BlockScout reliably implements.
// (token-transfer endpoints in compat mode return HTTP 500 — we use v2 REST
//  for those instead; see V2_TOKEN_ENDPOINTS below.)
const ENDPOINTS = [
  { name: 'txlist',          module: 'account', action: 'txlist' },
  { name: 'txlistinternal',  module: 'account', action: 'txlistinternal' },
];

// BlockScout v2 REST endpoints — paginated via next_page_params.
const V2_TOKEN_ENDPOINTS = [
  { name: 'erc20-transfers',   path: '/token-transfers?type=ERC-20' },
  { name: 'erc721-transfers',  path: '/token-transfers?type=ERC-721' },
  { name: 'erc1155-transfers', path: '/token-transfers?type=ERC-1155' },
  { name: 'token-balances',    path: '/tokens', single: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ClaimApp/basescan-history' } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

async function downloadEndpoint(address, endpoint) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const params = new URLSearchParams({
      module: endpoint.module,
      action: endpoint.action,
      address,
      startblock: '0',
      endblock: '99999999',
      page: String(page),
      offset: String(PAGE_SIZE),
      sort: 'asc',
    });
    const url = `${BASE_URL}?${params}`;
    let j;
    try {
      j = await fetchJson(url);
    } catch (e) {
      console.warn(`    ${endpoint.name} page ${page}: ${e.message}`);
      break;
    }
    if (j.status === '0' && j.message === 'No transactions found') break;
    if (j.status !== '1' || !Array.isArray(j.result)) {
      console.warn(`    ${endpoint.name} page ${page}: ${j.message || 'unexpected response'}`);
      break;
    }
    all.push(...j.result);
    if (j.result.length < PAGE_SIZE) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }
  return all;
}

async function downloadV2Token(address, endpoint) {
  const all = [];
  let nextParams = '';
  let page = 0;
  while (page < MAX_PAGES) {
    const url = `https://base.blockscout.com/api/v2/addresses/${address}${endpoint.path}${nextParams ? `&${nextParams}` : ''}`;
    let j;
    try {
      j = await fetchJson(url);
    } catch (e) {
      console.warn(`    ${endpoint.name} page ${page + 1}: ${e.message}`);
      break;
    }
    if (Array.isArray(j.items)) all.push(...j.items);
    else if (Array.isArray(j)) all.push(...j); // /tokens returns a flat array
    if (endpoint.single) break;
    if (!j.next_page_params) break;
    nextParams = new URLSearchParams(j.next_page_params).toString();
    page++;
    await sleep(RATE_LIMIT_MS);
  }
  return all;
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.join(',');
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(',')).join('\n');
  return `${header}\n${body}`;
}

async function downloadWallet(address) {
  console.log(`\n=== ${address} ===`);
  const dir = resolve(ROOT, `tx-history/${address.toLowerCase()}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const summary = { address, endpoints: {} };
  const allEndpoints = [
    ...ENDPOINTS.map((e) => ({ ...e, type: 'compat' })),
    ...V2_TOKEN_ENDPOINTS.map((e) => ({ ...e, type: 'v2' })),
  ];
  for (const endpoint of allEndpoints) {
    process.stdout.write(`  ${endpoint.name.padEnd(20)} `);
    const start = Date.now();
    const rows = endpoint.type === 'compat'
      ? await downloadEndpoint(address, endpoint)
      : await downloadV2Token(address, endpoint);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    summary.endpoints[endpoint.name] = rows.length;

    const jsonPath = resolve(dir, `${endpoint.name}.json`);
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
    if (rows.length > 0) {
      const csvPath = resolve(dir, `${endpoint.name}.csv`);
      writeFileSync(csvPath, toCsv(rows));
    }
    console.log(`${rows.length} rows  (${elapsed}s)`);
    await sleep(RATE_LIMIT_MS);
  }

  writeFileSync(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

const cliArg = process.argv[2];
let targets;
if (cliArg && cliArg.startsWith('0x') && cliArg.length === 42) {
  targets = [{ address: cliArg, label: '' }];
} else {
  const invPath = resolve(ROOT, 'scan-results/wallet-inventory.json');
  if (!existsSync(invPath)) {
    console.error('No wallet inventory. Run scripts/wallet-inventory.mjs first.');
    process.exit(1);
  }
  targets = JSON.parse(readFileSync(invPath, 'utf8'));
}

console.log(`Source:         BlockScout (${BASE_URL})`);
console.log(`Targets:        ${targets.length} wallet(s)`);
console.log(`Output:         tx-history/<address>/`);

const aggregate = [];
for (const t of targets) {
  aggregate.push(await downloadWallet(t.address));
}

writeFileSync(
  resolve(ROOT, 'tx-history/_summary.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), wallets: aggregate }, null, 2),
);

console.log('\n=== Summary ===');
for (const a of aggregate) {
  const totalRows = Object.values(a.endpoints).reduce((s, n) => s + n, 0);
  console.log(`  ${a.address}  ${totalRows} rows total`);
}
