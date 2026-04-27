// Analyze tx-history files for 12 wallets and produce findings JSON.
// Usage: node test/analyze-history.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('tx-history');
const OUT_DIR = path.resolve('scan-results');
const OUT_FILE = path.join(OUT_DIR, 'history-analysis.json');

const WALLETS = [
  '0x7a3e312ec6e20a9f62fe2405938eb9060312e334',
  '0x718d6142fb15f95f43fac6f70498d8da130240bc',
  '0xe78da1f3a55fb5d359ddcbc10866c0e3cfaeea7e',
  '0x5f644a130e7e14cfe81c023ec987376263dc9384',
  '0xafd8dabe75cd7f9745a59dc750a1fe174aba84b0',
  '0xb17fb3a034087b011545a15ede4b8b961bf84806',
  '0x084d16f954da4c37ecd3b106718376a077742c2c',
  '0x47e36db608a1ac41280e205d08e979f40d03ae90',
  '0xc1687cc5320896aaa21915e9c07628132c55b7a4',
  '0xe14f521d8a540ba95c246ecd46a0813671f5c251',
  '0x03f2b0ae7f6bade9944d2cfb8ad66b62cf6ba1d4',
  '0x2d750ebb49a041821401011b45eefcd6367f7e4a',
];

const WALLET_SET = new Set(WALLETS.map((w) => w.toLowerCase()));

const PROTOCOL_TOKENS = {
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { symbol: 'AERO', protocol: 'Aerodrome' },
  '0xa88594d404727625a9437c3f886c7643872296ae': { symbol: 'WELL', protocol: 'Moonwell' },
  '0x9e1028f5f1d5ede59748ffcee5532509976840e0': { symbol: 'COMP', protocol: 'Compound' },
  '0xe3b53af74a4bf62ae5511055290838050bf764df': { symbol: 'STG', protocol: 'Stargate' },
  '0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842': { symbol: 'MORPHO', protocol: 'Morpho' },
  '0x2dad3a13ef0c6366220f989157009e501e7938f8': { symbol: 'EXTRA', protocol: 'Extra Finance' },
  '0x7c8a1a80fdd00c9cccd6ebd573e9ecb49bfa2a59': { symbol: 'MAV', protocol: 'Maverick' },
};
// Symbol-only for tokens we don't have an authoritative Base address for here.
const SYMBOL_PROTOCOLS = {
  PENDLE: { protocol: 'Pendle' },
  CRV: { protocol: 'Curve' },
};

const NPM_CONTRACTS = {
  '0x03a520b32c04bf3beef7beb72e919cf822ed34f1': 'Uniswap V3 NPM',
  '0x80c7dd17b01855a6d2347444a0fcc36136a314de': 'Sushi V3 NPM',
  '0x7c5f5a4bbd8fd63184577525326123b519429bdc': 'Uniswap V4 PM',
  '0x35e44dc4702fd51744001e248b49cbf9fcc51f0c': 'Maverick V2 PM',
};

function readJSON(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function lc(x) { return (x || '').toLowerCase(); }
function bigIntFromValue(v) { try { return BigInt(v); } catch { return 0n; } }
function ethFromWei(weiBI) {
  // Avoid float loss: format as ether string with 6 decimals
  const neg = weiBI < 0n;
  const w = neg ? -weiBI : weiBI;
  const ETH = 1000000000000000000n;
  const whole = w / ETH;
  const frac = w % ETH;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '') || '0';
  return `${neg ? '-' : ''}${whole}.${fracStr}`;
}

const results = {
  generatedAt: new Date().toISOString(),
  wallets: {},
  globals: {
    failedTxsWithValueTop20: [],
    nftLpDetections: [],
    protocolFootprintByWallet: {},
  },
};

const allFailedWithValue = [];

for (const wallet of WALLETS) {
  const dir = path.join(ROOT, wallet);
  const txlist = readJSON(path.join(dir, 'txlist.json')) || [];
  const erc20 = readJSON(path.join(dir, 'erc20-transfers.json')) || [];
  const erc721 = readJSON(path.join(dir, 'erc721-transfers.json')) || [];

  // 1) failed txs that consumed value
  const failedWithValue = [];
  for (const t of txlist) {
    if (t.isError === '1' || t.txreceipt_status === '0') {
      const val = bigIntFromValue(t.value);
      if (val > 0n) {
        failedWithValue.push({
          wallet,
          txHash: t.hash,
          to_contract: t.to,
          value_eth: ethFromWei(val),
          value_wei: val.toString(),
          timeStamp: t.timeStamp,
          isError: t.isError,
          methodId: t.methodId,
        });
      }
    }
  }
  failedWithValue.sort((a, b) => {
    const av = BigInt(a.value_wei), bv = BigInt(b.value_wei);
    if (av === bv) return 0;
    return av > bv ? -1 : 1;
  });
  allFailedWithValue.push(...failedWithValue);

  // 2) protocol-token receives
  const protocolReceives = {};
  for (const ev of erc20) {
    const toAddr = lc(ev?.to?.hash);
    if (toAddr !== wallet) continue;
    const tokenAddr = lc(ev?.token?.address_hash);
    const sym = ev?.token?.symbol;
    let match = PROTOCOL_TOKENS[tokenAddr];
    if (!match && sym && SYMBOL_PROTOCOLS[sym]) {
      match = { symbol: sym, protocol: SYMBOL_PROTOCOLS[sym].protocol, byMatch: 'symbol' };
    }
    if (!match) continue;
    const fromAddr = lc(ev?.from?.hash);
    const key = `${match.protocol}|${tokenAddr || sym}`;
    if (!protocolReceives[key]) {
      protocolReceives[key] = {
        protocol: match.protocol,
        symbol: match.symbol || sym,
        tokenAddress: tokenAddr || null,
        receiveCount: 0,
        senders: new Set(),
        firstTs: null,
        lastTs: null,
        sampleTx: ev?.transaction_hash,
      };
    }
    const r = protocolReceives[key];
    r.receiveCount++;
    if (fromAddr) r.senders.add(fromAddr);
    const ts = ev?.timestamp ? new Date(ev.timestamp).getTime() : null;
    if (ts) {
      if (r.firstTs === null || ts < r.firstTs) r.firstTs = ts;
      if (r.lastTs === null || ts > r.lastTs) r.lastTs = ts;
    }
  }
  const protocolFootprint = Object.values(protocolReceives).map((r) => ({
    protocol: r.protocol,
    symbol: r.symbol,
    tokenAddress: r.tokenAddress,
    receiveCount: r.receiveCount,
    uniqueSenders: r.senders.size,
    senders: Array.from(r.senders).slice(0, 5),
    firstTs: r.firstTs ? new Date(r.firstTs).toISOString() : null,
    lastTs: r.lastTs ? new Date(r.lastTs).toISOString() : null,
    sampleTx: r.sampleTx,
  })).sort((a, b) => b.receiveCount - a.receiveCount);

  // 3) top contracts by frequency of `to`
  const toFreq = new Map();
  for (const t of txlist) {
    const to = lc(t.to);
    if (!to) continue;
    if (WALLET_SET.has(to)) continue; // exclude inventory wallets
    if (to === wallet) continue;
    toFreq.set(to, (toFreq.get(to) || 0) + 1);
  }
  const topContracts = Array.from(toFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([address, count]) => ({ address, count }));

  // 4) NFT positions held that look like LP
  // Track tokenId net flow: +1 if to == wallet, -1 if from == wallet
  // For ERC-721, holder of last "to == wallet" event without subsequent "from == wallet" still holds
  const npmHoldings = {}; // npmAddr -> Map<tokenId, {lastDirection, lastTs}>
  for (const ev of erc721) {
    const tokenAddr = lc(ev?.token?.address_hash);
    if (!NPM_CONTRACTS[tokenAddr]) continue;
    const tokenId = ev?.total?.token_id;
    if (!tokenId) continue;
    const toAddr = lc(ev?.to?.hash);
    const fromAddr = lc(ev?.from?.hash);
    if (!npmHoldings[tokenAddr]) npmHoldings[tokenAddr] = new Map();
    const ts = ev?.timestamp ? new Date(ev.timestamp).getTime() : 0;
    const cur = npmHoldings[tokenAddr].get(tokenId);
    let direction;
    if (toAddr === wallet) direction = 'in';
    else if (fromAddr === wallet) direction = 'out';
    else continue;
    if (!cur || ts >= cur.ts) {
      npmHoldings[tokenAddr].set(tokenId, { direction, ts });
    }
  }
  const lpNftPositions = [];
  for (const [npm, map] of Object.entries(npmHoldings)) {
    const heldTokenIds = [];
    for (const [tokenId, info] of map.entries()) {
      if (info.direction === 'in') heldTokenIds.push(tokenId);
    }
    if (heldTokenIds.length) {
      lpNftPositions.push({
        wallet,
        npm_contract: npm,
        npm_name: NPM_CONTRACTS[npm],
        heldCount: heldTokenIds.length,
        last_known_token_ids: heldTokenIds.slice(-20),
      });
      results.globals.nftLpDetections.push({
        wallet,
        npm_contract: npm,
        npm_name: NPM_CONTRACTS[npm],
        heldCount: heldTokenIds.length,
        last_known_token_ids: heldTokenIds.slice(-20),
      });
    }
  }

  results.wallets[wallet] = {
    txCount: txlist.length,
    erc20EventCount: erc20.length,
    erc721EventCount: erc721.length,
    failedWithValueCount: failedWithValue.length,
    failedWithValueTop10: failedWithValue.slice(0, 10),
    protocolFootprint,
    topContracts,
    lpNftPositions,
  };
  results.globals.protocolFootprintByWallet[wallet] = protocolFootprint.map((r) => ({
    protocol: r.protocol,
    symbol: r.symbol,
    receiveCount: r.receiveCount,
  }));
}

allFailedWithValue.sort((a, b) => {
  const av = BigInt(a.value_wei), bv = BigInt(b.value_wei);
  if (av === bv) return 0;
  return av > bv ? -1 : 1;
});
results.globals.failedTxsWithValueTop20 = allFailedWithValue.slice(0, 20);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));

// ----- summary print (under 800 words) -----
const lines = [];
lines.push(`history-analysis written: ${OUT_FILE}`);
lines.push(`wallets analyzed: ${WALLETS.length}`);
lines.push('');
lines.push('Per-wallet protocol footprint, failed-with-value count, LP NFT detection:');
for (const wallet of WALLETS) {
  const w = results.wallets[wallet];
  const pf = w.protocolFootprint.length
    ? w.protocolFootprint.map((p) => `${p.symbol || p.protocol}x${p.receiveCount}`).join(', ')
    : 'none';
  const lp = w.lpNftPositions.length
    ? w.lpNftPositions.map((l) => `${l.npm_name}(${l.heldCount})`).join(', ')
    : 'none';
  lines.push(`- ${wallet}`);
  lines.push(`    txs=${w.txCount} erc20=${w.erc20EventCount} erc721=${w.erc721EventCount}`);
  lines.push(`    protocols: ${pf}`);
  lines.push(`    failed-with-value: ${w.failedWithValueCount}`);
  lines.push(`    lp-nfts: ${lp}`);
}
lines.push('');
lines.push('Top 10 failed-with-value tx (across all wallets):');
for (const f of results.globals.failedTxsWithValueTop20.slice(0, 10)) {
  lines.push(`  ${f.value_eth} ETH  ${f.txHash}  -> ${f.to_contract}  (wallet ${f.wallet.slice(0, 10)}…)`);
}
lines.push('');
lines.push('LP-NFT detections:');
if (results.globals.nftLpDetections.length === 0) lines.push('  none');
for (const l of results.globals.nftLpDetections) {
  lines.push(`  wallet ${l.wallet.slice(0, 10)}…  ${l.npm_name} held=${l.heldCount} ids=${l.last_known_token_ids.slice(0, 5).join(',')}${l.heldCount > 5 ? '…' : ''}`);
}

console.log(lines.join('\n'));
