# Contributing to ClaimApp

Thanks for wanting to contribute. ClaimApp is a small, security-sensitive
project — a zero-backend web app that handles user private keys entirely
in the browser. Every change has to preserve that invariant.

This document explains how the team is organized, the issue-driven workflow,
and the bar for merging.

## TL;DR

1. Open an issue (bug / feature / security) using the templates
2. Wait for triage — an area owner will pick it up
3. Send a PR that references the issue with `Fixes #N`
4. Final QA verifies the PR actually closes the issue
5. Merge → issue auto-closes → deployed to GitHub Pages automatically

## Team structure

The codebase is split into areas. Each area has one owner who maintains
it and reviews incoming PRs. Nobody steps on anybody else's toes.

| Area | Paths | Owner focus |
|---|---|---|
| **RPC infrastructure** | `src/services/rpc/**` | Provider list, routing, rate limits, CORS, health tracking, failover. Owns the multi-RPC router and the log-fetcher hot path. |
| **Core services** | `src/services/{wallet,provider,multicall,rpc-throttle}.js` | Wallet lifecycle, ethers provider wiring, multicall batching, retry primitives. |
| **Source modules** | `src/sources/**` | Per-platform adapters: Clanker today, Bankr / Zora / Doppler tomorrow. Each module follows the SourceAdapter contract in `src/sources/index.js`. |
| **Frontend** | `src/main.js`, `src/ui/**`, `index.html` | UI wiring, rendering, CSS, CSP, accessibility. |
| **Security** | Cross-cutting (anywhere that touches keys or user data) | Audits, vuln response, CSP review, dependency hygiene, threat modeling. |
| **Testing** | `test/**` | Unit and integration test scripts, CORS regression checks, provider benchmarks. |
| **Docs / DX** | `README.md`, `CONTRIBUTING.md`, `docs/**`, inline comments | External-facing docs, onboarding flow, contributor experience. |
| **Final QA / merge** | Everything at merge time | Runs the full test suite, does a live-site smoke test after every merge, closes the referenced issue only if the fix actually works. |

Final review on every PR routes to the repo owner
(`@lordbasilaiassistant-sudo`) via the [`CODEOWNERS`](.github/CODEOWNERS)
file. The table above is the internal ownership map used to decide who
drafts a fix — the merge authority is shared.

## Issue-driven workflow

### 1. Open an issue first

Every code change starts with an issue. Use the templates:

- **[Bug report](./.github/ISSUE_TEMPLATE/bug_report.yml)** — something
  is broken or produces wrong results
- **[Feature request](./.github/ISSUE_TEMPLATE/feature_request.yml)** —
  new source module, UI improvement, etc.
- **[Security finding](./.github/ISSUE_TEMPLATE/security.yml)** — LOW or
  MEDIUM hardening recommendation. **HIGH and CRITICAL findings must use
  the [private Security Advisory](https://github.com/lordbasilaiassistant-sudo/ClaimApp/security/advisories/new)**,
  not a public issue.

The triage process labels the issue with one of:
`area:rpc`, `area:clanker`, `area:frontend`, `area:services`,
`area:security`, `area:test`, `area:docs`.

### 2. Owner picks it up

The area owner drafts a fix. If you want to take an issue yourself,
comment on it first so we don't double up.

### 3. Open a PR referencing the issue

Every PR **must** reference the issue it resolves:

```
Fixes #42
```

(or `Closes #42` — both work). This causes the issue to auto-close when
the PR merges.

PRs follow the template in `.github/pull_request_template.md` — it has
an area checklist, a testing checklist, and a security checklist.

### 4. Final QA

Before merging, the reviewer verifies:

1. The code change actually fixes the referenced issue
2. `node test/ping-router.mjs` still passes (RPC sanity)
3. `node test/scan-treasury.mjs` still works (discovery + balance reads)
4. `node test/bench-cors.mjs` still shows all providers CORS-green
5. CI passes (syntax + CORS regression check)
6. The change doesn't violate any of the invariants in "Design rules" below
7. After merge: a live-site smoke test on the deployed GitHub Pages URL

### 5. Auto-deploy

Merging to `main` triggers the [deploy-pages workflow](./.github/workflows/deploy-pages.yml)
which publishes the site to
<https://lordbasilaiassistant-sudo.github.io/ClaimApp/>.

## Design rules (hard invariants)

These are not style preferences — they're load-bearing for the app's
security model. PRs that violate them will not merge.

### Privacy & security

- **Zero backend.** The deployed site is 100% static HTML/JS/CSS. No
  server to compromise. If your feature needs a backend, open a feature
  issue first so we can discuss architecture.
- **No runtime CDN dependencies.** All JS (including ethers) is bundled
  in `src/vendor/`. A compromised CDN cannot inject code into a page
  that handles private keys.
- **No telemetry, analytics, or trackers.** Zero third-party scripts.
  Not "anonymous" analytics, not "performance monitoring" — zero.
- **No `innerHTML` with user-controlled strings.** Use `el()` and
  `document.createTextNode()` from `src/ui/dom.js`.
- **No `localStorage` / `sessionStorage` / `cookie` writes of wallet
  data.** Private keys live in a closure inside `src/services/wallet.js`
  and are wiped on `beforeunload`.
- **No new `connect-src` URLs without adding them to both**
  `src/services/rpc/providers.js` **AND** `index.html`'s CSP meta tag.
  Mismatches cause silent scan failures.
- **Providers must pass `node test/bench-cors.mjs`.** A provider that
  works in Node but fails CORS preflight in a browser is useless. This
  is how we shipped a bug the first time — never again.

### Code quality

- **No frameworks, no build step, no bundler.** Vanilla JS + ES modules.
  Adding a build step requires a very strong justification.
- **Small files.** If a file exceeds ~300 lines, split it.
- **Comments explain _why_, not _what_.** Code shows what. Comments
  explain the reasoning, trade-offs, or non-obvious behavior.
- **Tests before fixes.** When fixing a bug, write a test (or at least
  a repro script in `test/`) that demonstrates the bug before you fix it.
- **No speculative abstractions.** Three similar lines of code beat a
  premature helper function. Wait until you have a real second use case.

## Running locally

```bash
git clone https://github.com/lordbasilaiassistant-sudo/ClaimApp.git
cd ClaimApp
node test/serve.mjs 8000
# → open http://localhost:8000
```

No dependencies to install — the repo is self-contained.

## Running the test suite

```bash
node test/ping-router.mjs          # RPC sanity check (~1 sec)
node test/scan-treasury.mjs        # full scan of the treasury wallet (~5 sec)
node test/stress-scan.mjs          # 10 back-to-back scans — stress test
node test/bench-cors.mjs           # CORS compatibility check for every provider
node test/bench-chunk-sizes.mjs    # max eth_getLogs chunk size per provider
```

## Adding a new source module

Each claim source lives in its own folder under `src/sources/<name>/`.
The shape is:

```
src/sources/my-source/
├── config.js      # addresses, block windows, constants
├── abis.js        # contract ABIs (human-readable format)
├── scanner.js     # discovery + balance queries
├── claimer.js     # claim execution (signer required)
└── index.js       # default export implementing SourceAdapter
```

The adapter must implement `scan(address, options)` and may implement
`claimItem(item, signer)`, `claimAll(items, signer)`, etc. See
`src/sources/clanker/` for a complete reference implementation and
`src/sources/index.js` for the exact contract.

Register your new source in `src/sources/index.js`:

```js
import mySource from './my-source/index.js';
export const SOURCES = [clanker, mySource];
```

That's it — the UI will automatically render its results alongside
the other sources.

## Questions?

Open an issue. If it's a quick question about contributing, use a
feature request template and label it `question`.

Made by [**THRYX**](https://thryx.fun) — the free gasless token launchpad on Base.
