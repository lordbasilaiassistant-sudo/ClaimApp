#!/usr/bin/env node
// scripts/grab-direct.mjs
//
// Stripped-down direct sender. Reads scan-results/contract-balances.json
// + WALLETS_JSON and processes contracts one at a time via a single-URL
// ethers JsonRpcProvider (no multi-RPC router complexity that hung).
//
// For each contract with balance:
//   1. estimateGas with the appropriate withdraw function (verified ABI
//      first, then a blind selector list).
//   2. If estimate succeeds → send tx, wait receipt, append to ledger.
//   3. If estimate reverts → skip and log.
//
// After all contract drains: unwrap any direct WETH balance.
//
// Output: claims-log/ledger.csv (append) + claims-log/grab-direct-<ts>.json

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
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

const args = new Set(process.argv.slice(2));
const DRY_RUN = !args.has('--execute');
const ONLY_WALLET = process.argv.find((a) => a.startsWith('--wallet='))?.replace('--wallet=', '');

const WALLETS_JSON = process.env.WALLETS_JSON;
if (!WALLETS_JSON) {
  console.error('Set WALLETS_JSON.');
  process.exit(1);
}
const wallets = JSON.parse(readFileSync(WALLETS_JSON, 'utf8'));

// Direct single-URL provider — no router, no failover, no hangs.
const provider = new ethers.JsonRpcProvider('https://gateway.tenderly.co/public/base', {
  name: 'base',
  chainId: 8453,
});

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const NEVER_DRAIN = new Set([
  '0xbdaf455adcd7f1aaa1b25c8d4182c935f93eba0a', // THRYXPool — live launchpad
]);

const TX_TIMEOUT_MS = 60_000; // per-tx hard cap
const LEDGER_PATH = resolve(ROOT, 'claims-log/ledger.csv');
const LEDGER_HEADERS = [
  'timestamp', 'mode', 'wallet', 'wallet_label', 'contract', 'action', 'fn',
  'eth_recovered', 'tx_hash', 'block_number', 'gas_used', 'status', 'reason',
];
function ledgerAppend(row) {
  const order = LEDGER_HEADERS;
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dir = dirname(LEDGER_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(LEDGER_PATH)) appendFileSync(LEDGER_PATH, order.join(',') + '\n');
  appendFileSync(LEDGER_PATH, order.map((k) => escape(row[k] || '')).join(',') + '\n');
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

async function fetchAbi(addr) {
  try {
    const res = await fetch(`${BLOCKSCOUT}/smart-contracts/${addr}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.is_verified || !Array.isArray(j.abi)) return null;
    return j.abi;
  } catch { return null; }
}

function pickFromAbi(abi, ethBal, signer) {
  const fns = abi.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure');
  const tries = [
    { name: 'withdrawExcessETH', argsFor: () => [] },
    { name: 'withdrawAll', argsFor: () => [] },
    { name: 'withdraw', argsFor: () => [] },
    { name: 'sweep', argsFor: () => [] },
    { name: 'sweepETH', argsFor: () => [] },
    { name: 'release', argsFor: () => [] },
    { name: 'withdraw', argsFor: () => [ethBal] },
    { name: 'withdrawTo', argsFor: () => [signer, ethBal] },
    { name: 'withdrawSurplus', argsFor: () => [signer] },
    { name: 'withdrawETH', argsFor: () => [signer, ethBal] },
  ];
  for (const t of tries) {
    for (const c of fns.filter((f) => f.name === t.name)) {
      const args = t.argsFor();
      const inputs = c.inputs || [];
      if (inputs.length !== args.length) continue;
      let ok = true;
      for (let i = 0; i < inputs.length; i++) {
        const want = inputs[i].type;
        const got = typeof args[i] === 'bigint' ? 'uint256' : (typeof args[i] === 'string' ? 'address' : '?');
        if (!(want === got || want.startsWith('uint'))) { ok = false; break; }
      }
      if (ok) return { fn: c, args };
    }
  }
  return null;
}

const BLIND_SIGS = [
  'function withdraw()',
  'function withdrawAll()',
  'function withdrawExcessETH()',
  'function withdrawETH()',
  'function release()',
  'function sweep()',
  'function sweepETH()',
  'function rescueETH()',
  'function recoverETH()',
  'function claim()',
  'function claimAll()',
  'function withdraw(uint256)',
  'function withdrawAmount(uint256)',
  'function withdrawTo(address)',
  'function withdrawSurplus(address)',
  'function sweep(address)',
  'function sweepETH(address)',
  'function withdrawTo(address,uint256)',
  'function withdrawETH(address,uint256)',
  'function withdraw(address,uint256)',
  'function transferETH(address,uint256)',
  'function withdrawStake(address)',
];

async function tryBlind(contractAddr, ethBal, signerAddr) {
  for (const sig of BLIND_SIGS) {
    const iface = new ethers.Interface([sig]);
    const fn = iface.fragments[0];
    let args;
    if (fn.inputs.length === 0) args = [];
    else if (fn.inputs.length === 1 && fn.inputs[0].type.startsWith('uint')) args = [ethBal];
    else if (fn.inputs.length === 1 && fn.inputs[0].type === 'address') args = [signerAddr];
    else if (fn.inputs.length === 2) args = [signerAddr, ethBal];
    else continue;
    const data = iface.encodeFunctionData(fn.name, args);
    try {
      await withTimeout(
        provider.estimateGas({ to: contractAddr, data, from: signerAddr }),
        10_000, `estimateGas ${sig}`,
      );
      return { fn, args, sig };
    } catch {}
  }
  return null;
}

async function processContract(c, signer, walletLabel) {
  const addr = c.contract;
  if (NEVER_DRAIN.has(addr.toLowerCase())) {
    return { contract: addr, status: 'skipped-never-drain' };
  }
  const ethBal = BigInt(c.ethBalance || '0');
  if (ethBal === 0n) return { contract: addr, status: 'skipped-zero-eth' };

  let pick;
  const abi = await fetchAbi(addr);
  if (abi) pick = pickFromAbi(abi, ethBal, signer.address);
  if (!pick) {
    const blind = await tryBlind(addr, ethBal, signer.address);
    if (blind) pick = { fn: blind.fn, args: blind.args };
  }
  if (!pick) {
    return { contract: addr, status: 'skipped-no-fn' };
  }

  const iface = new ethers.Interface([pick.fn]);
  const data = iface.encodeFunctionData(pick.fn.name, pick.args);
  let gasEst;
  try {
    gasEst = await withTimeout(
      provider.estimateGas({ to: addr, data, from: signer.address }),
      10_000, 'final estimate',
    );
  } catch (e) {
    return { contract: addr, status: 'skipped-revert', reason: (e.message || '').slice(0, 80), fn: pick.fn.name };
  }
  console.log(`    ${pick.fn.name}()  eth=${ethers.formatEther(ethBal)}`);
  if (DRY_RUN) {
    return { contract: addr, status: 'plan', fn: pick.fn.name, ethBalance: ethers.formatEther(ethBal) };
  }
  try {
    const sent = await withTimeout(
      signer.sendTransaction({ to: addr, data, gasLimit: gasEst * 12n / 10n }),
      TX_TIMEOUT_MS, 'send',
    );
    console.log(`      sent ${sent.hash}`);
    const receipt = await withTimeout(sent.wait(), TX_TIMEOUT_MS, 'wait');
    const status = receipt.status === 1 ? 'success' : 'failed';
    console.log(`      ${status}  block ${receipt.blockNumber}  gas ${receipt.gasUsed}`);
    return { contract: addr, status, txHash: sent.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), fn: pick.fn.name, ethRecovered: ethers.formatEther(ethBal) };
  } catch (e) {
    return { contract: addr, status: 'send-failed', reason: (e.message || '').slice(0, 80), fn: pick.fn.name };
  }
}

async function processWallet(walletEntry, allBalances) {
  const { address, label, privateKey } = walletEntry;
  if (ONLY_WALLET && address.toLowerCase() !== ONLY_WALLET.toLowerCase()) return null;

  console.log(`\n=== ${address}  ${label || ''} ===`);
  const signer = new ethers.Wallet(privateKey, provider);
  if (signer.address.toLowerCase() !== address.toLowerCase()) {
    console.log(`  key mismatch — skip`);
    return { address, label, skipped: 'key mismatch' };
  }
  const valuable = allBalances.filter((c) => c.deployer.toLowerCase() === address.toLowerCase());
  console.log(`  contracts with balance: ${valuable.length}`);
  const results = [];
  for (const c of valuable) {
    const r = await processContract(c, signer, label);
    results.push({ ...c, ...r });
    ledgerAppend({
      timestamp: new Date().toISOString(),
      mode: DRY_RUN ? 'dry-run' : 'execute',
      wallet: address,
      wallet_label: label || '',
      contract: c.contract,
      action: 'withdraw',
      fn: r.fn || '',
      eth_recovered: r.ethRecovered || '',
      tx_hash: r.txHash || '',
      block_number: r.blockNumber || '',
      gas_used: r.gasUsed || '',
      status: r.status || '',
      reason: r.reason || '',
    });
  }

  // Phase 2: unwrap WETH held by the wallet directly
  const weth = new ethers.Contract(WETH_BASE, [
    'function balanceOf(address) view returns (uint256)',
    'function withdraw(uint256)',
  ], signer);
  const wbal = await weth.balanceOf(address);
  if (wbal > 0n) {
    console.log(`  WETH ${ethers.formatEther(wbal)} → unwrap`);
    if (!DRY_RUN) {
      try {
        const sent = await withTimeout(weth.withdraw(wbal), TX_TIMEOUT_MS, 'unwrap');
        const receipt = await withTimeout(sent.wait(), TX_TIMEOUT_MS, 'unwrap-wait');
        console.log(`    unwrap ${sent.hash}  block ${receipt.blockNumber}`);
        ledgerAppend({
          timestamp: new Date().toISOString(),
          mode: 'execute',
          wallet: address,
          wallet_label: label || '',
          contract: WETH_BASE,
          action: 'unwrap-weth',
          fn: 'withdraw(uint256)',
          eth_recovered: ethers.formatEther(wbal),
          tx_hash: sent.hash,
          block_number: receipt.blockNumber,
          gas_used: receipt.gasUsed.toString(),
          status: 'success',
          reason: '',
        });
      } catch (e) {
        console.log(`    unwrap fail: ${e.message}`);
        ledgerAppend({
          timestamp: new Date().toISOString(), mode: 'execute', wallet: address, wallet_label: label || '',
          contract: WETH_BASE, action: 'unwrap-weth', fn: 'withdraw(uint256)',
          eth_recovered: ethers.formatEther(wbal), status: 'failed', reason: (e.message || '').slice(0, 80),
        });
      }
    } else {
      ledgerAppend({
        timestamp: new Date().toISOString(), mode: 'dry-run', wallet: address, wallet_label: label || '',
        contract: WETH_BASE, action: 'unwrap-weth', fn: 'withdraw(uint256)',
        eth_recovered: ethers.formatEther(wbal), status: 'plan',
      });
    }
  }
  return { address, label, results };
}

const balPath = resolve(ROOT, 'scan-results/contract-balances.json');
const allBalances = JSON.parse(readFileSync(balPath, 'utf8')).contractsWithBalance || [];

console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE EXECUTE'}`);
console.log(`Ledger: ${LEDGER_PATH}\n`);

const all = [];
for (const w of wallets) {
  if (!w.privateKey || !w.address) continue;
  const r = await processWallet(w, allBalances);
  if (r) all.push(r);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = resolve(ROOT, `claims-log/grab-direct-${ts}.json`);
writeFileSync(logPath, JSON.stringify({ mode: DRY_RUN ? 'dry-run' : 'execute', wallets: all }, null, 2));

const drained = [];
for (const w of all) {
  for (const r of w.results || []) {
    if (r.status === 'success') drained.push(r);
  }
}
console.log(`\n=== Drained ${drained.length} contracts ===`);
let recovered = 0;
for (const d of drained) {
  console.log(`  ${d.contract}  ${d.ethRecovered} ETH  ${d.txHash}`);
  recovered += parseFloat(d.ethRecovered || '0');
}
console.log(`\n  total ETH recovered: ${recovered.toFixed(8)}`);
console.log(`  log:    ${logPath}`);
console.log(`  ledger: ${LEDGER_PATH}`);
