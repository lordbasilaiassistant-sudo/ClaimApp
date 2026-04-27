// src/services/rpc/auto-prune.js
//
// Persistent failure tracking for RPC providers across runs.
//
// Rule (per Anthony, 2026-04-27): each provider gets ONE try per request.
// If a provider fails in two SEPARATE runs (sessions on browser, script
// invocations on Node) it is marked permanently disabled and excluded
// from the active provider set.
//
// Storage:
//   - Browser: localStorage key 'claimapp:rpc-state'
//   - Node:    scan-results/rpc-state.json
//
// State shape:
//   {
//     "providers": {
//       "<name>": {
//         "failedRuns": ["<runId>", "<runId>"],  // unique run IDs that failed
//         "successRuns": int,                    // running counter (info only)
//         "lastFailureAt": ISO string,
//         "disabled": bool                        // sticky once true
//       }
//     }
//   }

const STORAGE_KEY = 'claimapp:rpc-state';
const FAILURE_THRESHOLD = 2;
const RUN_ID = (() => {
  // Stable per session/script invocation. Browser: page-load-scoped.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `run_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
})();

// Process.versions.node is the authoritative Node check. We don't use a
// `typeof window === 'undefined'` test because the Node test harness shims
// `globalThis.window` so wallet.js can attach unload listeners.
function isNode() {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

// Eager import on Node so the file reads/writes are synchronous everywhere
// downstream. Browser path simply leaves these undefined.
let _node_fs = null;
let _node_path = null;
let _node_state_path = null;

if (isNode()) {
  _node_fs = await import('node:fs');
  _node_path = await import('node:path');
  _node_state_path = _node_path.resolve(process.cwd(), 'scan-results/rpc-state.json');
}

function readState() {
  if (isNode()) {
    if (!_node_fs || !_node_state_path) return { providers: {} };
    try {
      const raw = _node_fs.readFileSync(_node_state_path, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { providers: {} };
    }
  }
  try {
    if (typeof localStorage === 'undefined') return { providers: {} };
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

function writeState(state) {
  if (isNode()) {
    if (!_node_fs || !_node_state_path) return;
    try {
      const dir = _node_path.dirname(_node_state_path);
      if (!_node_fs.existsSync(dir)) _node_fs.mkdirSync(dir, { recursive: true });
      _node_fs.writeFileSync(_node_state_path, JSON.stringify(state, null, 2));
    } catch {
      // best-effort
    }
    return;
  }
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / privacy mode
  }
}

// Synchronous load on first access (Node imports happened at top-level).
let _state = readState();

export async function init() {
  return _state;
}

function ensureProvider(name) {
  if (!_state) _state = readState();
  if (!_state.providers[name]) {
    _state.providers[name] = {
      failedRuns: [],
      successRuns: 0,
      lastFailureAt: null,
      disabled: false,
    };
  }
  return _state.providers[name];
}

export function recordFailure(name) {
  const p = ensureProvider(name);
  if (!p.failedRuns.includes(RUN_ID)) {
    p.failedRuns.push(RUN_ID);
    p.lastFailureAt = new Date().toISOString();
  }
  if (p.failedRuns.length >= FAILURE_THRESHOLD) {
    p.disabled = true;
  }
  writeState(_state);
}

export function recordSuccess(name) {
  const p = ensureProvider(name);
  p.successRuns++;
  writeState(_state);
}

export function isDisabled(name) {
  if (!_state) return false;
  return !!_state.providers[name]?.disabled;
}

export function getState() {
  if (!_state) _state = readState();
  return _state;
}

export function reset() {
  _state = { providers: {} };
  writeState(_state);
}

export function filterActive(providers) {
  return providers.filter((p) => !isDisabled(p.name));
}
