// src/services/rpc/health.js
// Per-provider health tracking: latency, failures, rate-limit cooldowns,
// and in-flight concurrency slots. Adapted from RPCagg's health checker
// but slimmed down for browser use (no background interval pinging).
//
// Key behaviors:
//   * Track smoothed latency per provider (EWMA).
//   * Recover automatically after CONSECUTIVE_FAILURES threshold.
//   * 429 triggers exponential cooldown (1s → 2s → 4s → 8s → cap 60s).
//   * Each provider has a concurrency slot budget.

const LATENCY_EWMA_ALPHA = 0.3;
const CONSECUTIVE_FAILURES = 3;
const RECOVERY_SUCCESSES = 2;
const BASE_COOLDOWN_MS = 1000;
const MAX_COOLDOWN_MS = 60_000;

export class ProviderHealth {
  constructor(providers) {
    this.providers = providers;
    this.state = new Map();
    for (const p of providers) {
      this.state.set(p.name, {
        healthy: true,
        latency: Infinity,
        smoothedLatency: Infinity,
        failures: 0,
        recoveries: 0,
        // Rate limit
        rateLimited: false,
        rateLimitUntil: 0,
        rateLimitCount: 0,
        // Concurrency slots
        inflight: 0,
        maxConcurrent: p.maxConcurrent || 4,
        // Stats
        totalRequests: 0,
        totalErrors: 0,
        totalSuccess: 0,
      });
    }
  }

  /** Get providers ranked best-to-worst by latency, excluding unhealthy ones. */
  getRanked(excludeSet = new Set()) {
    const now = Date.now();
    const available = [];
    for (const p of this.providers) {
      if (excludeSet.has(p.name)) continue;
      const s = this.state.get(p.name);
      // Skip if in rate-limit cooldown
      if (s.rateLimited && now < s.rateLimitUntil) continue;
      // Skip if unhealthy
      if (!s.healthy) continue;
      // Skip if at concurrency cap
      if (s.inflight >= s.maxConcurrent) continue;
      available.push({ provider: p, state: s });
    }
    // Sort: first by weight (desc), then by smoothed latency (asc)
    available.sort((a, b) => {
      if (a.provider.weight !== b.provider.weight) {
        return b.provider.weight - a.provider.weight;
      }
      return a.state.smoothedLatency - b.state.smoothedLatency;
    });
    return available.map((a) => a.provider);
  }

  acquireSlot(name) {
    const s = this.state.get(name);
    if (!s) return false;
    if (s.inflight >= s.maxConcurrent) return false;
    s.inflight++;
    return true;
  }

  releaseSlot(name) {
    const s = this.state.get(name);
    if (!s) return;
    s.inflight = Math.max(0, s.inflight - 1);
  }

  recordSuccess(name, latencyMs) {
    const s = this.state.get(name);
    if (!s) return;
    s.latency = latencyMs;
    if (s.smoothedLatency === Infinity) {
      s.smoothedLatency = latencyMs;
    } else {
      s.smoothedLatency = LATENCY_EWMA_ALPHA * latencyMs + (1 - LATENCY_EWMA_ALPHA) * s.smoothedLatency;
    }
    s.totalRequests++;
    s.totalSuccess++;
    s.failures = 0;
    // Health recovery
    if (!s.healthy) {
      s.recoveries++;
      if (s.recoveries >= RECOVERY_SUCCESSES) {
        s.healthy = true;
        s.recoveries = 0;
      }
    }
    // Reset rate-limit state on success
    if (s.rateLimited && Date.now() >= s.rateLimitUntil) {
      s.rateLimited = false;
      s.rateLimitCount = 0;
    }
  }

  recordFailure(name, err) {
    const s = this.state.get(name);
    if (!s) return;
    s.totalRequests++;
    s.totalErrors++;
    s.failures++;
    s.recoveries = 0;
    if (s.failures >= CONSECUTIVE_FAILURES) {
      s.healthy = false;
    }
  }

  recordRateLimit(name) {
    const s = this.state.get(name);
    if (!s) return;
    s.totalErrors++;
    s.rateLimited = true;
    s.rateLimitCount++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
    const cooldown = Math.min(
      BASE_COOLDOWN_MS * 2 ** (s.rateLimitCount - 1),
      MAX_COOLDOWN_MS,
    );
    s.rateLimitUntil = Date.now() + cooldown;
  }

  getStats() {
    const providers = [];
    for (const p of this.providers) {
      const s = this.state.get(p.name);
      providers.push({
        name: p.name,
        healthy: s.healthy,
        rateLimited: s.rateLimited,
        inflight: s.inflight,
        latency: Math.round(s.smoothedLatency),
        success: s.totalSuccess,
        errors: s.totalErrors,
      });
    }
    return providers;
  }
}
