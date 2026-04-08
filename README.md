# ClaimApp

**A universal on-chain claim finder and claimer. One wallet, every platform.**

ClaimApp is a zero-backend web app that scans multiple EVM platforms for
anything your wallet can claim — LP fees, creator rewards, staking yield,
airdrops — and lets you claim it all from one page. Runs entirely in your
browser: no server, no telemetry, no bundler.

It's built modularly: each platform lives in its own folder under
`src/sources/`. Add a new platform = add a new folder. The UI doesn't care.

> Your keys stay in your browser. No backend. No telemetry. No CDN. Host it on
> GitHub Pages or clone and open `index.html` locally — both work.

## Supported sources

| Source  | Status | What it finds                                                   |
|---------|--------|-----------------------------------------------------------------|
| Clanker | ✅ live | LP fees on Uniswap V4 pools for every Clanker token you admin   |
| Bankr (Doppler) | planned | Doppler V4 LP fees + creator rewards                   |
| Zora    | planned | Creator rewards, protocol rewards                               |
| Uniswap V3/V4 (arbitrary) | planned | Sweep uncollected LP fees from positions you own |
| Merkle airdrops | planned | Multi-protocol merkle claimers                          |

The first module is **Clanker** because [clanker.world](https://clanker.world)
hides your launches behind a gated verified-account flow — new creators can't
see their own tokens without a Twitter handshake. Once you scan, you'll see
every token you've ever admin'd with its current claimable balance.

## How the Clanker module works

1. Scans every Clanker factory version (`v4`, `v3_1`, `v3`, `v2`) for
   `TokenCreated` events filtered by your wallet as `tokenAdmin`.
2. Queries `FeeLocker.availableFees(owner, token)` for each discovered token,
   plus the shared WETH balance.
3. Shows everything in one list with per-token and batch claim buttons.
4. Signs claim transactions locally with an ephemeral private key (or read-only
   if you only paste an address).

## Project goals

- **Zero backend.** The deployed site is 100% static HTML/JS/CSS. GitHub Pages
  or any static host works. You can clone and run it offline.
- **Zero third-party scripts.** Ethers.js is bundled in `src/vendor/`. Strict
  Content-Security-Policy blocks every request except Base RPC.
- **Zero persistence.** Private keys live in a JavaScript closure. No
  `localStorage`, no cookies, no "remember me". Close the tab → wiped.
- **Modular sources.** Clanker is `src/sources/clanker/`. Future platforms
  (Bankr, Zora, Doppler, etc.) drop in as siblings with the same interface.
- **Auditable.** Handwritten code, no build step, no bundler. Read the source
  in an afternoon.

## How it works

```
┌─────────────────────────┐
│ You paste address or    │
│ private key             │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐    ┌───────────────────────┐
│ src/sources/clanker/    │    │ Base mainnet RPC      │
│ scanner.js              │───▶│ eth_getLogs (chunked) │
│  → discoverLaunches()   │    │ aggregate3 multicall  │
│  → queryClaimables()    │    └───────────────────────┘
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ UI renders the token    │
│ list + claim buttons    │
└────────┬────────────────┘
         │ user clicks "Claim"
         ▼
┌─────────────────────────┐    ┌───────────────────────┐
│ clanker/claimer.js      │───▶│ LpLocker.collectRewards│
│  → claimItem()          │    │ FeeLocker.claim       │
└─────────────────────────┘    └───────────────────────┘
```

All contract addresses live in [`src/sources/clanker/config.js`](src/sources/clanker/config.js),
verified against the published [`clanker-sdk`](https://www.npmjs.com/package/clanker-sdk)
package.

## Repo layout

```
ClaimApp/
├── index.html                       # Single-page entry
├── src/
│   ├── main.js                      # UI wiring (thin)
│   ├── config/
│   │   └── chains.js                # Base mainnet metadata
│   ├── services/
│   │   ├── provider.js              # JsonRpcProvider wrapper
│   │   ├── multicall.js             # Multicall3 batching
│   │   └── wallet.js                # Ephemeral key handling
│   ├── sources/
│   │   ├── index.js                 # Source registry
│   │   └── clanker/                 # ◀── one module per platform
│   │       ├── index.js             # Adapter entry
│   │       ├── config.js            # All Clanker addresses
│   │       ├── abis.js              # Contract ABIs
│   │       ├── scanner.js           # Discovery + balance queries
│   │       └── claimer.js           # Claim execution
│   ├── ui/
│   │   ├── dom.js                   # Tiny DOM helpers (no framework)
│   │   └── styles.css               # Dark theme, responsive
│   ├── utils/
│   │   └── format.js                # Display helpers
│   └── vendor/
│       ├── ethers.js                # Bundled ethers.js v6
│       └── README.md
├── .github/
│   └── workflows/
│       └── deploy-pages.yml         # Auto-deploy to GitHub Pages
├── .gitignore                       # Excludes secrets, keys, .env
├── .env.example                     # Dev-only, never committed
└── README.md
```

## Running locally

**Option A — open directly:**

```bash
git clone https://github.com/<you>/ClaimApp.git
cd ClaimApp
# Open index.html in your browser.
# On Windows: start index.html
# On macOS:   open index.html
# On Linux:   xdg-open index.html
```

ES modules require `file://` → some browsers block that. If so, use Option B.

**Option B — any static server:**

```bash
# Python
python -m http.server 8000
# or Node
npx serve .
```

Then open `http://localhost:8000`.

## Using the app

1. **Load a wallet.** Either paste a public address (read-only — you can scan
   but not claim) or paste a private key (full claim ability). The key input
   is a `type=password` field; toggle "Reveal" if you need to verify.
2. **Scan.** Click "Scan Clanker". It'll query `TokenCreated` events from every
   configured factory, then batch-read claimable balances via Multicall3.
3. **Review.** You'll see:
   - An **aggregate WETH card** (WETH accrued across all launches — Clanker
     pays fees on both the token side and WETH side).
   - A **per-token list** with claimable amounts, token version, and Basescan
     links.
4. **Claim.** Per-row buttons run `LpLocker.collectRewards` → `FeeLocker.claim`.
   Each step is a separate on-chain transaction. Gas is paid from your wallet.

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
| Rogue GitHub Action injecting code  | `.github/workflows/` is reviewed in PRs; deploy job has zero permissions beyond Pages. |

**What this app will NOT protect you from:**
- A compromised device (keyloggers, clipboard sniffers, browser extensions
  with access to your tabs).
- A fake copy of this site at a different URL. **Always verify the URL.**
- You pasting a private key on a shared computer.

If any of those are a concern, clone the repo and run it locally on a trusted
machine with no extensions.

## Adding a new source

Every claim platform lives in its own folder under `src/sources/`. To add one:

1. Create `src/sources/<name>/`.
2. Add `config.js`, `abis.js`, `scanner.js`, `claimer.js`, `index.js`.
3. The `index.js` must default-export an object matching the `SourceAdapter`
   contract in [`src/sources/index.js`](src/sources/index.js).
4. Import it in `src/sources/index.js` and push it to `SOURCES`.
5. The UI will automatically render its scan results.

Planned sources:
- [ ] Bankr (Doppler V4 launches)
- [ ] Zora (creator rewards)
- [ ] LP fee sweepers for arbitrary Uniswap V3/V4 positions
- [ ] Merkle-based airdrop claimers

Open a PR if you want to add one.

## Contributing

Pull requests welcome. Keep it small, keep it audit-friendly, keep it
dependency-free. No frameworks, no build step, no new runtime dependencies
without a security rationale.

## Donations

If this tool saved you an afternoon of Basescan scrolling, consider sending
a tip to the treasury:

```
0x7a3E312Ec6e20a9F62fE2405938EB9060312E334
```

Keeps the lights on.

## License

MIT. See [`LICENSE`](LICENSE).

## Disclaimer

Not affiliated with Clanker, Uniswap, or any launched token. Not financial
advice. Verify every transaction in your wallet before signing. Use at your
own risk.
