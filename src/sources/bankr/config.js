// src/sources/bankr/config.js
// Bankr / Doppler V4 contract addresses on Base.
//
// STATUS: STUB — needs on-chain research before this module is functional.
// The scanner currently returns a single informational row explaining the
// limitation rather than attempting (and failing) to claim.
//
// What we know:
//   * Bankr launches use Doppler V4, which is built on Uniswap V4 hooks.
//   * Pool IDs are bytes32 keccak hashes of the PoolKey struct.
//   * Fee collection is intended to be permissionless via Doppler's locker
//     (comment in Agent0/tools/claim-rewards.js says
//     "Doppler `collectFees(poolId)` call is permissionless").
//   * Bankr's fee claim API (`bankr fees claim`) is off-chain and not
//     usable from a browser.
//
// What we need:
//   * The Doppler airlock / fee locker contract address on Base mainnet
//   * The exact function signature of the on-chain claim call
//   * The event emitted on Doppler launch (for scanner-side discovery)
//   * A way to resolve a wallet → its Bankr/Doppler poolIds without a
//     centralized indexer (on-chain event scan filter by creator topic)

export const BANKR = {
  chainId: 8453,

  // TODO: fill in Doppler airlock / locker on Base mainnet
  airlock: null,

  // Doppler uses Uniswap V4 under the hood. These are the known V4 addresses
  // on Base mainnet (same as Clanker v4 uses).
  poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  positionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',

  weth: '0x4200000000000000000000000000000000000006',
};
