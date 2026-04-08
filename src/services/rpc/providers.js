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

export const BASE_PROVIDERS = [
  // ===== Large-range (200k+ block eth_getLogs) =====
  // Tenderly's public gateway is currently the ONLY public Base RPC that
  // both (a) supports 200k-block eth_getLogs and (b) has browser-safe CORS.
  // This is a single point of failure — if tenderly is down, scanning falls
  // back to the 10k providers below (slower but functional).
  // Lowered from 15 → 8: tenderly rate-limits aggressively. 8 concurrent
  // 200k-block eth_getLogs is the sweet spot between speed and 429 avoidance
  // (verified empirically by stress-testing the treasury scan).
  { name: 'tenderly-public', url: 'https://gateway.tenderly.co/public/base',    weight: 10, maxConcurrent: 8,  maxLogBlockRange: 200_000 },

  // ===== 10k-range fallback (CORS-verified) =====
  // These cap at ~10k block eth_getLogs windows. Used for:
  //   1. General RPC calls (eth_call, eth_blockNumber, balance reads)
  //   2. Fallback when tenderly fails a large-range chunk
  //      (we split the failed 200k range into 20 × 10k sub-chunks)
  { name: 'base-developer',  url: 'https://developer-access-mainnet.base.org', weight: 8, maxConcurrent: 15, maxLogBlockRange: 9_999 },
  { name: 'base-official',   url: 'https://mainnet.base.org',                  weight: 7, maxConcurrent: 15, maxLogBlockRange: 9_999 },
  { name: 'sequence',        url: 'https://nodes.sequence.app/base',           weight: 6, maxConcurrent: 8,  maxLogBlockRange: 9_999 },
  { name: '1rpc',            url: 'https://1rpc.io/base',                      weight: 5, maxConcurrent: 6,  maxLogBlockRange: 9_999 },
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
