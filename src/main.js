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
import { SOURCES } from './sources/index.js';
import clanker from './sources/clanker/index.js';
import {
  formatAmount,
  shortAddress,
  basescanTxUrl,
  basescanTokenUrl,
} from './utils/format.js';
import { $, el, clear, show } from './ui/dom.js';

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

  // Warn prominently if any scan came back incomplete (chunks failed even
  // after retries). Incomplete scans explain "same wallet, different results"
  // behavior — without this warning users would see a silently-shrunk list.
  const incompleteScans = scans.filter((s) => s && s.complete === false);
  if (incompleteScans.length > 0) {
    const warnBanner = el('div', { className: 'incomplete-warn' }, [
      el('strong', {}, '⚠ Scan incomplete — '),
      document.createTextNode(
        incompleteScans.map((s) => `${s.source}: ${s.failedRanges?.length || 0} chunks failed`).join(', ') +
        '. Results may be missing some launches. Click Scan again to retry — this is usually a transient RPC issue.'
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

  const hasClaimable = claimableArr.some((c) => c && typeof c.amount === 'bigint' && c.amount > 0n);

  const claimableText = claimableArr.length === 0
    ? (isLegacy ? 'legacy — see Basescan' : '0')
    : claimableArr
        .map((c) => {
          try {
            return `${formatAmount(c.amount, c.decimals)} ${c.symbol || '???'}`;
          } catch {
            return '?';
          }
        })
        .join(' + ');

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
    className: `claimable-amt ${hasClaimable ? '' : 'zero'}`,
  }, claimableText);

  const actions = el('div', { className: 'actions' });
  const versionBadge = el('span', { className: 'version-badge' }, version);
  actions.appendChild(versionBadge);

  if (canSign() && version === 'v4') {
    const btn = el('button', {
      className: 'btn small success',
    }, 'Claim');
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

  btn.disabled = true;
  btn.textContent = 'Claiming…';
  try {
    const res = await clanker.claimItem(item, signer);
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

// ===== Address change listener =====
onAddressChange((addr) => {
  show($('#scan-card'), !!addr);
  if (!addr) {
    show($('#results-card'), false);
  }
});

// ===== Bootstrap =====
function init() {
  initTabs();
  initWalletInputs();
  initDonationCopy();
  $('#scan-btn').addEventListener('click', runScan);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
