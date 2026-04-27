#!/usr/bin/env node
// scripts/scan-deployments.mjs
//
// For every contract a wallet has deployed (from scan-results/discovery/),
// pull the verified ABI from BlockScout and surface every function
// matching claim-shaped patterns. This is how we find money on
// custom contracts the user built — including the "we built together"
// stuff that no targeted scanner knows about.
//
// What we look for in each contract's ABI:
//   * Functions containing: claim, withdraw, collect, redeem, harvest, sweep
//   * View functions matching: balanceOf, claimable, pending, earned,
//     rewards, available
//
// For every "view" claim-checker found, we eth_call it with the wallet's
// own address to surface a non-zero pending balance instantly.
//
// Run scripts/discover.mjs first to populate the deployments list.
//
// Usage:
//   node scripts/scan-deployments.mjs                  # all inventory wallets
//   node scripts/scan-deployments.mjs 0x<addr>         # one wallet

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);
const { getProvider } = await import(`file://${ROOT}/src/services/provider.js`);

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const provider = getProvider();

const CLAIM_VERBS = /^(claim|withdraw|collect|redeem|harvest|sweep|release)/i;
const VIEW_PATTERNS = /^(balanceOf|claimable|pending|earned|rewards?|available|withdrawable|releasable|owed)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAbi(contractAddr) {
  // BlockScout v2 returns { abi: [...], is_verified: bool }
  try {
    const res = await fetch(`${BLOCKSCOUT}/smart-contracts/${contractAddr}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.is_verified || !Array.isArray(j.abi)) return null;
    return j.abi;
  } catch {
    return null;
  }
}

function categorizeAbi(abi) {
  const claimFuncs = [];
  const viewClaimables = [];
  for (const item of abi) {
    if (item.type !== 'function') continue;
    if (CLAIM_VERBS.test(item.name)) {
      claimFuncs.push(item);
    } else if (
      (item.stateMutability === 'view' || item.stateMutability === 'pure') &&
      VIEW_PATTERNS.test(item.name)
    ) {
      viewClaimables.push(item);
    }
  }
  return { claimFuncs, viewClaimables };
}

async function checkPending(contractAddr, viewFn, walletAddr) {
  // Only call view functions that take no args, or exactly one address arg.
  const inputs = viewFn.inputs || [];
  if (inputs.length > 1) return null;
  if (inputs.length === 1 && inputs[0].type !== 'address') return null;

  try {
    const iface = new ethers.Interface([viewFn]);
    const data = inputs.length === 0
      ? iface.encodeFunctionData(viewFn.name, [])
      : iface.encodeFunctionData(viewFn.name, [walletAddr]);
    const result = await provider.call({ to: contractAddr, data });
    if (!result || result === '0x' || result === '0x0') return null;
    const decoded = iface.decodeFunctionResult(viewFn.name, result);
    // Only surface non-zero numeric returns.
    const v = decoded[0];
    if (typeof v === 'bigint' && v > 0n) {
      return v.toString();
    }
    return null;
  } catch {
    return null;
  }
}

async function scanWallet(address, label = '') {
  const discoveryPath = resolve(ROOT, `scan-results/discovery/${address.toLowerCase()}.json`);
  if (!existsSync(discoveryPath)) {
    return { address, error: 'no discovery data — run scripts/discover.mjs first' };
  }
  const disc = JSON.parse(readFileSync(discoveryPath, 'utf8'));
  const deployments = disc.deployments || [];
  console.log(`\n=== ${address}  ${label} ===`);
  console.log(`  ${deployments.length} deployments to scan`);

  const verified = [];
  const claimables = [];

  for (let i = 0; i < deployments.length; i++) {
    const d = deployments[i];
    if (i > 0 && i % 25 === 0) console.log(`  …processed ${i}/${deployments.length}`);
    const abi = await fetchAbi(d.address);
    if (!abi) continue;
    verified.push({ address: d.address, abiSize: abi.length });

    const { claimFuncs, viewClaimables } = categorizeAbi(abi);
    if (claimFuncs.length === 0 && viewClaimables.length === 0) continue;

    // Run each view to see if anything is currently claimable for this wallet.
    const pendings = [];
    for (const v of viewClaimables) {
      const pending = await checkPending(d.address, v, address);
      if (pending) {
        pendings.push({
          fn: v.name,
          inputs: (v.inputs || []).map((i) => i.type),
          pending,
        });
      }
    }

    if (pendings.length > 0 || claimFuncs.length > 0) {
      claimables.push({
        contract: d.address,
        deployTx: d.txHash,
        deployBlock: d.blockNumber,
        claimFunctions: claimFuncs.map((f) => ({
          name: f.name,
          inputs: (f.inputs || []).map((i) => `${i.type} ${i.name || ''}`.trim()),
          stateMutability: f.stateMutability,
        })),
        pendingChecks: pendings,
      });
    }

    // Be polite to BlockScout
    await sleep(150);
  }

  console.log(`  verified contracts: ${verified.length}/${deployments.length}`);
  console.log(`  contracts with claim shape: ${claimables.length}`);
  const withPending = claimables.filter((c) => c.pendingChecks.length > 0);
  console.log(`  contracts with NON-ZERO pending claimable: ${withPending.length}`);
  if (withPending.length > 0) {
    console.log(`\n  ⚡ MATCHES:`);
    for (const m of withPending) {
      console.log(`    ${m.contract}`);
      for (const p of m.pendingChecks) {
        console.log(`      ${p.fn}(${p.inputs.join(',')}) → ${p.pending}`);
      }
    }
  }
  return {
    address,
    summary: {
      deployments: deployments.length,
      verified: verified.length,
      withClaimShape: claimables.length,
      withPending: withPending.length,
    },
    claimables,
  };
}

const cliArg = process.argv[2];
let targets;
if (cliArg && cliArg.startsWith('0x') && cliArg.length === 42) {
  targets = [{ address: cliArg, label: '' }];
} else {
  const inv = JSON.parse(readFileSync(resolve(ROOT, 'scan-results/wallet-inventory.json'), 'utf8'));
  targets = inv;
}

const outDir = resolve(ROOT, 'scan-results/deployment-scans');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const aggregate = [];
for (const t of targets) {
  const r = await scanWallet(t.address, t.label);
  writeFileSync(resolve(outDir, `${t.address.toLowerCase()}.json`), JSON.stringify(r, null, 2));
  aggregate.push(r);
}

writeFileSync(resolve(outDir, '_summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), wallets: aggregate }, null, 2));

const totalPending = aggregate.reduce((s, w) => s + (w.summary?.withPending || 0), 0);
console.log(`\n=== Total contracts with NON-ZERO pending across ${aggregate.length} wallet(s): ${totalPending} ===`);
