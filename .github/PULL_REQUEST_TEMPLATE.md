## What does this PR do?

<!-- Describe the change clearly. What problem does it solve? Why is this approach the right one? -->

## Related Issue / Phase

<!-- Link the issue or roadmap phase this PR addresses (e.g. Fixes #12, Phase 6 tab control, etc.) -->

Fixes #

## Type of Change

<!-- Check all that apply. -->

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change adding new browser capability)
- [ ] 🌐 Browser compatibility (Edge, Brave, Comet, Opera, Firefox, etc.)
- [ ] 🔒 Security & Privacy hardening (consent gates, redaction, sandbox isolation)
- [ ] 🎨 UI & Design polish (theme studio, side panel, animations, Nous theme)
- [ ] 📝 Documentation update (README, developer guides)
- [ ] ✅ Tests (unit tests, Chrome-for-Testing / E2E suites)
- [ ] ♻️ Refactor (internal cleanup with zero behavior change)

## Changes Made

<!-- List specific changes made. Include file paths for key files. -->

- 

## How to Test

<!-- Provide exact steps to verify this change works. Include command lines and browser steps. -->

1. `npm test`
2. `npm run verify`
3. Load unpacked extension in Chrome/Comet (`chrome://extensions`) and test:

## Checklist

### Code & Manifest

- [ ] I've read the [Contributing Guide](https://github.com/abundantbeing/hermes-browser-extension/blob/main/CONTRIBUTING.md)
- [ ] My commit messages follow Conventional Commits (`fix(scope):`, `feat(scope):`, etc.)
- [ ] My PR contains **only** changes related to this fix/feature (no unrelated commits or workspace artifacts)
- [ ] All tests pass: `npm test` (and `npm run verify`)
- [ ] JavaScript syntax check passes: `npm run check:js`
- [ ] Manifest and locales are valid: `npm run check:manifest`
- [ ] Zero eval / zero remote script execution (strict MV3 compliance)

### Cross-Browser & Safety

- [ ] Tested on target browser(s): <!-- e.g. Comet, Chrome, Brave, Edge, Firefox -->
- [ ] Context consent rules preserved (no ambient page capture without user consent)
- [ ] No hardcoded secrets, tokens, or unredacted personal credentials

## Screenshots / Logs

<!-- If applicable, add screenshots, GIFs, or log outputs demonstrating the change. -->
