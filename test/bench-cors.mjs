#!/usr/bin/env node
// Browser-compatible CORS check for every candidate RPC.
// A provider is "browser usable" only if it returns
//   access-control-allow-origin: *
// on an OPTIONS preflight with Content-Type: application/json.
// Otherwise any POST from a browser will be blocked by the browser
// BEFORE the request is sent.

const CANDIDATES = [
  // ===== Currently active (in src/services/rpc/providers.js) =====
  { name: 'tenderly-public', url: 'https://gateway.tenderly.co/public/base' },
  { name: 'base-developer',  url: 'https://developer-access-mainnet.base.org' },
  { name: 'base-official',   url: 'https://mainnet.base.org' },
  { name: 'sequence',        url: 'https://nodes.sequence.app/base' },
  { name: '1rpc',            url: 'https://1rpc.io/base' },

  // ===== Known to fail CORS (kept here as regression guards) =====
  { name: 'merkle',          url: 'https://base.merkle.io' }, // 405 on preflight

  // ===== Candidates from 2026-04-27 RPC research pass =====
  { name: 'llamarpc',        url: 'https://base.llamarpc.com' },
  { name: 'blockpi-public',  url: 'https://base.public.blockpi.network/v1/rpc/public' },
  { name: 'nodies-public',   url: 'https://base-public.nodies.app' },
  { name: 'meowrpc',         url: 'https://base.meowrpc.com' },
  { name: 'blast-api',       url: 'https://base-mainnet.public.blastapi.io' },
  { name: 'drpc',            url: 'https://base.drpc.org' },
  { name: 'lava',            url: 'https://base.lava.build' },
  { name: 'subquery-public', url: 'https://base.rpc.subquery.network/public' },
  { name: 'subquery-gw',     url: 'https://gateway.subquery.network/rpc/base' },
  { name: 'tatum',           url: 'https://base-mainnet.gateway.tatum.io' },
  { name: 'bloxroute',       url: 'https://base.rpc.blxrbdn.com' },
  { name: 'pocket',          url: 'https://base.api.pocket.network' },
  { name: 'sentio',          url: 'https://rpc.sentio.xyz/base' },
  { name: 'thirdweb-named',  url: 'https://base.rpc.thirdweb.com' },
  { name: 'thirdweb-id',     url: 'https://8453.rpc.thirdweb.com' },
  { name: 'zan',             url: 'https://api.zan.top/base-mainnet' },
  { name: 'publicnode',      url: 'https://base-rpc.publicnode.com' },
  { name: 'publicnode-alt',  url: 'https://base.publicnode.com' },
  { name: 'onfinality',      url: 'https://base.api.onfinality.io/public' },
];

const ORIGIN = 'https://lordbasilaiassistant-sudo.github.io';

async function checkCors(url) {
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const acao = res.headers.get('access-control-allow-origin');
    const acam = res.headers.get('access-control-allow-methods');
    const acah = res.headers.get('access-control-allow-headers');

    const browserOK = res.ok && (acao === '*' || acao === ORIGIN) && /post/i.test(acam || '') && /content-type/i.test(acah || '');
    return { browserOK, status: res.status, acao, acam, acah };
  } catch (e) {
    return { browserOK: false, status: 0, error: e.message };
  }
}

// Also verify the provider actually supports large eth_getLogs queries.
// Returns { ok, reason, latencyMs, maxBlocks }
async function checkLogRange(url, blocks) {
  const TOP = 44_400_000;
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getLogs',
    params: [{
      address: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9', // v4 factory
      fromBlock: '0x' + (TOP - blocks).toString(16),
      toBlock: '0x' + TOP.toString(16),
    }],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, latencyMs: Date.now() - start };
    const json = await res.json();
    if (json.error) return { ok: false, reason: json.error.message?.slice(0, 60), latencyMs: Date.now() - start };
    return { ok: true, latencyMs: Date.now() - start, logCount: Array.isArray(json.result) ? json.result.length : 0 };
  } catch (e) {
    return { ok: false, reason: e.message?.slice(0, 60), latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

console.log('=== CORS + eth_getLogs compatibility ===');
console.log(`Origin: ${ORIGIN}`);
console.log('');
console.log(`${'provider'.padEnd(20)} CORS  10k      200k     verdict`);
console.log('-'.repeat(80));

const results = [];
for (const p of CANDIDATES) {
  const cors = await checkCors(p.url);
  let log10k = { ok: false };
  let log200k = { ok: false };
  if (cors.browserOK) {
    log10k = await checkLogRange(p.url, 9_999);
    log200k = await checkLogRange(p.url, 199_999);
  }
  const corsTag = cors.browserOK ? '✓' : '✗';
  const l10 = log10k.ok ? `${log10k.latencyMs}ms` : 'FAIL';
  const l200 = log200k.ok ? `${log200k.latencyMs}ms` : 'FAIL';
  const verdict = !cors.browserOK ? 'NO CORS'
    : log200k.ok ? 'KEEP (large-range)'
    : log10k.ok ? 'FALLBACK (10k only)'
    : 'NO getLogs';
  console.log(`${p.name.padEnd(20)} ${corsTag}     ${l10.padEnd(8)} ${l200.padEnd(8)} ${verdict}`);
  results.push({ name: p.name, url: p.url, cors: cors.browserOK, log10k: log10k.ok, log200k: log200k.ok, latency10k: log10k.latencyMs, latency200k: log200k.latencyMs });
}

console.log('');
console.log('=== Summary ===');
const browserUsable = results.filter((r) => r.cors);
const largeRange = results.filter((r) => r.cors && r.log200k);
const fallback = results.filter((r) => r.cors && r.log10k && !r.log200k);
console.log(`  ${browserUsable.length}/${results.length} CORS-compatible`);
console.log(`  ${largeRange.length} support 200k-block eth_getLogs (large-range fast path)`);
console.log(`  ${fallback.length} only support ≤10k eth_getLogs (fallback)`);

if (largeRange.length === 0) {
  console.log('');
  console.log('  ⚠ NO browser-compatible large-range provider — must fall back to 10k chunks only');
}
