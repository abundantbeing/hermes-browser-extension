import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { describeCapabilityRow } from '../extension/lib/capability-view.mjs';
import { COMPANION_REASONS, companionReasonText } from '../extension/lib/companion-plugin-status.mjs';
import english from '../extension/lib/locales/en.mjs';
import { CHECK_JS } from '../scripts/check-js.mjs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function body(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const open = panel.indexOf('{', panel.indexOf(')', start));
  let depth = 0;
  for (let at = open; at < panel.length; at += 1) {
    if (panel[at] === '{') depth += 1;
    if (panel[at] === '}' && --depth === 0) return panel.slice(start, at + 1);
  }
  throw new Error(`${name} does not close`);
}

test('the panel probes the companion plugin through the ledger, bounded and not for a remote dashboard', () => {
  assert.match(panel, /import \{[^}]*companionRecordFields[^}]*probeCompanionPlugin[^}]*\} from '\.\/lib\/companion-plugin-status\.mjs'/);
  const fn = body('refreshCompanionPluginStatus').replace(/^async /, '');
  assert.match(panel, /async function refreshCompanionPluginStatus\(\{ force = false \} = \{\}\)/);
  assert.match(fn, /normalizeGatewayMode\(settings\.gatewayMode\) === 'remote-dashboard'/);
  assert.match(fn, /Date\.now\(\) - companionProbeAt < 30_000/);
  assert.match(fn, /syncCapabilityRuntime\(\)/);
  assert.match(fn, /capabilityRuntime\.ledger\.observeProbe\('browserCompanionPlugin', fields\)/);
  assert.match(fn, /identityKey/, 'an answer for another connection is dropped');
  assert.match(fn, /refreshCapabilityViews\(\)/);
});

test('the probes run after capabilities load, when the socket is ready, and forced when About & Diagnostics opens', () => {
  const load = panel.slice(panel.indexOf('async function loadGatewayCapabilities('), panel.indexOf('// Product mode (Local / Cloud / Remote)'));
  assert.match(load, /void refreshCompanionPluginStatus\(\)\.catch/);
  assert.match(load, /void refreshDashboardRoutes\(\)\.catch/);
  const show = body('showSettingsPane');
  assert.match(show, /settingsActivePane === 'about'[\s\S]*refreshCompanionPluginStatus\(\{ force: true \}\)[\s\S]*refreshDashboardRoutes\(\{ force: true \}\)/);
  assert.match(panel, /gatewayClient\.on\('gateway\.ready', \(\) => \{\s*refreshCapabilityViews\(\);\s*void refreshCompanionPluginStatus\(\{ force: true \}\)/);
});

test('the dashboard-route probe stays off a remote dashboard and feeds only the three rows the dashboard serves', () => {
  const fn = body('refreshDashboardRoutes');
  assert.match(fn, /isRemoteWsMode\(\)/);
  assert.match(fn, /fetchDashboardSessionToken\(/);
  assert.match(fn, /for \(const id of DASHBOARD_ROUTE_CAPABILITIES\) capabilityRuntime\.ledger\.observeProbe\(id, fields\)/);
});

test('a pasted image without an API upload route goes through the dashboard before staying inline', () => {
  const fn = body('uploadImageAttachment');
  const gate = fn.indexOf('!gatewayCapabilities.imageUpload');
  assert.ok(gate > 0);
  assert.match(fn, /uploadImageViaDashboard\(/);
  assert.ok(fn.indexOf('uploadImageViaDashboard(') > gate, 'only when the gateway advertises no upload route');
  assert.match(fn, /uploadSkipped: true/, 'the inline-only result is still there when the dashboard cannot help');
});

test('the Settings reason line is localized, with the companion reasons and params in every catalog the panel reads', () => {
  const codes = Object.keys(COMPANION_REASONS);
  assert.equal(codes.length, 14);
  const t = (key, params = {}) => String(english[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
  for (const code of codes) {
    assert.ok(english[`capability.reason.${code.replaceAll('-', '_')}`], `${code} has an English string`);
  }
  const row = (reasonCode, params) => ({ key: 'browserCompanionPlugin', state: 'degraded', status: 'ok', reasonCode, params, source: 'probe', checkedAt: 1, ageMs: 1000 });
  const cases = [
    ['companion-ready', { version: '0.3.4', profile: '', toolCount: 7 }],
    ['companion-ready-route-only', { version: '0.3.4', profile: 'work', toolCount: 7 }],
    ['companion-version-old', { version: '0.2.0', expected: '0.3.4' }],
    ['companion-tools-missing', { version: '0.3.4', missing: ['browser_text_utility', 'browser_event_log'] }],
    ['companion-no-route', { present: ['browser_get_context'] }],
    ['companion-network', { detail: 'timed out' }],
    ['companion-network', { detail: '' }],
    ['companion-auth-refused', { status: 401 }],
    ['companion-gateway-error', { status: 502 }],
    ['companion-route', { version: '0.4.0', route: '/api/plugins/hermes-browser-extension/context' }],
    ['companion-renamed', { version: '0.3.4' }],
  ];
  for (const [code, params] of cases) {
    const view = describeCapabilityRow(row(code, params), { t });
    assert.doesNotMatch(view.reason, /\{\w+\}/, `${code}: no unfilled placeholder in "${view.reason}"`);
    assert.doesNotMatch(view.reason, /\[object|,,/, code);
  }
  // The English catalog and the module's own sentences agree on what each says.
  const missing = describeCapabilityRow(row('companion-tools-missing', { version: '0.3.4', missing: ['a', 'b'] }), { t }).reason;
  assert.match(missing, /missing tools: a, b\./);
  assert.match(companionReasonText('companion-tools-missing', { version: '0.3.4', missing: ['a', 'b'] }), /missing tools: a, b\./);
});

test('the two new reason codes have strings', () => {
  for (const key of ['capability.reason.dashboard_route', 'capability.reason.not_in_hermes']) {
    assert.ok(english[key], key);
  }
});

test('check:js covers the new modules', () => {
  for (const file of ['companion-plugin-status', 'dashboard-routes']) {
    assert.ok(CHECK_JS.includes(`node --check extension/lib/${file}.mjs`), file);
  }
});
