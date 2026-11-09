import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

import { describeVoiceRoute } from '../extension/lib/read-aloud.mjs';
import { createMessageThreadUi } from '../extension/lib/message-thread-ui.mjs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const refreshDashboardRoutesSource = panel.slice(
  panel.indexOf('async function refreshDashboardRoutes('),
  panel.indexOf('async function loadGatewayCapabilities('),
);

function runDashboardProbeRefresh(overrides = {}) {
  const notifies = [];
  const refreshes = [];
  const script = `
    var notifies = [];
    var refreshes = [];
    var readAloudDashboardProbe = { reachable: true, gatewayUrl: 'http://127.0.0.1:9119' };
    var dashboardRoutesProbeAt = 0;
    var settings = { gatewayUrl: 'http://127.0.0.1:9119', gatewayMode: 'local-api' };
    var capabilityRuntime = { ledger: { identityKey: 'idem', observeProbe: function() {} } };
    var DASHBOARD_ROUTE_CAPABILITIES = ['audioTranscription'];
    var panelMessageThread = { refreshAfterReadAloudProbe: function() { refreshes.push('refresh'); } };
    function isRemoteWsMode() { return false; }
    function renderCompatibilityPanel() {}
    function refreshCapabilityViews() {}
    function dashboardRouteRecordFields() { return { state: 'available', reasonCode: 'dashboard-route', params: {}, checkedAt: 1 }; }
    async function resolveDashboardMediaBaseUrl() { return 'http://127.0.0.1:9119'; }
    async function fetchDashboardSessionToken() { return 'tok'; }
    async function probeDashboardRoutes() { return { reachable: false, reason: 'unsupported', checkedAt: Date.now() }; }
  ${overrides.probeDashboardRoutes ? `async function probeDashboardRoutes() { ${overrides.probeDashboardRoutes} }` : ''}
    ${overrides.syncCapabilityRuntime ? `function syncCapabilityRuntime() { ${overrides.syncCapabilityRuntime} }` : 'function syncCapabilityRuntime() {}'}
    function notifyReadAloudDashboardProbeChanged() {
      notifies.push(JSON.parse(JSON.stringify(readAloudDashboardProbe)));
      panelMessageThread.refreshAfterReadAloudProbe();
    }
    ${refreshDashboardRoutesSource}
    async function run() { return refreshDashboardRoutes({ force: true }); }
  `;
  const context = vm.createContext({ Date });
  vm.runInContext(script, context);
  return {
    context,
    notifies,
    refreshes,
    run: async () => {
      await vm.runInContext('run()', context);
      notifies.push(...vm.runInContext('notifies', context));
      refreshes.push(...vm.runInContext('refreshes', context));
    },
  };
}

function threadFixture(options = {}) {
  const { document, window } = parseHTML('<html><body><section id="messages"></section></body></html>');
  const root = document.querySelector('#messages');
  const TS = Date.now();
  const controller = createMessageThreadUi({
    root, document, window, ResizeObserver: null, requestFrame: (callback) => callback(),
    locale: () => 'en-US', now: () => TS,
    ...options,
  });
  const add = (record, extra = {}) => {
    const row = document.createElement('div');
    row.className = 'message-row';
    const node = document.createElement('article');
    node.className = `message ${record.role}`;
    row.append(node);
    controller.attach({ row, node, record, ...extra });
    root.append(row);
    return { row, node };
  };
  return { add, controller };
}

test('when speech synthesis is absent and the dashboard probe fails with a non-OK response, speaker buttons disappear and diagnostics show none', async () => {
  const probe = runDashboardProbeRefresh();
  await probe.run();
  assert.equal(vm.runInContext('readAloudDashboardProbe.reachable', probe.context), false);
  assert.equal(probe.notifies.at(-1)?.reachable, false);
  assert.ok(probe.refreshes.includes('refresh'));

  let offerVoice = true;
  const f = threadFixture({ canReadAloud: () => offerVoice, onReadAloud: () => {} });
  const a = f.add({ role: 'assistant', ts: Date.now() });
  assert.ok(a.row.querySelector('.message-action-speak'));
  offerVoice = false;
  f.controller.refreshAfterReadAloudProbe();
  assert.equal(a.row.querySelector('.message-action-speak'), null);

  const voice = describeVoiceRoute({ gatewayAvailable: false, browserAvailable: false });
  assert.equal(voice.route, 'none');
  assert.equal(voice.stateKey, 'read_aloud.route.none');
});

test('when speech synthesis is absent and the dashboard probe throws, the stale probe is cleared and rails refresh', async () => {
  const probe = runDashboardProbeRefresh({ syncCapabilityRuntime: 'throw new Error("ledger blew up");' });
  await probe.run();
  assert.equal(vm.runInContext('readAloudDashboardProbe.reachable', probe.context), false);
  assert.ok(probe.notifies.length >= 1);
  assert.ok(probe.refreshes.includes('refresh'));
});

test('when speech synthesis is absent, a failed probe removes idle speaker buttons but keeps Stop during playback', () => {
  let offerVoice = true;
  const reading = new Set();
  const f = threadFixture({
    canReadAloud: () => offerVoice,
    onReadAloud: () => {},
    readAloudStateFor: (record) => (reading.has(record) ? 'speaking' : 'idle'),
  });
  const idle = { role: 'assistant', ts: Date.now() };
  const live = { role: 'assistant', ts: Date.now() + 1 };
  const idleRow = f.add(idle);
  const liveRow = f.add(live);
  reading.add(live);
  f.controller.refreshReadAloud();
  offerVoice = false;
  assert.equal(f.controller.readAloudRailsNeedRebuild(), true);
  f.controller.refreshAfterReadAloudProbe();
  assert.equal(idleRow.row.querySelector('.message-action-speak'), null);
  assert.ok(liveRow.row.querySelector('.message-action-speak'));
  assert.equal(liveRow.row.querySelector('.message-action-speak').getAttribute('aria-pressed'), 'true');
  assert.equal(describeVoiceRoute({ gatewayAvailable: false, browserAvailable: false }).route, 'none');
});
