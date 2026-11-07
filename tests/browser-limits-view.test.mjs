import assert from 'node:assert/strict';
import test from 'node:test';

import en from '../extension/lib/locales/en.mjs';
import { describeBrowserLimits } from '../extension/lib/browser-limits-view.mjs';
import {
  BROWSER_CAPABILITY_ROWS,
  CAPABILITY_ENGINES,
  CAPABILITY_STATUSES,
  capabilityLimitsFor,
  capabilityMessageKey,
} from '../extension/lib/browser-capability-matrix.mjs';

const fill = (text, params = {}) => String(text).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
const english = (key, params) => fill(en[key] ?? `MISSING:${key}`, params);
const firefox = { id: 'firefox', engine: 'gecko' };

test('Firefox shows the limits, worst first, each with its status, reason and what to do instead', () => {
  const view = describeBrowserLimits({ product: firefox, t: english });
  assert.equal(view.hidden, false);
  assert.deepEqual(view.rows.map((row) => row.id), capabilityLimitsFor(CAPABILITY_ENGINES.FIREFOX).map((row) => row.id));
  assert.equal(view.summary, english('browser_limits.summary', { count: view.rows.length }));
  const pointer = view.rows.find((row) => row.id === 'control.pointer-keyboard');
  assert.equal(pointer.status, CAPABILITY_STATUSES.UNAVAILABLE);
  assert.equal(pointer.statusLabel, 'Unavailable');
  assert.match(pointer.reason, /no debugger API/);
  assert.match(pointer.instead, /^Instead: /);
  assert.ok(view.rows.every((row) => !/MISSING|\{/.test(`${row.label} ${row.reason} ${row.instead} ${row.statusLabel}`)));
});

test('Chromium, unknown browsers and a missing product show nothing', () => {
  for (const product of [{ id: 'edge', engine: 'chromium' }, { id: 'safari', engine: 'webkit' }, null, undefined]) {
    const view = describeBrowserLimits({ product, t: english });
    assert.equal(view.hidden, true);
    assert.deepEqual(view.rows, []);
  }
});

test('the catalog carries every Firefox limit in the same words as the matrix, so the product and the guide say one thing', () => {
  for (const row of capabilityLimitsFor(CAPABILITY_ENGINES.FIREFOX)) {
    const source = BROWSER_CAPABILITY_ROWS.find((entry) => entry.id === row.id);
    assert.equal(en[capabilityMessageKey(row.id, 'label')], source.label, `${row.id} label`);
    assert.equal(en[capabilityMessageKey(row.id, 'reason')], source.firefox.reason, `${row.id} reason`);
    assert.equal(en[capabilityMessageKey(row.id, 'instead')], source.firefox.instead, `${row.id} instead`);
  }
  for (const status of ['limited', 'experimental', 'unavailable']) assert.ok(en[`browser_limits.status_${status}`], status);
});

test('Settings > About & Diagnostics has the Firefox limits block, hidden until the panel runs on Firefox, drawn with the compatibility list styles', async () => {
  const { readFile } = await import('node:fs/promises');
  const [html, js] = await Promise.all([
    readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8'),
    readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<details id="browserLimitsPanel" class="compatibility-panel"[^>]* hidden>/);
  assert.match(html, /id="browserLimitsTitle" class="compatibility-title" data-i18n="browser_limits\.title"/);
  assert.match(html, /<ul id="browserLimitsList" class="compatibility-list">/);
  assert.match(js, /import \{ describeBrowserLimits \} from '\.\/lib\/browser-limits-view\.mjs';/);
  assert.match(js, /describeBrowserLimits\(\{ product: browserProduct, t \}\)/);
  assert.match(js, /renderBrowserLimitsPanel\(\);\n\}/, 'drawn whenever the compatibility panel is');
});
