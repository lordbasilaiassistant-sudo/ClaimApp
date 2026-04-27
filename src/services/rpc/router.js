// src/services/rpc/router.js
// Multi-provider JSON-RPC router with failover, 429 cooldown, and per-provider
// concurrency caps. Adapted from RPCagg's router with browser-friendly simplifications.
//
// Behavior:
//   * Pick the best-available provider via ProviderHealth.getRanked().
//   * Send the request with a timeout (AbortController).
//   * On success → record latency, return result.
//   * On 429 → mark provider in cooldown, retry on next provider.
//   * On timeout/network error → record failure, retry on next provider.
//   * On "execution reverted" or other permanent errors → return immediately.
//   * Retries cap at MAX_RETRIES across all providers.
//
// This router speaks raw JSON-RPC over HTTP POST. A custom ethers provider
// (see ./ethers-adapter.js) wraps this so the rest of the app uses ethers normally.

import { BASE_PROVIDERS, BASE_CHAIN_ID } from './providers.js';
import { ProviderHealth } from './health.js';
import * as autoPrune from './auto-prune.js';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 4;

const PERMANENT_ERROR_PATTERNS = [
  'execution reverted',
  'invalid argument',
  'method not found',
  'invalid params',
  'block range too large',
  'out of gas',
];

export class RpcRouter {
  constructor(providers = BASE_PROVIDERS) {
    // Drop providers that have failed in 2+ separate runs (auto-prune).
    // Permanent — to recover a provider, call autoPrune.reset() or edit
    // the persisted state file.
    this.providers = autoPrune.filterActive(providers);
    this.health = new ProviderHealth(this.providers);
    this.chainId = BASE_CHAIN_ID;
    this.stats = { total: 0, success: 0, errors: 0, retries: 0, rateLimits: 0 };
  }

  /**
   * Send a JSON-RPC request with multi-provider failover.
   * @param {{method: string, params: any[]}} payload
   * @returns {Promise<any>} the JSON-RPC `result` field
   */
  async send(payload) {
    this.stats.total++;
    const body = {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: payload.method,
      params: payload.params || [],
    };

    const excludeSet = new Set();
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const ranked = this.health.getRanked(excludeSet);
      if (ranked.length === 0) {
        // Nothing healthy → break and throw below
        break;
      }
      const provider = ranked[0];

      if (!this.health.acquireSlot(provider.name)) {
        // All slots taken on this provider → exclude and try another
        excludeSet.add(provider.name);
        continue;
      }

      try {
        const result = await this._sendToProvider(provider, body);
        this.health.releaseSlot(provider.name);

        if (result.error) {
          const msg = (result.error.message || '').toLowerCase();

          // Rate limit detected in RPC response
          if (msg.includes('rate') || msg.includes('limit') || msg.includes('too many')) {
            this.health.recordRateLimit(provider.name);
            this.stats.rateLimits++;
            excludeSet.add(provider.name);
            lastError = new Error(`rate limited: ${result.error.message}`);
            this.stats.retries++;
            continue;
          }

          // Permanent error → return as-is (caller will handle)
          if (PERMANENT_ERROR_PATTERNS.some((p) => msg.includes(p))) {
            this.stats.errors++;
            const err = new Error(result.error.message);
            err.code = result.error.code;
            err.data = result.error.data;
            throw err;
          }

          // Unknown RPC error → try another provider
          this.health.recordFailure(provider.name, new Error(msg));
          excludeSet.add(provider.name);
          lastError = new Error(result.error.message || 'rpc error');
          this.stats.retries++;
          continue;
        }

        // Success
        this.stats.success++;
        return result.result;
      } catch (err) {
        this.health.releaseSlot(provider.name);
        const errMsg = String(err.message || err).toLowerCase();

        if (errMsg.includes('429') || errMsg.includes('rate limit')) {
          this.health.recordRateLimit(provider.name);
          this.stats.rateLimits++;
        } else {
          this.health.recordFailure(provider.name, err);
        }

        // If the caller threw a permanent error, propagate it
        if (err.code && PERMANENT_ERROR_PATTERNS.some((p) => errMsg.includes(p))) {
          throw err;
        }

        excludeSet.add(provider.name);
        lastError = err;
        this.stats.retries++;
      }
    }

    this.stats.errors++;
    const msg = lastError
      ? `all providers failed: ${lastError.message}`
      : 'no healthy providers available';
    throw new Error(msg);
  }

  async _sendToProvider(provider, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const start = Date.now();

    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new Error('HTTP 429');
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      const latency = Date.now() - start;
      this.health.recordSuccess(provider.name, latency);
      autoPrune.recordSuccess(provider.name);
      return json;
    } catch (err) {
      autoPrune.recordFailure(provider.name);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  getStats() {
    return {
      ...this.stats,
      providers: this.health.getStats(),
    };
  }
}

// Module-singleton router (lazy-init)
let _router = null;
// Session-only custom providers (set via addCustomProvider, cleared on reset/reload)
const _customProviders = [];

export function getRouter() {
  if (!_router) {
    _router = new RpcRouter([..._customProviders, ...BASE_PROVIDERS]);
  }
  return _router;
}

export function resetRouter() {
  _router = null;
}

/**
 * Add a custom RPC provider at runtime. Session-only — never persisted.
 * Prepends to the provider list with high weight so it's picked first.
 * Recreates the router so the new provider takes effect immediately.
 *
 * @param {{name: string, url: string, maxConcurrent?: number, maxLogBlockRange?: number}} provider
 */
export function addCustomProvider(provider) {
  const normalized = {
    name: provider.name || 'custom',
    url: provider.url,
    weight: 100, // beats all defaults
    maxConcurrent: provider.maxConcurrent || 5,
    maxLogBlockRange: provider.maxLogBlockRange || 9_999,
  };
  // Replace if same name already exists
  const idx = _customProviders.findIndex((p) => p.name === normalized.name);
  if (idx >= 0) _customProviders[idx] = normalized;
  else _customProviders.unshift(normalized);
  resetRouter();
}

export function listCustomProviders() {
  return [..._customProviders];
}

export function removeCustomProvider(name) {
  const idx = _customProviders.findIndex((p) => p.name === name);
  if (idx >= 0) {
    _customProviders.splice(idx, 1);
    resetRouter();
  }
}
