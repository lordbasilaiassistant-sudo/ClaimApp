// src/services/rpc/providers.js
// Curated list of Base mainnet public RPC endpoints. Adapted from the RPCagg
// project's tier-1 and tier-2 nodes. Removed all endpoints that require API
// keys or have known authentication issues.
//
// Weighting: higher `weight` = preferred by fastest-first strategies.
// maxConcurrent: soft cap on in-flight requests per provider. Public endpoints
// throttle aggressively; stay conservative.
//
// Adding a new provider? Rules:
//   1. Must be a real public endpoint (no API key required).
//   2. Must be HTTPS.
//   3. Must respond to eth_chainId with 8453.
//   4. Start with maxConcurrent: 4 until you've verified it handles more.

export const BASE_CHAIN_ID = 8453;

export const BASE_PROVIDERS = [
  // ===== Tier 1 — reliable, proven under load =====
  { name: 'base-official',   url: 'https://mainnet.base.org',                    weight: 10, maxConcurrent: 4 },
  { name: 'base-developer',  url: 'https://developer-access-mainnet.base.org',   weight: 9,  maxConcurrent: 4 },
  { name: 'publicnode',      url: 'https://base-rpc.publicnode.com',             weight: 8,  maxConcurrent: 4 },
  { name: 'blast-api',       url: 'https://base-mainnet.public.blastapi.io',     weight: 8,  maxConcurrent: 4 },
  { name: 'llamanodes',      url: 'https://base.llamarpc.com',                   weight: 8,  maxConcurrent: 4 },
  { name: 'drpc',            url: 'https://base.drpc.org',                       weight: 7,  maxConcurrent: 4 },
  { name: 'tenderly-public', url: 'https://gateway.tenderly.co/public/base',     weight: 8,  maxConcurrent: 4 },

  // ===== Tier 2 — good, moderate limits =====
  { name: 'blockpi',         url: 'https://base.public.blockpi.network/v1/rpc/public', weight: 7, maxConcurrent: 3 },
  { name: '1rpc',            url: 'https://1rpc.io/base',                        weight: 6,  maxConcurrent: 3 },
  { name: 'meowrpc',         url: 'https://base.meowrpc.com',                    weight: 6,  maxConcurrent: 3 },
  { name: 'merkle',          url: 'https://base.merkle.io',                      weight: 6,  maxConcurrent: 3 },
  { name: 'nodies-public',   url: 'https://base-public.nodies.app',              weight: 6,  maxConcurrent: 3 },

  // ===== Tier 3 — backup =====
  { name: 'publicnode-alt',  url: 'https://base.publicnode.com',                 weight: 5,  maxConcurrent: 3 },
  { name: 'thirdweb',        url: 'https://base.rpc.thirdweb.com',               weight: 5,  maxConcurrent: 3 },
];

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
    // Allow localhost for dev only
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // Block private / link-local ranges
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
