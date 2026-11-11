import assert from 'node:assert/strict';
import test from 'node:test';

import { contextChipSummary } from '../extension/lib/common.mjs';
import { pageContextSkipMessageKey } from '../extension/lib/page-script-host-policy.mjs';
import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';

const SIDE_PANEL_SKIP_KEYS = [
  'ui.page_context_skipped',
  'ui.page_context_off_chip',
  ...new Set(['private-network', 'excluded-origin', ''].map(pageContextSkipMessageKey)),
];

test('page-context skip strings exist in every side-panel locale catalog', async () => {
  const { default: english } = await import('../extension/lib/locales/en.mjs');
  for (const key of SIDE_PANEL_SKIP_KEYS) {
    assert.equal(typeof english[key], 'string', `${key} in English catalog`);
    assert.ok(english[key].trim(), `${key} is non-empty in English`);
    for (const locale of SUPPORTED_LOCALES) {
      const messages = await loadLocaleMessages(locale.id);
      assert.equal(typeof messages[key], 'string', `${key} in ${locale.id}`);
      assert.ok(messages[key].trim(), `${key} is non-empty in ${locale.id}`);
    }
  }
});

test('contextChipSummary reports skipped private pages without an error chip', () => {
  const summary = contextChipSummary({
    pageContext: {
      skipped: true,
      skipReason: 'private-network',
      ok: false,
      reason: 'http://127.0.0.1/ — Hermes did not inject page scripts on this private or LAN address.',
    },
    activeTab: { title: 'LAN dashboard fixture', url: 'http://127.0.0.1:18901/' },
  });
  assert.match(summary.label, /off for this site/i);
  assert.doesNotMatch(summary.label, /Error · N\/A/);
});
