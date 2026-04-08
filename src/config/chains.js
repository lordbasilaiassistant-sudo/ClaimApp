// src/config/chains.js
// Network configurations. Single source of truth for chain metadata.

export const BASE = {
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: 'https://mainnet.base.org',
    fallback: [
      'https://base.llamarpc.com',
      'https://base-rpc.publicnode.com',
      'https://1rpc.io/base',
    ],
  },
  blockExplorer: 'https://basescan.org',
  contracts: {
    // Multicall3 — same address across all EVM chains
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    weth: '0x4200000000000000000000000000000000000006',
  },
};

export const DEFAULT_CHAIN = BASE;
