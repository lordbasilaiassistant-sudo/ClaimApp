// src/sources/bankr/config.js
// Doppler V4 (used by Bankr) contract addresses on Base mainnet.
//
// Verified against Agent0/BankrRewards/scan-and-claim.js which is a
// production script that successfully claims fees from these contracts.

export const BANKR = {
  chainId: 8453,

  // Doppler V4 "DecayMulticurve" contract — THE contract for Bankr launches.
  // It's both a Uniswap V4 hook AND the fee locker. Pool state lives here.
  decay: '0xd59ce43e53d69f190e15d9822fb4540dccc91178',

  // Uniswap V4 PoolManager on Base (shared with Clanker v4).
  poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',

  weth: '0x4200000000000000000000000000000000000006',

  // Scan window for Release events. The BankrRewards/scan-and-claim.js
  // script defaults to 42_100_000 which is approximately when Doppler
  // started seeing activity on Base. Safe lower bound: 42_000_000.
  startBlock: 42_000_000n,
};
