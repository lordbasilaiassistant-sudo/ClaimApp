// src/services/rpc/providers.js
// Browser-verified Base mainnet RPC endpoints.
//
// CRITICAL: every entry here MUST pass test/bench-cors.mjs — a provider that
// works from node but rejects OPTIONS preflight is USELESS in a browser,
// because the browser blocks the POST before it's sent. Merkle looks fast
// in node tests but returns 405 on preflight and fails silently in the
// actual deployed app. Do NOT re-add it unless Merkle fixes their CORS.
//
// Re-run `node test/bench-cors.mjs` any time you add or remove a provider.
//
// maxLogBlockRange is the largest eth_getLogs window the provider accepts
// (verified empirically). We use this to route large-range scans to the
// provider(s) that can actually handle them.

export const BASE_CHAIN_ID = 8453;

// Bench results from test/bench-cors.mjs (2026-04-27, refresh after RPC research).
// Every entry below was empirically verified for browser CORS + eth_getLogs.
//
// Tenderly remains primary because it's been most reliable in production.
// Sentio is the strongest new addition: 200k-block eth_getLogs at ~1s,
// faster than tenderly on the bench, gives us large-range redundancy.
export const BASE_PROVIDERS = [
  // ===== Large-range (200k-block eth_getLogs) =====
  { name: 'tenderly-public', url: 'https://gateway.tenderly.co/public/base',    weight: 10, maxConcurrent: 8,  maxLogBlockRange: 200_000 },
  { name: 'sentio',          url: 'https://rpc.sentio.xyz/base',                weight: 9,  maxConcurrent: 6,  maxLogBlockRange: 200_000 },
  // sequence supports 200k but ~12s latency on bench → keep at 10k tier instead

  // ===== 10k-range fallback (CORS-verified) =====
  { name: 'base-developer',  url: 'https://developer-access-mainnet.base.org', weight: 8, maxConcurrent: 15, maxLogBlockRange: 9_999 },
  { name: 'base-official',   url: 'https://mainnet.base.org',                  weight: 7, maxConcurrent: 15, maxLogBlockRange: 9_999 },
  { name: 'sequence',        url: 'https://nodes.sequence.app/base',           weight: 6, maxConcurrent: 8,  maxLogBlockRange: 9_999 },
  { name: 'subquery-public', url: 'https://base.rpc.subquery.network/public',  weight: 6, maxConcurrent: 6,  maxLogBlockRange: 9_999 },
  { name: 'pocket',          url: 'https://base.api.pocket.network',           weight: 5, maxConcurrent: 6,  maxLogBlockRange: 9_999 },
  { name: 'publicnode',      url: 'https://base.publicnode.com',               weight: 5, maxConcurrent: 6,  maxLogBlockRange: 9_999 },
  { name: '1rpc',            url: 'https://1rpc.io/base',                      weight: 4, maxConcurrent: 6,  maxLogBlockRange: 9_999 },
  { name: 'bloxroute',       url: 'https://base.rpc.blxrbdn.com',              weight: 3, maxConcurrent: 4,  maxLogBlockRange: 9_999 }, // slow (~10s)
];

// Providers that support large (>= 100k block) eth_getLogs windows.
export const LARGE_RANGE_LOG_PROVIDERS = BASE_PROVIDERS.filter((p) => p.maxLogBlockRange >= 100_000);

// Providers that support at least 10k-block eth_getLogs — the fallback set
// when a large-range chunk fails and we need to sub-divide.
export const SMALL_RANGE_LOG_PROVIDERS = BASE_PROVIDERS.filter(
  (p) => p.maxLogBlockRange >= 9_999 && p.maxLogBlockRange < 100_000,
);

export const TOTAL_SLOT_CAPACITY = BASE_PROVIDERS.reduce((sum, p) => sum + p.maxConcurrent, 0);

/**
 * Validate an RPC URL the user is trying to add. Blocks private ranges and
 * non-HTTPS endpoints (except localhost for dev).
 */
export function validateProviderUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Invalid protocol: ${parsed.protocol} (must be http/https)`);
    }
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      host.startsWith('172.16.') ||
      host.startsWith('172.17.') ||
      host.startsWith('172.18.') ||
      host.startsWith('172.19.') ||
      host.startsWith('172.2') ||
      host.startsWith('172.30.') ||
      host.startsWith('172.31.') ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    ) {
      throw new Error(`Private/internal URL not allowed: ${host}`);
    }
    return true;
  } catch (err) {
    if (err.message.startsWith('Invalid') || err.message.startsWith('Private')) throw err;
    throw new Error(`Invalid URL: ${url}`);
  }
}
