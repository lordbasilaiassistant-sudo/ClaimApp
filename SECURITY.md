# Security Policy

## Reporting a vulnerability

ClaimApp handles private keys entirely in the user's browser. A security
bug could cost real users real money. Please report any suspected
vulnerability responsibly.

### Critical / High severity

**Do NOT open a public issue for vulnerabilities that could:**

- Leak or exfiltrate a private key, mnemonic, or signed transaction
- Allow an attacker to inject code into the deployed page
- Allow an attacker to redirect signing to a different contract
- Bypass the Content-Security-Policy or CORS controls
- Compromise the GitHub Pages build pipeline

**Use GitHub's private Security Advisory flow instead:**
<https://github.com/lordbasilaiassistant-sudo/ClaimApp/security/advisories/new>

This keeps the report private until a fix is ready and deployed.

### Low / Medium severity

For non-exploitable hardening findings — CSP tweaks, dependency updates,
documentation gaps, defense-in-depth improvements — use the
[Security finding issue template](.github/ISSUE_TEMPLATE/security.yml).

## Scope

**In scope:**

- The deployed site at <https://lordbasilaiassistant-sudo.github.io/ClaimApp/>
- Code in `src/`, `index.html`, and `test/`
- The GitHub Actions workflows in `.github/workflows/`
- The vendored `src/vendor/ethers.js` — though for bugs in ethers itself
  please report upstream at <https://github.com/ethers-io/ethers.js>

**Out of scope:**

- Third-party RPC providers we route through (tenderly, base-official,
  etc.) — report issues with those to the respective providers
- GitHub itself, GitHub Pages infrastructure
- Vulnerabilities in the Clanker protocol contracts on Base — report
  those to the Clanker team directly

## Our commitment

If you report a valid security issue:

1. We'll acknowledge receipt within 72 hours
2. We'll work with you on a timeline for the fix
3. We'll credit you in the fix commit (unless you prefer anonymity)
4. We won't pursue legal action against good-faith researchers

## What to test

The high-value things to audit:

- `src/services/wallet.js` — private key handling, closure discipline,
  cleanup on unload
- `src/main.js` — key input flow, claim confirmation, error sanitization
- `index.html` — CSP policy, inline handlers, script-src allowlist
- `src/services/rpc/*.js` — URL validation, CORS handling, request bodies
- `.github/workflows/*.yml` — workflow permissions, action pinning

## Out-of-scope "findings" we see a lot

- "The site doesn't have HSTS" — GitHub Pages enforces HTTPS at the edge
- "The site doesn't have X-Frame-Options" — the CSP `frame-ancestors 'none'`
  covers this
- "jQuery is outdated" — we don't use jQuery
- "The CDN could be compromised" — we don't use a CDN (all JS is
  bundled in `src/vendor/`)
- "The ethers.js bundle has console.log statements" — those are in
  dead upstream code paths, not reachable from our code

Thanks for helping keep ClaimApp users safe.
