# Contributing to Hermes Browser Extension

Thank you for contributing to Hermes Browser Extension! This guide outlines our architecture, development workflow, and the quality standards required to get pull requests reviewed and merged.

---

## 1. Core Architecture Principles

Hermes Browser Extension is a Manifest V3 web extension designed to bring Hermes Agent capabilities into real browser environments.

* **Fail-Closed Security:** No silent permission escalations or ambient context leaks. Context consent is strictly scoped by gateway, profile, and controller.
* **Zero Remote Execution / Zero Eval:** The extension contains zero `eval()`, zero `new Function()`, zero remote script/font injections, and adheres strictly to Chrome Web Store and Mozilla Add-on security guidelines.
* **Deterministic Model Routing:** The "Model-Fidelity Triad" (Provider-Aware Routing, Live Inventory, and Session Model Lock) guarantees user-selected models are respected.
* **Cross-Browser Parity:** First-class support for Chromium engines (Comet, Chrome, Brave, Edge, Opera, Arc) with clean, documented subset compatibility for Firefox.

---

## 2. Development Setup

### Prerequisites
* Node.js `>=20`
* Chromium-based browser (Comet / Chrome / Brave) or Firefox

### Installation
```bash
git clone https://github.com/abundantbeing/hermes-browser-extension.git
cd hermes-browser-extension
npm install
```

### Building & Testing
```bash
# Run unit tests
npm test

# Build unpacked extension into dist/
npm run build

# Build Firefox extension into dist/firefox
npm run build:firefox

# Run complete canonical verification (tests, JS syntax checks, manifest & locale validation)
npm run verify
```

---

## 3. Submitting Pull Requests

### Before Opening a PR
1. **Search Existing Work:** Search open and merged PRs/issues to ensure your change isn't a duplicate.
2. **Atomic Changes:** Keep your PR focused on a single bug fix, feature, or enhancement. Avoid bundling unrelated formatting or refactoring.
3. **Run Full Verification:** Make sure `npm run verify` passes with zero errors and zero unexpected warnings.

### Commit Messages
We follow [Conventional Commits](https://www.conventionalcommits.org/):
* `fix(assist): ...`
* `feat(browser-control): ...`
* `fix(sidepanel): ...`
* `docs(readme): ...`
* `test(policy): ...`

### PR Description
Fill out the provided [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md) completely:
* Explain what the PR does and why the chosen approach is correct.
* Reference related issue numbers (`Fixes #...`).
* Provide clear, reproducible verification steps.
* Include screenshots or screencasts for any UI or behavioral changes.

---

## 4. Automated & Human Review

* Automated review agents inspect incoming PRs for security boundaries, test coverage, and regressions.
* Maintainers review all code diffs prior to merging into `main`.
