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

async function runScan() {
  const addr = getAddress();
  if (!addr) {
    setWalletStatus('Load a wallet first', 'error');
    return;
  }

  const btn = $('#scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  setProgress(`Scanning ${SOURCES.length} source${SOURCES.length === 1 ? '' : 's'}…`);

  try {
    // Run every enabled source in parallel. Each source is independent —
    // a failure in one does not block the others.
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
    renderResults(scans);
  } catch (e) {
    setProgress(`Scan failed: ${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan all sources';
  }
}

// ===== Results rendering =====
// Takes an array of ScanResult (one per source) and renders all items
// grouped by source. Each source still owns its own WETH aggregate display
// if relevant.
function renderResults(scans) {
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
    `${claimableCount} with claimable balances.`
  ));

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

  // Render each item row
  if (totalCount === 0) {
    list.appendChild(el('div', { className: 'muted' }, 'No claimable items found across any source.'));
    return;
  }

  for (const item of allItems) {
    list.appendChild(renderTokenRow(item));
  }
}

function renderTokenRow(item) {
  const isLegacy = item.version !== 'v4';
  const hasClaimable = item.claimable.some((c) => c.amount > 0n);

  const claimableText = item.claimable.length === 0
    ? (isLegacy ? 'legacy — see Basescan' : '0')
    : item.claimable
        .map((c) => `${formatAmount(c.amount, c.decimals)} ${c.symbol}`)
        .join(' + ');

  const left = el('div', { className: 'meta' }, [
    el('div', { className: 'symbol' }, item.symbol),
    el('div', { className: 'name' }, item.name || ''),
  ]);

  const middle = el('div', {}, [
    el('a', {
      className: 'addr',
      href: basescanTokenUrl(item.tokenAddress),
      target: '_blank',
      rel: 'noopener noreferrer',
    }, shortAddress(item.tokenAddress)),
  ]);

  const amount = el('div', {
    className: `claimable-amt ${hasClaimable ? '' : 'zero'}`,
  }, claimableText);

  const actions = el('div', { className: 'actions' });
  const version = el('span', { className: 'version-badge' }, item.version);
  actions.appendChild(version);

  if (canSign() && item.version === 'v4') {
    const btn = el('button', {
      className: 'btn small success',
      onclick: () => handleClaimItem(item, btn),
    }, 'Claim');
    actions.appendChild(btn);
  }

  return el('div', {
    className: `token-row ${isLegacy ? 'legacy' : ''}`,
  }, [left, middle, amount, actions]);
}

// ===== Claim handlers =====
async function handleClaimWeth() {
  if (!canSign()) return;
  const btn = $('#claim-weth-btn');
  btn.disabled = true;
  btn.textContent = 'Claiming…';
  try {
    const signer = getSigner();
    const res = await clanker.claimWeth(signer);
    if (res.ok) {
      btn.textContent = '✓ Claimed';
      appendProgress(`WETH claimed: ${res.hash}`);
      // Re-scan to refresh balances
      setTimeout(() => runScan(), 2000);
    } else {
      btn.textContent = 'Claim WETH';
      btn.disabled = false;
      alert(`Claim failed: ${res.error}`);
    }
  } catch (e) {
    btn.textContent = 'Claim WETH';
    btn.disabled = false;
    alert(`Claim failed: ${e.message || e}`);
  }
}

async function handleClaimItem(item, btn) {
  if (!canSign()) return;
  btn.disabled = true;
  btn.textContent = 'Claiming…';
  try {
    const signer = getSigner();
    const res = await clanker.claimItem(item, signer);
    if (res.ok) {
      btn.textContent = '✓';
      setTimeout(() => runScan(), 2000);
    } else {
      btn.textContent = 'Claim';
      btn.disabled = false;
      alert(`Claim failed: ${res.error}`);
    }
  } catch (e) {
    btn.textContent = 'Claim';
    btn.disabled = false;
    alert(`Claim failed: ${e.message || e}`);
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
