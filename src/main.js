// src/main.js
// Entry point. Wires the UI to the wallet + source modules.
// Keep this file thin — business logic belongs in services/ and sources/.

import { ethers } from './vendor/ethers.js';
import {
  loadPrivateKey,
  setReadOnlyAddress,
  clearWallet,
  getAddress,
  canSign,
  getSigner,
  onAddressChange,
} from './services/wallet.js';
import { SOURCES, getSource } from './sources/index.js';
import clanker from './sources/clanker/index.js';
import { getRpcStats } from './services/provider.js';
import {
  addCustomProvider,
  listCustomProviders,
  removeCustomProvider,
} from './services/rpc/router.js';
import { validateProviderUrl } from './services/rpc/providers.js';
import {
  formatAmount,
  shortAddress,
  basescanTxUrl,
  basescanTokenUrl,
} from './utils/format.js';
import { $, el, clear, show } from './ui/dom.js';
import { renderPortfolio, hidePortfolio } from './ui/portfolio.js';

// ===== Tab switching =====
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t.dataset.tab === target;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.dataset.panel === target);
      });
    });
  });
}

// ===== Wallet loading =====
function setWalletStatus(message, kind = '') {
  const node = $('#wallet-status');
  clear(node);
  if (!message) {
    node.className = 'wallet-status';
    return;
  }
  node.className = `wallet-status ${kind}`;
  node.appendChild(document.createTextNode(message));
}

function initWalletInputs() {
  // Load by address (read-only)
  $('#load-address-btn').addEventListener('click', () => {
    const addr = $('#address-input').value.trim();
    try {
      setReadOnlyAddress(addr);
      setWalletStatus(`Read-only mode — ${getAddress()}`, 'active');
    } catch (e) {
      setWalletStatus(`Invalid address: ${e.shortMessage || e.message}`, 'error');
    }
  });

  // Reveal-key toggle
  $('#reveal-key').addEventListener('change', (evt) => {
    $('#key-input').type = evt.target.checked ? 'text' : 'password';
  });

  // Load by private key
  $('#load-key-btn').addEventListener('click', () => {
    const key = $('#key-input').value;
    try {
      loadPrivateKey(key);
      // Wipe the input immediately — we have the key in the module closure,
      // no reason to leave it in the DOM.
      $('#key-input').value = '';
      $('#reveal-key').checked = false;
      $('#key-input').type = 'password';
      setWalletStatus(`Signer loaded — ${getAddress()}`, 'active');
    } catch (e) {
      setWalletStatus('Invalid private key', 'error');
    }
  });
}

// ===== Scan flow =====
let lastScan = null;

function appendProgress(msg) {
  const node = $('#scan-progress');
  const line = el('div', {}, msg);
  node.appendChild(line);
}

function setProgress(msg) {
  const node = $('#scan-progress');
  clear(node);
  if (msg) node.appendChild(el('div', {}, msg));
}

// Scan result cache — keyed on wallet address. Protects against rapid
// rescans that would otherwise hammer rate-limited RPCs and cause chunk
// failures. TTL is short enough that balance reads stay fresh but long
// enough to cover user double-clicks and accidental re-scans.
const SCAN_CACHE_TTL_MS = 30_000;
// Minimum time between scan button clicks, regardless of cache state.
const SCAN_COOLDOWN_MS = 2_000;
const _scanCache = new Map(); // address → { scans, ts }
let _lastScanStarted = 0;

async function runScan() {
  const addr = getAddress();
  if (!addr) {
    setWalletStatus('Load a wallet first', 'error');
    return;
  }

  // ===== Cooldown: prevent rapid-fire button mashing =====
  const elapsedSinceLast = Date.now() - _lastScanStarted;
  if (elapsedSinceLast < SCAN_COOLDOWN_MS) {
    const remaining = Math.ceil((SCAN_COOLDOWN_MS - elapsedSinceLast) / 1000);
    setProgress(`Please wait ${remaining}s before re-scanning (rate-limit protection)`);
    return;
  }
  _lastScanStarted = Date.now();

  // ===== Cache: reuse recent results for the same wallet =====
  const cached = _scanCache.get(addr);
  if (cached && Date.now() - cached.ts < SCAN_CACHE_TTL_MS) {
    setProgress(`Using cached results from ${Math.floor((Date.now() - cached.ts) / 1000)}s ago`);
    lastScan = cached.scans;
    renderResults(cached.scans, true);
    return;
  }

  const btn = $('#scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  setProgress(`Scanning ${SOURCES.length} source${SOURCES.length === 1 ? '' : 's'}…`);

  try {
    const scans = await Promise.all(
      SOURCES.map(async (src) => {
        try {
          appendProgress(`  ${src.name}: querying…`);
          const r = await src.scan(addr);
          appendProgress(`  ${src.name}: ${r.items.length} item${r.items.length === 1 ? '' : 's'}${r.error ? ` (${r.error})` : ''}`);
          return r;
        } catch (e) {
          appendProgress(`  ${src.name}: failed — ${e.message || e}`);
          return { source: src.id, address: addr, items: [], error: e.message };
        }
      }),
    );
    lastScan = scans;
    // Only cache COMPLETE scans. Incomplete ones should be retriable
    // immediately so the user can get a clean result.
    const allComplete = scans.every((s) => s && s.complete !== false);
    if (allComplete) {
      _scanCache.set(addr, { scans, ts: Date.now() });
    }
    renderResults(scans, false);
  } catch (e) {
    setProgress(`Scan failed: ${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan all sources';
  }
}

/** Clear scan cache — exposed for debugging / settings UI. */
export function clearScanCache() {
  _scanCache.clear();
}

// ===== Results rendering =====
// Takes an array of ScanResult (one per source) and renders all items
// grouped by source. Each source still owns its own WETH aggregate display
// if relevant. `fromCache` adds a subtle notice that results are reused.
function renderResults(scans, fromCache = false) {
  show($('#results-card'), true);
  const list = $('#token-list');
  clear(list);

  const summary = $('#results-summary');
  clear(summary);

  // Flatten items across all sources while remembering which source they came from.
  const allItems = scans.flatMap((s) => s.items || []);
  const clankerScan = scans.find((s) => s.source === 'clanker');

  const totalCount = allItems.length;
  const claimableCount = allItems.filter((i) =>
    (i.claimable || []).some((c) => c.amount > 0n),
  ).length;

  summary.appendChild(document.createTextNode(
    `Scanned ${scans.length} source${scans.length === 1 ? '' : 's'}. ` +
    `Found ${totalCount} item${totalCount === 1 ? '' : 's'}. ` +
    `${claimableCount} with claimable balances.` +
    (fromCache ? ' (cached)' : '')
  ));

  // Portfolio dashboard with stat cards + per-source bar chart + basescan links.
  renderPortfolio(getAddress(), scans);

  // Confidence-tiered warning (issue #6):
  //
  // A handful of failed chunks doesn't mean data is lost — if the failed
  // ranges fall in block windows where the wallet had no activity, nothing
  // is missing. But we can't know that without retrying. So we use a
  // three-tier approach based on how many chunks failed relative to how
  // many items we did find:
  //
  //   tier 0: no failures           → no banner (clean)
  //   tier 1: ≤ 5 failures total    → subtle info note (likely fine)
  //   tier 2: > 5 failures          → red warning (probably missing data)
  //
  // The threshold 5 is empirically picked: a clean scan of the treasury
  // has 0 failures; a stressed scan typically has 2-4 sporadic failures
  // that don't correlate with missing launches; outright rate-limit
  // cascades produce 10+ failures.
  const totalFailed = scans.reduce(
    (sum, s) => sum + ((s && s.failedRanges?.length) || 0),
    0,
  );
  if (totalFailed > 0 && totalFailed <= 5) {
    const infoBanner = el('div', { className: 'incomplete-note' }, [
      document.createTextNode(
        `Note: ${totalFailed} minor RPC hiccup${totalFailed === 1 ? '' : 's'} during scan — results are likely complete. ` +
        `Rescan within 30s uses cache; after that triggers a fresh scan.`
      ),
    ]);
    summary.appendChild(infoBanner);
  } else if (totalFailed > 5) {
    const warnBanner = el('div', { className: 'incomplete-warn' }, [
      el('strong', {}, '⚠ Scan may be incomplete — '),
      document.createTextNode(
        `${totalFailed} chunks failed after retries. ` +
        `Wait a few seconds and click Scan again for a fresh attempt.`
      ),
    ]);
    summary.appendChild(warnBanner);
  }

  // Clanker-specific WETH aggregate card (it's the only source today that
  // has a shared reward token across items). Other sources can add similar
  // aggregate cards in future.
  const wethCard = $('#weth-card');
  const wethAmount = $('#weth-amount');
  const claimWethBtn = $('#claim-weth-btn');
  if (clankerScan && clankerScan.wethClaimable > 0n) {
    show(wethCard, true);
    wethAmount.textContent = `${formatAmount(clankerScan.wethClaimable, 18)} WETH`;
    if (canSign()) {
      show(claimWethBtn, true);
      claimWethBtn.onclick = () => handleClaimWeth();
    } else {
      show(claimWethBtn, false);
    }
  } else if (clankerScan && clankerScan.items.length > 0) {
    show(wethCard, true);
    wethAmount.textContent = '0 WETH';
    show(claimWethBtn, false);
  } else {
    show(wethCard, false);
  }

  // Render each item row. Per-item try/catch so a single bad item can't
  // break the whole list — this used to be the cause of "it shows some,
  // not all" symptoms.
  if (totalCount === 0) {
    list.appendChild(el('div', { className: 'muted' }, 'No claimable items found across any source.'));
    return;
  }

  let renderedCount = 0;
  let failedCount = 0;
  for (const item of allItems) {
    try {
      list.appendChild(renderTokenRow(item));
      renderedCount++;
    } catch (e) {
      failedCount++;
      // Render a minimal fallback row so the user at least sees the token exists
      try {
        const fallback = el('div', { className: 'token-row fallback' }, [
          el('div', { className: 'symbol' }, item?.symbol || '???'),
          el('div', { className: 'addr' }, item?.tokenAddress || 'unknown'),
          el('div', { className: 'claimable-amt zero' }, 'render error'),
          el('div', {}, ''),
        ]);
        list.appendChild(fallback);
      } catch {
        /* even the fallback failed — skip this item entirely */
      }
    }
  }

  // Add a count confirmation line so the user can verify render matches scan
  const countLine = el('div', { className: 'muted render-count' }, [
    document.createTextNode(`Rendered ${renderedCount} of ${allItems.length} items`),
    ...(failedCount > 0 ? [document.createTextNode(` (${failedCount} render errors)`)] : []),
  ]);
  list.appendChild(countLine);
}

function renderTokenRow(item) {
  // Defensive: coerce all displayed fields to strings so nothing crashes
  // the document.createTextNode() call downstream.
  const version = String(item?.version ?? '?');
  const isLegacy = version !== 'v4';
  const symbol = String(item?.symbol ?? '???');
  const name = String(item?.name ?? '');
  const tokenAddress = String(item?.tokenAddress ?? '');
  const claimableArr = Array.isArray(item?.claimable) ? item.claimable : [];
  const legacyUnknown = item?.legacyUnknownBalance === true;

  const hasClaimable = claimableArr.some((c) => c && typeof c.amount === 'bigint' && c.amount > 0n);

  // Display text for the claimable column:
  //   - v4 with balance → formatted amount
  //   - v4 with zero    → "0"
  //   - legacy          → "? (try claim)" — balance is unknown at scan time
  let claimableText;
  if (claimableArr.length > 0) {
    claimableText = claimableArr
      .map((c) => {
        try { return `${formatAmount(c.amount, c.decimals)} ${c.symbol || '???'}`; }
        catch { return '?'; }
      })
      .join(' + ');
  } else if (legacyUnknown) {
    claimableText = '? (try claim)';
  } else {
    claimableText = '0';
  }

  const left = el('div', { className: 'meta' }, [
    el('div', { className: 'symbol' }, symbol),
    el('div', { className: 'name' }, name),
  ]);

  const middle = el('div', {}, [
    el('a', {
      className: 'addr',
      href: tokenAddress ? basescanTokenUrl(tokenAddress) : '#',
      target: '_blank',
      rel: 'noopener noreferrer',
    }, shortAddress(tokenAddress)),
  ]);

  const amount = el('div', {
    className: `claimable-amt ${hasClaimable ? '' : legacyUnknown ? 'unknown' : 'zero'}`,
  }, claimableText);

  const actions = el('div', { className: 'actions' });
  const versionBadge = el('span', { className: 'version-badge' }, version);
  actions.appendChild(versionBadge);

  // Show a Claim button if we can sign AND it's either a v4 token with
  // claimable > 0, OR a legacy token (we don't know the balance — the
  // user can try).
  if (canSign() && (version === 'v4' || isLegacy)) {
    const btn = el('button', {
      className: 'btn small success',
    }, isLegacy ? 'Try Claim' : 'Claim');
    btn.addEventListener('click', () => handleClaimItem(item, btn));
    actions.appendChild(btn);
  }

  return el('div', {
    className: `token-row ${isLegacy ? 'legacy' : ''}`,
  }, [left, middle, amount, actions]);
}

// ===== Claim handlers =====
// Sanitize errors shown to the user — RPC error strings can embed the full
// raw request body in rare failure modes. Prefer ethers' shortMessage and
// fall back to a generic string rather than dumping the raw error.
function safeErrorMessage(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.shortMessage) return e.shortMessage;
  // Whitelist a few safe ethers error codes
  if (e.code === 'INSUFFICIENT_FUNDS') return 'Insufficient funds for gas';
  if (e.code === 'NONCE_EXPIRED') return 'Nonce expired';
  if (e.code === 'TIMEOUT') return 'Request timed out';
  if (e.code === 'NETWORK_ERROR') return 'Network error';
  if (e.code === 'ACTION_REJECTED') return 'Transaction rejected';
  return 'Transaction failed';
}

// Claim confirmation dialog. Shows the recipient address (derived from the
// currently-loaded signer, not user input) before we broadcast. Prevents a
// user who pasted the wrong key from sweeping funds to an unexpected address.
function confirmClaim(recipient, label) {
  return window.confirm(
    `Confirm claim:\n\n` +
    `  Action: ${label}\n` +
    `  Recipient: ${recipient}\n\n` +
    `This will broadcast a transaction from the currently loaded wallet. ` +
    `Proceed?`,
  );
}

async function handleClaimWeth() {
  if (!canSign()) return;
  const btn = $('#claim-weth-btn');
  const signer = getSigner();
  const recipient = await signer.getAddress();
  if (!confirmClaim(recipient, 'Claim aggregate WETH fees')) return;

  btn.disabled = true;
  btn.textContent = 'Claiming…';
  try {
    const res = await clanker.claimWeth(signer);
    if (res.ok) {
      btn.textContent = '✓ Claimed';
      appendProgress(`WETH claimed: ${res.hash}`);
      setTimeout(() => runScan(), 4000);
    } else {
      btn.textContent = 'Claim WETH';
      btn.disabled = false;
      window.alert(`Claim failed: ${safeErrorMessage({ shortMessage: res.error })}`);
    }
  } catch (e) {
    btn.textContent = 'Claim WETH';
    btn.disabled = false;
    window.alert(`Claim failed: ${safeErrorMessage(e)}`);
  }
}

async function handleClaimItem(item, btn) {
  if (!canSign()) return;
  const signer = getSigner();
  const recipient = await signer.getAddress();
  if (!confirmClaim(recipient, `Claim ${item.symbol} fees (${item.tokenAddress.slice(0, 10)}…)`)) return;

  // Route to the right source adapter based on item.source. This is how
  // multi-source claims work — each source owns its own claimItem.
  const source = getSource(item.source);
  if (!source || typeof source.claimItem !== 'function') {
    window.alert(`No claim handler for source: ${item.source}`);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Claiming…';
  try {
    const res = await source.claimItem(item, signer);
    if (res.ok) {
      btn.textContent = '✓';
      setTimeout(() => runScan(), 4000);
    } else {
      btn.textContent = 'Claim';
      btn.disabled = false;
      window.alert(`Claim failed: ${safeErrorMessage({ shortMessage: res.error })}`);
    }
  } catch (e) {
    btn.textContent = 'Claim';
    btn.disabled = false;
    window.alert(`Claim failed: ${safeErrorMessage(e)}`);
  }
}

// ===== Donation copy =====
function initDonationCopy() {
  const btn = $('#copy-donation');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const addr = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';
    try {
      await navigator.clipboard.writeText(addr);
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    } catch {
      /* clipboard API unavailable — user can select-all the code block */
    }
  });
}

// ===== Settings panel =====
function initSettings() {
  const toggle = $('#settings-toggle');
  const card = $('#settings-card');
  if (!toggle || !card) return;

  toggle.addEventListener('click', () => {
    const isHidden = card.hasAttribute('hidden');
    show(card, isHidden);
    toggle.classList.toggle('active', isHidden);
    if (isHidden) refreshRpcStats();
  });

  $('#test-rpc-btn')?.addEventListener('click', testCustomRpc);
  $('#add-rpc-btn')?.addEventListener('click', addCustomRpc);
  $('#refresh-stats-btn')?.addEventListener('click', refreshRpcStats);
  $('#clear-cache-btn')?.addEventListener('click', handleClearCache);
}

function setSettingsStatus(msg, kind = '') {
  const node = $('#custom-rpc-status');
  if (!node) return;
  clear(node);
  if (!msg) {
    node.className = 'settings-status';
    return;
  }
  node.className = `settings-status ${kind}`;
  node.appendChild(document.createTextNode(msg));
}

async function testCustomRpc() {
  const url = $('#custom-rpc-url')?.value.trim();
  if (!url) { setSettingsStatus('Enter an RPC URL first', 'error'); return; }
  try {
    validateProviderUrl(url);
  } catch (e) {
    setSettingsStatus(safeErrorMessage(e), 'error');
    return;
  }
  setSettingsStatus('Testing…');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { setSettingsStatus(`HTTP ${res.status}`, 'error'); return; }
    const json = await res.json();
    if (json.error) { setSettingsStatus(json.error.message || 'RPC error', 'error'); return; }
    if (json.result !== '0x2105') {
      setSettingsStatus(`Wrong chain: got ${json.result}, expected 0x2105 (Base)`, 'error');
      return;
    }
    setSettingsStatus('✓ Valid Base RPC — ready to add', 'success');
  } catch (e) {
    // On the deployed site, a failed fetch to a non-CSP-allowlisted URL
    // shows up as a network error. Give a specific hint.
    const msg = safeErrorMessage(e);
    setSettingsStatus(
      `${msg}. If this is the deployed site, the CSP blocks non-allowlisted URLs. ` +
      `Run ClaimApp locally to use custom endpoints.`,
      'error',
    );
  }
}

function addCustomRpc() {
  const url = $('#custom-rpc-url')?.value.trim();
  if (!url) { setSettingsStatus('Enter an RPC URL first', 'error'); return; }
  try {
    validateProviderUrl(url);
  } catch (e) {
    setSettingsStatus(safeErrorMessage(e), 'error');
    return;
  }
  const name = `custom-${new URL(url).hostname}`;
  addCustomProvider({ name, url, maxConcurrent: 5, maxLogBlockRange: 9_999 });
  // Invalidate the scan cache since provider set changed
  clearScanCache();
  setSettingsStatus(`✓ Added ${name}. Scan again to use it.`, 'success');
  refreshRpcStats();
}

function handleClearCache() {
  clearScanCache();
  setSettingsStatus('✓ Scan cache cleared', 'success');
}

function refreshRpcStats() {
  const node = $('#rpc-stats');
  if (!node) return;
  clear(node);

  let stats;
  try {
    stats = getRpcStats();
  } catch (e) {
    node.appendChild(el('div', { className: 'muted' }, 'Stats unavailable'));
    return;
  }

  // Overall stats line
  const totals = el('div', { className: 'muted', style: 'margin-bottom: 10px;' }, [
    document.createTextNode(
      `total: ${stats.total}  success: ${stats.success}  errors: ${stats.errors}  ` +
      `retries: ${stats.retries}  rate-limits: ${stats.rateLimits}`
    ),
  ]);
  node.appendChild(totals);

  // Per-provider table
  if (!stats.providers || stats.providers.length === 0) {
    node.appendChild(el('div', { className: 'muted' }, 'No provider activity yet — run a scan.'));
    return;
  }
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, 'provider'),
        el('th', {}, 'status'),
        el('th', {}, 'in-flight'),
        el('th', {}, 'latency'),
        el('th', {}, 'ok'),
        el('th', {}, 'err'),
      ]),
    ]),
  ]);
  const tbody = el('tbody', {});
  for (const p of stats.providers) {
    const statusLabel = !p.healthy ? 'unhealthy' : p.rateLimited ? 'rate-limited' : 'healthy';
    const statusClass = !p.healthy ? 'stat-err' : p.rateLimited ? 'stat-rl' : 'stat-ok';
    tbody.appendChild(el('tr', {}, [
      el('td', {}, p.name),
      el('td', { className: statusClass }, statusLabel),
      el('td', {}, String(p.inflight)),
      el('td', {}, p.latency === Infinity ? '—' : `${p.latency}ms`),
      el('td', { className: 'stat-ok' }, String(p.success)),
      el('td', { className: 'stat-err' }, String(p.errors)),
    ]));
  }
  table.appendChild(tbody);
  node.appendChild(table);
}

// ===== Address change listener =====
onAddressChange((addr) => {
  show($('#scan-card'), !!addr);
  if (!addr) {
    show($('#results-card'), false);
    hidePortfolio();
  }
});

// ===== Bootstrap =====
function init() {
  initTabs();
  initWalletInputs();
  initDonationCopy();
  initSettings();
  $('#scan-btn').addEventListener('click', runScan);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
