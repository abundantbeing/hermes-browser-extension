import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_GATEWAY_CAPABILITIES,
  browserControlSupport,
  dashboardWsGatewayCapabilities,
  normalizeGatewayCapabilities,
} from '../extension/lib/capabilities.mjs';
import { browserControlView } from '../extension/lib/browser-control-ui.mjs';
import { CONTROLLER_UNSUPPORTED_GATEWAY } from '../extension/lib/controller-protocol.mjs';
import english from '../extension/lib/locales/en.mjs';

const sidepanel = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const fn = (name) => sidepanel.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || '';

const STOCK = { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: { session_chat: true } };
const patched = (extra = {}) => ({
  ...STOCK,
  features: { ...STOCK.features, browser_extension_control: { enabled: true, ...extra } },
});

test('REST gateways are gated on the advertised capability', () => {
  assert.equal(browserControlSupport(normalizeGatewayCapabilities(patched(), { healthOk: true })), 'supported');
  // Stock Hermes does not advertise the key at all.
  assert.equal(browserControlSupport(normalizeGatewayCapabilities(STOCK, { healthOk: true })), 'unsupported');
  assert.equal(
    browserControlSupport(normalizeGatewayCapabilities({
      ...STOCK,
      features: { browser_extension_control: { enabled: false } },
    }, { healthOk: true })),
    'unsupported',
  );
  assert.equal(
    browserControlSupport(normalizeGatewayCapabilities({
      ...STOCK,
      features: { browser_extension_control: {} },
    }, { healthOk: true })),
    'unsupported',
    'a key without enabled: true is not support',
  );
});

test('an unproven capability read is unknown, never a guess either way', () => {
  assert.equal(browserControlSupport(), 'unknown');
  assert.equal(browserControlSupport(null), 'unknown');
  assert.equal(browserControlSupport({ ...DEFAULT_GATEWAY_CAPABILITIES }), 'unknown', 'before any capability read');
  // /v1/capabilities unreachable: legacy mode proves nothing about control.
  assert.equal(browserControlSupport(normalizeGatewayCapabilities(null, { healthOk: true, hasApiKey: true })), 'unknown');
  // Socket transports report no control capability at all.
  assert.equal(browserControlSupport(dashboardWsGatewayCapabilities({ health: true })), 'unknown');
  assert.equal(browserControlSupport(dashboardWsGatewayCapabilities({ health: true, source: 'remote-dashboard' })), 'unknown');
});

test('the capability flags the patched gateway relies on are unchanged', () => {
  const caps = normalizeGatewayCapabilities(patched({ developer_mode: true }), { healthOk: true });
  assert.equal(caps.browserControl, true);
  assert.equal(caps.browserControlDeveloperMode, true);
});

const CONNECTED = {
  connected: true,
  controlEnabled: true,
  leasedTabIds: [7],
  pendingCommands: 0,
};
const TAB = { id: 7, url: 'https://example.test/', windowId: 1 };

test('the view for a gateway without control says so plainly, with no way to enable or reconnect', () => {
  for (const settings of [{ browserControlEnabled: false }, { browserControlEnabled: true }]) {
    const view = browserControlView({ settings, status: {}, activeTab: TAB, support: 'unsupported' });
    assert.equal(view.state, 'unsupported');
    assert.equal(view.title, "Hermes Control isn't available on this Hermes");
    assert.equal(view.detail, 'It needs a Hermes with browser extension control.');
    assert.equal(view.canEnable, false);
    assert.equal(view.canAttach, false);
    assert.equal(view.canAuthorize, false);
    assert.equal(view.canPause, false);
    assert.equal(view.attention, false);
    // A stale "on" can still be turned off; there is nothing to turn off when it is already off.
    assert.equal(view.canDetach, settings.browserControlEnabled);
  }
});

test('a terminal register result replaces the endless "Reconnecting control" state', () => {
  const settings = { browserControlEnabled: true };
  const view = browserControlView({
    settings,
    status: { connected: false, lastConnectFailure: { reason: CONTROLLER_UNSUPPORTED_GATEWAY, detail: 'HTTP 404' } },
    activeTab: TAB,
  });
  assert.equal(view.state, 'unsupported');
  assert.notEqual(view.title, 'Reconnecting control');
  assert.equal(view.canDetach, true);

  // Anything else that fails to connect is still a reconnect.
  const transient = browserControlView({
    settings,
    status: { connected: false, lastConnectFailure: { reason: 'connect_failed', detail: 'socket refused' } },
    activeTab: TAB,
  });
  assert.equal(transient.state, 'reconnecting');
});

test('a gateway that supports control keeps every existing view', () => {
  const settings = { browserControlEnabled: true };
  assert.equal(browserControlView({ settings: { browserControlEnabled: false }, support: 'supported' }).state, 'off');
  assert.equal(browserControlView({ settings: { browserControlEnabled: false }, support: 'supported' }).canEnable, true);
  assert.equal(browserControlView({ settings: { browserControlEnabled: false } }).canEnable, true, 'unknown support can still enable');
  assert.equal(browserControlView({ settings, status: { connected: false }, support: 'supported' }).state, 'reconnecting');
  const ready = browserControlView({ settings, status: CONNECTED, activeTab: TAB, support: 'supported', currentTarget: null });
  assert.notEqual(ready.state, 'unsupported');
  assert.notEqual(ready.state, 'reconnecting');
});

test('the new strings are in the English catalogue exactly as the view and toast use them', () => {
  const view = browserControlView({ settings: { browserControlEnabled: false }, support: 'unsupported' });
  assert.equal(english['browser_control.unsupported'], view.title);
  assert.equal(english['browser_control.unsupported_detail'], view.detail);
  assert.match(english['browser_control.error_unsupported'], /isn't available on this Hermes/);
});

test('the side panel resolves an unsupported gateway before chat-only or control-off', () => {
  const resolve = fn('resolveBrowserControlForTurn');
  assert.match(resolve, /availability: 'unsupported'/);
  assert.match(resolve, /reason: 'gateway_unsupported'/);
  const unsupportedBranch = resolve.slice(resolve.indexOf("browserControlSupportState() === 'unsupported'"), resolve.indexOf('CHAT_ONLY'));
  assert.ok(unsupportedBranch.length > 0 && resolve.indexOf("availability: 'unsupported'") < resolve.indexOf('CHAT_ONLY'));
  assert.doesNotMatch(unsupportedBranch, /isolatedFallback/);
});

test('the support read combines the capability, the worker verdict and the connection it applies to', () => {
  const state = fn('browserControlSupportState');
  assert.match(state, /browserControlSupport\(gatewayCapabilities\)/);
  assert.match(state, /lastConnectFailure\?\.reason === 'unsupported_gateway'/);
  assert.match(state, /browserControlConnectionKey\(\)/);
  const render = fn('renderBrowserControl');
  assert.match(render, /support: browserControlSupportState\(\)/);
  assert.match(render, /unsupported: 'ui\.unavailable'/);
  assert.match(render, /view\.state === 'unsupported'/, 'Enable is hidden when control cannot exist');
});

test('the status poll does not keep a dead loop alive', () => {
  const poll = fn('scheduleBrowserControlPoll');
  const guard = poll.indexOf("browserControlSupportState() === 'unsupported'");
  assert.ok(guard > 0, 'poll checks the support state');
  assert.ok(guard < poll.indexOf('setTimeout'), 'and stops before arming the timer');
  assert.match(
    fn('setGatewayCapabilities'),
    /refreshBrowserControlStatus\(\)\.then\(scheduleBrowserControlPoll\)/,
    'a gateway or capability change re-arms the poll',
  );
});

test('enabling control never announces success when it cannot work', () => {
  const enable = fn('enableBrowserControl');
  const gate = enable.indexOf("browserControlSupportState() === 'unsupported'");
  assert.ok(gate > 0 && gate < enable.indexOf('persistBrowserControlPreferences'), 'refused before anything is persisted');
  assert.match(enable, /t\('browser_control\.error_unsupported'\)/);
  const terminal = enable.indexOf("'unsupported_gateway'");
  assert.ok(terminal > enable.indexOf('HERMES_CONTROLLER_SETTINGS_REFRESH'));
  assert.ok(terminal < enable.indexOf('HERMES_CONTROLLER_LEASE_ACQUIRE'), 'a refused register stops before the lease');
  assert.ok(terminal < enable.indexOf('browser_control.enabled_toast'), 'and before the "enabled" toast');
  // The throw lands in the catch that turns control back off.
  assert.match(enable.slice(enable.indexOf('} catch (error) {')), /browserControlEnabled: false/);
  assert.match(fn('attachBrowserControlToCurrentTab'), /browserControlSupportState\(\) === 'unsupported'/);
});
