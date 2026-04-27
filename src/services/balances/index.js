// src/services/balances/index.js
//
// Per-wallet balance + value scanner. Returns native ETH balance plus every
// ERC-20 the wallet holds, with each token priced through the DEX aggregator
// stack (LiFi → Kyberswap → OpenOcean) to estimate sellable ETH value.
//
// Data source: BlockScout v2 REST. Free, CORS-clean, no API key. Same
// backend already used by scripts/basescan-history.mjs.
//
// Composition contract:
//   getWalletBalances(address, { onLog?, priceTokens?: bool })
//     → { address, ethBalance, ethBalanceFormatted, tokens, totalValueWei,
//         totalValueFormatted }
//
// The DEX-pricing pass is opt-in (priceTokens defaults to true) — turn it
// off for fast-path balance-only checks.

import { ethers } from '../../vendor/ethers.js';
import { getProvider } from '../provider.js';
import { getBestQuote, NATIVE_ETH } from '../dex/index.js';

const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';
const PRICE_TIMEOUT_MS = 6_000;
const PRICE_PARALLELISM = 4;
const MIN_VALUE_WEI = 100_000_000_000_000n; // 0.0001 ETH — below this, skip pricing
const MAX_TOKENS_TO_PRICE = 200;            // cap to avoid hammering DEX APIs
const MAX_TOKEN_PAGES = 20;                 // BlockScout returns 50/page → up to 1000 tokens

function fmtEth(wei) {
  return Number(wei) / 1e18;
}

async function fetchTokenList(address) {
  // BlockScout paginates via next_page_params (50 items/page).
  const all = [];
  let nextParams = '';
  let page = 0;
  while (page < MAX_TOKEN_PAGES) {
    const url = `${BLOCKSCOUT_BASE}/addresses/${address}/tokens?type=ERC-20${nextParams ? `&${nextParams}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`blockscout ${res.status}`);
    const j = await res.json();
    if (Array.isArray(j)) {
      all.push(...j);
      break; // legacy shape, no pagination
    }
    if (Array.isArray(j.items)) all.push(...j.items);
    if (!j.next_page_params) break;
    nextParams = new URLSearchParams(j.next_page_params).toString();
    page++;
  }
  return all;
}

function shapeToken(entry) {
  const t = entry.token || {};
  return {
    address: t.address || '',
    symbol: t.symbol || '?',
    name: t.name || '',
    decimals: Number(t.decimals || 18),
    balance: BigInt(entry.value || '0'),
    iconUrl: t.icon_url || null,
  };
}

// Cheap dexscreener pre-filter: ask "does this token have any DEX pair?".
// If pairs is empty/null, the token is illiquid → skip the expensive
// aggregator call. Single batched endpoint takes ≤30 token addresses.
async function dexscreenerLiquidTokens(addresses) {
  const live = new Set();
  // Dexscreener supports up to 30 addresses per request
  const CHUNK = 30;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const batch = addresses.slice(i, i + CHUNK);
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = await res.json();
      const pairs = Array.isArray(j.pairs) ? j.pairs : [];
      for (const p of pairs) {
        const liq = Number(p.liquidity?.usd || 0);
        if (liq < 100) continue; // < $100 liquidity → effectively unsellable
        // Mark whichever side is the input token
        if (p.baseToken?.address) live.add(p.baseToken.address.toLowerCase());
        if (p.quoteToken?.address) live.add(p.quoteToken.address.toLowerCase());
      }
    } catch {
      // best-effort; don't fail the whole scan over a dexscreener hiccup
    }
  }
  return live;
}

async function priceToken(token, taker) {
  if (token.balance === 0n) return { ...token, valueWei: 0n, priced: false };
  try {
    const quote = await Promise.race([
      getBestQuote({
        tokenIn: token.address,
        amount: token.balance,
        taker: taker || '0x0000000000000000000000000000000000000000',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PRICE_TIMEOUT_MS)),
    ]);
    const valueWei = quote.bestQuote?.amountOutWei || 0n;
    return { ...token, valueWei, priced: !!quote.bestQuote };
  } catch {
    return { ...token, valueWei: 0n, priced: false };
  }
}

async function pmap(items, fn, parallelism) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: parallelism }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function getWalletBalances(address, options = {}) {
  const { onLog = () => {}, priceTokens = true } = options;

  // Native ETH balance via existing RPC pool.
  onLog(`fetching native balance for ${address}…`);
  const provider = getProvider();
  const ethBalance = await provider.getBalance(address);

  // ERC-20 token list via BlockScout.
  onLog(`fetching ERC-20 holdings…`);
  let raw = [];
  try {
    raw = await fetchTokenList(address);
  } catch (e) {
    onLog(`token list fetch failed: ${e.message}`);
  }
  const tokens = raw.map(shapeToken).filter((t) => t.balance > 0n);
  onLog(`found ${tokens.length} non-zero ERC-20 holdings`);

  let priced = tokens;
  if (priceTokens && tokens.length > 0) {
    onLog(`dexscreener pre-filter on ${tokens.length} tokens…`);
    const live = await dexscreenerLiquidTokens(tokens.map((t) => t.address));
    onLog(`  → ${live.size} have ≥$100 DEX liquidity (skipping ${tokens.length - live.size} illiquid)`);
    const liquid = tokens.filter((t) => live.has(t.address.toLowerCase()));
    const skipped = tokens.filter((t) => !live.has(t.address.toLowerCase())).map((t) => ({ ...t, valueWei: 0n, priced: false, illiquid: true }));
    const head = liquid.slice(0, MAX_TOKENS_TO_PRICE);
    const tail = liquid.slice(MAX_TOKENS_TO_PRICE).map((t) => ({ ...t, valueWei: 0n, priced: false }));
    onLog(`pricing ${head.length} liquid tokens via DEX aggregator…`);
    const pricedHead = await pmap(head, (t) => priceToken(t, address), PRICE_PARALLELISM);
    priced = [...pricedHead, ...tail, ...skipped];
  } else {
    priced = tokens.map((t) => ({ ...t, valueWei: 0n, priced: false }));
  }

  // Sort: priced+meaningful first, then by valueWei desc, then by symbol.
  priced.sort((a, b) => {
    if (a.valueWei === b.valueWei) return a.symbol.localeCompare(b.symbol);
    return b.valueWei > a.valueWei ? 1 : -1;
  });

  const tokenValueWei = priced.reduce((sum, t) => sum + t.valueWei, 0n);
  const totalValueWei = ethBalance + tokenValueWei;

  return {
    address,
    ethBalance,
    ethBalanceFormatted: ethers.formatEther(ethBalance),
    tokens: priced,
    tokenCount: priced.length,
    sellableTokenCount: priced.filter((t) => t.valueWei >= MIN_VALUE_WEI).length,
    tokenValueWei,
    totalValueWei,
    totalValueFormatted: ethers.formatEther(totalValueWei),
  };
}

export async function getEthBalance(address) {
  const provider = getProvider();
  return provider.getBalance(address);
}
