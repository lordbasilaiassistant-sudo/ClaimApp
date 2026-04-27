#!/usr/bin/env node
// scripts/grab-everything.mjs
//
// Master consolidation script. For every wallet in WALLETS_JSON:
//   1. Read scan-results/deployment-scans/<addr>.json for owned contracts
//      with ETH/WETH balance.
//   2. For each, simulate a withdraw via the appropriate ABI function. If
//      the simulation reverts, skip (so we never break a live contract).
//   3. Send the withdraw txs sequentially.
//   4. After all withdrawals, unwrap any WETH balance held DIRECTLY by the
//      wallet (WETH.withdraw(amount)) → native ETH.
//   5. Print final per-wallet ETH balance.
//
// Safety:
//   - --dry-run is default. --execute flips to live.
//   - NEVER_DRAIN list skips contracts known to be live infrastructure.
//   - Per-tx gas estimate; if it reverts, skip that contract.
//   - Per-wallet gas cap (--max-gas-per-wallet, default 0.005 ETH).
//
// Auth:
//   WALLETS_JSON=/path/to/wallets.json — JSON array of {address, label, privateKey}
//
// Usage:
//   WALLETS_JSON=... node scripts/grab-everything.mjs                # dry-run
//   WALLETS_JSON=... node scripts/grab-everything.mjs --execute      # live

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
const provider = getProvider();

const args = new Set(process.argv.slice(2));
const DRY_RUN = !args.has('--execute');
const MAX_GAS_PER_WALLET = parseFloat(
  (process.argv.find((a) => a.startsWith('--max-gas-per-wallet')) || '').replace(/^--max-gas-per-wallet[= ]?/, '') || '0.005',
);

const WALLETS_JSON = process.env.WALLETS_JSON;
if (!WALLETS_JSON) {
  console.error('Set WALLETS_JSON=/path/to/wallets.json before running.');
  process.exit(1);
}
const wallets = JSON.parse(readFileSync(WALLETS_JSON, 'utf8'));

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function name() view returns (string)'];
const WETH_ABI = [
  ...ERC20,
  'function withdraw(uint256 amount)',
];
const weth = new ethers.Contract(WETH_BASE, WETH_ABI, provider);

const NEVER_DRAIN = new Set([
  // Contracts that are KNOWN to be live infrastructure — withdrawing from
  // them would break thryx.fun. Lowercase.
  '0xbdaf455adcd7f1aaa1b25c8d4182c935f93eba0a', // THRYXPool (live launchpad)
]);

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

function pickWithdrawFn(abi, ethBal, signerAddr) {
  const fns = abi.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure');
  const tryNames = [
    { name: 'withdrawExcessETH', argsFor: () => [] },
    { name: 'withdrawAll', argsFor: () => [] },
    { name: 'withdraw', argsFor: () => [] },
    { name: 'sweep', argsFor: () => [] },
    { name: 'sweepETH', argsFor: () => [] },
    { name: 'withdraw', argsFor: () => [ethBal] },
    { name: 'withdrawTo', argsFor: () => [signerAddr, ethBal] },
    { name: 'withdrawSurplus', argsFor: () => [signerAddr] },
    { name: 'withdrawETH', argsFor: () => [signerAddr, ethBal] },
  ];
  for (const t of tryNames) {
    const candidates = fns.filter((f) => f.name === t.name);
    for (const c of candidates) {
      const args = t.argsFor();
      const inputs = c.inputs || [];
      if (inputs.length !== args.length) continue;
      let ok = true;
      for (let i = 0; i < inputs.length; i++) {
        const want = inputs[i].type;
        const got = typeof args[i] === 'bigint' ? 'uint256' : (typeof args[i] === 'string' ? 'address' : '?');
        if (!(want === got || want.startsWith('uint'))) { ok = false; break; }
      }
      if (!ok) continue;
      return { fn: c, args };
    }
  }
  return null;
}

// Blind selector list for unverified contracts. Each entry is a synthetic
// ABI fragment (parseable by ethers.Interface) we'll try. We attempt them
// sequentially via estimateGas; the first one that doesn't revert wins.
function blindCandidates(ethBal, signerAddr) {
  return [
    // No-arg withdraws
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
    // 1-arg uint256
    `function withdraw(uint256)`,
    `function withdrawAmount(uint256)`,
    // 1-arg address
    `function withdrawTo(address)`,
    `function withdrawSurplus(address)`,
    `function sweep(address)`,
    `function sweepETH(address)`,
    // 2-arg (address,uint256)
    `function withdrawTo(address,uint256)`,
    `function withdrawETH(address,uint256)`,
    `function withdraw(address,uint256)`,
    `function transferETH(address,uint256)`,
    // EntryPoint-style stake withdrawal
    `function withdrawStake(address)`,
  ].map((sig) => {
    const iface = new ethers.Interface([sig]);
    const fn = iface.fragments[0];
    let args;
    if (fn.inputs.length === 0) args = [];
    else if (fn.inputs.length === 1 && fn.inputs[0].type.startsWith('uint')) args = [ethBal];
    else if (fn.inputs.length === 1 && fn.inputs[0].type === 'address') args = [signerAddr];
    else if (fn.inputs.length === 2) args = [signerAddr, ethBal];
    else return null;
    return { sig, fn, args, iface };
  }).filter(Boolean);
}

async function tryBlindWithdraw(contractAddr, ethBal, signerAddr, fromAddr) {
  for (const cand of blindCandidates(ethBal, signerAddr)) {
    const data = cand.iface.encodeFunctionData(cand.fn.name, cand.args);
    try {
      await provider.estimateGas({ to: contractAddr, data, from: fromAddr });
      return { fn: cand.fn, args: cand.args, sig: cand.sig };
    } catch {
      // try next selector
    }
  }
  return null;
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

async function processWallet(walletEntry) {
  const { address, label, privateKey } = walletEntry;
  console.log(`\n=== ${address}  ${label || ''} ===`);

  if (!privateKey) {
    console.log(`  no private key — skip`);
    return { address, label, skipped: 'no key' };
  }
  const signer = new ethers.Wallet(privateKey, provider);
  if (signer.address.toLowerCase() !== address.toLowerCase()) {
    console.log(`  key mismatch — skip`);
    return { address, label, skipped: 'key mismatch' };
  }

  // Use the master contract-balances.json (which covers verified AND
  // unverified contracts) instead of just deployment-scans (verified only).
  const balancesPath = resolve(ROOT, 'scan-results/contract-balances.json');
  const allBalances = existsSync(balancesPath)
    ? JSON.parse(readFileSync(balancesPath, 'utf8')).contractsWithBalance || []
    : [];
  const valuable = allBalances.filter(
    (c) => c.deployer.toLowerCase() === address.toLowerCase(),
  ).map((c) => ({
    contract: c.contract,
    ethBalance: c.ethBalance,
    wethBalance: c.wethBalance,
    ethBalanceFormatted: c.ethFormatted,
    wethBalanceFormatted: c.wethFormatted,
  }));
  console.log(`  contracts with balance: ${valuable.length}`);

  const txLog = [];
  let gasSpent = 0n;
  const gasCap = BigInt(Math.floor(MAX_GAS_PER_WALLET * 1e18));

  // Phase 1: drain owned contracts
  for (const c of valuable) {
    if (gasSpent >= gasCap) {
      console.log(`  gas cap hit, skipping rest`);
      break;
    }
    if (NEVER_DRAIN.has(c.contract.toLowerCase())) {
      console.log(`  ${c.contract.slice(0, 10)}…  ${c.name || ''} — NEVER_DRAIN`);
      txLog.push({ contract: c.contract, status: 'skipped-never-drain' });
      continue;
    }
    const meta = await fetchAbi(c.contract);
    const ethBal = BigInt(c.ethBalance || '0');
    let pick;

    if (meta) {
      const owner = await readOwner(c.contract, meta.abi);
      if (owner && owner.toLowerCase() !== address.toLowerCase()) {
        txLog.push({ contract: c.contract, status: 'skipped-not-owner', owner });
        continue;
      }
      pick = pickWithdrawFn(meta.abi, ethBal, address);
    }

    // Unverified or no compatible function in verified ABI → try blind selectors.
    if (!pick) {
      const blind = await tryBlindWithdraw(c.contract, ethBal, address, address);
      if (blind) {
        pick = { fn: blind.fn, args: blind.args };
        console.log(`    blind-match: ${blind.sig}`);
      }
    }

    if (!pick) {
      txLog.push({ contract: c.contract, status: 'skipped-no-withdraw-fn' });
      continue;
    }
    const iface = new ethers.Interface([pick.fn]);
    const data = iface.encodeFunctionData(pick.fn.name, pick.args);
    const tx = { to: c.contract, data, from: address };
    let gasEst;
    try {
      gasEst = await provider.estimateGas(tx);
    } catch (e) {
      const msg = (e.shortMessage || e.message || '').slice(0, 60);
      txLog.push({ contract: c.contract, status: 'skipped-revert', reason: msg, fn: pick.fn.name });
      continue;
    }
    const fee = (await provider.getFeeData()).gasPrice || 100_000_000n;
    const gasCost = gasEst * fee;
    console.log(
      `  ${c.contract.slice(0, 10)}…  ${(c.name || '?').padEnd(20)}  ${pick.fn.name}()  eth=${ethers.formatEther(ethBal)}  gas≈${ethers.formatEther(gasCost)}`
    );
    if (DRY_RUN) {
      txLog.push({ contract: c.contract, name: c.name, status: 'plan', fn: pick.fn.name, ethBalance: c.ethBalanceFormatted, wethBalance: c.wethBalanceFormatted, gasCostEth: ethers.formatEther(gasCost) });
      continue;
    }
    try {
      const sent = await signer.sendTransaction({ ...tx, gasLimit: gasEst * 12n / 10n });
      const receipt = await sent.wait();
      const status = receipt.status === 1 ? 'success' : 'failed';
      console.log(`    ${status}  ${sent.hash}  block ${receipt.blockNumber}`);
      txLog.push({ contract: c.contract, status, txHash: sent.hash, fn: pick.fn.name });
      gasSpent += receipt.gasUsed * fee;
    } catch (e) {
      console.log(`    SEND FAIL: ${e.shortMessage || e.message}`);
      txLog.push({ contract: c.contract, status: 'send-failed', reason: e.shortMessage || e.message });
    }
  }

  // Phase 2: unwrap WETH held directly by the wallet
  const wethBalance = await weth.balanceOf(address);
  if (wethBalance > 0n) {
    console.log(`  WETH balance: ${ethers.formatEther(wethBalance)} → unwrap to ETH`);
    if (DRY_RUN) {
      txLog.push({ action: 'unwrap-weth', amount: ethers.formatEther(wethBalance), status: 'plan' });
    } else {
      try {
        const wethSigner = weth.connect(signer);
        const sent = await wethSigner.withdraw(wethBalance);
        const receipt = await sent.wait();
        console.log(`    unwrap success  ${sent.hash}`);
        txLog.push({ action: 'unwrap-weth', amount: ethers.formatEther(wethBalance), status: 'success', txHash: sent.hash });
      } catch (e) {
        console.log(`    unwrap fail: ${e.shortMessage || e.message}`);
        txLog.push({ action: 'unwrap-weth', status: 'failed', reason: e.shortMessage || e.message });
      }
    }
  }

  const finalEth = await provider.getBalance(address);
  console.log(`  → final ETH: ${ethers.formatEther(finalEth)}`);
  return { address, label, finalEthBalance: ethers.formatEther(finalEth), txLog };
}

console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE EXECUTE'}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Per-wallet gas cap: ${MAX_GAS_PER_WALLET} ETH`);

const allResults = [];
for (const w of wallets) {
  allResults.push(await processWallet(w));
}

const logDir = resolve(ROOT, 'claims-log');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = resolve(logDir, `grab-everything-${ts}.json`);
writeFileSync(logPath, JSON.stringify({
  mode: DRY_RUN ? 'dry-run' : 'execute',
  generatedAt: new Date().toISOString(),
  wallets: allResults,
}, null, 2));

// Append to a flat CSV ledger that opens cleanly in Excel.
const csvPath = resolve(logDir, 'ledger.csv');
const csvHeaders = [
  'timestamp', 'mode', 'wallet', 'wallet_label', 'contract', 'contract_name',
  'action', 'fn', 'eth_recovered', 'weth_recovered', 'gas_cost_eth',
  'tx_hash', 'block_number', 'status', 'reason',
];
const escape = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLines = [];
if (!existsSync(csvPath)) csvLines.push(csvHeaders.join(','));
for (const r of allResults) {
  if (!r.txLog) continue;
  for (const t of r.txLog) {
    csvLines.push([
      new Date().toISOString(),
      DRY_RUN ? 'dry-run' : 'execute',
      r.address,
      r.label || '',
      t.contract || '',
      t.name || '',
      t.action || 'withdraw',
      t.fn || '',
      t.ethBalance || t.amount || '',
      t.wethBalance || '',
      t.gasCostEth || '',
      t.txHash || '',
      t.blockNumber || '',
      t.status || '',
      t.reason || '',
    ].map(escape).join(','));
  }
}
if (csvLines.length > 0) {
  const fs = await import('node:fs');
  fs.appendFileSync(csvPath, csvLines.join('\n') + '\n');
}

console.log(`\n=== FINAL ===`);
let totalFinalEth = 0n;
for (const r of allResults) {
  if (r.finalEthBalance) {
    totalFinalEth += ethers.parseEther(r.finalEthBalance);
    console.log(`  ${r.address}  ${(r.label || '').padEnd(20)} ${r.finalEthBalance} ETH`);
  }
}
console.log(`\n  GRAND TOTAL native ETH after consolidation: ${ethers.formatEther(totalFinalEth)} ETH`);
console.log(`  Log: ${logPath}`);
if (DRY_RUN) console.log(`\n  Re-run with --execute to send transactions.`);
