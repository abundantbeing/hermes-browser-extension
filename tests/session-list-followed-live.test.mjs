import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeHermesSessions } from '../extension/lib/common.mjs';

// Runs the real loadSessions against stubs. Following a chat that runs in another app (Desktop, the phone
// app) moves the panel onto the Hermes Web socket, and New session keeps it there. That socket lists only
// the chats its own sign-in made, so the panel must keep listing the gateway's history over REST.
async function runLoadSessions({ transport = 'dashboard-ws', gatewayMode = 'local-api', apiKey = 'test-key', profile = '' } = {}) {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function loadSessions(');
  const end = source.indexOf('\nasync function refreshSessionsFromMenu', start);
  assert.ok(start >= 0 && end > start, 'loadSessions source region must exist');
  const calls = [];
  const restRows = { sessions: [
    { id: 'phone-1', title: 'Started on the phone', source: 'mobile', message_count: 6 },
    { id: 'cli-1', title: 'CLI chat', source: 'cli', message_count: 3 },
    { id: 'hbe-1', title: 'Browser chat', source: 'hermes_browser', message_count: 2 },
  ] };
  const socket = { client: { readyState: 1, readyPayload: { session_authority: true }, request: async (method, params) => {
    calls.push(`ws:${method}:${JSON.stringify(params)}`);
    return { sessions: [] };
  } } };
  const env = {
    usesDashboardWsChatTransport: () => transport === 'dashboard-ws' || gatewayMode === 'remote-dashboard',
    isLocalApiMode: () => gatewayMode === 'local-api',
    isRemoteWsMode: () => gatewayMode === 'remote-dashboard',
    isNamedHermesProfile: () => Boolean(profile && profile !== 'default'),
    safeActiveProfile: () => profile,
    settings: { apiKey, sessionModelBindings: {} },
    remoteWsConnection: socket,
    activeDashboardWsConnection: socket,
    availableSessions: [{ id: 'stale', title: 'stale', messageCount: 1 }],
    updateSessionLabel: () => {},
    renderSessionMenu: () => {},
    WS_METHODS: { sessionList: 'session.list' },
    sessionListParamsFor: (_client, params) => params,
    applySessionModelBindings: (sessions) => sessions,
    normalizeHermesSessions,
    syncActiveSessionRuntimeFromList: () => {},
    setStatus: () => {},
    loadAllHermesSessions: async () => { calls.push('rest:/api/sessions'); return restRows; },
    localDashboardUrl: () => '',
    loadDashboardSessionsForProfile: async () => { calls.push('rest:dashboard'); return restRows; },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${source.slice(start, end)}\nreturn { loadSessions, listed: () => availableSessions };`);
  const { loadSessions, listed } = factory(...names.map((name) => env[name]));
  const result = await loadSessions({ quiet: true });
  return { result, calls, ids: listed().map((session) => session.id) };
}

test('after following a chat from another app, a local API connection still lists every session over REST', async () => {
  const { result, calls, ids } = await runLoadSessions();
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.deepEqual(calls, ['rest:/api/sessions'], 'the socket, which lists only its own chats, is not asked');
  assert.deepEqual(ids.sort(), ['cli-1', 'hbe-1', 'phone-1']);
});

test('a named profile and a remote dashboard keep listing over the socket', async () => {
  for (const options of [{ profile: 'juniper' }, { gatewayMode: 'remote-dashboard' }, { apiKey: '' }]) {
    const { calls } = await runLoadSessions(options);
    assert.equal(calls.length, 1, JSON.stringify(options));
    assert.match(calls[0], /^ws:session\.list:/, JSON.stringify(options));
  }
});

test('a REST chat lists over REST as before', async () => {
  const { calls, result } = await runLoadSessions({ transport: 'rest' });
  assert.deepEqual(calls, ['rest:/api/sessions']);
  assert.equal(result.count, 3);
});
