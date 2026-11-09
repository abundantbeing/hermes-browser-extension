import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import english from '../extension/lib/locales/en.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const panel = await read('extension/sidepanel.js');
const css = await read('extension/sidepanel.css');
const manifest = JSON.parse(await read('manifest.json'));
const diagnostics = await read('extension/lib/support-diagnostics.mjs');

test('a reply is read only when the speaker button is pressed', () => {
  assert.equal(panel.match(/toggleReadAloud\(/g).length, 2, 'defined once, called once (the button)');
  assert.match(panel, /onReadAloud: \(record, node\) => \{ void toggleReadAloud\(record, node\); \}/);
});

test('only the reply body is read, never its tools or thinking, the same node Copy reads', () => {
  const body = panel.slice(panel.indexOf('async function toggleReadAloud('), panel.indexOf('window.addEventListener(\'pagehide\''));
  assert.match(body, /readableTextFromElement\(node\?\.querySelector\?\.\('\.message-content'\)\)/);
});

test('a new turn, a chat switch and closing the panel stop what is being read', () => {
  assert.match(panel, /if \(turnRunning && !readAloudTurnWasRunning\) readAloudPlayer\.turnStarted\(\)/);
  assert.match(panel, /newBelowTracker\.reset\(\);\s*readAloudPlayer\.chatChanged\(\);/);
  assert.match(panel, /window\.addEventListener\('pagehide', \(\) => readAloudPlayer\.stop\(\)\)/);
});

test('the Voice row and the support report say which route is active', () => {
  assert.match(panel, /els\.compatibilityList\.appendChild\(buildVoiceRouteRow\(\)\)/);
  assert.match(panel, /voiceOutput: voiceRouteSummary\(readAloudAvailability\(\)\)/);
  assert.match(diagnostics, /Voice output \(read aloud\)/);
});

test('gateway audio never goes through a media element, which the page security policy would block', () => {
  assert.match(manifest.content_security_policy.extension_pages, /media-src 'self';/);
  assert.doesNotMatch(panel, /new Audio\(|createElement\('audio'\)/);
});

test('the speaker button is square like its neighbours and gives no pill shape', () => {
  const rules = css.split('\n').filter((line) => /message-action-speak|is-being-read/.test(line)).join('\n');
  assert.doesNotMatch(rules, /border-radius/);
  assert.match(css, /\.message-action \{[^}]*border-radius: 6px;/);
});

test('every string the read aloud button and Voice row show is in the catalog', () => {
  for (const key of [
    'ui.read.aloud', 'ui.stop.reading.aloud', 'read_aloud.failed', 'read_aloud.nothing', 'read_aloud.label',
    'read_aloud.route.gateway', 'read_aloud.route.browser', 'read_aloud.route.none',
    'read_aloud.reason.gateway', 'read_aloud.reason.gateway_fell_back', 'read_aloud.reason.browser', 'read_aloud.reason.none',
    'read_aloud.meta.gateway', 'read_aloud.meta.browser', 'read_aloud.meta.none',
  ]) assert.equal(typeof english[key], 'string', key);
  assert.equal(english['ui.read.aloud'], 'Read aloud');
  assert.equal(english['ui.stop.reading.aloud'], 'Stop reading aloud');
});

test('the gateway voice is offered from what the dashboard probe last found, not from the capability ledger that forgets probes on a reconnect', () => {
  assert.match(panel, /readAloudDashboardProbe = \{ reachable: probe\.reachable === true, gatewayUrl: settings\.gatewayUrl \}/);
  const availability = panel.slice(panel.indexOf('function readAloudAvailability()'), panel.indexOf('function readAloudStateOf('));
  assert.match(availability, /readAloudDashboardProbe/);
  assert.doesNotMatch(availability, /capabilityRuntime/);
});

test('a shared settings write that only changes appearance does not stop read aloud', () => {
  const block = panel.slice(panel.indexOf('async function adoptHermesBrowserSettingsStorageChange('), panel.indexOf('function reloadForSavedConnection('));
  assert.match(block, /let connectionChanged = false/);
  assert.match(block, /if \(connectionChanged\) \{[\s\S]*readAloudPlayer\.stop\(\)/);
});

test('when the dashboard URL cannot be resolved, the probe records unreachable and refreshes read-aloud rails', () => {
  const body = panel.slice(panel.indexOf('async function refreshDashboardRoutes('), panel.indexOf('async function loadGatewayCapabilities('));
  assert.match(body, /if \(!baseUrl\) \{[\s\S]*readAloudDashboardProbe = \{ reachable: false, gatewayUrl: settings\.gatewayUrl \}/);
  assert.match(body, /notifyReadAloudDashboardProbeChanged\(\)/);
  assert.match(body, /catch \{[\s\S]*readAloudDashboardProbe = \{ reachable: false, gatewayUrl: settings\.gatewayUrl \}[\s\S]*notifyReadAloudDashboardProbeChanged\(\)/);
});

test('when the connection is remote or has no gateway URL, clearing the probe refreshes read-aloud rails', () => {
  const body = panel.slice(panel.indexOf('async function refreshDashboardRoutes('), panel.indexOf('async function loadGatewayCapabilities('));
  assert.match(body, /if \(isRemoteWsMode\(\) \|\| !settings\.gatewayUrl\) \{[\s\S]*readAloudDashboardProbe = null/);
  assert.match(body, /notifyReadAloudDashboardProbeChanged\(\)/);
});

test('after a cross-tab connection change clears the probe, read-aloud rails are refreshed', () => {
  const block = panel.slice(panel.indexOf('async function adoptHermesBrowserSettingsStorageChange('), panel.indexOf('function reloadForSavedConnection('));
  assert.match(block, /readAloudDashboardProbe = null;[\s\S]*notifyReadAloudDashboardProbeChanged\(\)/);
});
