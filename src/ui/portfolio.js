// src/ui/portfolio.js
// Renders the portfolio dashboard above the token list. Pure SVG, no chart
// libraries, CSP-clean.
//
// Inputs:
//   address  — wallet being scanned
//   scans    — array of ScanResult (per source)
//
// What it shows:
//   - 4 stat cards: tokens found, with claimable, WETH total, sources scanned
//   - One stacked bar per source: green = items with claimable, blue = empty
//   - Quick-link row to BaseScan + BlockScout for the wallet

import { $, clear, show } from './dom.js';
import { formatAmount } from '../utils/format.js';
import { getWalletBalances } from '../services/balances/index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

export function renderPortfolio(address, scans) {
  const dash = $('#portfolio-dashboard');
  if (!dash) return;

  const allItems = scans.flatMap((s) => s.items || []);
  const withClaim = allItems.filter((i) => (i.claimable || []).some((c) => c.amount > 0n));
  const totalWeth = scans.reduce((sum, s) => sum + (s.wethClaimable || 0n), 0n);

  $('#stat-found').textContent = String(allItems.length);
  $('#stat-claimable').textContent = String(withClaim.length);
  $('#stat-weth').textContent =
    totalWeth === 0n ? '0' : formatAmount(totalWeth, 18);
  $('#stat-sources').textContent = String(scans.length);

  // Chart: per-source stacked bars (claim vs empty)
  const chart = $('#portfolio-chart');
  clear(chart);
  const W = 600, H = 140, padX = 60, padY = 20, gap = 12;
  const maxItems = Math.max(...scans.map((s) => (s.items || []).length), 1);
  const barW = (W - padX - 20 - gap * (scans.length - 1)) / Math.max(scans.length, 1);
  const usableH = H - padY * 2;

  // Y-axis tick at top
  chart.appendChild(
    svg('text', { x: 8, y: padY + 8, class: 'axis-label' }, String(maxItems)),
  );
  chart.appendChild(
    svg('text', { x: 8, y: H - padY + 4, class: 'axis-label' }, '0'),
  );
  chart.appendChild(
    svg('line', {
      x1: padX - 8, y1: padY,
      x2: padX - 8, y2: H - padY,
      stroke: 'var(--border)', 'stroke-width': '1',
    }),
  );

  scans.forEach((s, i) => {
    const total = (s.items || []).length;
    const claim = (s.items || []).filter((it) =>
      (it.claimable || []).some((c) => c.amount > 0n),
    ).length;
    const x = padX + i * (barW + gap);
    const totalH = (total / maxItems) * usableH;
    const claimH = (claim / maxItems) * usableH;
    // empty portion (back layer)
    chart.appendChild(
      svg('rect', {
        x: String(x),
        y: String(H - padY - totalH),
        width: String(barW),
        height: String(totalH - claimH),
        class: 'bar-other',
        rx: '3',
      }),
    );
    // claimable portion (front layer)
    if (claim > 0) {
      chart.appendChild(
        svg('rect', {
          x: String(x),
          y: String(H - padY - claimH),
          width: String(barW),
          height: String(claimH),
          class: 'bar-claim',
          rx: '3',
        }),
      );
    }
    // source label
    chart.appendChild(
      svg(
        'text',
        {
          x: String(x + barW / 2),
          y: String(H - padY + 14),
          class: 'axis-label',
          'text-anchor': 'middle',
        },
        s.source || '?',
      ),
    );
    // count above bar
    chart.appendChild(
      svg(
        'text',
        {
          x: String(x + barW / 2),
          y: String(H - padY - totalH - 4),
          class: 'axis-label',
          'text-anchor': 'middle',
        },
        `${claim}/${total}`,
      ),
    );
  });

  // Quick links
  const links = $('#portfolio-links');
  clear(links);
  const link = (href, text) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  };
  links.appendChild(link(`https://basescan.org/address/${address}`, 'BaseScan'));
  links.appendChild(link(`https://base.blockscout.com/address/${address}`, 'BlockScout'));
  links.appendChild(link(`https://basescan.org/tokenholdings?a=${address}`, 'Token holdings'));
  links.appendChild(link(`https://debank.com/profile/${address}`, 'DeBank'));

  show(dash, true);

  // Async portfolio-value enrichment. Independent of the claim scan — runs
  // after the dashboard is already visible so the user sees stats fast,
  // then the value tile fills in.
  enrichWithBalances(address).catch((e) => {
    const sub = $('#stat-value-sub');
    if (sub) sub.textContent = `error: ${e.message || 'failed'}`;
  });
}

async function enrichWithBalances(address) {
  const value = $('#stat-value');
  const sub = $('#stat-value-sub');
  if (!value || !sub) return;
  value.textContent = '…';
  sub.textContent = 'fetching balances…';
  const result = await getWalletBalances(address, {
    priceTokens: true,
    onLog: (msg) => { sub.textContent = msg; },
  });
  const ethStr = Number(result.totalValueFormatted).toFixed(6);
  value.textContent = `${ethStr} ETH`;
  sub.textContent =
    `${result.tokenCount} ERC-20 holdings, ${result.sellableTokenCount} priced sellable. ` +
    `Native: ${Number(result.ethBalanceFormatted).toFixed(6)} ETH.`;
}

export function hidePortfolio() {
  const dash = $('#portfolio-dashboard');
  if (!dash) return;
  show(dash, false);
}
