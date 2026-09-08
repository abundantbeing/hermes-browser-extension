import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const loadSource = source.slice(source.indexOf('async function loadProfiles('), source.indexOf('\nfunction profileSwitchDisplayName('));
function harness({ fail = false, profiles = [{ name: 'default' }], previous = [] } = {}) {
  const writes = [];
  const statuses = [];
  const context = {
    settings: { activeProfile: 'default', gatewayUrl: 'http://127.0.0.1:8642' },
    botModeRosterGeneration: 0, botModeRoster: previous, botModeGroupChats: [{ id: 'existing-room' }],
    availableProfiles: [], botModeRosterNote: '', rosterRetryCount: 0,
    profileRichRosterPromise: null, profileRichRosterAllowsTrust: false,
    desktopDashboardUrl: '', botModeRemoteAvatarCache: new Map(),
    els: {}, WS_METHODS: { profilesList: 'profiles.list' },
    normalizeGatewayUrl: (url) => url,
    ensureProfileWsConnection: async () => {
      if (fail) throw new Error('dashboard-unavailable');
      return { baseUrl: 'http://127.0.0.1:43210', client: { request: async () => ({ profiles }) } };
    },
    splitBotRosterRows: (payload) => ({ agents: payload.profiles, groupChats: [{ id: 'real-room' }] }),
    botProfileRowsToHermesProfiles: (rows) => rows,
    adoptSyncedGroupChats: (rows) => { context.botModeGroupChats = rows; },
    writeLastKnownRoster: async (value) => { writes.push(value); },
    readLastKnownRoster: async () => ({ agents: [], groupChats: [] }),
    renderProfiles() {}, renderBotModeRoster() {}, renderBotModeGroupChats() {},
    loadSessions: async () => {}, setStatus: (...args) => statuses.push(args),
    scheduleRosterRetry() {}, isRemoteWsMode: () => false,
    ensureDesktopDashboardUrl: async () => '',
    fetchRosterFromGateway: async () => ({ profiles: [{ name: 'default' }] }),
    discoverRosterViaGatewayTab: async () => ({ ok: false }),
    retainRosterAfterFailedDiscovery: () => ({ keep: false }),
    hermesGatewayKey: () => '', fetch: async () => { throw new Error('not expected'); },
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
    clearTimeout, console,
  };
  vm.createContext(context);
  vm.runInContext(`${loadSource}\nthis.run = loadProfiles;`, context);
  return { context, writes, statuses };
}

test('failed rich discovery cannot replace or cache bare health names', async () => {
  const previous = [{ name: 'default', title: 'Custom title', avatar: 'custom-image' }];
  const { context, writes } = harness({ fail: true, previous });
  await context.run();
  assert.equal(context.botModeRoster, previous);
  assert.equal(context.botModeGroupChats[0].id, 'existing-room');
  assert.equal(writes.length, 0);
  assert.ok(context.botModeRosterNote);
});

test('one-profile rich roster is complete and cached exactly once', async () => {
  const { context, writes } = harness();
  await context.run();
  assert.equal(context.botModeRoster.length, 1);
  assert.equal(context.botModeGroupChats[0].id, 'real-room');
  assert.equal(writes.length, 1);
});

test('legacy local bootstrap connects without requiring an unrelated signed-in tab', async () => {
  const wsSource = source.slice(source.indexOf('async function ensureProfileWsConnection('), source.indexOf('\nfunction usesDashboardWsChatTransport('));
  const client = { readyState: 1, on() {}, connect: async () => {}, close() {} };
  const context = {
    isRemoteWsMode: () => false, desktopDashboardUrl: 'http://127.0.0.1:43210',
    normalizeGatewayUrl: (url) => url, profileConnectionKey: () => 'profile-route',
    profileWsConnection: null, trustedDashboardTabId: null,
    dashboardTicketOriginMatches: () => false,
    dashboardFetch: async () => ({ ok: true, text: async () => 'legacy bootstrap' }),
    extractDashboardSessionToken: () => 'fixture-bootstrap',
    requestDashboardOriginTrust: async () => { throw new Error('no-dashboard-tab'); },
    settings: {}, createGatewayClient: () => client, WebSocket: {},
    buildDashboardWsUrlWithCredential: () => 'ws://localhost/fixture',
    buildDashboardWsUrl: () => 'ws://localhost/fixture',
  };
  vm.createContext(context);
  vm.runInContext(`${wsSource}\nthis.run = ensureProfileWsConnection;`, context);
  const connection = await context.run({ allowDashboardTrust: true });
  assert.equal(connection.client, client);
});

test('dashboard WebSocket bootstrap uses the same worker transport as discovery', () => {
  const wsSource = source.slice(source.indexOf('async function ensureProfileWsConnection('), source.indexOf('\nfunction usesDashboardWsChatTransport('));
  assert.doesNotMatch(wsSource, /await fetch\((?:baseUrl|freshBase)/);
  assert.match(wsSource, /await dashboardFetch\(baseUrl/);
});
