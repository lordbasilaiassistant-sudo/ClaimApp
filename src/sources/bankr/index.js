// src/sources/bankr/index.js
// Bankr / Doppler V4 source adapter — STUB implementation.
//
// Registered in src/sources/index.js but currently returns a placeholder
// item that tells the user why this source isn't scanning real data yet.
// Once we have the Doppler airlock contract address and claim function
// signature, replace the stub scan() with a real event-based discovery
// path. See issue #8 in the repo for the research backlog.

const bankr = {
  id: 'bankr',
  name: 'Bankr / Doppler V4',
  chainId: 8453,
  description:
    'Discover and claim LP fees from Bankr launches (Doppler V4 on Base). ' +
    'Coming soon — needs on-chain contract info.',

  /**
   * Stub scan. Returns a single informational item so users see that the
   * source is registered but not yet operational. This is better than
   * silently returning empty — users would otherwise think they have
   * no Bankr launches even if they do.
   */
  async scan(address) {
    return {
      source: 'bankr',
      address,
      items: [
        {
          source: 'bankr',
          id: 'bankr:stub',
          version: 'stub',
          name: 'Bankr / Doppler V4 support is a work in progress',
          symbol: 'WIP',
          tokenAddress: '0x0000000000000000000000000000000000000000',
          claimable: [],
          legacyUnknownBalance: false,
          meta: {
            note: 'See issue #8 on GitHub — needs Doppler airlock address + claim ABI.',
            stub: true,
          },
        },
      ],
      wethClaimable: 0n,
      failedRanges: [],
      complete: true,
    };
  },

  async claimItem(item) {
    return {
      ok: false,
      txs: [],
      error: 'Bankr claims not yet supported. See issue #8 on GitHub.',
    };
  },
};

export default bankr;
