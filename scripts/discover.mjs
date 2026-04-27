#!/usr/bin/env node
// scripts/discover.mjs
//
// Mine the on-chain history of a wallet (already downloaded by
// scripts/basescan-history.mjs) to surface things the targeted scanners
// miss:
//
//   1. Every contract this wallet DEPLOYED — look for txs with
//      to == null in the normal tx list. Each is a contract you authored.
//      Includes Clanker tokens, Bankr tokens, Zora coins, plus any custom
//      contracts (Diamond facets, custom ERC20s, NFT collections, etc.).
//
//   2. Every COUNTERPARTY (top 20 by interaction frequency) — addresses
//      this wallet has interacted with most. Often surfaces:
//        - other wallets you control
//        - protocol contracts (Clanker factory, Doppler DECAY, etc.)
//        - reward contracts (ZORA ProtocolRewards, etc.)
//
//   3. Every TOKEN this wallet ever received — from tokentx data.
//      Includes airdrops, fee payouts, transfers in.
//
//   4. NFT collections owned at any point.
//
// Output: scan-results/discovery/<address>.json (gitignored)
//
// Run scripts/basescan-history.mjs <address> first to populate tx-history/.
//
// Usage:
//   node scripts/discover.mjs                         # all inventory wallets
//   node scripts/discover.mjs 0x<addr>                # one address

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function analyzeWallet(address) {
  const dir = resolve(ROOT, `tx-history/${address.toLowerCase()}`);
  if (!existsSync(dir)) {
    return { address, error: 'no tx-history — run scripts/basescan-history.mjs first' };
  }
  const txs = readJson(resolve(dir, 'txlist.json')) || [];
  const erc20 = readJson(resolve(dir, 'erc20-transfers.json')) || [];
  const erc721 = readJson(resolve(dir, 'erc721-transfers.json')) || [];
  const erc1155 = readJson(resolve(dir, 'erc1155-transfers.json')) || [];
  const balances = readJson(resolve(dir, 'token-balances.json')) || [];

  // ===== 1. Deployments =====
  // BlockScout's compat txlist marks contract-creation txs with `to: ""`
  // and the deployed address in `contractAddress`.
  const deployments = txs
    .filter((t) => (!t.to || t.to === '' || t.to === '0x') && t.contractAddress && t.contractAddress.startsWith('0x'))
    .map((t) => ({
      address: t.contractAddress,
      txHash: t.hash,
      blockNumber: Number(t.blockNumber),
      timestamp: Number(t.timeStamp) * 1000,
      gasUsed: t.gasUsed,
    }));

  // ===== 2. Counterparties =====
  const cpCount = new Map();
  const bumpCp = (addr) => {
    if (!addr) return;
    const k = addr.toLowerCase();
    cpCount.set(k, (cpCount.get(k) || 0) + 1);
  };
  for (const t of txs) {
    if (t.to && t.to.toLowerCase() !== address.toLowerCase()) bumpCp(t.to);
    if (t.from && t.from.toLowerCase() !== address.toLowerCase()) bumpCp(t.from);
  }
  for (const t of erc20) {
    if (t.from?.hash && t.from.hash.toLowerCase() !== address.toLowerCase()) bumpCp(t.from.hash);
    if (t.to?.hash && t.to.hash.toLowerCase() !== address.toLowerCase()) bumpCp(t.to.hash);
  }
  const counterparties = [...cpCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([addr, count]) => ({ address: addr, interactions: count }));

  // ===== 3. Tokens received =====
  // Distinct tokens that ever transferred TO this wallet.
  const receivedTokens = new Map();
  for (const t of erc20) {
    const toAddr = t.to?.hash?.toLowerCase();
    if (toAddr !== address.toLowerCase()) continue;
    const tokenAddr = t.token?.address || t.token?.address_hash || '';
    if (!tokenAddr) continue;
    const key = tokenAddr.toLowerCase();
    const existing = receivedTokens.get(key) || {
      address: tokenAddr,
      symbol: t.token?.symbol || '?',
      name: t.token?.name || '',
      decimals: Number(t.token?.decimals || 18),
      transfersIn: 0,
    };
    existing.transfersIn++;
    receivedTokens.set(key, existing);
  }

  // ===== 4. Current ERC-20 holdings (from balances snapshot) =====
  const holdings = balances.map((b) => ({
    address: b.token?.address || '',
    symbol: b.token?.symbol || '?',
    name: b.token?.name || '',
    type: b.token?.type || '',
    balance: b.value || '0',
    decimals: Number(b.token?.decimals || 18),
  }));

  // ===== 5. NFTs touched =====
  const nftCollections = new Map();
  for (const t of [...erc721, ...erc1155]) {
    const addr = t.token?.address || '';
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (!nftCollections.has(key)) {
      nftCollections.set(key, {
        address: addr,
        symbol: t.token?.symbol || '?',
        name: t.token?.name || '',
        type: t.token?.type || '',
        transfers: 0,
      });
    }
    nftCollections.get(key).transfers++;
  }

  return {
    address,
    summary: {
      totalNormalTx: txs.length,
      totalErc20Transfers: erc20.length,
      totalErc721Transfers: erc721.length,
      totalErc1155Transfers: erc1155.length,
      contractsDeployed: deployments.length,
      uniqueCounterparties: cpCount.size,
      tokensEverReceived: receivedTokens.size,
      currentErc20Holdings: holdings.length,
      nftCollectionsTouched: nftCollections.size,
    },
    deployments,
    topCounterparties: counterparties,
    tokensReceived: [...receivedTokens.values()].sort((a, b) => b.transfersIn - a.transfersIn).slice(0, 50),
    currentHoldings: holdings,
    nftCollections: [...nftCollections.values()].sort((a, b) => b.transfers - a.transfers),
  };
}

const cliArg = process.argv[2];
let targets;
if (cliArg && cliArg.startsWith('0x') && cliArg.length === 42) {
  targets = [{ address: cliArg, label: '' }];
} else {
  const inv = readJson(resolve(ROOT, 'scan-results/wallet-inventory.json'));
  if (!inv) {
    console.error('No inventory. Run scripts/wallet-inventory.mjs first.');
    process.exit(1);
  }
  targets = inv;
}

const outDir = resolve(ROOT, 'scan-results/discovery');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const aggregate = [];
for (const t of targets) {
  console.log(`\n=== ${t.address}  ${t.label || ''} ===`);
  const r = analyzeWallet(t.address);
  if (r.error) {
    console.log(`  ${r.error}`);
    aggregate.push(r);
    continue;
  }
  const s = r.summary;
  console.log(`  normal txs:           ${s.totalNormalTx}`);
  console.log(`  contracts deployed:   ${s.contractsDeployed}`);
  console.log(`  unique counterparties:${s.uniqueCounterparties}`);
  console.log(`  tokens ever received: ${s.tokensEverReceived}`);
  console.log(`  current ERC-20 hold:  ${s.currentErc20Holdings}`);
  console.log(`  NFT collections:      ${s.nftCollectionsTouched}`);
  if (r.deployments.length > 0) {
    console.log(`\n  Top 5 deployments:`);
    for (const d of r.deployments.slice(0, 5)) {
      const date = new Date(d.timestamp).toISOString().slice(0, 10);
      console.log(`    ${d.address}  block ${d.blockNumber}  ${date}`);
    }
  }
  writeFileSync(resolve(outDir, `${t.address.toLowerCase()}.json`), JSON.stringify(r, null, 2));
  aggregate.push(r);
}

writeFileSync(resolve(outDir, '_summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), wallets: aggregate }, null, 2));

console.log(`\n=== Discovery summary ===`);
const totalDeploys = aggregate.reduce((s, w) => s + (w.summary?.contractsDeployed || 0), 0);
const totalTokens = aggregate.reduce((s, w) => s + (w.summary?.tokensEverReceived || 0), 0);
console.log(`  Total contracts deployed across ${aggregate.length} wallet(s): ${totalDeploys}`);
console.log(`  Total distinct tokens ever received:                       ${totalTokens}`);
console.log(`  Output: scan-results/discovery/<address>.json`);
