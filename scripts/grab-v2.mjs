#!/usr/bin/env node
// scripts/grab-v2.mjs
//
// Production grab. Uses raw eth_sendRawTransaction with multi-RPC failover.
// EIP-1559 type-2 txs (Base rejects type-0 legacy with status=0). Tenderly
// rate-limits sendRawTransaction → never use it for broadcasts; use it for
// reads only.
//
// Pipeline per wallet:
//   1. For each owned contract with non-zero ETH balance, try to find the
//      right withdraw fn via verified ABI (BlockScout) or blind selectors.
//   2. estimateGas via tenderly. If revert, skip.
//   3. Broadcast EIP-1559 tx via mainnet.base.org (with fallbacks).
//   4. Poll for receipt. Log to claims-log/ledger.csv as each completes.
//   5. After all contracts: unwrap any wallet WETH balance.
//
// Usage:
//   WALLETS_JSON=... node scripts/grab-v2.mjs                # dry-run
//   WALLETS_JSON=... node scripts/grab-v2.mjs --execute      # live

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
if (!WALLETS_JSON) { console.error('Set WALLETS_JSON.'); process.exit(1); }
const wallets = JSON.parse(readFileSync(WALLETS_JSON, 'utf8'));

// All methods rotate through this set on rate-limit. Tenderly is fine for
// occasional bursts but rate-limits sustained workloads. mainnet.base.org +
// dev-access never rate-limited us in testing. Order matters — first one
// that doesn't error wins.
const RPC_FALLBACKS = [
  'https://mainnet.base.org',
  'https://developer-access-mainnet.base.org',
  'https://nodes.sequence.app/base',
  'https://base.publicnode.com',
  'https://gateway.tenderly.co/public/base',
];
const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const NEVER_DRAIN = new Set([
  '0xbdaf455adcd7f1aaa1b25c8d4182c935f93eba0a', // THRYXPool — live launchpad
]);

const LEDGER_PATH = resolve(ROOT, 'claims-log/ledger.csv');
const LEDGER_HEADERS = [
  'timestamp','mode','wallet','wallet_label','contract','contract_name','action','fn',
  'eth_recovered','tx_hash','block_number','gas_used','status','reason',
];
function ledgerAppend(row) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dir = dirname(LEDGER_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(LEDGER_PATH)) appendFileSync(LEDGER_PATH, LEDGER_HEADERS.join(',') + '\n');
  appendFileSync(LEDGER_PATH, LEDGER_HEADERS.map((k) => escape(row[k] || '')).join(',') + '\n');
}

async function rpc(method, params, urls = RPC_FALLBACKS) {
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const j = await res.json();
      if (j.error) {
        lastErr = new Error(`${method}@${url}: ${j.error.message || JSON.stringify(j.error)}`);
        if (j.error.code === -32005 || /rate/i.test(j.error.message || '')) continue;
        if (/revert/i.test(j.error.message || '')) throw lastErr;
        continue;
      }
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${method}: all RPCs failed`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getReceipt(hash, maxWaitMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (r) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function fetchAbi(addr) {
  try {
    const res = await fetch(`${BLOCKSCOUT}/smart-contracts/${addr}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.is_verified || !Array.isArray(j.abi)) return null;
    return { abi: j.abi, name: j.name || null };
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
    let fnArgs;
    if (fn.inputs.length === 0) fnArgs = [];
    else if (fn.inputs.length === 1 && fn.inputs[0].type.startsWith('uint')) fnArgs = [ethBal];
    else if (fn.inputs.length === 1 && fn.inputs[0].type === 'address') fnArgs = [signerAddr];
    else if (fn.inputs.length === 2) fnArgs = [signerAddr, ethBal];
    else continue;
    const data = iface.encodeFunctionData(fn.name, fnArgs);
    try {
      await rpc('eth_estimateGas', [{ to: contractAddr, data, from: signerAddr }, 'latest']);
      return { fn, args: fnArgs, sig };
    } catch {}
  }
  return null;
}

async function broadcastTx({ wallet, to, data, value = 0n }) {
  const [nonceHex, blockHex, chainIdHex] = await Promise.all([
    rpc('eth_getTransactionCount', [wallet.address, 'pending']),
    rpc('eth_getBlockByNumber', ['latest', false]),
    rpc('eth_chainId', []),
  ]);
  const baseFee = BigInt(blockHex.baseFeePerGas || '0x1');
  const maxPriority = 100_000n;
  const maxFee = baseFee * 2n + maxPriority;
  // estimate gas
  const gasEstHex = await rpc('eth_estimateGas', [
    { from: wallet.address, to, data, value: '0x' + value.toString(16) },
    'latest',
  ]);
  const gasLimit = (BigInt(gasEstHex) * 13n) / 10n;
  const tx = {
    to,
    data,
    value,
    gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority,
    nonce: parseInt(nonceHex, 16),
    chainId: parseInt(chainIdHex, 16),
    type: 2,
  };
  const signed = await wallet.signTransaction(tx);
  const hash = await rpc('eth_sendRawTransaction', [signed], RPC_FALLBACKS);
  return { hash, gasLimit };
}

async function processContract(c, wallet, label) {
  const addr = c.contract;
  if (NEVER_DRAIN.has(addr.toLowerCase())) return { contract: addr, status: 'skipped-never-drain' };
  const ethBal = BigInt(c.ethBalance || '0');
  if (ethBal === 0n) return { contract: addr, status: 'skipped-zero-eth' };

  let pick;
  let contractName;
  const meta = await fetchAbi(addr);
  if (meta) {
    contractName = meta.name;
    pick = pickFromAbi(meta.abi, ethBal, wallet.address);
  }
  if (!pick) {
    const blind = await tryBlind(addr, ethBal, wallet.address);
    if (blind) pick = { fn: blind.fn, args: blind.args };
  }
  if (!pick) return { contract: addr, status: 'skipped-no-fn', name: contractName };

  const iface = new ethers.Interface([pick.fn]);
  const data = iface.encodeFunctionData(pick.fn.name, pick.args);
  // final estimate (catches reverts)
  try {
    await rpc('eth_estimateGas', [{ from: wallet.address, to: addr, data }, 'latest']);
  } catch (e) {
    return { contract: addr, status: 'skipped-revert', reason: (e.message || '').slice(0, 80), fn: pick.fn.name, name: contractName };
  }

  console.log(`    ${pick.fn.name}() on ${(contractName || '?').slice(0, 18).padEnd(18)} eth=${ethers.formatEther(ethBal)}`);
  if (DRY_RUN) {
    return { contract: addr, status: 'plan', fn: pick.fn.name, ethBalance: ethers.formatEther(ethBal), name: contractName };
  }
  try {
    const { hash } = await broadcastTx({ wallet, to: addr, data });
    console.log(`      sent ${hash}`);
    const receipt = await getReceipt(hash);
    if (!receipt) return { contract: addr, status: 'pending-no-receipt', txHash: hash, name: contractName };
    const status = receipt.status === '0x1' ? 'success' : 'failed';
    console.log(`      ${status}  block ${parseInt(receipt.blockNumber,16)}`);
    return {
      contract: addr, name: contractName, status, txHash: hash,
      blockNumber: parseInt(receipt.blockNumber, 16),
      gasUsed: parseInt(receipt.gasUsed, 16).toString(),
      fn: pick.fn.name, ethRecovered: ethers.formatEther(ethBal),
    };
  } catch (e) {
    console.log(`      send-fail: ${e.message}`);
    return { contract: addr, status: 'send-failed', reason: (e.message || '').slice(0, 100), fn: pick.fn.name, name: contractName };
  }
}

async function processWallet(walletEntry, allBalances) {
  const { address, label, privateKey } = walletEntry;
  if (ONLY_WALLET && address.toLowerCase() !== ONLY_WALLET.toLowerCase()) return null;
  console.log(`\n=== ${address}  ${label || ''} ===`);
  const w = new ethers.Wallet(privateKey);
  if (w.address.toLowerCase() !== address.toLowerCase()) {
    console.log(`  key mismatch — skip`);
    return null;
  }
  const valuable = allBalances.filter((c) => c.deployer.toLowerCase() === address.toLowerCase());
  console.log(`  contracts with balance: ${valuable.length}`);
  const results = [];
  for (const c of valuable) {
    const r = await processContract(c, w, label);
    results.push(r);
    await sleep(500); // rate-limit cushion
    ledgerAppend({
      timestamp: new Date().toISOString(),
      mode: DRY_RUN ? 'dry-run' : 'execute',
      wallet: address,
      wallet_label: label || '',
      contract: r.contract,
      contract_name: r.name || '',
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

  // WETH unwrap directly held by wallet
  const wbalHex = await rpc('eth_call', [{
    to: WETH_BASE,
    data: '0x70a08231000000000000000000000000' + address.slice(2).toLowerCase(),
  }, 'latest']);
  const wbal = BigInt(wbalHex);
  if (wbal > 0n) {
    console.log(`  WETH ${ethers.formatEther(wbal)} → unwrap`);
    if (!DRY_RUN) {
      const iface = new ethers.Interface(['function withdraw(uint256)']);
      const data = iface.encodeFunctionData('withdraw', [wbal]);
      try {
        const { hash } = await broadcastTx({ wallet: w, to: WETH_BASE, data });
        console.log(`    sent ${hash}`);
        const receipt = await getReceipt(hash);
        const status = receipt?.status === '0x1' ? 'success' : 'failed';
        console.log(`    unwrap ${status}`);
        ledgerAppend({
          timestamp: new Date().toISOString(), mode: 'execute',
          wallet: address, wallet_label: label || '', contract: WETH_BASE,
          action: 'unwrap-weth', fn: 'withdraw(uint256)',
          eth_recovered: ethers.formatEther(wbal), tx_hash: hash,
          block_number: receipt ? parseInt(receipt.blockNumber, 16) : '',
          status, reason: '',
        });
      } catch (e) {
        console.log(`    unwrap fail: ${e.message}`);
        ledgerAppend({
          timestamp: new Date().toISOString(), mode: 'execute',
          wallet: address, wallet_label: label || '', contract: WETH_BASE,
          action: 'unwrap-weth', fn: 'withdraw(uint256)',
          eth_recovered: ethers.formatEther(wbal), status: 'failed',
          reason: (e.message || '').slice(0, 80),
        });
      }
    } else {
      ledgerAppend({
        timestamp: new Date().toISOString(), mode: 'dry-run',
        wallet: address, wallet_label: label || '', contract: WETH_BASE,
        action: 'unwrap-weth', fn: 'withdraw(uint256)',
        eth_recovered: ethers.formatEther(wbal), status: 'plan',
      });
    }
  }
  return { address, label, results };
}

const balPath = resolve(ROOT, 'scan-results/contract-balances.json');
const allBalances = JSON.parse(readFileSync(balPath, 'utf8')).contractsWithBalance || [];

console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE EXECUTE'}`);
console.log(`Contracts to process: ${allBalances.length}`);
console.log(`Ledger: ${LEDGER_PATH}\n`);

const all = [];
for (const w of wallets) {
  if (!w.privateKey || !w.address) continue;
  const r = await processWallet(w, allBalances);
  if (r) all.push(r);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = resolve(ROOT, `claims-log/grab-v2-${ts}.json`);
writeFileSync(logPath, JSON.stringify({ mode: DRY_RUN ? 'dry-run' : 'execute', wallets: all }, null, 2));

let recovered = 0;
let succeeded = 0;
for (const w of all) {
  for (const r of w.results || []) {
    if (r.status === 'success') {
      succeeded++;
      recovered += parseFloat(r.ethRecovered || '0');
    }
  }
}
console.log(`\n=== Summary ===`);
console.log(`  succeeded: ${succeeded}`);
console.log(`  total ETH recovered (via withdraw txs): ${recovered.toFixed(8)}`);
console.log(`  log:    ${logPath}`);
console.log(`  ledger: ${LEDGER_PATH}`);
