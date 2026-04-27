// Manual raw-tx broadcast test. Bypasses ethers' sendTransaction
// to isolate whether the hang is in populateTransaction or eth_sendRawTransaction.

import { readFileSync } from 'node:fs';
process.stdout.write('1 start\n');

globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const { ethers } = await import('../src/vendor/ethers.js');
process.stdout.write('2 ethers loaded\n');

const wallets = JSON.parse(readFileSync(process.env.WALLETS_JSON, 'utf8'));
const treasury = wallets.find((w) => w.label?.includes('treasury'));
process.stdout.write(`3 treasury: ${treasury.address}\n`);

// READ ops use tenderly (large-range) — but writes (eth_sendRawTransaction)
// must NOT use tenderly. Tenderly rate-limits sendRawTransaction with -32005
// and ethers retries forever, hanging the script. Use mainnet.base.org for
// broadcasts.
const RPC_READ = 'https://gateway.tenderly.co/public/base';
const RPC_WRITE_FALLBACKS = [
  'https://mainnet.base.org',
  'https://developer-access-mainnet.base.org',
  'https://nodes.sequence.app/base',
  'https://base.publicnode.com',
];

async function rpc(method, params) {
  const writes = ['eth_sendRawTransaction'];
  const targets = writes.includes(method) ? RPC_WRITE_FALLBACKS : [RPC_READ];
  let lastErr;
  for (const url of targets) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const j = await res.json();
      if (j.error) {
        lastErr = new Error(`${method}@${url}: ${JSON.stringify(j.error)}`);
        // -32005 rate limit → next provider
        if (j.error.code === -32005 || /rate/i.test(j.error.message || '')) continue;
        throw lastErr;
      }
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${method}: all RPCs failed`);
}

const wallet = new ethers.Wallet(treasury.privateKey);
process.stdout.write(`4 wallet derived: ${wallet.address}\n`);

const [nonce, latestBlock, chainId] = await Promise.all([
  rpc('eth_getTransactionCount', [wallet.address, 'pending']),
  rpc('eth_getBlockByNumber', ['latest', false]),
  rpc('eth_chainId', []),
]);
const baseFee = BigInt(latestBlock.baseFeePerGas || '0x0');
const maxPriorityFee = 100_000n; // 0.0001 gwei tip — Base accepts very low priority
const maxFee = baseFee * 2n + maxPriorityFee;
process.stdout.write(`5 nonce=${parseInt(nonce, 16)} baseFee=${baseFee} maxFee=${maxFee} chainId=${parseInt(chainId, 16)}\n`);

// EIP-1559 type-2 tx
const tx = {
  to: wallet.address,
  value: ethers.parseEther('0.0000001'),
  gasLimit: 30000n,                    // bump above 21000 for safety
  maxFeePerGas: maxFee,
  maxPriorityFeePerGas: maxPriorityFee,
  nonce: parseInt(nonce, 16),
  chainId: parseInt(chainId, 16),
  type: 2,
};
process.stdout.write(`6 tx prepared\n`);

const signed = await wallet.signTransaction(tx);
process.stdout.write(`7 signed (${signed.length} chars)\n`);

const hash = await rpc('eth_sendRawTransaction', [signed]);
process.stdout.write(`8 BROADCAST OK  hash=${hash}\n`);

// Poll for receipt
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (receipt) {
    process.stdout.write(`9 mined block=${parseInt(receipt.blockNumber, 16)} status=${receipt.status}\n`);
    break;
  }
  process.stdout.write(`  waiting (${i + 1}/30)...\n`);
}
