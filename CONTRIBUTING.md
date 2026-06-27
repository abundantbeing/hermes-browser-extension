# Contributing

Thanks for helping improve Hermes Browser Extension.

## Development

- Use Node.js 20+.
- Run `npm run verify` before opening a PR.
- The CI runs `verify` + `build` on every push and pull request. You can see results
  at the bottom of your PR before a maintainer reviews it.
- Keep v0.1 read-only unless a proposal explicitly changes the permission model.
- Load `dist/` unpacked for manual browser testing; do not load the repo root.

## Security-sensitive changes

Open an issue before adding permissions like:

- `debugger`
- `nativeMessaging`
- `downloads`
- `cookies`
- `history`
- `bookmarks`
- browser click/type/form-submit/control behavior

Hermes Browser Extension connects to a real local or remote Hermes runtime. Treat API key handling, browser permissions, page context capture, and prompt-injection boundaries as security-sensitive.

## Relationship to Hermes Agent

This repo is a community extension for Hermes Agent. Prefer changes that use existing Hermes API/MCP/plugin surfaces and avoid requiring Hermes core changes unless discussed upstream.
