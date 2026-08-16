# Vendored third-party libraries

These files are committed copies of npm packages used by the extension at
runtime. The extension has no bundler and must remain fully self-contained
(`load unpacked` runs straight from this tree), so runtime dependencies are
vendored here instead of resolved from `node_modules`.

| File | Package | Version | License |
|------|---------|---------|---------|
| `purify.es.mjs` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.13 | Apache-2.0 OR MPL-2.0 |

## Updating

1. `npm install <package>@<version>` (updates `package.json` + lockfile).
2. `node scripts/vendor-security-libs.mjs` (copies the ESM build here).
3. `npm run verify` and `npm run lint` to confirm nothing regressed.
4. Commit the dependency bump together with the vendored file.

## Integrity

These files are byte-for-byte copies of the published npm package builds.
Verify with `npm ci && node scripts/vendor-security-libs.mjs` followed by
`git diff --exit-code` — a clean diff proves the vendored copies match the
published artifacts. The build also refuses to proceed when any extension
page references remote scripts (see `scripts/check-self-contained.mjs`).
