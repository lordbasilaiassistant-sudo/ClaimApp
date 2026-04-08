// src/sources/clanker/abis.js
// Human-readable ABIs for Clanker protocol contracts on Base.
// Using ethers' string-ABI format keeps the repo small and auditable.

// ===== FeeLocker (v4) =====
// Holds claimable fees indexed by (feeOwner, rewardToken).
// Both WETH (paired side, shared across all launches) and each clanker token
// accrue fees here after LpLocker.collectRewards() is called.
export const FEE_LOCKER_ABI = [
  'function availableFees(address feeOwner, address token) view returns (uint256)',
  'function feesToClaim(address feeOwner, address token) view returns (uint256 balance)',
  'function claim(address feeOwner, address token)',
];

// ===== LpLocker (v4) =====
// Holds the Uniswap V4 LP position NFTs. Anyone can call collectRewards to
// sweep pool fees into the FeeLocker. collectRewardsWithoutUnlock keeps the
// position locked (preferred — we're not trying to exit the position).
export const LP_LOCKER_ABI = [
  'function collectRewards(address token)',
  'function collectRewardsWithoutUnlock(address token)',
];

// ===== Clanker v4 Factory — TokenCreated event =====
// Event signature (from clanker-sdk@latest v4/index.js):
//   event TokenCreated(
//     address msgSender,           // NOT indexed
//     address indexed tokenAddress,
//     address indexed tokenAdmin,
//     string tokenImage,
//     string tokenName,
//     string tokenSymbol,
//     string tokenMetadata,
//     string tokenContext,
//     int24 startingTick,
//     address poolHook,
//     bytes32 poolId,
//     address pairedToken,
//     address locker,
//     address mevModule,
//     uint256 extensionsSupply,
//     address[] extensions
//   )
// We can filter by tokenAdmin (topic[2]) to find all tokens a wallet admins.
export const CLANKER_V4_FACTORY_ABI = [
  'event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)',
];

// ===== Clanker v3_1 Factory — TokenCreated event =====
// v3_1 event has a different shape. Based on clanker-sdk v3 ABI.
// Fields indexed: tokenAddress, tokenAdmin, msgSender.
export const CLANKER_V3_FACTORY_ABI = [
  'event TokenCreated(address indexed msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, uint256 vault, address pairedToken, address locker, address mevModule)',
];

// ===== ERC20 (minimal) =====
export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
];

// ===== Multicall3 =====
export const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
];
