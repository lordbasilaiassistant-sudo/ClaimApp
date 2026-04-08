// src/services/wallet.js
// Ephemeral wallet service — holds at most ONE wallet in module-private memory.
//
// SECURITY CONTRACT:
//   1. Private keys NEVER touch localStorage, sessionStorage, cookies, or the DOM.
//   2. Private keys NEVER cross the network — all signing is local via ethers.
//   3. Private keys NEVER appear in console.log, thrown errors, or analytics.
//   4. The wallet is cleared on tab close, refresh, or explicit clearWallet().
//   5. Only the address is ever exposed to the rest of the app.
//   6. Read-only mode (address only) is a first-class citizen — signing is
//      explicitly opt-in per transaction.

import { ethers } from '../vendor/ethers.js';
import { getProvider } from './provider.js';

// Module-private — never exported, never referenced outside this file.
let _wallet = null;
let _readOnlyAddress = null;

const addressListeners = new Set();

function notifyAddress() {
  const addr = getAddress();
  for (const fn of addressListeners) {
    try { fn(addr); } catch { /* listener failure shouldn't break others */ }
  }
}

/**
 * Subscribe to address changes. Returns an unsubscribe fn.
 */
export function onAddressChange(fn) {
  addressListeners.add(fn);
  return () => addressListeners.delete(fn);
}

/**
 * Load a wallet from a private key. Overwrites any existing wallet.
 * @param {string} privateKey — 0x-prefixed 32-byte hex
 * @throws if the key is malformed
 */
export function loadPrivateKey(privateKey) {
  const trimmed = (privateKey || '').trim();
  if (!trimmed) throw new Error('Empty private key');

  // ethers.Wallet will throw on invalid keys — let it.
  const w = new ethers.Wallet(trimmed, getProvider());
  _wallet = w;
  _readOnlyAddress = null;
  notifyAddress();
}

/**
 * Set a read-only address (no signing ability). Use for scanning other wallets
 * without holding their keys.
 */
export function setReadOnlyAddress(address) {
  const addr = ethers.getAddress((address || '').trim()); // checksums + validates
  _readOnlyAddress = addr;
  _wallet = null;
  notifyAddress();
}

/**
 * Wipe all wallet state. Call on tab close, logout, or mode switch.
 */
export function clearWallet() {
  _wallet = null;
  _readOnlyAddress = null;
  notifyAddress();
}

/**
 * @returns {string | null} current address (from wallet or read-only), checksummed
 */
export function getAddress() {
  if (_wallet) return _wallet.address;
  if (_readOnlyAddress) return _readOnlyAddress;
  return null;
}

/**
 * @returns {boolean} true if we have a wallet capable of signing
 */
export function canSign() {
  return _wallet !== null;
}

/**
 * Get the signer for writing transactions.
 * Throws if we're in read-only mode — callers must check canSign() first.
 * @returns {ethers.Wallet}
 */
export function getSigner() {
  if (!_wallet) throw new Error('No signer available (read-only mode)');
  return _wallet;
}

// Belt-and-suspenders: wipe on page unload.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', clearWallet);
  // Also clear if the tab goes to bfcache and comes back.
  window.addEventListener('pagehide', clearWallet);
}
