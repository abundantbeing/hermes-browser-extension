import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLER_ADAPTER_IDS,
  controllerAdapterContractFor,
} from '../extension/lib/browser-controller-adapter.mjs';

const CHROMIUM_ACTIONS = [
  'browser_back',
  'browser_click',
  'browser_drag',
  'browser_fill',
  'browser_hover',
  'browser_navigate',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_scroll_to',
  'browser_select',
  'browser_snapshot',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_create',
  'browser_tab_group',
  'browser_tab_ungroup',
  'browser_tabs',
  'browser_type',
];

const FIREFOX_ACTIONS = [
  'browser_back',
  'browser_navigate',
  'browser_screenshot',
  'browser_scroll',
  'browser_snapshot',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_create',
  'browser_tabs',
];

test('Phase 6 Chromium adapter truthfully enables the full real-tab set only with required APIs and explicit control', () => {
  const enabled = controllerAdapterContractFor({
    product: { id: 'edge', engine: 'chromium' },
    capabilities: { apis: { debugger: true, scripting: true, tabs: true } },
    controlEnabled: true,
  });
  assert.equal(enabled.id, CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP);
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.actions, CHROMIUM_ACTIONS);
  assert.equal(enabled.inputMode, 'trusted-cdp');
  assert.equal(enabled.snapshotMode, 'accessibility-cdp');
  assert.equal(enabled.gaps.length, 0);

  const disabled = controllerAdapterContractFor({
    product: { id: 'edge', engine: 'chromium' },
    capabilities: { apis: { debugger: true, scripting: true, tabs: true } },
  });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.actions, []);
  assert.match(disabled.reason, /not enabled/i);

  const missingDebugger = controllerAdapterContractFor({
    product: { id: 'edge', engine: 'chromium' },
    capabilities: { apis: { debugger: false, scripting: true, tabs: true } },
    controlEnabled: true,
  });
  assert.equal(missingDebugger.enabled, false);
  assert.match(missingDebugger.reason, /debugger/i);
});

test('Phase 6 Firefox adapter advertises a safe subset and exact trusted-input gap', () => {
  const firefox = controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { debugger: false, scripting: true, tabs: true } },
    controlEnabled: true,
  });
  assert.equal(firefox.id, CONTROLLER_ADAPTER_IDS.FIREFOX_WEBEXTENSION);
  assert.equal(firefox.enabled, true);
  assert.deepEqual(firefox.actions, FIREFOX_ACTIONS);
  assert.equal(firefox.inputMode, 'unavailable');
  assert.equal(firefox.snapshotMode, 'content-script');
  assert.deepEqual(firefox.gaps, [
    { action: 'browser_click', reason: 'trusted-input-unavailable' },
    { action: 'browser_drag', reason: 'trusted-input-unavailable' },
    { action: 'browser_fill', reason: 'trusted-input-unavailable' },
    { action: 'browser_hover', reason: 'trusted-input-unavailable' },
    { action: 'browser_press', reason: 'trusted-input-unavailable' },
    { action: 'browser_scroll_to', reason: 'trusted-input-unavailable' },
    { action: 'browser_select', reason: 'trusted-input-unavailable' },
    { action: 'browser_type', reason: 'trusted-input-unavailable' },
  ]);
});

test('Phase 6 unknown engines and incomplete Firefox APIs fail closed', () => {
  const unknown = controllerAdapterContractFor({
    product: { id: 'safari', engine: 'webkit' },
    capabilities: { apis: { scripting: true, tabs: true } },
    controlEnabled: true,
  });
  assert.equal(unknown.id, CONTROLLER_ADAPTER_IDS.UNSUPPORTED);
  assert.equal(unknown.enabled, false);
  assert.deepEqual(unknown.actions, []);

  const incomplete = controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { scripting: false, tabs: true } },
    controlEnabled: true,
  });
  assert.equal(incomplete.enabled, false);
  assert.match(incomplete.reason, /scripting/i);
});
