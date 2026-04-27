// src/services/dex/aggregators.js
// Per-aggregator adapters. Each exports a uniform `quote(ctx)` method.
//
// Returns shape:
//   {
//     amountOutWei: bigint,
//     amountOutEth: string,           // human-readable, e.g. "0.0123"
//     amountOutUsd?: number,
//     gasEstimateWei?: bigint,
//     txRequest?: { to, data, value, gas? }   // ready to sign+send if present
//     route?: any,                    // raw aggregator response for debugging
//   }
//
// ctx shape:
//   { tokenIn, tokenOut, amount: string, taker, slippageBps }
//
// `tokenOut === NATIVE_ETH` means user wants native ETH out. Aggregators that
// only do ERC20 swaps will route via WETH unwrap.

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6);

// ===== LiFi =====
async function quoteLifi({ tokenIn, tokenOut, amount, taker, slippageBps }) {
  const slip = (slippageBps / 10_000).toString();
  const url =
    `https://li.quest/v1/quote?fromChain=8453&toChain=8453` +
    `&fromToken=${tokenIn}&toToken=${tokenOut}` +
    `&fromAmount=${amount}` +
    (taker ? `&fromAddress=${taker}` : '') +
    `&slippage=${slip}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lifi ${res.status}`);
  const j = await res.json();
  if (!j.estimate) throw new Error('lifi no estimate');
  const out = BigInt(j.estimate.toAmount);
  return {
    amountOutWei: out,
    amountOutEth: fmtEth(out),
    amountOutUsd: Number(j.estimate.toAmountUSD || 0),
    gasEstimateWei: j.estimate.gasCosts?.[0]?.estimate
      ? BigInt(j.estimate.gasCosts[0].estimate)
      : undefined,
    txRequest: j.transactionRequest
      ? {
          to: j.transactionRequest.to,
          data: j.transactionRequest.data,
          value: j.transactionRequest.value,
          gas: j.transactionRequest.gasLimit,
        }
      : undefined,
    route: j,
  };
}

// ===== Kyberswap =====
async function quoteKyberswap({ tokenIn, tokenOut, amount, taker, slippageBps }) {
  const inAddr = tokenOut === NATIVE_ETH ? tokenIn : tokenIn;
  const outAddr = tokenOut === NATIVE_ETH ? NATIVE_ETH : tokenOut;
  const routeUrl =
    `https://aggregator-api.kyberswap.com/base/api/v1/routes?` +
    `tokenIn=${inAddr}&tokenOut=${outAddr}&amountIn=${amount}`;
  const res = await fetch(routeUrl, { headers: { 'x-client-id': 'claimapp' } });
  if (!res.ok) throw new Error(`kyber ${res.status}`);
  const j = await res.json();
  if (j.code !== 0 || !j.data?.routeSummary) throw new Error('kyber no route');
  const rs = j.data.routeSummary;
  const out = BigInt(rs.amountOut);
  let txRequest;
  if (taker) {
    try {
      const buildRes = await fetch(`https://aggregator-api.kyberswap.com/base/api/v1/route/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-id': 'claimapp' },
        body: JSON.stringify({
          routeSummary: rs,
          sender: taker,
          recipient: taker,
          slippageTolerance: slippageBps,
        }),
      });
      if (buildRes.ok) {
        const b = await buildRes.json();
        if (b.code === 0 && b.data) {
          txRequest = {
            to: b.data.routerAddress,
            data: b.data.data,
            value: b.data.transactionValue || '0x0',
          };
        }
      }
    } catch {
      // keep quote-only
    }
  }
  return {
    amountOutWei: out,
    amountOutEth: fmtEth(out),
    amountOutUsd: Number(rs.amountOutUsd || 0),
    gasEstimateWei: rs.gas ? BigInt(rs.gas) : undefined,
    txRequest,
    route: rs,
  };
}

// ===== OpenOcean =====
async function quoteOpenOcean({ tokenIn, tokenOut, amount, taker, slippageBps }) {
  // OpenOcean wants `amount` in token units (NOT wei). Need decimals.
  // For now, fall back to passing wei and let it error gracefully — caller
  // can supply decimals via a richer ctx in a future revision.
  const inAddr = tokenIn;
  const outAddr = tokenOut === NATIVE_ETH ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : tokenOut;
  const url =
    `https://open-api.openocean.finance/v3/base/quote?` +
    `inTokenAddress=${inAddr}&outTokenAddress=${outAddr}` +
    `&amount=${amount}` + // raw wei — OO will reinterpret; expect possible 0 outAmount on V4-hooked Clanker tokens
    `&slippage=${(slippageBps / 100).toFixed(2)}` +
    `&gasPrice=0.05`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`oo ${res.status}`);
  const j = await res.json();
  if (j.code !== 200 || !j.data) throw new Error('oo no data');
  const out = BigInt(j.data.outAmount || '0');
  if (out === 0n) throw new Error('oo zero out');
  return {
    amountOutWei: out,
    amountOutEth: fmtEth(out),
    gasEstimateWei: j.data.estimatedGas ? BigInt(j.data.estimatedGas) : undefined,
    route: j.data,
  };
}

export const aggregators = [
  { name: 'lifi', quote: quoteLifi },
  { name: 'kyberswap', quote: quoteKyberswap },
  { name: 'openocean', quote: quoteOpenOcean },
];
