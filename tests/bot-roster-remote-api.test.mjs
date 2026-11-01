import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import english from '../extension/lib/locales/en.mjs';
import { ROSTER_SOURCES, botAvatarRoute } from '../extension/lib/bot-roster-source.mjs';

// Issue #103, Bot Mode part: in Remote API mode the roster and the avatars come from the
// gateway's own /v1/profiles routes (the API key works on a remote gateway), and nothing in
// remote mode ever reaches 127.0.0.1. The panel's functions run from the real source.

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const loadSource = source.slice(source.indexOf('async function loadProfilesFromGatewayRoutes('), source.indexOf('\nfunction profileSwitchDisplayName('));
const REMOTE = 'https://gateway.example.test:8642';

function rosterHarness({ mode = 'remote-api', key = 'remote-key', roster = null, rosterError = null, localDashboard = '' } = {}) {
  const seen = { rosterCalls: [], loopback: [], connectionRequests: [], statuses: [], writes: [], healthProbes: 0, account: [] };
  const context = {
    settings: { activeProfile: 'default', gatewayUrl: REMOTE, gatewayMode: mode, apiKey: key },
    botModeRosterGeneration: 0,
    botModeRoster: [{ profileName: 'old-dashboard-agent' }],
    botModeRosterSource: 'dashboard',
    botModeGroupChats: [],
    availableProfiles: [{ name: 'old-dashboard-agent' }],
    botModeRosterNote: '',
    rosterRetryCount: 0,
    activeGroupGeneration: 0,
    activeGroupProjection: null,
    activeGroupRuntime: null,
    activeGroupMessages: [],
    activeConversationTransport: 'rest',
    activeDashboardWsConnection: null,
    messages: [],
    els: { botModePanel: { hidden: true }, botModeButton: { setAttribute() {} }, botChatIntro: { hidden: false }, input: { value: '', focus() {} } },
    document: { body: { classList: { add() {}, remove() {} } } },
    WS_METHODS: { profilesList: 'profiles.list' },
    normalizeGatewayUrl: (url) => url,
    isRemoteMode: () => mode !== 'local-api',
    isRemoteWsMode: () => mode === 'remote-dashboard',
    isLocalApiMode: () => mode === 'local-api',
    localDashboardUrl: () => localDashboard,
    hermesGatewayKey: () => key,
    connectProfileViaGatewayTicket: async () => { seen.connectionRequests.push('ticket'); return null; },
    // A Hermes account sign-in on the remote gateway's own origin; none is held here, so it answers null.
    connectProfileViaAccount: async () => { seen.account.push('account'); return null; },
    ensureProfileWsConnection: async () => { seen.connectionRequests.push('profile-ws'); throw new Error('no dashboard'); },
    ensureDesktopDashboardUrl: async () => { seen.loopback.push('discover'); return ''; },
    fetchRosterFromGatewayApi: async (options) => {
      seen.rosterCalls.push(options);
      if (rosterError) throw rosterError;
      return roster || { profiles: [{ name: 'default' }, { name: 'luxord', has_avatar: true }] };
    },
    fetchRosterFromGateway: async () => { seen.healthProbes += 1; throw Object.assign(new Error('no names'), { metadata: { profileNames: [] } }); },
    attachBotChatSessionsToRoster: async () => {},
    splitBotRosterRows: (payload) => ({ agents: payload.profiles.map((row) => ({ profileName: row.name, hasAvatar: row.has_avatar === true })), groupChats: [] }),
    botProfileRowsToHermesProfiles: (rows) => rows.map((row) => ({ name: row.profileName })),
    adoptSyncedGroupChats: () => {},
    writeLastKnownRoster: async (value) => { seen.writes.push(value); },
    readLastKnownRoster: async () => ({ agents: [] }),
    renderProfiles() {}, renderBotModeRoster() {}, renderBotModeGroupChats() {}, renderActiveProfileIndicator() {},
    renderGroupThreadStrip() {}, renderMessagesFromStorage() {}, updateSessionLabel() {},
    abortAttachedGroupTurn() {}, abortBackgroundGroupTurn() {}, resetActiveGroupTypingIndicator() {},
    setBotModeView() {}, loadSessions: async () => {}, scheduleRosterRetry() {},
    setStatus: (...args) => seen.statuses.push(args),
    t: (key) => english[key] || key,
    fetch: async (url) => { seen.loopback.push(String(url)); throw new Error('not expected'); },
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${loadSource}\nthis.run = loadProfiles;`, context);
  return { context, seen };
}

test('Remote API with a key loads the roster from the gateway routes, never from a dashboard or this machine', async () => {
  const { context, seen } = rosterHarness();
  const result = await context.run({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.detail, '2 PROFILES LOADED.');
  assert.deepEqual(context.botModeRoster.map((row) => row.profileName), ['default', 'luxord']);
  assert.deepEqual(context.availableProfiles.map((row) => row.name), ['default', 'luxord']);
  assert.equal(context.botModeRosterSource, 'gateway', 'the roster remembers where it came from');
  assert.equal(context.botModeRosterNote, '', 'no "companion not configured" note once the roster loaded');
  assert.equal(seen.rosterCalls.length, 1);
  assert.equal(seen.rosterCalls[0].gatewayUrl, REMOTE);
  assert.equal(seen.rosterCalls[0].apiKey, 'remote-key');
  assert.equal(seen.writes.length, 1);
  // Nothing reached a dashboard, a discovery probe or 127.0.0.1.
  assert.equal(seen.connectionRequests.length, 0);
  assert.equal(seen.loopback.length, 0);
});

test('Remote API without a key, or on a gateway without /v1/profiles, still reports the missing companion', async () => {
  const noKey = rosterHarness({ key: '' });
  const keyless = await noKey.context.run({ quiet: true });
  assert.equal(keyless.status, 'degraded');
  assert.equal(keyless.detail, english['profile.companion_not_configured']);
  assert.equal(noKey.seen.rosterCalls.length, 0, 'no credential, no request');

  const older = rosterHarness({ rosterError: Object.assign(new Error('gateway-roster-404'), { status: 404 }) });
  const result = await older.context.run({ quiet: true });
  assert.equal(result.status, 'degraded');
  assert.equal(result.detail, english['profile.companion_not_configured']);
  assert.equal(older.context.botModeRoster.length, 0, 'the dashboard roster that was on screen is gone');
  assert.equal(older.context.botModeRosterSource, '');
  assert.equal(older.seen.connectionRequests.length, 0);
  assert.equal(older.seen.loopback.length, 0);
});

test('a successful empty API roster is authoritative and is not replaced by health guesses', async () => {
  const { context, seen } = rosterHarness({ roster: { profiles: [] } });
  const result = await context.run({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.detail, '0 PROFILES LOADED.');
  assert.equal(context.botModeRoster.length, 0);
  assert.equal(seen.healthProbes, 0);
});

test('a roster reply that arrives after the connection changed is dropped', async () => {
  const { context, seen } = rosterHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  context.fetchRosterFromGatewayApi = async (options) => {
    seen.rosterCalls.push(options);
    await gate;
    return { profiles: [{ name: 'late' }] };
  };
  const running = context.run({ quiet: true });
  context.settings.gatewayUrl = 'https://other-gateway.example.test:8642';
  release();
  const result = await running;
  assert.equal(result.status, 'skipped');
  assert.equal(seen.writes.length, 0);
  assert.notEqual(context.botModeRosterSource, 'gateway');
});

test('Remote Dashboard and Local API keep their dashboard rosters (the early branch is only for Remote API)', async () => {
  const local = rosterHarness({ mode: 'local-api' });
  local.context.localDashboardUrl = () => '';
  local.context.connectProfileViaGatewayTicket = async () => ({
    baseUrl: 'http://127.0.0.1:9120',
    client: { request: async () => ({ profiles: [{ name: 'default' }] }) },
  });
  local.context.ensureProfileWsConnection = async () => ({ baseUrl: 'http://127.0.0.1:9120', client: { request: async () => ({ profiles: [{ name: 'default' }] }) } });
  const result = await local.context.run({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.equal(local.context.botModeRosterSource, 'dashboard');
});

// ---- Avatars follow the roster -------------------------------------------------------------

test('the avatar route follows the roster source, and keeps the old order when it is unknown', () => {
  // A gateway roster: the gateway only, even with a dashboard known.
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.gateway, hasLocalDashboard: true, hasApiKey: true }), { gatewayFirst: true, dashboardFallback: false });
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.gateway, hasLocalDashboard: false, hasApiKey: true }), { gatewayFirst: true, dashboardFallback: false });
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.gateway, hasApiKey: false }), { gatewayFirst: false, dashboardFallback: false }, 'no key: the blobatar, never a dashboard');
  // A dashboard roster or an unknown one: as before.
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.dashboard, hasLocalDashboard: true, hasApiKey: true }), { gatewayFirst: false, dashboardFallback: true });
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.dashboard, hasLocalDashboard: false, hasApiKey: true }), { gatewayFirst: true, dashboardFallback: true });
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.none, hasLocalDashboard: false, remoteWs: false, hasApiKey: true }), { gatewayFirst: true, dashboardFallback: true });
  assert.deepEqual(botAvatarRoute({ rosterSource: ROSTER_SOURCES.none, hasLocalDashboard: false, remoteWs: true, hasApiKey: true }), { gatewayFirst: false, dashboardFallback: true });
  assert.deepEqual(botAvatarRoute(), { gatewayFirst: false, dashboardFallback: true });
});

async function avatarHarness({ rosterSource, localDashboard = '', remoteWs = false, key = 'remote-key', gatewayImage = 'data:image/png;base64,AAAA' } = {}) {
  const start = source.indexOf('async function fetchBotModeRemoteAvatar(');
  const end = source.indexOf('async function hydrateBotModeRemoteAvatar(');
  assert.ok(start > 0 && end > start);
  const seen = { gateway: [], dashboard: [], profileWs: 0, remoteWs: 0, fetch: [] };
  const env = { rosterSource };
  const code = `export default function make(env, deps) {
    const { settings, botAvatarRoute, WS_METHODS } = deps;
    const botModeRemoteAvatarCache = new Map();
    const botModeRemoteAvatarInflight = new Map();
    const botModeRemoteAvatarFetchedAt = new Map();
    const isAvatarCacheFresh = () => false;
    const botModeAvatarCacheKey = (name) => 'k:' + name;
    const botModeAvatarDataUrlFromAsset = (asset) => asset?.data || '';
    const normalizeGatewayUrl = (url) => url;
    const localDashboardUrl = () => deps.localDashboard;
    const isRemoteWsMode = () => deps.remoteWs;
    const fetchGatewayProfileAvatar = async (options) => { deps.seen.gateway.push(options); return deps.gatewayImage; };
    const ensureProfileWsConnection = async () => { deps.seen.profileWs += 1; throw new Error('no profile socket'); };
    const ensureRemoteWsClient = async () => { deps.seen.remoteWs += 1; throw new Error('no remote socket'); };
    const dashboardTokenFor = async () => { deps.seen.dashboard.push('token'); return ''; };
    const fetch = async (url) => { deps.seen.fetch.push(String(url)); throw new Error('not expected'); };
    const AbortSignal = globalThis.AbortSignal;
    const FileReader = globalThis.FileReader;
    ${source.slice(start, end).replace(/\bbotModeRosterSource\b/g, 'env.rosterSource')}
    return fetchBotModeRemoteAvatar;
  }`;
  const { default: make } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const run = make(env, {
    settings: { gatewayUrl: REMOTE, apiKey: key },
    botAvatarRoute,
    WS_METHODS: { profilesGetAsset: 'profiles.get_asset' },
    localDashboard,
    remoteWs,
    gatewayImage,
    seen,
  });
  return { run, seen };
}

test('a gateway-sourced roster reads avatars from /v1/profiles/{name}/avatar even when a dashboard is known', async () => {
  const { run, seen } = await avatarHarness({ rosterSource: 'gateway', localDashboard: 'http://127.0.0.1:9119' });
  const image = await run({ profileName: 'luxord' });
  assert.equal(image, 'data:image/png;base64,AAAA');
  assert.equal(seen.gateway.length, 1);
  assert.deepEqual({ gatewayUrl: seen.gateway[0].gatewayUrl, apiKey: seen.gateway[0].apiKey, profileName: seen.gateway[0].profileName }, { gatewayUrl: REMOTE, apiKey: 'remote-key', profileName: 'luxord' });
  assert.equal(seen.profileWs + seen.remoteWs + seen.dashboard.length + seen.fetch.length, 0, 'no dashboard, socket or loopback request');
});

test('a gateway-sourced roster whose gateway has no picture shows the fallback and still asks no dashboard', async () => {
  const { run, seen } = await avatarHarness({ rosterSource: 'gateway', localDashboard: 'http://127.0.0.1:9119', gatewayImage: '' });
  assert.equal(await run({ profileName: 'luxord' }), '');
  assert.equal(seen.profileWs + seen.remoteWs + seen.dashboard.length + seen.fetch.length, 0);
  // And Remote API with no key sends nothing anywhere.
  const keyless = await avatarHarness({ rosterSource: 'gateway', key: '' });
  assert.equal(await keyless.run({ profileName: 'luxord' }), '');
  assert.equal(keyless.seen.gateway.length, 0);
});

test('a dashboard-sourced roster with a known dashboard keeps asking the dashboard, as before', async () => {
  const { run, seen } = await avatarHarness({ rosterSource: 'dashboard', localDashboard: 'http://127.0.0.1:9119' });
  await run({ profileName: 'luxord' });
  assert.equal(seen.gateway.length, 0, 'the gateway is not tried first when a dashboard is known');
  assert.ok(seen.profileWs >= 1 || seen.fetch.length >= 1, 'the dashboard route is tried');
});

test('the source is recorded where each roster is loaded and cleared where it is dropped', () => {
  const gatewayLoader = loadSource.slice(0, loadSource.indexOf('// A profile\'s Bot Chat rows'));
  assert.equal([...gatewayLoader.matchAll(/botModeRosterSource = 'gateway';/g)].length, 2, 'rich roster and names-only roster');
  const loader = loadSource.slice(loadSource.indexOf('async function loadProfiles('));
  assert.match(loader, /botModeRosterSource = 'dashboard';/);
  assert.match(loader, /botModeRosterSource = '';/);
  assert.match(source, /botModeRoster = \[\];\s*botModeRosterSource = '';\s*renderBotModeRoster\(\);/);
  // The Remote API branch runs before any dashboard code and never discovers one.
  const remoteBranch = loader.slice(loader.indexOf('if (isRemoteMode() && !isRemoteWsMode() && !viaAccountRemote) {'), loader.indexOf('try {\n    // The unified gateway'));
  assert.match(remoteBranch, /if \(hermesGatewayKey\(\)\) \{\s*const served = await loadProfilesFromGatewayRoutes\(/);
  assert.doesNotMatch(remoteBranch, /ensureDesktopDashboardUrl|ensureProfileWsConnection|connectProfileViaGatewayTicket|localDashboardUrl/);
});
