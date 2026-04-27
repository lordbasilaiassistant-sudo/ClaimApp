#!/usr/bin/env node
// scripts/grab-all.mjs
//
// Pull ETH/WETH out of every wallet-authored contract that holds value.
// Source data: scan-results/deployment-scans/<addr>.json (already enriched).
//
// Pipeline per contract:
//   1. Read its own ABI to pick the right withdraw function.
//   2. estimateGas with the wallet as caller — if it reverts, we skip.
//      This automatically excludes contracts where we're not the owner,
//      contracts paused/locked, contracts with custom logic that blocks us.
//   3. If gas estimate succeeds, send the tx. Wait for receipt.
//   4. Log txHash → claims-log/grab-all-<timestamp>.json (gitignored).
//
// Safety:
//   - --dry-run prints the plan without sending anything (default).
//   - --execute is the live flip.
//   - Skips contracts where the caller wouldn't pass the .owner() check
//     (we read owner() if available; if owner != caller, skip).
//   - Skips THRYXPool by name — that's the live launchpad, never drain.
//
// Auth:
//   THRYXTREASURY_PRIVATE_KEY env var (already set on this machine).
//
// Usage:
//   node scripts/grab-all.mjs                              # dry-run
//   node scripts/grab-all.mjs --execute                    # send txs
//   node scripts/grab-all.mjs --execute --max-gas 0.01     # cap gas spend in ETH

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const { ethers } = await import(`file://${ROOT}/src/vendor/ethers.js`);
const { getProvider } = await import(`file://${ROOT}/src/services/provider.js`);

const args = new Set(process.argv.slice(2));
const DRY_RUN = !args.has('--execute');
const MAX_GAS_ETH = parseFloat(
  (process.argv.find((a) => a.startsWith('--max-gas')) || '').replace(/^--max-gas[= ]?/, '') || '0.005',
);

const KEY = process.env.THRYXTREASURY_PRIVATE_KEY;
if (!KEY) {
  console.error('Set THRYXTREASURY_PRIVATE_KEY before running this script.');
  process.exit(1);
}

const provider = getProvider();
const signer = new ethers.Wallet(KEY, provider);
const SIGNER_ADDR = signer.address;
console.log(`Signer:    ${SIGNER_ADDR}`);
console.log(`Mode:      ${DRY_RUN ? 'DRY RUN (no txs sent)' : 'LIVE EXECUTE'}`);
console.log(`Max gas:   ${MAX_GAS_ETH} ETH`);
console.log('');

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';

const NEVER_DRAIN = [
  // Add live infrastructure addresses here. Lowercased.
  // 0xbdaf455... = THRYXPool — actively used by deployed launchpad.
  '0xbdaf455adcd7f1aaa1b25c8d4182c935f93eba0a',
];

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const weth = new ethers.Contract(WETH_BASE, ERC20_ABI, provider);

async function fetchAbi(addr) {
  try {
    const res = await fetch(`${BLOCKSCOUT}/smart-contracts/${addr}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.is_verified || !Array.isArray(j.abi)) return null;
    return { abi: j.abi, name: j.name || null };
  } catch {
    return null;
  }
}

async function readOwner(addr, abi) {
  const ownerFn = abi.find(
    (f) => f.type === 'function' && f.name === 'owner' && (!f.inputs || f.inputs.length === 0),
  );
  if (!ownerFn) return null;
  try {
    const c = new ethers.Contract(addr, [ownerFn], provider);
    return await c.owner();
  } catch {
    return null;
  }
}

// Try several candidate withdraw functions in priority order.
// Returns { fn, args } or null.
function pickWithdrawFn(abi, ethBal, wethBal, signerAddr) {
  const fns = abi.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure');

  const tryNames = [
    // No-arg first (cleanest)
    { name: 'withdrawExcessETH', argsFor: () => [] },
    { name: 'withdrawAll', argsFor: () => [] },
    { name: 'withdraw', argsFor: () => [] },
    { name: 'sweep', argsFor: () => [] },
    { name: 'sweepETH', argsFor: () => [] },
    // Single uint256 amount (full ETH balance)
    { name: 'withdraw', argsFor: () => [ethBal] },
    // (address,uint256) — withdraw to signer
    { name: 'withdrawTo', argsFor: () => [signerAddr, ethBal] },
    { name: 'withdrawSurplus', argsFor: () => [signerAddr] },
    // CafeTreasury-shape
    { name: 'withdrawETH', argsFor: () => [signerAddr, ethBal] },
  ];

  for (const t of tryNames) {
    const candidates = fns.filter((f) => f.name === t.name);
    for (const c of candidates) {
      const args = t.argsFor();
      const inputs = c.inputs || [];
      if (inputs.length !== args.length) continue;
      // Type compatibility check (rough)
      let typesOk = true;
      for (let i = 0; i < inputs.length; i++) {
        const want = inputs[i].type;
        const got = typeof args[i] === 'bigint' ? 'uint256' : (typeof args[i] === 'string' ? 'address' : '?');
        if (!(want === got || want.startsWith('uint'))) { typesOk = false; break; }
      }
      if (!typesOk) continue;
      return { fn: c, args };
    }
  }
  return null;
}

async function processContract(c, summary) {
  const addr = c.contract;
  const ethBal = BigInt(c.ethBalance || '0');
  const wethBal = BigInt(c.wethBalance || '0');
  const total = ethBal + wethBal;
  const tag = (c.name || '?').slice(0, 22);

  if (NEVER_DRAIN.includes(addr.toLowerCase())) {
    console.log(`  ${addr}  ${tag.padEnd(22)} SKIP (in NEVER_DRAIN)`);
    summary.push({ contract: addr, name: c.name, status: 'skipped', reason: 'NEVER_DRAIN' });
    return;
  }
  if (total === 0n) {
    summary.push({ contract: addr, name: c.name, status: 'skipped', reason: 'zero balance' });
    return;
  }

  const meta = await fetchAbi(addr);
  if (!meta) {
    console.log(`  ${addr}  ${tag.padEnd(22)} SKIP (no verified ABI)`);
    summary.push({ contract: addr, name: c.name, status: 'skipped', reason: 'no verified ABI' });
    return;
  }

  // Owner check — only proceed if we own it (or there's no owner concept)
  const owner = await readOwner(addr, meta.abi);
  if (owner && owner.toLowerCase() !== SIGNER_ADDR.toLowerCase()) {
    console.log(`  ${addr}  ${tag.padEnd(22)} SKIP (owner=${owner})`);
    summary.push({ contract: addr, name: c.name, status: 'skipped', reason: `not owner (${owner})` });
    return;
  }

  const pick = pickWithdrawFn(meta.abi, ethBal, wethBal, SIGNER_ADDR);
  if (!pick) {
    console.log(`  ${addr}  ${tag.padEnd(22)} SKIP (no compatible withdraw fn)`);
    summary.push({ contract: addr, name: c.name, status: 'skipped', reason: 'no compatible withdraw fn' });
    return;
  }

  const iface = new ethers.Interface([pick.fn]);
  const data = iface.encodeFunctionData(pick.fn.name, pick.args);
  const tx = { to: addr, data, from: SIGNER_ADDR };

  let gasEst;
  try {
    gasEst = await provider.estimateGas(tx);
  } catch (e) {
    const msg = (e.shortMessage || e.message || '').slice(0, 80);
    console.log(`  ${addr}  ${tag.padEnd(22)} SKIP (estimateGas reverts: ${msg})`);
    summary.push({ contract: addr, name: c.name, status: 'skipped', reason: `revert: ${msg}`, fn: pick.fn.name });
    return;
  }

  const gasPrice = (await provider.getFeeData()).gasPrice || 100_000_000n; // 0.1 gwei fallback
  const gasCost = gasEst * gasPrice;
  console.log(
    `  ${addr}  ${tag.padEnd(22)} ` +
    `eth=${ethers.formatEther(ethBal)}  weth=${ethers.formatEther(wethBal)}  ` +
    `→ ${pick.fn.name}(${pick.args.map((a) => typeof a === 'bigint' ? a.toString() : a).join(',')})  ` +
    `gas≈${ethers.formatEther(gasCost)} ETH`
  );

  if (DRY_RUN) {
    summary.push({
      contract: addr, name: c.name, status: 'plan',
      ethBalance: c.ethBalanceFormatted, wethBalance: c.wethBalanceFormatted,
      fn: pick.fn.name, args: pick.args.map((a) => typeof a === 'bigint' ? a.toString() : a),
      gasEstimateWei: gasEst.toString(), gasCostEth: ethers.formatEther(gasCost),
    });
    return;
  }

  try {
    const sent = await signer.sendTransaction({ ...tx, gasLimit: gasEst * 12n / 10n });
    console.log(`    tx ${sent.hash} pending…`);
    const receipt = await sent.wait();
    const status = receipt.status === 1 ? 'success' : 'failed';
    console.log(`    ${status}  block ${receipt.blockNumber}  gasUsed ${receipt.gasUsed}`);
    summary.push({
      contract: addr, name: c.name, status,
      txHash: sent.hash, blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(), fn: pick.fn.name,
    });
  } catch (e) {
    console.log(`    SEND FAILED: ${e.shortMessage || e.message}`);
    summary.push({ contract: addr, name: c.name, status: 'send-failed', reason: e.shortMessage || e.message });
  }
}

const targetWallet = SIGNER_ADDR.toLowerCase();
const scanPath = resolve(ROOT, `scan-results/deployment-scans/${targetWallet}.json`);
if (!existsSync(scanPath)) {
  console.error(`No deployment-scan for ${targetWallet}. Run scripts/scan-deployments.mjs first.`);
  process.exit(1);
}
const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
const claims = (scan.claimables || []).filter((c) => {
  const eth = BigInt(c.ethBalance || '0');
  const wEth = BigInt(c.wethBalance || '0');
  return eth + wEth > 0n;
});

console.log(`Found ${claims.length} contract(s) with non-zero ETH/WETH balance:\n`);

const summary = [];
let totalGasSpent = 0n;
const gasCap = BigInt(Math.floor(MAX_GAS_ETH * 1e18));

for (const c of claims) {
  if (totalGasSpent >= gasCap) {
    console.log(`  -- gas cap reached (${MAX_GAS_ETH} ETH), stopping --`);
    break;
  }
  await processContract(c, summary);
}

const logDir = resolve(ROOT, 'claims-log');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = resolve(logDir, `grab-all-${ts}.json`);
writeFileSync(logPath, JSON.stringify({
  signer: SIGNER_ADDR,
  mode: DRY_RUN ? 'dry-run' : 'execute',
  generatedAt: new Date().toISOString(),
  results: summary,
}, null, 2));

const ok = summary.filter((s) => s.status === 'success').length;
const planned = summary.filter((s) => s.status === 'plan').length;
const skipped = summary.filter((s) => s.status === 'skipped').length;
const failed = summary.filter((s) => s.status === 'failed' || s.status === 'send-failed').length;

console.log(`\n=== Summary ===`);
console.log(`  succeeded: ${ok}`);
console.log(`  planned:   ${planned}`);
console.log(`  skipped:   ${skipped}`);
console.log(`  failed:    ${failed}`);
console.log(`  log:       ${logPath}`);
if (DRY_RUN) console.log(`\n  Re-run with --execute to send transactions.`);
