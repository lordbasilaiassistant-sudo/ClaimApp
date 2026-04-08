// src/utils/format.js
// Display helpers. Keep formatting logic out of the UI components.

import { ethers } from '../vendor/ethers.js';

/**
 * Format a token amount with a max of `places` decimals, trimming trailing zeros.
 * @param {bigint} amount
 * @param {number} decimals
 * @param {number} [places=6]
 */
export function formatAmount(amount, decimals, places = 6) {
  if (amount === 0n) return '0';
  const full = ethers.formatUnits(amount, decimals);
  const [intPart, fracPart = ''] = full.split('.');
  const trimmed = fracPart.slice(0, places).replace(/0+$/, '');
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

/**
 * Shorten an address for display: 0xabcd…1234
 */
export function shortAddress(addr) {
  if (!addr) return '';
  const s = String(addr);
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Convert a bigint wei value to an approximate USD string. Caller provides
 * the ETH price — we never fetch prices automatically (no third-party calls).
 */
export function weiToUsd(wei, ethPriceUsd) {
  if (!ethPriceUsd || wei === 0n) return '$0.00';
  const eth = Number(ethers.formatEther(wei));
  return '$' + (eth * ethPriceUsd).toFixed(4);
}

/**
 * Link to Basescan for a transaction hash or address.
 */
export function basescanTxUrl(hash) {
  return `https://basescan.org/tx/${hash}`;
}
export function basescanAddressUrl(addr) {
  return `https://basescan.org/address/${addr}`;
}
export function basescanTokenUrl(addr) {
  return `https://basescan.org/token/${addr}`;
}
