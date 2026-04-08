// src/sources/clanker/config.js
// Clanker protocol addresses and constants on Base mainnet.
// Verified against clanker-sdk@latest (node_modules/clanker-sdk/dist/index.js
// ClankerDeployments record) and agent0/tools/vorago-clanker-claims.js.

export const CLANKER = {
  chainId: 8453,

  // ===== v4 (CURRENT / ACTIVE) =====
  // Most launches from 2025+ are v4. FeeLocker-based claim flow:
  //   LpLocker.collectRewards(token)  → sweeps V4 position fees
  //   FeeLocker.claim(feeOwner, token) → withdraws to wallet
  //
  // startBlock is verified against actual factory deploy block via
  // test/find-factory-block.mjs — it's set just BEFORE the deploy so we
  // catch the earliest possible launches without wasting chunks.
  v4: {
    factory:   '0xE85A59c628F7d27878ACeB4bf3b35733630083a9',
    lpLocker:  '0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496',
    feeLocker: '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68',
    vault:     '0x8E845EAd15737bF71904A30BdDD3aEE76d6ADF6C',
    // Factory deployed at block 31,526,699. Start just before.
    startBlock: 31_500_000n,
  },

  // ===== v3_1 (LEGACY, still has claimable fees for older launches) =====
  v3_1: {
    factory:  '0x2A787b2362021cC3eEa3C24C4748a6cD5B687382',
    lpLocker: '0x33e2Eda238edcF470309b8c6D228986A1204c8f9',
    vault:    '0x42A95190B4088C88Dd904d930c79deC1158bF09D',
    // Factory deployed at block 27,733,337. Start just before.
    startBlock: 27_700_000n,
    deepStartBlock: 27_700_000n,
  },

  // ===== v3 (legacy) =====
  v3: {
    factory:  '0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E',
    lpLocker: '0x5eC4f99F342038c67a312a166Ff56e6D70383D86',
    startBlock: 14_000_000n,
  },

  // ===== v2 (legacy, kept for completeness) =====
  v2: {
    factory:  '0x732560fa1d1A76350b1A500155BA978031B53833',
    lpLocker: '0x618A9840691334eE8d24445a4AdA4284Bf42417D',
    startBlock: 12_000_000n,
  },

  // ===== Shared =====
  weth: '0x4200000000000000000000000000000000000006',

  // Clanker's historical "main" proxy referenced in some docs. Kept for reference;
  // the version-specific factories above are what actually emit events.
  legacyMainProxy: '0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb',

  // Max blocks per eth_getLogs call. Public Base RPCs cap around 10k, so
  // 9_999 is the largest safe value without crossing an off-by-one limit.
  logScanChunkSize: 9_999n,

  // Which versions to scan by default. v4 only keeps the MVP fast and
  // respects public RPC limits. Users can opt into legacy versions via a
  // "deep scan" toggle once the UI exposes it.
  //
  // NOTE: we intentionally use PUBLIC RPCs by default. Every chunk is a
  // public good — if we abuse them, other ClaimApp users lose access.
  // See src/services/rpc-throttle.js for the concurrency + retry contract.
  defaultScanVersions: ['v4'],
  deepScanVersions: ['v4', 'v3_1', 'v3', 'v2'],
};
