// The side panel's wiring of the Hermes account sign-in (lib/hermes-account.mjs): the order of preference where
// the panel needs the session-authority socket, the dial with the ticket in the subprotocol only, sign-out and
// session expiry, the remote guard, and what Settings and Projects offer. The panel's own functions are sliced out
// of sidepanel.js and run against fakes; nothing here touches a real gateway or a real sign-in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { buildDashboardWsEndpoint, gatewayWebSocketProtocols } from '../extension/lib/gateway-ws.mjs';
import * as hermesAccountLib from '../extension/lib/hermes-account.mjs';
import { localDashboardResetPlan } from '../extension/lib/local-dashboard-scope.mjs';
import english from '../extension/lib/locales/en.mjs';
import { PROJECTS_UNAVAILABLE } from '../extension/lib/projects-client.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `could not slice sidepanel.js from ${from}`);
  return source.slice(start, end);
}

const SECTION = slice('let hermesAccountStoreInstance = null;', '// The token to send to the dashboard at baseUrl:');

const REMOTE = 'https://hermes.example.com';
const LOCAL_GATED = 'http://127.0.0.1:9119';
const LOCAL_OPEN = 'http://127.0.0.1:9120';

function reply(status, json = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function memoryArea(data = {}) {
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) { for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value); },
    async remove(key) { delete data[key]; },
  };
}

function fakeEl() {
  return { hidden: true, disabled: false, textContent: '' };
}

// listeners: which origins answer /api/status as gated and with the native flow. signedIn: tokens to start with.
function panel({
  gatewayMode = 'local-api',
  gatewayUrl = 'http://127.0.0.1:8642',
  statuses = {},
  held = [],
  local = [],
  webapp = '',
  ticketStatus = 200,
  connectFails = 0,
} = {}) {
  const storage = {};
  const requests = [];
  const connects = [];
  const closed = [];
  let ticketNumber = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(String(url));
    requests.push({ origin: target.origin, path: target.pathname, method: init.method || 'GET', headers: { ...(init.headers || {}) } });
    const status = statuses[target.origin];
    if (target.pathname === '/api/status') return status ? reply(200, status) : reply(500);
    if (target.pathname === '/api/auth/ws-ticket') {
      ticketNumber += 1;
      return ticketStatus === 200 ? reply(200, { ticket: `ticket_${ticketNumber}`, ttl_seconds: 30 }) : reply(ticketStatus, {});
    }
    if (target.pathname === '/auth/native/refresh') return reply(401, { error: 'session_expired' });
    return reply(404);
  };
  const els = {
    hermesAccountRow: fakeEl(), hermesAccountStatus: fakeEl(), hermesAccountSignIn: fakeEl(), hermesAccountSignOut: fakeEl(),
    sessionMenu: { hidden: true },
  };
  const context = {
    settings: { gatewayMode, gatewayUrl },
    browserApi: {
      storage: { local: memoryArea(storage) },
      permissions: { request: async () => true },
      windows: undefined, tabs: undefined, webRequest: undefined,
    },
    fetch: fetchImpl,
    globalThis: undefined,
    ...hermesAccountLib,
    buildDashboardWsEndpoint,
    gatewayWebSocketProtocols,
    normalizeGatewayMode: (value) => String(value || '').trim().toLowerCase(),
    normalizeGatewayUrl: (value) => String(value || '').replace(/\/+$/, ''),
    localDashboardUrl: () => (gatewayMode === 'local-api' ? (local[0] || '') : ''),
    webappTargetForSettings: () => (webapp ? { origin: webapp } : null),
    webappListeners: new Map(),
    profileWsConnection: null,
    remoteWsConnection: null,
    activeDashboardWsConnection: null,
    activeConversationTransport: 'rest',
    activeGroupProjection: null,
    syncActiveGroupRoomFromGateway: async () => {},
    profileConnectionKey: (base) => `key:${base}`,
    isRemoteWsMode: () => gatewayMode === 'remote-dashboard',
    WebSocket: function WebSocket() {},
    createChatGatewayClient: () => {
      const client = {
        readyState: 1,
        on() {},
        close() { closed.push('closed'); client.readyState = 3; },
        connect: async (endpoint, protocols) => {
          connects.push({ endpoint, protocols });
          if (connectFails > 0 && connects.length <= connectFails) throw new Error('WebSocket closed before gateway.ready and open');
        },
      };
      return client;
    },
    refreshCapabilityViews() {},
    loadProfiles: async () => {},
    loadSkills: async () => {},
    refreshGatewaySocket: async () => null,
    projectsTabActive: () => false,
    getProjectsController: () => ({ refresh() {} }),
    showOperationToast() {},
    gatewaySocketFailedAt: 0,
    t: (key, params) => (english[key] || key).replace(/\{(\w+)\}/g, (_m, name) => params?.[name] ?? ''),
    els,
    console,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SECTION, context);
  // tokens that exist before the panel starts
  const seed = async () => {
    for (const record of held) {
      await vm.runInContext('hermesAccountStore()', context).save(new hermesAccountLib.AccountSession({
        origin: record.origin, connectionKey: record.connectionKey ?? vm.runInContext('accountConnectionKeyNow()', context),
        accessToken: 'at-held', refreshToken: 'rt-held', expiresAt: 9_999_999_999, provider: 'nous', userId: 'u1', displayName: record.displayName || 'Ada',
      }));
    }
  };
  return {
    context, els, storage, requests, connects, closed,
    run: (expression) => vm.runInContext(expression, context),
    seed,
    requestsTo: (origin) => requests.filter((request) => request.origin === origin),
  };
}

const GATED = { auth_required: true, auth_providers: ['nous'], auth_flows: ['cookie', 'native_pkce'] };
const OPEN = { auth_required: false, auth_providers: ['nous'], auth_flows: [], nous_session_valid: 'valid' };

// ---- Order of preference ------------------------------------------------------------------------------------------

test('ensureProfileWsConnection prefers the paired gateway, then the account, then the held credential and discovery', () => {
  const body = slice('async function ensureProfileWsConnection(', '\n// The gateway\'s Webapp: its page injects no token');
  const ticket = body.indexOf('connectProfileViaGatewayTicket(');
  const account = body.indexOf('connectProfileViaAccount(', ticket);
  const discovery = body.indexOf('ensureDesktopDashboardUrl(');
  const held = body.indexOf('connectProfileViaWebapp(');
  assert.ok(ticket > 0 && account > ticket, 'paired gateway before the account');
  assert.ok(discovery > account, 'the account before dashboard discovery');
  assert.ok(held > account, 'the account before the held Webapp credential');
  // Remote API mode: an account on the gateway's own origin, else the missing companion; never a dashboard here.
  const remote = body.slice(body.indexOf('if (!isLocalApiMode()) {'), body.indexOf('connectProfileViaGatewayTicket('));
  assert.match(remote, /connectProfileViaAccount\(\{ readyTimeoutMs \}\)[\s\S]*dashboardCompanionNotConfiguredError\(\)/);
  assert.doesNotMatch(remote, /ensureDesktopDashboardUrl|dashboardFetch|localDashboardUrl/);
});

test('Projects, the roster and the background refresh all try the account where the panel needs the socket', () => {
  const projects = slice('async function prepareProjectsConnection()', '\nfunction getProjectsController()');
  assert.ok(projects.indexOf('connectProfileViaGatewayTicket(') < projects.indexOf('connectProfileViaAccount('));
  assert.match(projects, /PROJECTS_UNAVAILABLE\.accountSignIn/);
  assert.match(source, /signInWithAccount: \(\) => signInWithHermesAccount\(\)/);
  const roster = slice('async function loadProfiles(', '\nfunction profileSwitchDisplayName(');
  assert.ok(roster.indexOf('viaAccountRemote') > 0 && roster.indexOf('viaAccountRemote') < roster.indexOf('ensureProfileWsConnection('));
  const refresh = slice('async function refreshGatewaySocket(', '\nfunction usesDashboardWsChatTransport()');
  assert.ok(refresh.indexOf('connectProfileViaGatewayTicket(') < refresh.indexOf('connectProfileViaAccount('));
});

test('the remote dashboard dial uses an account ticket in the subprotocol only, and the tab path is unchanged without one', () => {
  const remote = slice('async function ensureRemoteWsClient()', '\nasync function ensureRemoteWsSession(');
  assert.match(remote, /const accountOrigin = await signedInAccountOriginFor\(baseUrl\)/);
  assert.match(remote, /if \(!accountOrigin && !isTrustedDashboardOrigin\(/);
  assert.match(remote, /dialWithAccountTicket\(\{[\s\S]*protocolsFor: gatewayWebSocketProtocols/);
  // the legacy ?ticket= fallback belongs to the tab path alone
  const accountBranch = remote.slice(remote.indexOf('if (accountOrigin) {\n      // The account'), remote.indexOf('} else {\n      await connectGatewayWithTicket('));
  assert.doesNotMatch(accountBranch, /connectGatewayWithTicket|buildDashboardWsUrl\(/);
  assert.match(remote, /await connectGatewayWithTicket\(client, baseUrl, ticket\.ticket/);
});

test('the remote dashboard dial closes a socket that opens after the panel moved to another gateway', () => {
  const remote = slice('async function ensureRemoteWsClient()', '\nasync function ensureRemoteWsSession(');
  assert.match(remote, /const dialedFor = accountConnectionKeyNow\(\);/);
  // checked before the stored socket is closed, so a stale dial never closes the new connection's socket
  assert.ok(remote.indexOf('if (!stillCurrent()) throw connectionMovedError();') < remote.indexOf('remoteWsConnection?.client?.close()'));
  const guard = remote.indexOf('if (!stillCurrent()) {\n    try { client.close(); }');
  assert.ok(guard > 0 && guard < remote.indexOf('remoteWsConnection = connection;'), 'closed before it could be stored');
});

// ---- The dial ----------------------------------------------------------------------------------------------------

test('signed out: no request is made and the dial answers null, so the next source decides', async () => {
  const p = panel({ gatewayMode: 'remote-api', gatewayUrl: `${REMOTE}:8642`, statuses: { [REMOTE]: GATED } });
  assert.equal(await p.run('connectProfileViaAccount()'), null);
  assert.equal(p.requests.length, 0);
  assert.equal(p.connects.length, 0);
});

test('remote API with a held sign-in: the ticket goes in the subprotocol only and the socket is the account\'s', async () => {
  const origin = `${REMOTE}:8642`;
  const p = panel({ gatewayMode: 'remote-api', gatewayUrl: `${origin}/v1`, held: [{ origin }] });
  await p.seed();
  const connection = await p.run('connectProfileViaAccount({ readyTimeoutMs: 1000 })');
  assert.ok(connection, 'a socket was opened');
  assert.equal(connection.account, origin);
  assert.equal(connection.baseUrl, origin);
  assert.deepEqual(p.connects, [{ endpoint: `wss://hermes.example.com:8642/api/ws`, protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.ticket_1'] }]);
  assert.ok(!p.connects[0].endpoint.includes('?'));
  const ticket = p.requests.find((request) => request.path === '/api/auth/ws-ticket');
  assert.equal(ticket.headers.Authorization, 'Bearer at-held');
  // every request went to the gateway's own origin
  assert.ok(p.requests.every((request) => request.origin === origin));
  // a second ask while it is open reuses it
  assert.equal(await p.run('connectProfileViaAccount()'), connection);
  assert.equal(p.connects.length, 1);
});

test('a handshake that closes before gateway.ready retries with a NEW ticket in the subprotocol, never in a URL', async () => {
  const p = panel({ gatewayMode: 'remote-api', gatewayUrl: REMOTE, held: [{ origin: REMOTE }], connectFails: 1 });
  await p.seed();
  assert.ok(await p.run('connectProfileViaAccount({ readyTimeoutMs: 1000 })'));
  assert.deepEqual(p.connects.map((c) => c.protocols[1]), ['hermes-gateway-ticket.ticket_1', 'hermes-gateway-ticket.ticket_2']);
  assert.ok(p.connects.every((c) => !c.endpoint.includes('?') && !c.endpoint.includes('ticket')));
});

test('a local gateway behind sign-in dials the loopback listener the panel found, and no other', async () => {
  const p = panel({ local: [LOCAL_GATED], held: [{ origin: LOCAL_GATED }, { origin: REMOTE }] });
  await p.seed();
  const connection = await p.run('connectProfileViaAccount({ readyTimeoutMs: 1000 })');
  assert.equal(connection.account, LOCAL_GATED);
  assert.deepEqual(p.connects.map((c) => c.endpoint), ['ws://127.0.0.1:9119/api/ws']);
  assert.ok(p.requests.every((request) => request.origin === LOCAL_GATED), 'a remote sign-in is never used for the local gateway');
});

test('a remote connection can never reach 127.0.0.1: neither the origins, the dial nor the remote-dashboard check resolve it', async () => {
  for (const gatewayMode of ['remote-api', 'remote-dashboard']) {
    const p = panel({
      gatewayMode, gatewayUrl: REMOTE, held: [{ origin: LOCAL_GATED }, { origin: REMOTE }], local: [LOCAL_GATED], webapp: LOCAL_OPEN,
    });
    await p.seed();
    p.context.webappListeners.set(LOCAL_OPEN, 'none');
    assert.deepEqual(p.run('accountOriginsNow()'), [REMOTE]);
    assert.equal(await p.run(`signedInAccountOriginFor('${LOCAL_GATED}')`), '', 'a loopback origin is never a remote account origin');
    assert.equal(await p.run(`signedInAccountOriginFor('${REMOTE}')`), REMOTE);
    await p.run('refreshAccountOffer({ force: true })');
    assert.ok(p.requests.every((request) => !request.origin.includes('127.0.0.1')), `${gatewayMode} made no request to this machine`);
  }
});

test('a dial that cannot mint a ticket leaves no connection; session-expired is not retried, an outage waits', async () => {
  const down = panel({ gatewayMode: 'remote-api', gatewayUrl: REMOTE, held: [{ origin: REMOTE }], ticketStatus: 503 });
  await down.seed();
  assert.equal(await down.run('connectProfileViaAccount()'), null);
  assert.equal(await down.run('connectProfileViaAccount()'), null);
  assert.equal(down.requests.filter((request) => request.path === '/api/auth/ws-ticket').length, 1, 'the outage cools down before another try');
  assert.ok(await down.run('hermesAccountStore().get(\'https://hermes.example.com\')'), 'the sign-in is kept through an outage');
});

// A dial that outlives the connection it was started for must not hand its socket to the panel: Save closes only the
// socket already stored, so without this the old gateway's socket would come back after the switch.
test('a handshake that finishes after the connection moved is closed, not stored, and does not cool the new connection down', async () => {
  const p = panel({ gatewayMode: 'local-api', local: [LOCAL_GATED], held: [{ origin: LOCAL_GATED }] });
  await p.seed();
  vm.runInContext(slice('function sessionAuthoritySideSocket() {', '\nfunction refreshCapabilityViews()'), p.context);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const closes = [];
  p.context.createChatGatewayClient = () => {
    const client = {
      readyState: 1,
      on() {},
      close() { closes.push('stale'); client.readyState = 3; },
      connect: async (endpoint, protocols) => { p.connects.push({ endpoint, protocols }); await gate; },
    };
    return client;
  };
  const dial = p.run('connectProfileViaAccount({ readyTimeoutMs: 1000 })');
  while (p.connects.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  // Settings: Remote API mode, saved while the local handshake is still pending.
  p.context.settings.gatewayMode = 'remote-api';
  p.context.settings.gatewayUrl = REMOTE;
  release();
  assert.equal(await dial, null);
  assert.equal(p.run('profileWsConnection'), null, 'the old socket did not come back');
  assert.deepEqual(closes, ['stale'], 'and it was closed');
  assert.equal(p.run('accountSocketFailedAt'), 0);
  assert.equal(p.run('accountSocketPending'), null);
  assert.equal(p.run('sessionAuthoritySideSocket()'), null, 'nothing is left for a pasted image to reach');
});

test('a sign-in read that finishes after the connection moved dials nothing and leaves the new connection\'s socket alone', async () => {
  const p = panel({ gatewayMode: 'local-api', local: [LOCAL_GATED], held: [{ origin: LOCAL_GATED }] });
  await p.seed();
  const store = p.run('hermesAccountStore()');
  const read = store.get.bind(store);
  store.get = async (origin) => {
    const held = await read(origin);
    p.context.settings.gatewayMode = 'remote-api';
    p.context.settings.gatewayUrl = REMOTE;
    return held;
  };
  const current = { client: { readyState: 1, close() { p.closed.push('current'); } }, baseUrl: REMOTE, key: `key:${REMOTE}` };
  p.context.profileWsConnection = current;
  assert.equal(await p.run('dialProfileViaAccount({ readyTimeoutMs: 1000 })'), null);
  assert.equal(p.connects.length, 0, 'no socket was opened');
  assert.deepEqual(p.requests.filter((request) => request.path === '/api/auth/ws-ticket'), [], 'no ticket was minted');
  assert.equal(p.run('profileWsConnection'), current);
  assert.deepEqual(p.closed, [], 'the socket of the connection the panel is on was not closed');
});

test('a dial that fails after the connection moved does not start the retry cool-down', async () => {
  const p = panel({ gatewayMode: 'local-api', local: [LOCAL_GATED], held: [{ origin: LOCAL_GATED }] });
  await p.seed();
  p.context.createChatGatewayClient = () => ({
    readyState: 0,
    on() {},
    close() {},
    connect: async () => {
      p.context.settings.gatewayMode = 'remote-api';
      p.context.settings.gatewayUrl = REMOTE;
      throw new Error('Hermes gateway.ready timed out');
    },
  });
  assert.equal(await p.run('dialProfileViaAccount({ readyTimeoutMs: 1000 })'), null);
  assert.equal(p.run('accountSocketFailedAt'), 0);
});

// ---- Sign-out, expiry and the connection --------------------------------------------------------------------------

test('Sign out forgets the tokens, closes the account socket and offers the sign-in again, without asking the gateway', async () => {
  const p = panel({ gatewayMode: 'remote-api', gatewayUrl: REMOTE, held: [{ origin: REMOTE }], statuses: { [REMOTE]: GATED } });
  await p.seed();
  await p.run('refreshAccountOffer({ force: true })');
  assert.equal(p.run('accountOffer.signedIn'), true);
  assert.ok(await p.run('connectProfileViaAccount()'));
  const before = p.requests.length;
  assert.equal(await p.run('signOutHermesAccount()'), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await p.run('hermesAccountStore().get(\'https://hermes.example.com\')'), null);
  assert.equal(p.run('profileWsConnection'), null);
  assert.equal(p.closed.length >= 1, true, 'the socket was closed');
  assert.deepEqual(p.requests.slice(before).filter((request) => request.method === 'POST'), [], 'sign-out revokes nothing on the gateway');
  assert.equal(p.run('accountOffer.signedIn'), false);
  assert.equal(p.run('accountOffer.available'), true);
  assert.equal(p.run('accountSignInOffered()'), true);
});

test('a refresh 401 session_expired clears the tokens, closes the socket and says the session ended', async () => {
  const p = panel({ gatewayMode: 'remote-api', gatewayUrl: REMOTE, statuses: { [REMOTE]: GATED } });
  await vm.runInContext('hermesAccountStore()', p.context).save(new hermesAccountLib.AccountSession({
    origin: REMOTE, connectionKey: p.run('accountConnectionKeyNow()'), accessToken: 'old', refreshToken: 'rt', expiresAt: 1, provider: 'nous', userId: 'u1',
  }));
  assert.equal(await p.run('connectProfileViaAccount()'), null, 'the expired session opens nothing');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await p.run('hermesAccountStore().get(\'https://hermes.example.com\')'), null);
  assert.equal(p.run('accountNotice'), 'session-expired');
  p.run('renderHermesAccountRow()');
  assert.equal(p.els.hermesAccountStatus.textContent, english['account.notice.session_expired']);
  assert.equal(p.els.hermesAccountSignIn.hidden, false, 'the sign-in is offered again');
  assert.equal(p.els.hermesAccountSignOut.hidden, true);
});

test('a changed connection clears the sign-in made for the old one, and only that one', async () => {
  const p = panel({ gatewayMode: 'remote-api', gatewayUrl: REMOTE, held: [{ origin: REMOTE }, { origin: 'https://other.example.com', connectionKey: 'remote-api|https://other.example.com' }] });
  await p.seed();
  await p.run('clearAccountForConnection()');
  assert.ok(await p.run('hermesAccountStore().get(\'https://hermes.example.com\')'), 'this connection\'s sign-in stays');
  assert.equal(await p.run('hermesAccountStore().get(\'https://other.example.com\')'), null, 'the other connection\'s is gone');
  // Save runs it when the identity changed
  const save = slice('const identityChanged = connectionIdentityChanged(', 'if (connectionChanged) {');
  assert.match(save, /if \(identityChanged\) void clearAccountForConnection\(\)/);
});

test('a remote connection keeps its own account socket across the local-dashboard reset, and drops a loopback one', () => {
  const socket = { client: {} };
  const keep = localDashboardResetPlan({ gatewayMode: 'remote-api', profileConnection: socket, profileConnectionIsAccount: true });
  assert.equal(keep.closeProfileConnection, false);
  assert.equal(keep.clearRoster, false);
  const drop = localDashboardResetPlan({ gatewayMode: 'remote-api', profileConnection: socket, profileConnectionIsAccount: false });
  assert.equal(drop.closeProfileConnection, true);
  const wiring = slice('function resetLocalDashboardState() {', '\nfunction currentConnectionState()');
  assert.match(wiring, /profileConnectionIsAccount: Boolean\(profileWsConnection\?\.account\) && !isLocalApiMode\(\)\s*&& accountOriginsNow\(\)\.includes\(profileWsConnection\.account\)/);
});

// ---- What Settings and Projects offer ---------------------------------------------------------------------------

test('the user\'s own gateway (ungated loopback Webapp, Nous configured) offers no sign-in and says exactly why', async () => {
  const p = panel({ webapp: LOCAL_OPEN, statuses: { [LOCAL_OPEN]: OPEN } });
  const offer = await p.run('refreshAccountOffer({ force: true })');
  assert.equal(offer.available, false);
  assert.equal(offer.reason, 'not-gated');
  assert.equal(p.run('accountSignInOffered()'), false);
  assert.equal(p.els.hermesAccountSignIn.hidden, true, 'no button where it cannot work');
  assert.equal(p.els.hermesAccountStatus.textContent, english['account.unavailable.not_gated']);
  assert.equal(p.els.hermesAccountRow.hidden, false);
});

test('a gated listener offers the button; signed in it reads Signed in as <user> (provider) with Sign out', async () => {
  const p = panel({ gatewayMode: 'remote-dashboard', gatewayUrl: REMOTE, statuses: { [REMOTE]: GATED } });
  const offer = await p.run('refreshAccountOffer({ force: true })');
  assert.equal(offer.available, true);
  assert.equal(p.els.hermesAccountSignIn.hidden, false);
  assert.equal(p.els.hermesAccountStatus.textContent, english['account.status_signed_out']);
  assert.equal(p.run('accountSignInOffered()'), true);
  await p.run('hermesAccountStore()').save(new hermesAccountLib.AccountSession({
    origin: REMOTE, connectionKey: p.run('accountConnectionKeyNow()'), accessToken: 'a', refreshToken: 'r', expiresAt: 9_999_999_999, provider: 'nous', userId: 'u1', displayName: 'Ada',
  }));
  await p.run('refreshAccountOffer()');
  assert.equal(p.els.hermesAccountStatus.textContent, 'Signed in as Ada (nous)');
  assert.equal(p.els.hermesAccountSignOut.hidden, false);
  assert.equal(p.els.hermesAccountSignIn.hidden, true);
  assert.equal(p.run('accountSignInOffered()'), false);
});

test('the Sign in click asks for the permission before it awaits anything', () => {
  const click = slice('async function signInWithHermesAccount() {', '\nasync function signOutHermesAccount()');
  const request = click.indexOf('requestWebRequestPermission(browserApi.permissions)');
  assert.ok(request > 0);
  assert.equal(click.slice(0, request).includes('await'), false, 'nothing awaits before the permission request');
  assert.match(source, /hermesAccountSignIn\?\.addEventListener\('click', \(\) => \{\s*void signInWithHermesAccount\(\);/);
});

test('Settings has the Hermes account row, Projects offers the button on its unavailable card, and the strings exist', () => {
  for (const id of ['hermesAccountRow', 'hermesAccountStatus', 'hermesAccountSignIn', 'hermesAccountSignOut']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="hermesAccountRow"[^>]*hidden/);
  assert.equal(PROJECTS_UNAVAILABLE.accountSignIn, 'account-sign-in');
  const panelSource = readFileSync(new URL('../extension/lib/projects-panel.mjs', import.meta.url), 'utf8');
  assert.match(panelSource, /failure\.reason === PROJECTS_UNAVAILABLE\.accountSignIn && controller\.canAccountSignIn\?\.\(\)/);
  for (const key of ['account.label', 'account.sign_in', 'account.sign_out', 'account.signed_in_as', 'account.notice.session_expired', 'projects.unavailable.account_sign_in', 'capability.reason.account_sign_in']) {
    assert.ok(english[key], key);
  }
});
