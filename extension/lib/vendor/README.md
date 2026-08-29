# Vendored third-party libraries

These files are committed copies of npm packages used by the extension at
runtime. The extension has no bundler and must remain fully self-contained
(`load unpacked` runs straight from this tree), so runtime dependencies are
vendored here instead of resolved from `node_modules`.

| File | Package | Version | License |
|------|---------|---------|---------|
| `purify.es.mjs` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.13 | Apache-2.0 OR MPL-2.0 |
| `highlight-core.mjs`, `highlight-*.mjs` | [highlight.js](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause |

The highlight.js license text is included as `highlight.js.LICENSE`. The
vendored language set is intentionally limited to common chat/code-review
formats; update `scripts/vendor-security-libs.mjs` to change it.

## Updating

1. `npm install <package>@<version>` (updates `package.json` + lockfile).
2. `node scripts/vendor-security-libs.mjs` (copies the ESM build here).
3. `npm run verify` and `npm run lint` to confirm nothing regressed.
4. Commit the dependency bump together with the vendored file.

## Integrity

DOMPurify is copied byte-for-byte from its published ESM build. The
highlight.js CommonJS core and language modules are converted by the vendor
script into deterministic local ESM modules. Verify both with
`npm ci && node scripts/vendor-security-libs.mjs` followed by
`git diff --exit-code`. The build also refuses to proceed when any extension
page references remote scripts (see `scripts/check-self-contained.mjs`).
