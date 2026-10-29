// The product is the Hermes Browser Extension. "Hermes Browser" alone is a
// brand mark: the wordmarks, the welcome title and the right-click menu. Copy
// that says what the product is, or what to reload, allow or look for, names
// the extension; a separate Hermes Browser (a full browser) is planned.

import assert from 'node:assert/strict';
import test from 'node:test';

import english from '../extension/lib/locales/en.mjs';

const BRAND_MARK_KEYS = new Set([
  'ui.hermes.browser',
  'ui.hermes.browser.intro',
  'ui.hermes.browser.local.sidecar',
  'ui.open.hermes.browser',
  'ui.open.hermes.browser.always.opens.the.side.panel.only.selection.0b8dac3c',
  'ui.open.hermes.browser.uses.the.side.panel.only.selection.tasks.st.4f56df05',
  'onboarding.welcome.title',
]);

test('English copy uses the bare "Hermes Browser" only as a brand mark', () => {
  const bare = Object.entries(english)
    .filter(([, message]) => typeof message === 'string' && /Hermes Browser(?! Extension)/.test(message))
    .map(([key]) => key);
  assert.deepEqual(bare.filter((key) => !BRAND_MARK_KEYS.has(key)), []);
  for (const key of BRAND_MARK_KEYS) assert.ok(bare.includes(key), `${key} still carries the brand mark`);
});

test('English copy never calls the extension just "Browser" when it is the one acting', () => {
  const acting = Object.entries(english)
    .filter(([, message]) => typeof message === 'string'
      && /(?:^|[.;:]\s+|, so |, but |, and )Browser (?:could|cannot|can|will|released|probes)\b/.test(message))
    .map(([key]) => key);
  assert.deepEqual(acting, []);
});
