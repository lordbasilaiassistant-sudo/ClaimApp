// src/services/dex/index.js
// DEX aggregator: query multiple Base aggregators, pick best ETH-out quote.
//
// All endpoints CORS-verified for browser use, no API key required.
// Stack (verified 2026-04-27):
//   1. LiFi      — returns ready-to-sign transactionRequest (incl. native ETH)
//   2. Kyberswap — best long-tail / V4-hook routing (Clanker tokens)
//   3. OpenOcean — tertiary fallback
//
// 0x v2 and 1inch require keys → excluded (would leak in static bundle).

import { aggregators } from './aggregators.js';

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const QUOTE_TIMEOUT_MS = 8_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), ms),
    ),
  ]);
}

/**
 * Get the best quote to sell `amount` of `tokenIn` for native ETH on Base.
 *
 * Returns:
 *   {
 *     bestQuote:   { aggregator, amountOutWei, amountOutEth, gasEstimateWei?, txRequest? } | null,
 *     allQuotes:   per-aggregator results,
 *     errors:      per-aggregator errors,
 *   }
 *
 * `taker` is the wallet address (required by some aggregators to encode tx).
 */
export async function getBestQuote({ tokenIn, amount, taker, tokenOut = NATIVE_ETH, slippageBps = 100 }) {
  if (!tokenIn || !amount || amount === 0n) {
    return { bestQuote: null, allQuotes: [], errors: [{ aggregator: 'caller', error: 'tokenIn + amount required' }] };
  }

  const ctx = { tokenIn, tokenOut, amount: amount.toString(), taker, slippageBps };

  const settled = await Promise.allSettled(
    aggregators.map((a) =>
      withTimeout(a.quote(ctx), QUOTE_TIMEOUT_MS, a.name).then((q) => ({ aggregator: a.name, ...q })),
    ),
  );

  const allQuotes = [];
  const errors = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled' && r.value && r.value.amountOutWei && r.value.amountOutWei > 0n) {
      allQuotes.push(r.value);
    } else {
      errors.push({
        aggregator: aggregators[i].name,
        error: r.status === 'rejected' ? r.reason?.message || String(r.reason) : 'no quote',
      });
    }
  }

  allQuotes.sort((a, b) => (b.amountOutWei > a.amountOutWei ? 1 : -1));

  return {
    bestQuote: allQuotes[0] || null,
    allQuotes,
    errors,
  };
}

/**
 * Quick pricing check: is `amount` of `tokenIn` worth more than `minWei` ETH?
 * Use to decide whether to even attempt a claim+sell.
 */
export async function isWorthSelling({ tokenIn, amount, minWei = 1_000_000_000_000_000n /* 0.001 ETH */ }) {
  const { bestQuote } = await getBestQuote({ tokenIn, amount, taker: NATIVE_ETH });
  if (!bestQuote) return { worth: false, reason: 'no quote', quote: null };
  return {
    worth: bestQuote.amountOutWei >= minWei,
    reason: bestQuote.amountOutWei >= minWei ? 'above threshold' : `below threshold (${bestQuote.amountOutEth} ETH < ${Number(minWei) / 1e18} ETH)`,
    quote: bestQuote,
  };
}

export { NATIVE_ETH, WETH_BASE };
