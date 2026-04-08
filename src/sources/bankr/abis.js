// src/sources/bankr/abis.js
// Doppler V4 DecayMulticurve + helper ABIs.
// Verified against Agent0/BankrRewards/scan-and-claim.js (production claim script).

// ===== DecayMulticurve =====
// Pool state + fee accounting + claim. Everything lives in this single contract.
//
// Read functions (for balance queries via Multicall3):
//   getShares(poolId, beneficiary) → uint256
//     Returns the beneficiary's share count for that pool.
//   getCumulatedFees0(poolId) → uint256
//     Lifetime fees accumulated in token0 (the launched token).
//   getCumulatedFees1(poolId) → uint256
//     Lifetime fees accumulated in token1 (typically WETH).
//   getLastCumulatedFees0(poolId, beneficiary) → uint256
//     Beneficiary's checkpoint for token0 — the last value they were paid against.
//   getLastCumulatedFees1(poolId, beneficiary) → uint256
//     Same but for token1.
//   getPoolKey(poolId) → (currency0, currency1, fee, tickSpacing, hooks)
//     Resolves the V4 pool key from the poolId hash.
//
// Pending fees formula (per scan-and-claim.js):
//   pending = (cumulated - lastCumulated) * shares / totalShares
//   BUT the script simplifies to: if cumulated > lastCumulated, claimable > 0.
//   Full proportional calculation requires totalShares which isn't exposed
//   cheaply. We use the simplified form and let users see approximate values.
//
// Write:
//   collectFees(poolId) — permissionless; fees flow to the registered beneficiary.
//
// Event:
//   Release(poolId indexed, beneficiary indexed, amount0, amount1)
//   Emitted on successful collectFees. Filter by beneficiary topic[2] to
//   discover pools a wallet has ever received rewards from.
export const DECAY_ABI = [
  'function getPoolKey(bytes32 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
  'function getShares(bytes32 poolId, address beneficiary) view returns (uint256 shares)',
  'function getCumulatedFees0(bytes32 poolId) view returns (uint256)',
  'function getCumulatedFees1(bytes32 poolId) view returns (uint256)',
  'function getLastCumulatedFees0(bytes32 poolId, address beneficiary) view returns (uint256)',
  'function getLastCumulatedFees1(bytes32 poolId, address beneficiary) view returns (uint256)',
  'function collectFees(bytes32 poolId)',
  'event Release(bytes32 indexed poolId, address indexed beneficiary, uint256 amount0, uint256 amount1)',
];

// Minimal ERC20 for token name/symbol/decimals lookups.
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];
