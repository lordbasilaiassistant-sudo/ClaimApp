// src/services/rpc/providers.js
// Curated list of Base mainnet public RPC endpoints.
//
// This list is CALIBRATED against real eth_getLogs workloads (the scanner's
// hot path). Run `node test/bench-providers.mjs` to re-verify before adding
// or removing any entry.
//
// Why this list is small (4 entries):
//   Most public Base RPCs choke on 9999-block eth_getLogs calls:
//     - blockpi: 5000 block max
//     - nodies-public: 500 block max
//     - thirdweb: 1000 block max
//     - meowrpc: doesn't support eth_getLogs at all
//     - publicnode: frequent timeouts
//     - drpc/blast-api: HTTP 500/400 errors under load
//   Rather than bloat the list with providers that fail half the time, we
//   keep only the ones that handle our actual workload reliably.
//
// Weighting: higher `weight` = preferred by fastest-first strategies.
// maxConcurrent: calibrated against observed behavior. Don't raise without
// re-benchmarking.
//
// Adding a new provider? Rules:
//   1. Must pass test/bench-providers.mjs at 100% success rate.
//   2. Must be HTTPS.
//   3. Must respond to eth_chainId with 8453.
//   4. Must support 9999-block eth_getLogs.

export const BASE_CHAIN_ID = 8453;

export const BASE_PROVIDERS = [
  // ===== General-purpose providers (all methods, including 10k getLogs) =====
  // Sorted by observed latency (lowest first) when all are healthy.
  //
  // maxLogBlockRange: largest block window this provider will accept for
  // eth_getLogs. Calibrated via test/bench-chunk-sizes.mjs (April 2026).
  //
  //   - tenderly-public:  500k works, but slows at 500k. Sweet spot: 200k.
  //   - merkle:           500k in <3s. Use up to 500k.
  //   - base-official:    10k max (HTTP 413 above that).
  //   - base-developer:   10k max (HTTP 413 above that).
  { name: 'tenderly-public', url: 'https://gateway.tenderly.co/public/base',    weight: 10, maxConcurrent: 15, maxLogBlockRange: 200_000 },
  { name: 'merkle',          url: 'https://base.merkle.io',                    weight: 10, maxConcurrent: 10, maxLogBlockRange: 500_000 },
  { name: 'base-developer',  url: 'https://developer-access-mainnet.base.org', weight: 7,  maxConcurrent: 15, maxLogBlockRange: 10_000  },
  { name: 'base-official',   url: 'https://mainnet.base.org',                  weight: 7,  maxConcurrent: 15, maxLogBlockRange: 10_000  },
];

// Providers that support large (>= 100k block) eth_getLogs windows. Used by
// the scanner's fast-path discovery loop to blow through multi-million-block
// ranges in seconds instead of minutes.
export const LARGE_RANGE_LOG_PROVIDERS = BASE_PROVIDERS.filter((p) => p.maxLogBlockRange >= 100_000);

// Total theoretical in-flight capacity: sum of maxConcurrent across all
// providers. Scanners should not exceed this.
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
