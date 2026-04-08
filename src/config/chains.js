// src/config/chains.js
// Network metadata for Base mainnet. RPC endpoints themselves live in
// src/services/rpc/providers.js — keep that file as the single source of
// truth for URLs so the CSP in index.html only has to allowlist one set.

export const BASE = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://basescan.org',
  contracts: {
    // Multicall3 — same address across all EVM chains
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    weth: '0x4200000000000000000000000000000000000006',
  },
};

export const DEFAULT_CHAIN = BASE;
