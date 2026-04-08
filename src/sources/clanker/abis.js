// src/sources/clanker/abis.js
// Human-readable ABIs for Clanker protocol contracts on Base.
// Using ethers' string-ABI format keeps the repo small and auditable.

// ===== FeeLocker (v4) =====
// Holds claimable fees indexed by (feeOwner, rewardToken).
// Both WETH (paired side, shared across all launches) and each clanker token
// accrue fees here after LpLocker.collectRewards() is called.
//
// The StoreTokens event is the KEY discovery mechanism: filter by feeOwner
// to find every token that has EVER deposited fees for a wallet. This works
// whether the wallet is the launch admin OR just a fee recipient.
export const FEE_LOCKER_ABI = [
  // Read functions
  'function availableFees(address feeOwner, address token) view returns (uint256)',
  'function feesToClaim(address feeOwner, address token) view returns (uint256 balance)',
  // Write
  'function claim(address feeOwner, address token)',
  // Events (both indexed by feeOwner as topic[1])
  'event StoreTokens(address sender, address indexed feeOwner, address indexed token, uint256 balance, uint256 amount)',
  'event ClaimTokens(address indexed feeOwner, address indexed token, uint256 amountClaimed)',
];

// ===== LpLocker (v4) =====
// Holds the Uniswap V4 LP position NFTs. Anyone can call collectRewards to
// sweep pool fees into the FeeLocker. collectRewardsWithoutUnlock keeps the
// position locked (preferred — we're not trying to exit the position).
export const LP_LOCKER_ABI = [
  'function collectRewards(address token)',
  'function collectRewardsWithoutUnlock(address token)',
];

// Cached iface for the factory TokenCreated event — still used as a
// SECONDARY discovery path alongside FeeLocker StoreTokens.
// Launches you admin but nobody's collected fees on yet only show up here;
// launches where fees have landed in FeeLocker also show up in StoreTokens.
// Scanning both and merging gives complete coverage.

// ===== Legacy Clanker (v2, v3, v3_1) Factory — claimRewards function =====
// Source: clanker-sdk/dist/legacyFeeClaims/index.js line 1018-1024
// For v2/v3/v3_1 launches, fees are claimed by calling the FACTORY itself
// (not a separate locker like v4). Single function, single argument.
//
// There is NO corresponding view function to check pending fees — the
// only way to know if rewards are claimable is to call claimRewards() and
// see if it reverts (empty) or succeeds (paid out). We handle that in the
// claimer with a try/catch.
export const CLANKER_LEGACY_FACTORY_CLAIM_ABI = [
  'function claimRewards(address token)',
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

// ===== Clanker v3 / v3_1 / v2 Factory — TokenCreated event =====
// Verified against clanker-sdk write-clanker-contracts-*.d.ts — the older
// event shape is distinct from v4 and has separate fields for the creator
// admin vs the creator reward recipient (which is why fee recipients can
// differ from deployers in legacy launches).
//
// Indexed topics (for RPC-side filtering):
//   topic[1] = tokenAddress (the new token)
//   topic[2] = creatorAdmin (deployer/admin of this launch)
//   topic[3] = interfaceAdmin (the UI/platform that brokered the launch)
//
// Non-indexed payload includes `creatorRewardRecipient` — the wallet that
// actually receives fees. This can be different from creatorAdmin, which
// is why a pure "scan by admin" approach misses launches where the current
// wallet is only the recipient. See CLAUDE.md § Known limitations.
export const CLANKER_V3_FACTORY_ABI = [
  'event TokenCreated(address indexed tokenAddress, address indexed creatorAdmin, address indexed interfaceAdmin, address creatorRewardRecipient, address interfaceRewardRecipient, uint256 positionId, string name, string symbol, int24 startingTickIfToken0IsNewToken, string metadata, uint256 amountTokensBought, uint256 vaultDuration, uint8 vaultPercentage, address msgSender)',
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
