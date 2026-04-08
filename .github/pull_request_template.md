<!--
Thanks for contributing! Please fill out every section below.

Commits in the PR MUST reference the issue they close with "Fixes #N"
(or "Closes #N"). PRs without an issue reference will be asked to open
one first. Trivial typo fixes can use "refs #N" or a short justification.
-->

## What this PR does

<!-- One-line summary. -->

Fixes #

## Area

<!-- Check the one that applies. Only one — PRs that touch multiple areas should be split. -->

- [ ] `rpc` — providers, routing, rate limits (`src/services/rpc/`)
- [ ] `clanker` — source adapter (`src/sources/clanker/`)
- [ ] `frontend` — UI, rendering (`src/main.js`, `src/ui/`, `index.html`)
- [ ] `wallet` — key handling (`src/services/wallet.js`)
- [ ] `security` — CSP, audit, hardening
- [ ] `docs` — README, CONTRIBUTING, comments
- [ ] `ci` — GitHub Actions, workflows
- [ ] `test` — test scripts in `test/`

## Change summary

<!-- What did you change and why? Link to the file:line references if helpful. -->

## Testing

<!-- How did you verify this works? Required for any code change. -->

- [ ] Ran `node test/ping-router.mjs` (basic RPC sanity)
- [ ] Ran `node test/scan-treasury.mjs` (discovery + balance reads)
- [ ] Ran `node test/bench-cors.mjs` (CORS regression check — required for any `src/services/rpc/` change)
- [ ] Tested in a real browser on the live deployment OR locally via `node test/serve.mjs`

## Security checklist

- [ ] No private keys, mnemonics, API tokens, or secrets committed
- [ ] No new runtime dependencies on external CDNs (vendor bundled only)
- [ ] No new `connect-src` URLs added to CSP without matching `src/services/rpc/providers.js`
- [ ] No new `innerHTML` or `document.write` calls with user-controlled strings
- [ ] No `localStorage`/`sessionStorage`/`cookie` writes of wallet data
