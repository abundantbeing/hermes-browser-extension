// The capability matrix is only worth having if it cannot drift: every row is pinned to the manifest, the build profile
// or the code that decides it, and the Hermes Control rows must agree with the real adapter contract.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { manifestAssumptionsFor, MANIFEST_TARGETS } from '../scripts/manifest-profiles.mjs';
import {
  CHROMIUM_ACTIONS,
  FIREFOX_ACTIONS,
  FIREFOX_GAPS,
  controllerAdapterContractFor,
} from '../extension/lib/browser-controller-adapter.mjs';
import {
  BROWSER_CAPABILITY_ROWS,
  CAPABILITY_CAUSES,
  CAPABILITY_CHECKS,
  CAPABILITY_ENGINES,
  CAPABILITY_STATUSES,
  CAPABILITY_SURFACES,
  UNDESCRIBED_ADAPTER_GAP,
  capabilityEngineOf,
  capabilityLimitsFor,
  capabilityMessageKey,
  capabilityRowsFor,
} from '../extension/lib/browser-capability-matrix.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const firefoxProfile = manifestAssumptionsFor(MANIFEST_TARGETS.FIREFOX);
const rowById = (id) => BROWSER_CAPABILITY_ROWS.find((entry) => entry.id === id);
const ENGINES = Object.values(CAPABILITY_ENGINES);

test('every row names a surface, both browsers, and a reason; a feature that is not fully supported says what to do instead', () => {
  const ids = new Set();
  const surfaces = new Set(CAPABILITY_SURFACES.map((surface) => surface.id));
  for (const entry of BROWSER_CAPABILITY_ROWS) {
    assert.ok(!ids.has(entry.id), `duplicate row ${entry.id}`);
    ids.add(entry.id);
    assert.ok(surfaces.has(entry.surface), `${entry.id}: unknown surface ${entry.surface}`);
    assert.ok(entry.label.trim(), `${entry.id}: label`);
    for (const engine of ENGINES) {
      const found = entry[engine];
      assert.ok(Object.values(CAPABILITY_STATUSES).includes(found.status), `${entry.id}/${engine}: status`);
      assert.ok(Object.values(CAPABILITY_CAUSES).includes(found.cause), `${entry.id}/${engine}: cause`);
      assert.ok(Object.values(CAPABILITY_CHECKS).includes(found.checked), `${entry.id}/${engine}: checked`);
      assert.ok(found.reason.trim(), `${entry.id}/${engine}: reason`);
      assert.notEqual(found.reason, UNDESCRIBED_ADAPTER_GAP, `${entry.id}/${engine}: the adapter changed and the row has no stated reason`);
      if (found.status !== CAPABILITY_STATUSES.SUPPORTED) assert.ok(found.instead.trim(), `${entry.id}/${engine}: not supported, so it needs an "instead"`);
    }
  }
  for (const surface of surfaces) assert.ok(BROWSER_CAPABILITY_ROWS.some((entry) => entry.surface === surface), `${surface} has no rows`);
});

test('the matrix carries all four statuses the issue asks for as vocabulary, and no row is a guess about a gateway it cannot see', () => {
  assert.deepEqual(Object.values(CAPABILITY_STATUSES).sort(), ['experimental', 'limited', 'supported', 'unavailable']);
  assert.deepEqual(Object.values(CAPABILITY_CAUSES).sort(), ['browser-api', 'extension', 'gateway', 'none', 'permission', 'transport']);
});

test('Hermes Control rows are derived from the adapter contract: every Chromium action sits in exactly one row and each browser status follows what its adapter offers', () => {
  const controlRows = BROWSER_CAPABILITY_ROWS.filter((entry) => entry.actions);
  const placed = controlRows.flatMap((entry) => entry.actions);
  assert.deepEqual([...placed].sort(), [...CHROMIUM_ACTIONS].sort(), 'every Chromium action is in a row, once');
  for (const entry of controlRows) {
    const chromiumOffers = entry.actions.filter((action) => CHROMIUM_ACTIONS.includes(action)).length;
    const firefoxOffers = entry.actions.filter((action) => FIREFOX_ACTIONS.includes(action)).length;
    assert.equal(chromiumOffers, entry.actions.length, `${entry.id}: Chromium offers every action`);
    assert.equal(entry.chromium.status === CAPABILITY_STATUSES.UNAVAILABLE, false, entry.id);
    if (firefoxOffers === 0) assert.equal(entry.firefox.status, CAPABILITY_STATUSES.UNAVAILABLE, `${entry.id}: Firefox offers none of it`);
    if (firefoxOffers === entry.actions.length) assert.notEqual(entry.firefox.status, CAPABILITY_STATUSES.UNAVAILABLE, `${entry.id}: Firefox offers all of it`);
    if (firefoxOffers > 0 && firefoxOffers < entry.actions.length) assert.equal(entry.firefox.status, CAPABILITY_STATUSES.LIMITED, entry.id);
  }
  const lostOnFirefox = CHROMIUM_ACTIONS.filter((action) => !FIREFOX_ACTIONS.includes(action));
  const unavailableOnFirefox = controlRows.filter((entry) => entry.firefox.status === CAPABILITY_STATUSES.UNAVAILABLE).flatMap((entry) => entry.actions);
  assert.deepEqual([...unavailableOnFirefox].sort(), [...lostOnFirefox].sort(), 'what Firefox cannot do is exactly the rows marked unavailable');
});

test('the Firefox adapter names every Chromium action it does not offer as a gap with a reason, so nothing is silently missing', () => {
  const lostOnFirefox = CHROMIUM_ACTIONS.filter((action) => !FIREFOX_ACTIONS.includes(action));
  const contract = controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { scripting: true, tabs: true } },
    controlEnabled: true,
  });
  assert.deepEqual(contract.gaps.map((gap) => gap.action).sort(), [...lostOnFirefox].sort());
  for (const gap of FIREFOX_GAPS) assert.ok(gap.reason.trim(), `${gap.action}: reason`);
  for (const gap of contract.gaps) assert.ok(!FIREFOX_ACTIONS.includes(gap.action), `${gap.action} is both offered and a gap`);
});

test('side panel and sidebar rows follow the manifest and the Firefox build profile', () => {
  assert.ok(manifest.side_panel && manifest.permissions.includes('sidePanel') && manifest.sidebar_action, 'one manifest declares both hosts');
  assert.ok(firefoxProfile.removedManifestKeys.includes('side_panel'));
  assert.ok(firefoxProfile.removedPermissions.includes('sidePanel'));
  assert.equal(firefoxProfile.panelMode, 'sidebar-action');
  assert.equal(rowById('side-panel.panel').firefox.status, CAPABILITY_STATUSES.SUPPORTED);
  assert.equal(rowById('side-panel.per-tab').firefox.status, CAPABILITY_STATUSES.UNAVAILABLE, 'no side panel API, so no panel per tab');
  assert.equal(rowById('side-panel.per-tab').chromium.status, CAPABILITY_STATUSES.SUPPORTED);
});

test('the wake word row follows the build: Firefox drops offscreen documents and the local listener page', () => {
  assert.ok(firefoxProfile.removedPermissions.includes('offscreen'));
  const build = read('scripts/build-firefox.mjs');
  assert.match(build, /wake-listener\.html/);
  assert.match(build, /wake-listener\.js/);
  assert.equal(rowById('side-panel.wake-word').firefox.status, CAPABILITY_STATUSES.LIMITED);
  assert.match(read('extension/lib/wake-background.mjs'), /offscreen-unavailable/);
});

test('Hermes Control rows follow the debugger permission and the screenshot permission', () => {
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(firefoxProfile.removedPermissions.includes('debugger'));
  assert.deepEqual(firefoxProfile.optionalHostPermissions, ['<all_urls>']);
  assert.equal(rowById('control.screenshot').firefox.cause, CAPABILITY_CAUSES.PERMISSION);
  assert.equal(rowById('control.pointer-keyboard').firefox.cause, CAPABILITY_CAUSES.BROWSER_API);
  assert.equal(rowById('control.frames').firefox.status, CAPABILITY_STATUSES.UNAVAILABLE);
  assert.equal(rowById('control.frames').chromium.status, CAPABILITY_STATUSES.LIMITED, 'Chromium reaches same-site frames only');
});

test('Assist, context menu and shortcut rows follow the manifest and are kept by the Firefox build', () => {
  const assist = manifest.content_scripts.find((script) => script.js.includes('content-inline-helper.js'));
  assert.ok(assist && assist.matches.includes('https://*/*'), 'the Assist content script is declared for web pages');
  assert.equal(firefoxProfile.removedManifestKeys.includes('content_scripts'), false);
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.equal(firefoxProfile.removedPermissions.includes('contextMenus'), false);
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Alt+H');
  assert.equal(manifest.commands._execute_sidebar_action.suggested_key.default, 'Ctrl+Shift+H');
  assert.equal(rowById('menus.sidebar-shortcut').chromium.status, CAPABILITY_STATUSES.UNAVAILABLE);
  assert.equal(rowById('menus.sidebar-shortcut').firefox.status, CAPABILITY_STATUSES.SUPPORTED);
});

test('the full tab row is retired in both browsers: the page and its script are gone from the extension', () => {
  assert.equal(existsSync(new URL('../extension/app.html', import.meta.url)), false);
  assert.equal(existsSync(new URL('../extension/app.js', import.meta.url)), false);
  for (const engine of ENGINES) assert.equal(rowById('web.full-tab')[engine].status, CAPABILITY_STATUSES.UNAVAILABLE);
  assert.match(read('guides/connection-guide.md'), /Full-page Hermes Web view \| Retired/);
});

// Each row's claim about how a browser behaves is decided in one place. The anchor must still be there.
const ANCHORS = Object.freeze({
  'side-panel.panel': [['extension/background.js', /openNativeSidebar/], ['extension/lib/browser-runtime.mjs', /sidePanel:\s*hasMethod\(api\?\.sidePanel/]],
  'side-panel.per-tab': [['extension/sidepanel.js', /function panelUsesWindowSidebar/]],
  'side-panel.wake-word': [['extension/lib/wake-background.mjs', /tryNativeWake/]],
  'side-panel.dictation': [['extension/sidepanel.js', /function speechRecognitionConstructor/]],
  'assist.panel-route': [['extension/background.js', /handOffInlineDraftToSidePanel/], ['extension/background.js', /openAssistSidePanelFromGesture/]],
  'assist.field-drafts': [['extension/content-inline-helper.js', /HermesInlineDraft/]],
  'assist.write-back': [['extension/content-extractor.js', /function writeEditableText/]],
  'assist.background-drafts': [['extension/background.js', /runInlineDraftInServiceWorker/]],
  'web.open': [['extension/lib/hermes-webapp.mjs', /export async function openHermesWebapp/]],
  'web.sign-in': [['extension/lib/hermes-web-opening.mjs', /Chrome and Firefox share this code/]],
  'control.screenshot': [['extension/lib/browser-control-browser-adapters.mjs', /screenshot_unavailable/]],
  'control.pointer-keyboard': [['extension/lib/browser-controller-adapter.mjs', /trusted-input-unavailable/]],
  'control.read-page': [['extension/lib/browser-controller-adapter.mjs', /snapshotMode: 'content-script'/]],
  'control.frames': [['extension/lib/browser-control-browser-adapters.mjs', /frameIds: \[Math\.max\(0, Number\(scope\.frameId\) \|\| 0\)\]/]],
  'menus.context-menu': [['extension/lib/context-menu-controller.mjs', /contexts: \['page', 'selection', 'editable', 'link', 'image', 'video', 'audio'\]/]],
  'menus.toolbar-button': [['extension/background.js', /sidebar\.toggle\(\)/]],
  'menus.open-shortcut': [['extension/manifest.json', /_execute_action/]],
  'menus.sidebar-shortcut': [['extension/manifest.json', /_execute_sidebar_action/]],
});

test('every anchored row still finds the code that decides it', () => {
  for (const [id, anchors] of Object.entries(ANCHORS)) {
    assert.ok(rowById(id), `${id} is not a row`);
    for (const [file, pattern] of anchors) assert.match(read(file), pattern, `${id}: ${file}`);
  }
});

test('the checks tell the truth about evidence: nothing is marked as run unless the guard lists it, and unchecked cells are on Firefox only', () => {
  const run = [];
  const unchecked = [];
  for (const entry of BROWSER_CAPABILITY_ROWS) {
    for (const engine of ENGINES) {
      if (entry[engine].checked === CAPABILITY_CHECKS.RUN) run.push(`${entry.id}/${engine}`);
      if (entry[engine].checked === CAPABILITY_CHECKS.UNCHECKED) unchecked.push(`${entry.id}/${engine}`);
    }
  }
  assert.ok(unchecked.every((id) => id.endsWith('/firefox')), 'Chromium is the reference browser: its rows are read from code and tests');
  assert.deepEqual(run.sort(), [
    'assist.field-drafts/firefox',
    'menus.context-menu/firefox',
    'menus.open-shortcut/chromium',
    'menus.open-shortcut/firefox',
    'menus.sidebar-shortcut/chromium',
    'menus.sidebar-shortcut/firefox',
    'side-panel.dictation/firefox',
  ]);
});

test('capabilityLimitsFor lists only where a browser does less than Chromium, worst first', () => {
  const limits = capabilityLimitsFor(CAPABILITY_ENGINES.FIREFOX);
  assert.deepEqual(limits.map((entry) => entry.id), [
    'side-panel.per-tab',
    'control.pointer-keyboard',
    'control.frames',
    'control.tab-groups',
    'control.batch',
    'assist.panel-route',
    'side-panel.wake-word',
    'side-panel.dictation',
    'control.read-page',
    'control.navigate',
    'control.screenshot',
  ]);
  assert.ok(limits.every((entry) => entry.status !== CAPABILITY_STATUSES.SUPPORTED));
  assert.equal(limits.some((entry) => entry.id === 'web.full-tab'), false, 'retired on both browsers, so not a Firefox limit');
  assert.deepEqual(capabilityLimitsFor(CAPABILITY_ENGINES.CHROMIUM), []);
  assert.deepEqual(capabilityLimitsFor('safari'), []);
});

test('the engine comes from the detected browser product and unknown engines get no rows', () => {
  assert.equal(capabilityEngineOf({ id: 'firefox', engine: 'gecko' }), CAPABILITY_ENGINES.FIREFOX);
  assert.equal(capabilityEngineOf({ id: 'edge', engine: 'chromium' }), CAPABILITY_ENGINES.CHROMIUM);
  assert.equal(capabilityEngineOf({ id: 'safari', engine: 'webkit' }), '');
  assert.equal(capabilityEngineOf(null), '');
  assert.deepEqual(capabilityRowsFor('webkit'), []);
  assert.equal(capabilityRowsFor(CAPABILITY_ENGINES.FIREFOX).length, BROWSER_CAPABILITY_ROWS.length);
});

test('message keys are stable and flat', () => {
  assert.equal(capabilityMessageKey('control.pointer-keyboard', 'reason'), 'browser_limits.control_pointer_keyboard.reason');
  assert.equal(capabilityMessageKey('side-panel.per-tab', 'label'), 'browser_limits.side_panel_per_tab.label');
});
