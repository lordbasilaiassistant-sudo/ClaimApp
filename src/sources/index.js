// src/sources/index.js
// Source registry. Every claim platform adapter registers itself here so the
// core scanner can iterate them without knowing their internals.
//
// To add a new source (e.g. Bankr, Zora, Doppler):
//   1. Create src/sources/<name>/ with the same shape as src/sources/clanker/
//   2. Export a default object matching the SourceAdapter contract below
//   3. Add `import x from './<name>/index.js';` here and push to SOURCES

import clanker from './clanker/index.js';
// import bankr from './bankr/index.js';
// ^ Bankr / Doppler V4 source is a stub (see src/sources/bankr/ and
// GitHub issue #8). Not registered until on-chain contract addresses
// and claim ABI are available. Uncomment and push to SOURCES below
// once the research is done.

/**
 * SourceAdapter contract — every source module MUST export an object with:
 *
 *   id:          string   — stable slug, e.g. 'clanker'
 *   name:        string   — human name, e.g. 'Clanker'
 *   chainId:     number   — EVM chain this source runs on
 *   description: string   — one-liner shown in the UI
 *
 *   scan(address):  async (string) => ScanResult
 *     Returns all launches + claimables for the given wallet.
 *     MUST be read-only (no signing required).
 *
 *   claim(item, signer):  async (ClaimItem, ethers.Wallet) => ClaimReceipt
 *     Executes a single claim. MAY perform multiple transactions internally
 *     (e.g. Clanker needs collectRewards → claim).
 *
 *   claimAll(items, signer):  async (ClaimItem[], ethers.Wallet) => ClaimReceipt[]
 *     Batch claim. May be more efficient than per-item claims.
 *
 * ScanResult shape:
 *   {
 *     source: string,              // source.id
 *     address: string,             // scanned wallet
 *     items: ClaimItem[],          // all launches/positions found
 *     totals: { [symbol]: bigint } // aggregated claimable per reward token
 *     error?: string               // non-fatal error message
 *   }
 *
 * ClaimItem shape:
 *   {
 *     source: string,              // source.id
 *     id: string,                  // unique within source (e.g. token address)
 *     name: string,                // human label
 *     symbol: string,
 *     tokenAddress: string,        // the Clanker/Zora/etc token contract
 *     claimable: [                 // reward tokens with non-zero balance
 *       { token: string, symbol: string, amount: bigint, decimals: number }
 *     ],
 *     meta: object                 // source-specific extras (launchBlock, etc.)
 *   }
 */

export const SOURCES = [clanker];

export function getSource(id) {
  return SOURCES.find((s) => s.id === id) || null;
}
