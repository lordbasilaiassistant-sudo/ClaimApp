# ClaimApp

> **Made by [THRYX](https://thryx.fun)** — the free, gasless token launchpad on Base.
> Launch tokens for free, graduate to Uniswap V4, earn 70% of trading fees as the creator.
> [→ try thryx.fun](https://thryx.fun)

**A universal on-chain claim finder and claimer. One wallet, every platform.**

ClaimApp is a zero-backend web app that scans multiple EVM platforms for
anything your wallet can claim — LP fees, creator rewards, staking yield,
airdrops — and lets you claim it all from one page. Runs entirely in your
browser: no server, no telemetry, no bundler, no build step.

It's built modularly: each platform lives in its own folder under
`src/sources/`. Add a new platform = add a new folder. The UI doesn't care.

> Your keys stay in your browser. No backend. No telemetry. No CDN. Host it on
> GitHub Pages or clone and open `index.html` locally — both work.

**Live site:** https://lordbasilaiassistant-sudo.github.io/ClaimApp/

## Supported sources

| Source  | Status | What it finds                                                   |
|---------|--------|-----------------------------------------------------------------|
| **Clanker v4** | ✅ live | LP fees from every Clanker token you admin OR receive rewards from (dual-path discovery) |
| **Clanker v2/v3/v3_1** | ✅ live (opt-in) | Legacy launches — claim via `factory.claimRewards(token)`. Enable via "Deep scan" (coming soon — see issue #9) |
| **Bankr / Doppler V4** | ✅ live | Doppler V4 LP fees via the DECAY contract. Tracks per-pool pending amounts |
| Zora    | 📋 planned ([#14](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/14)) | Creator and protocol rewards |
| Uniswap V3/V4 arbitrary positions | 📋 planned ([#15](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/15)) | Sweep uncollected LP fees from any position you own |
| Merkle airdrops | 📋 planned | Multi-protocol merkle claimers |

## Why it exists

[clanker.world](https://clanker.world) and similar launchpads hide your
launches behind verified-account flows — new creators can't see their own
tokens without a Twitter handshake. ClaimApp queries the chain directly so
anyone with a wallet can discover and sweep their stranded rewards.

## How the Clanker module works

1. **Path A** — scans `FeeLocker.StoreTokens` events filtered by `feeOwner`
   to catch every token where the wallet has received rewards (including
   launches someone else deployed that pay out to the wallet).
2. **Path B** — scans the v4 factory's `TokenCreated` events filtered by
   `tokenAdmin` to catch newly launched tokens where nobody has called
   `collectRewards` yet.
3. Merges the two paths by token address, queries
   `FeeLocker.availableFees(owner, token)` for each via Multicall3, and
   displays them with per-row and aggregate WETH claim buttons.
4. For legacy Clanker versions (v2/v3/v3_1), discovery scans the version
   factory's `TokenCreated` event filtered by `creatorAdmin`, and claims
   go through `factory.claimRewards(token)` directly (no FeeLocker).

## How the Bankr module works

1. Scans `Release` events on the Doppler `DECAY` contract filtered by
   `beneficiary == wallet` to find every pool the wallet has ever received
   rewards from.
2. Resolves poolIds → token addresses via `DECAY.getPoolKey(poolId)`.
3. Queries pending fees per pool via Multicall3
   (`getShares`, `getCumulatedFees0/1`, `getLastCumulatedFees0/1`).
4. Displays each pool with its token symbol and the approximate pending
   amount. A "Claim" button calls `DECAY.collectFees(poolId)` — which is
   permissionless, so any wallet with gas can trigger the payout.

> **Known limitation:** Bankr discovery uses `Release` events which only
> fire on CLAIM, so pools the wallet has never claimed from won't appear
> in the initial scan. Tracked as [issue #10](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/10).

## Project goals

- **Zero backend.** The deployed site is 100% static HTML/JS/CSS. GitHub Pages
  or any static host works. You can clone and run it offline.
- **Zero third-party scripts.** Ethers.js is bundled in `src/vendor/`. Strict
  Content-Security-Policy blocks every request except Base RPC.
- **Zero persistence.** Private keys live in a JavaScript closure. No
  `localStorage`, no cookies, no "remember me". Close the tab → wiped.
- **Modular sources.** Clanker is `src/sources/clanker/`, Bankr is
  `src/sources/bankr/`. Future platforms drop in as siblings with the
  same `SourceAdapter` interface.
- **Auditable.** Handwritten code, no build step, no bundler. Read the
  source in an afternoon.

## How fast is it?

A full 2-source scan (Clanker v4 + Bankr) of a wallet with dozens of
launches completes in **3–6 seconds** on a normal home connection. The
scanner routes the `eth_getLogs` hot path through Tenderly's public
gateway (200k-block windows) and falls back to a 10k-block sub-chunk
pass across multiple browser-CORS-verified providers if the primary
hiccups. A second-tier retry and in-flight request deduping handle
transient rate limits without losing events.

A **30-second in-memory scan cache** and a **2-second button cooldown**
prevent double-clicks from triggering the rate-limit cascades that
plagued earlier versions.

## RPC etiquette

ClaimApp runs against **public** RPC endpoints by default. Every request
is a small burden on a shared resource — if we abuse the endpoints, they
get slower for everyone. The app respects limits by design:

- **Per-provider concurrency caps** enforced by the in-project router
- **429 exponential backoff** (1s → 2s → 4s → 8s → 16s → 32s → 60s)
- **Failover on failure** — failed requests try a different provider
- **Bounded scan concurrency** — never exceeds total slot capacity
- **No background pinging** — health comes from real user traffic only

Every provider in the default set passes `test/bench-cors.mjs`, which
verifies CORS preflight compatibility (a provider that works in Node
but fails browser CORS is silently broken for real users — this check
is the #1 reason we trimmed the list).

If you have your own paid RPC (Alchemy, Infura, QuickNode, etc.) and
want to skip the public rotation, the settings gear icon opens a panel
where you can add a custom URL. The CSP on the deployed site only
allows the default providers, so custom endpoints work best when you
clone and run locally (or fork with your URL in the CSP meta tag).

**Current provider set** (all CORS-verified in browser):

| Provider             | Role                       | Max getLogs range |
|----------------------|----------------------------|-------------------|
| `gateway.tenderly.co`| large-range primary        | 200k blocks       |
| `developer-access-mainnet.base.org` | 10k fallback | 10k blocks        |
| `mainnet.base.org`   | 10k fallback               | 10k blocks        |
| `nodes.sequence.app` | 10k fallback               | 10k blocks        |
| `1rpc.io`            | 10k fallback               | 10k blocks        |

## Repo layout

```
ClaimApp/
├── index.html                       # Single-page entry
├── src/
│   ├── main.js                      # UI wiring (thin)
│   ├── config/
│   │   └── chains.js                # Base mainnet metadata
│   ├── services/
│   │   ├── provider.js              # Multi-RPC ethers provider
│   │   ├── multicall.js             # Multicall3 batching
│   │   ├── wallet.js                # Ephemeral key handling
│   │   ├── rpc-throttle.js          # Retry + concurrency primitives
│   │   └── rpc/                     # ◀── multi-provider router
│   │       ├── providers.js         # CORS-verified endpoint list
│   │       ├── health.js            # Per-provider health tracking
│   │       ├── router.js            # Multi-provider failover
│   │       ├── ethers-adapter.js    # MultiRpcProvider (extends ethers)
│   │       └── log-fetcher.js       # Fast-path large-range eth_getLogs
│   ├── sources/                     # ◀── claim source modules
│   │   ├── index.js                 # Source registry (SOURCES array)
│   │   ├── clanker/                 # Clanker v4 + legacy
│   │   │   ├── config.js
│   │   │   ├── abis.js
│   │   │   ├── scanner.js           # Dual-path discovery A + B
│   │   │   ├── claimer.js           # v4 FeeLocker + legacy factory
│   │   │   └── index.js
│   │   └── bankr/                   # Bankr / Doppler V4
│   │       ├── config.js
│   │       ├── abis.js
│   │       ├── scanner.js           # Release event + getPoolKey
│   │       ├── claimer.js           # DECAY.collectFees
│   │       └── index.js
│   ├── ui/
│   │   ├── dom.js                   # Tiny DOM helpers (no framework)
│   │   └── styles.css               # Dark theme, responsive
│   ├── utils/
│   │   └── format.js                # Display helpers
│   └── vendor/
│       ├── ethers.js                # Bundled ethers.js v6
│       └── README.md
├── test/
│   ├── ping-router.mjs              # RPC sanity check
│   ├── scan-treasury.mjs            # Full Clanker scan smoke test
│   ├── scan-bankr.mjs               # Full Bankr scan smoke test
│   ├── stress-scan.mjs              # Determinism stress test
│   ├── bench-cors.mjs               # Browser CORS regression check
│   ├── bench-providers.mjs          # Provider latency benchmark
│   ├── bench-chunk-sizes.mjs        # Max eth_getLogs range per provider
│   └── serve.mjs                    # Zero-dep local static server
├── .github/
│   ├── CODEOWNERS
│   ├── ISSUE_TEMPLATE/              # bug / feature / security
│   ├── pull_request_template.md
│   └── workflows/
│       ├── ci.yml                   # Syntax + CORS regression checks
│       └── deploy-pages.yml         # Auto-deploy to GitHub Pages
├── CONTRIBUTING.md                  # Team structure + issue-driven flow
├── SECURITY.md                      # Vulnerability reporting
├── .gitignore                       # Excludes secrets, keys, .env, CLAUDE.md
├── .env.example                     # Doc-only, no runtime role
└── README.md
```

## Running locally

Clone the repo and serve the root with any static server — no dependencies:

```bash
git clone https://github.com/lordbasilaiassistant-sudo/ClaimApp.git
cd ClaimApp
node test/serve.mjs 8000
# → http://localhost:8000
```

Or use any other static server (`python -m http.server`, `npx serve`, etc).
ES modules require an HTTP server — `file://` is blocked by modern browsers.

## Using the app

1. **Load a wallet.** Three modes:
   - **Address (read-only)** — paste any public address to scan without
     signing ability
   - **Private key (claim enabled)** — paste a 0x-prefixed 64-hex key.
     Stays in JavaScript memory only, never written to storage, wiped on
     refresh
   - Injected wallet support (MetaMask, etc) is [planned](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/12)
2. **Scan.** Click "Scan all sources". The scanner runs each registered
   source (Clanker + Bankr) and displays everything in one merged list.
3. **Review.** You'll see:
   - Summary line with item count and how many have pending claims
   - Optional subtle info note if 1-5 chunks had transient RPC hiccups
   - Optional red warning if more than 5 chunks failed
   - Per-source WETH aggregate card (Clanker only — Bankr is per-pool)
   - Per-token rows with claimable amounts, version badge, and claim button
4. **Claim.** Per-row buttons route to the correct source's claim flow.
   Clanker v4 runs `LpLocker.collectRewardsWithoutUnlock` →
   `FeeLocker.claim`. Clanker legacy runs `factory.claimRewards(token)`.
   Bankr runs `DECAY.collectFees(poolId)`. Each call shows a
   confirmation dialog with the recipient address before broadcast.

## Security model

This is an app that handles private keys. Here's the threat model:

| Threat                              | Mitigation                                     |
|-------------------------------------|------------------------------------------------|
| Backend compromise                  | There is no backend.                           |
| CDN compromise / supply chain       | All JS is bundled in-repo. No runtime CDN.     |
| Key exfiltration via `fetch`        | CSP `connect-src` allowlist limits outbound.   |
| Key persistence across sessions     | Held in JS closure; wiped on `beforeunload`.   |
| XSS                                 | No `innerHTML` with user data; CSP blocks inline scripts. |
| Clickjacking                        | CSP `frame-ancestors 'none'`.                  |
| Wrong-key claim to unintended wallet | Claim confirmation dialog shows recipient address before signing. |
| Malicious token name / decimals     | Per-read soft caps (16-char symbol, 64-char name, max 36 decimals). |
| Rogue GitHub Action injecting code  | Workflows are reviewed in PRs; deploy job has minimum permissions. |

**What this app will NOT protect you from:**
- A compromised device (keyloggers, clipboard sniffers, browser extensions
  with access to your tabs)
- A fake copy of this site at a different URL. **Always verify the URL.**
- You pasting a private key on a shared computer

If any of those are a concern, clone the repo and run it locally on a
trusted machine with no extensions.

Security findings are welcome via [SECURITY.md](./SECURITY.md). Critical
issues go to the [private Security Advisory](https://github.com/lordbasilaiassistant-sudo/ClaimApp/security/advisories/new),
not public issues.

## Contributing

We use an issue-driven workflow. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the team structure and full flow. TL;DR:

1. [Open an issue](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/new/choose)
   using one of the templates (bug / feature / security)
2. Pick a pending issue to work on (or wait for triage). **Good first
   issues** are labeled accordingly
3. Send a PR that references the issue with `Fixes #N`
4. CI runs syntax checks + CORS regression tests on every PR
5. On merge: auto-deploys to GitHub Pages and closes the issue

Design invariants that PRs must preserve:
- No backend server, no runtime CDN, no telemetry
- No `localStorage` / `sessionStorage` / `cookie` writes of wallet data
- No `innerHTML` with user-controlled strings
- New `connect-src` URLs must be added to BOTH `src/services/rpc/providers.js`
  AND `index.html`'s CSP meta tag
- Providers must pass `node test/bench-cors.mjs`

## Adding a new source

Every claim platform lives in its own folder under `src/sources/`. See
[`src/sources/clanker/`](src/sources/clanker/) and
[`src/sources/bankr/`](src/sources/bankr/) as reference implementations.
Required files:

```
src/sources/<name>/
├── config.js      # addresses, block windows, constants
├── abis.js        # contract ABIs (human-readable format)
├── scanner.js     # discovery + balance queries (read-only)
├── claimer.js     # claim execution (signer required)
└── index.js       # default export implementing SourceAdapter
```

The adapter must implement `scan(address, options)` and should implement
`claimItem(item, signer)`. Register it in
[`src/sources/index.js`](src/sources/index.js) by importing and pushing
to `SOURCES`.

Open backlog for new sources: [#14 Zora](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/14),
[#15 Uniswap V3/V4 LP sweeper](https://github.com/lordbasilaiassistant-sudo/ClaimApp/issues/15).

## Made by THRYX

ClaimApp is built by the team behind [**thryx.fun**](https://thryx.fun),
the free gasless token launchpad on Base. Launch your own token in
~30 seconds with zero gas fees, automatic graduation to Uniswap V4,
and 70% of trading fees paid to creators. If ClaimApp helped you find
your launches, come launch your next one on THRYX.

## Donations

If this tool saved you an afternoon of Basescan scrolling, consider
sending a tip to the treasury:

```
0x7a3E312Ec6e20a9F62fE2405938EB9060312E334
```

Keeps the lights on.

## License

MIT. See [`LICENSE`](LICENSE).

## Disclaimer

Not affiliated with Clanker, Bankr, Doppler, Uniswap, or any launched
token. Not financial advice. Verify every transaction in your wallet
before signing. Use at your own risk.
