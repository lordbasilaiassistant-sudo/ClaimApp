# vendor

Third-party libraries bundled locally so the app has **zero runtime
dependencies on external CDNs**. This means:

1. The site works offline after first load.
2. No CDN can inject malicious code into a page that handles private keys.
3. Subresource Integrity (SRI) is unnecessary — files are in-repo and
   version-controlled; any modification shows up in `git diff`.

## Files

| File         | Source                                       | Version  | License |
|--------------|----------------------------------------------|----------|---------|
| `ethers.js`  | https://www.npmjs.com/package/ethers         | 6.16.0   | MIT     |

## Updating

Never edit these files by hand. To update:

```bash
npm view ethers dist-tags.latest
# fetch the new version
curl -o src/vendor/ethers.js https://cdn.jsdelivr.net/npm/ethers@<VERSION>/dist/ethers.js
# verify checksum against the npm registry, then commit
```

Open a PR with the diff so reviewers can confirm the bundle matches the
official release.
