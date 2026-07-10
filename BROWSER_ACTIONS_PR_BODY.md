# Hermes browser action bridge

## Summary

- add the versioned `hermes.browser.actions.v1` policy with the exact reviewed action allow-list
- route `browser.action.requested` events through an explicit side-panel approval card for `click`, `typeText`, `select`, and `openUrl`
- execute approved actions in the active tab while blocking restricted URLs, sensitive/submitting controls, unsupported actions, and non-HTTP(S) targets
- return `browser.action.result` acknowledgements with sanitized metadata only; raw screenshot `dataUrl` values remain inside the extension
- add focused policy/bridge tests and a loaded-Chromium end-to-end smoke harness whose `ws:` CSP and screenshot host-permission relaxations exist only in a temporary extension copy

## Security properties

- exact supported actions: `getSnapshot`, `screenshot`, `scroll`, `click`, `typeText`, `select`, `openUrl`
- `submitForm`, cookie/history/bookmark/native-messaging style actions, restricted URL categories, browser-internal URLs, and sensitive controls are rejected
- mutating actions always require fresh user approval; an inbound `approvedByUser` value cannot bypass the side-panel prompt
- page content is labeled untrusted
- there is no form `.submit()` execution path
- screenshot pixels are stripped before the result crosses the gateway boundary
- action events are ignored until their exact browser session is active

## Test plan

- `npm run verify`
- `npm run smoke:loaded-browser`
- `npm run lint`
- `npm run build`

The focused browser-action tests cover restricted URL/action rejection, fresh mutating-action approval, session binding, absence of a `.submit()` path, and screenshot `dataUrl` sanitization. The loaded-browser smoke verifies a real unpacked extension receives `browser.action.requested`, captures a screenshot, reports `browser.action.result`, and does not return raw screenshot data to Hermes.
