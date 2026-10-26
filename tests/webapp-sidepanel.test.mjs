import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  discoverLocalDashboardBaseUrl,
  extractDashboardSessionToken,
  fetchRosterFromGatewayApi,
} from '../extension/lib/desktop-roster.mjs';
import { originOf, ticketFailureHelp } from '../extension/lib/dashboard-bridge.mjs';
import { buildDashboardWsEndpoint, connectGatewayWithTicket, gatewayWebSocketProtocols } from '../extension/lib/gateway-ws.mjs';
import * as hermesAccountLib from '../extension/lib/hermes-account.mjs';
import { resolveWebappTarget } from '../extension/lib/hermes-webapp.mjs';
import english from '../extension/lib/locales/en.mjs';
import { PROJECTS_UNAVAILABLE } from '../extension/lib/projects-client.mjs';
import { createWebappCredentialStore, keepSignedInEnabled, webappSessionStorageKey } from '../extension/lib/webapp-credential.mjs';
import { WEBAPP_TICKET_REASONS, createWebappGatewayTickets } from '../extension/lib/webapp-gateway-tickets.mjs';
import { installGroupLifecycleHarness } from './helpers/group-lifecycle-harness.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

const slice = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `could not slice sidepanel.js from ${from}`);
  return source.slice(start, end);
};

const WEBAPP = 'http://127.0.0.1:9120';
const GATEWAY = 'http://127.0.0.1:8642';
const CREDENTIAL = `cred-${'0123456789'.repeat(4)}`.slice(0, 43);
const TICKET = `tick-${'abcdefghij'.repeat(4)}`.slice(0, 43);
const GATEWAY_SOCKET_TICKET = `gwsock-${'klmnopqrst'.repeat(4)}`.slice(0, 43);
const STATUS = { version: '0.22.5', gateway_mode: 'multiplex', profiles: ['default', 'work'], auth_required: false };

const reply = (status, json = {}, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(),
  json: async () => json,
  text: async () => body || JSON.stringify(json),
});

// The machine the user has: the gateway on 8642 with /v1/profiles, and the Webapp on 9120 that
// answers like a dashboard but wants its own credential. `webapp.signedOut` models --sign-out.
function machine({ signedOut = false, socketTicketStatus = 200, routes = 'absent' } = {}) {
  const requests = [];
  const state = { signedOut, routes };
  const handler = async (url, init = {}) => {
    const target = String(url);
    const headers = init.headers || {};
    requests.push({ url: target, method: init.method || 'GET', headers: { ...headers } });
    if (target.startsWith(WEBAPP)) {
      const path = target.slice(WEBAPP.length).split('?')[0];
      const presented = headers['X-Hermes-Session-Token'];
      const authorised = !state.signedOut && presented === CREDENTIAL;
      if (path === '/api/status') return reply(200, STATUS);
      if (path === '' || path === '/') return reply(200, {}, '<!doctype html><title>Hermes</title>');
      if (path === '/api/profiles') return authorised ? reply(200, { profiles: [{ name: 'default' }, { name: 'work' }] }) : reply(401, { detail: 'Unauthorized' });
      if (path === '/api/webapp/socket-ticket') {
        if (!authorised) return reply(401, { detail: 'Unauthorized' });
        return socketTicketStatus === 200 ? reply(200, { ticket: TICKET, ttl_seconds: 30 }) : reply(socketTicketStatus, {});
      }
      return reply(404, {}, 'not found');
    }
    if (target.startsWith(GATEWAY)) {
      const path = target.slice(GATEWAY.length).split('?')[0];
      if (path === '/api/desktop/dashboard-candidates') return reply(404, {}, 'not found');
      // The pairing routes: absent on an older gateway (a plain 404), signing a socket in, or answering
      // that the Webapp is off.
      if (path === '/api/browser-extension/webapp-socket-ticket' || path === '/api/browser-extension/webapp-ticket') {
        if (state.routes === 'absent') return reply(404, {}, 'not found');
        if (headers.Authorization !== 'Bearer gateway-key') return reply(401, { error: { code: 'gateway_auth_failed' } });
        if (state.routes === 'off') return reply(404, { error: { code: 'webapp_off', message: 'The Webapp is off.' } });
        return path.endsWith('webapp-ticket')
          ? reply(200, { ticket: TICKET, webapp_url: WEBAPP, expires_in_seconds: 30 })
          : reply(200, { ticket: GATEWAY_SOCKET_TICKET, ws_url: 'ws://127.0.0.1:9120/api/ws', ttl_seconds: 30 });
      }
      if (path === '/v1/profiles') {
        return headers.Authorization === 'Bearer gateway-key'
          ? reply(200, { profiles: [{ name: 'default', title: 'Hermes' }, { name: 'work', title: 'Work' }] })
          : reply(401, {});
      }
      return reply(404, {}, 'not found');
    }
    throw new TypeError('connection refused');
  };
  handler.requests = requests;
  handler.state = state;
  return handler;
}

function panel({
  held = null,
  settings = {},
  tabs = [],
  tabStorage = {},
  net = machine(),
  gatewayMode = 'local-api',
} = {}) {
  const session = held ? { hermesWebappCredential: held } : {};
  const connects = [];
  const statuses = [];
  const context = {
    settings: { activeProfile: 'default', gatewayUrl: GATEWAY, gatewayMode, apiKey: 'gateway-key', ...settings },
    browserApi: {
      tabs: { query: async () => tabs, get: async (id) => tabs.find((tab) => tab.id === id) },
      scripting: {
        executeScript: async ({ target, func, args }) => {
          const previous = globalThis.sessionStorage;
          globalThis.sessionStorage = { getItem: (key) => tabStorage[target.tabId]?.[key] ?? null };
          try {
            return [{ result: await func(...args) }];
          } finally {
            if (previous === undefined) delete globalThis.sessionStorage;
            else globalThis.sessionStorage = previous;
          }
        },
      },
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: {
          get: async (key) => ({ [key]: session[key] }),
          set: async (patch) => { Object.assign(session, patch); },
          remove: async (key) => { delete session[key]; },
        },
      },
    },
    // modules sidepanel.js imports
    createWebappGatewayTickets, WEBAPP_TICKET_REASONS, refreshCapabilityViews() {},
    createWebappCredentialStore, keepSignedInEnabled, resolveWebappTarget, originOf, extractDashboardSessionToken,
    discoverLocalDashboardBaseUrl, connectGatewayWithTicket, ticketFailureHelp, PROJECTS_UNAVAILABLE,
    // the Hermes account sign-in the helpers slice also holds (nothing is signed in here, so it makes no request)
    ...hermesAccountLib, buildDashboardWsEndpoint, gatewayWebSocketProtocols, showOperationToast() {},
    refreshGatewaySocket: async () => null, projectsTabActive: () => false, getProjectsController: () => ({ refresh() {} }),
    fetchRosterFromGatewayApi: (options) => fetchRosterFromGatewayApi({ ...options, fetchFn: net }),
    // connection state
    desktopDashboardUrl: '', desktopDashboardDiscoveryPromise: null, profileWsConnection: null, activeDashboardWsConnection: null,
    trustedDashboardTabId: null, projectsConnectError: '', projectsBlockedReason: '',
    isLocalApiMode: () => gatewayMode === 'local-api', isRemoteMode: () => gatewayMode !== 'local-api', isRemoteWsMode: () => false,
    normalizeGatewayMode: (value) => value, normalizeGatewayUrl: (value) => String(value || '').replace(/\/+$/, ''),
    hermesGatewayKey: () => 'gateway-key',
    localDashboardUrl: () => context.desktopDashboardUrl,
    setLocalDashboardUrl: (url = '') => { context.desktopDashboardUrl = url; },
    profileConnectionKey: (url) => `key:${url}`,
    dashboardFetch: net,
    readCachedRosterUrl: async () => ({ url: '', cachedAt: 0 }),
    writeCachedRosterUrl: async () => {},
    clearCachedRosterUrl: async () => {},
    readLastKnownRoster: async () => ({ agents: [] }),
    writeLastKnownRoster: async () => {},
    dashboardCompanionNotConfiguredError: () => new Error('no companion'),
    dashboardTicketOriginMatches: () => false,
    findDashboardTab: async () => null,
    requestDashboardOriginTrust: async () => { throw new Error('the dashboard-tab trust prompt must not run for the Webapp'); },
    mintWsTicket: async () => { throw new Error('a signed-in dashboard tab is not how the Webapp signs a socket in'); },
    buildDashboardWsUrlWithCredential: () => { throw new Error('a credential must never go in a socket URL'); },
    buildDashboardWsUrl: () => { throw new Error('the legacy socket URL is not used for the Webapp'); },
    WebSocket: function WebSocket() {},
    createChatGatewayClient: () => {
      const client = {
        readyState: 1,
        on() {},
        close() {},
        connect: async (...args) => { connects.push(args); },
      };
      return client;
    },
    activeGroupProjection: null, syncActiveGroupRoomFromGateway: async () => {},
    t: (key) => english[key] || key,
    // roster
    botModeRosterGeneration: 0, botModeRoster: [], botModeGroupChats: [], availableProfiles: [], botModeRosterNote: '', rosterRetryCount: 0,
    botModeRemoteAvatarCache: new Map(),
    WS_METHODS: { profilesList: 'profiles.list' },
    BOT_CHAT_TITLE: 'Bot Chat',
    hermesClient: { fetch: async () => reply(200, { data: [] }), readJson: async (response) => response.json() },
    splitBotRosterRows: (payload) => ({ agents: payload.profiles, groupChats: [] }),
    botProfileRowsToHermesProfiles: (rows) => rows,
    adoptSyncedGroupChats: () => {},
    renderProfiles() {}, renderBotModeRoster() {}, renderBotModeGroupChats() {}, renderActiveProfileIndicator() {},
    loadSessions: async () => {}, loadSkills: async () => {},
    setStatus: (...args) => statuses.push(args),
    scheduleRosterRetry() {},
    els: { botModeSearch: { value: '' } },
    activeGroupGeneration: 0, activeGroupRuntime: null, activeGroupMessages: [], activeConversationTransport: 'rest',
    resetActiveGroupTypingIndicator() {}, renderGroupThreadStrip() {}, renderMessagesFromStorage() {}, updateSessionLabel() {},
    document: { body: { classList: { add() {}, remove() {} } } },
    abortAttachedGroupTurn() {}, abortBackgroundGroupTurn() {}, activeGroupExpandedThreads: new Set(), activeGroupThreadId: '',
    activeGroupPendingNewThread: false, activeGroupDisplayEvents: [], activeGroupTypingMembers: new Map(), roomEventStore: {},
    setBotModeView() {}, console, setTimeout, clearTimeout, AbortSignal, URL, URLSearchParams,
    // The credential store reads the page's fetch lazily from globalThis.
    fetch: net,
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  const helpers = slice('let webappCredentials = null;', '// The Hermes Web button. Hermes Web is the Webapp');
  const discovery = slice('function dashboardTicketOriginMatches(', 'async function ensureProfileWsConnection(');
  const dial = slice('async function ensureProfileWsConnection(', '\nfunction usesDashboardWsChatTransport(');
  const roster = slice('async function loadProfilesFromGatewayRoutes(', '\nfunction profileSwitchDisplayName(');
  const projects = slice('function projectsConnectionSnapshot()', '\nfunction getProjectsController()');
  vm.runInContext(
    `${helpers}\n${discovery}\n${dial}\n${roster}\n${projects}\n`
    + 'function ensureActiveDashboardWsConnection() { return ensureProfileWsConnection(); }\n'
    + 'function safeActiveProfile() { return settings.activeProfile || ""; }\n'
    + 'function contextConsentBindingMatches() { return false; }\n',
    context,
  );
  return {
    context, net, session, connects, statuses,
    read: (expression) => vm.runInContext(expression, context),
    listeners: () => Object.fromEntries(vm.runInContext('webappListeners', context)),
    held: () => session.hermesWebappCredential || null,
  };
}

const heldRecord = { origin: WEBAPP, basePath: '', token: CREDENTIAL, capturedAt: 1 };
const requestsTo = (net, prefix) => net.requests.filter((request) => request.url.startsWith(prefix));
const credentialedRequests = (net) => net.requests.filter((request) => request.headers['X-Hermes-Session-Token']);

// --- roster: it loads either way ---------------------------------------------------------------

test('Hermes Web on, nothing held: the roster loads from the gateway\'s /v1/profiles and the Webapp listener is not used', async () => {
  const p = panel();
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(p.context.availableProfiles.map((row) => row.name), ['default', 'work']);
  assert.equal(p.context.desktopDashboardUrl, '', 'the gated listener was not adopted as the dashboard');
  assert.equal(p.connects.length, 0, 'no socket was dialled at it');
  assert.deepEqual(p.listeners(), { [WEBAPP]: 'none' }, 'it was noticed, so Projects can say what is missing');
  const roster = requestsTo(p.net, GATEWAY).find((request) => request.url.endsWith('/v1/profiles'));
  assert.equal(roster.headers.Authorization, 'Bearer gateway-key');
  assert.deepEqual(credentialedRequests(p.net), [], 'nothing was authenticated against the Webapp');
});

test('with the sign-in held, the Webapp listener is the dashboard and the rich roster comes over a ticketed socket', async () => {
  const p = panel({ held: heldRecord });
  const connection = await vm.runInContext('ensureProfileWsConnection()', p.context);
  assert.equal(connection.baseUrl, WEBAPP);
  assert.equal(p.context.desktopDashboardUrl, WEBAPP);
  assert.equal(p.connects.length, 1);
  const [url, protocols] = p.connects[0];
  assert.equal(url, 'ws://127.0.0.1:9120/api/ws', 'the credential-free endpoint');
  assert.deepEqual(protocols, ['hermes-gateway-v1', `hermes-gateway-ticket.${TICKET}`], 'the socket ticket, offered as the subprotocol');
  assert.ok(!JSON.stringify(p.connects).includes(CREDENTIAL), 'the credential never reaches the socket');
  assert.ok(!url.includes('token='));
  const minted = p.net.requests.filter((request) => request.url.includes('/api/webapp/socket-ticket'));
  assert.equal(minted.length, 1);
  assert.equal(minted[0].method, 'POST');
  assert.equal(minted[0].url, `${WEBAPP}/api/webapp/socket-ticket?socket=gateway`);
  assert.equal(minted[0].headers['X-Hermes-Session-Token'], CREDENTIAL);
  assert.deepEqual(p.listeners(), { [WEBAPP]: 'accepted' });
});

test('with the sign-in held, loadProfiles reads the roster through the Webapp socket', async () => {
  const p = panel({ held: heldRecord });
  p.context.createChatGatewayClient = () => ({
    readyState: 1, on() {}, close() {},
    connect: async () => {},
    request: async (method) => (method === 'profiles.list' ? { profiles: [{ name: 'default' }, { name: 'work' }, { name: 'rich-only' }] } : {}),
  });
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(p.context.availableProfiles.map((row) => row.name), ['default', 'work', 'rich-only']);
  assert.deepEqual(requestsTo(p.net, GATEWAY).filter((request) => request.url.includes('/v1/')), [], 'the gateway roster route was not needed');
});

test('even when the Webapp socket cannot open for another reason, the roster still loads from the gateway routes', async () => {
  const p = panel({ held: heldRecord });
  p.context.createChatGatewayClient = () => ({
    readyState: 0, on() {}, close() {},
    connect: async () => { throw new Error('WebSocket closed before gateway.ready and open'); },
  });
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(p.context.availableProfiles.map((row) => row.name), ['default', 'work']);
});

test('an open signed-in Webapp tab is read by discovery, so the rich roster needs no click', async () => {
  const tabs = [{ id: 4, url: `${WEBAPP}/#/chat`, active: true }];
  const p = panel({ tabs, tabStorage: { 4: { [webappSessionStorageKey(WEBAPP, '')]: CREDENTIAL } } });
  const url = await vm.runInContext('ensureDesktopDashboardUrl({ timeoutMs: 2500 })', p.context);
  assert.equal(url, WEBAPP);
  assert.equal(p.held().token, CREDENTIAL, 'held for after the tab closes');
});

test('after hermes webapp --sign-out the ticket is refused, the credential dropped and the roster falls back to the gateway routes', async () => {
  const net = machine();
  const p = panel({ held: heldRecord, net });
  await vm.runInContext('ensureDesktopDashboardUrl({ timeoutMs: 2500 })', p.context);
  assert.equal(p.context.desktopDashboardUrl, WEBAPP);
  net.state.signedOut = true;
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.equal(p.held(), null, 'the old credential got its 401 and is gone');
  assert.equal(p.context.desktopDashboardUrl, '', 'the listener is no longer the dashboard');
  assert.deepEqual(p.context.availableProfiles.map((row) => row.name), ['default', 'work']);
  assert.equal(p.connects.length, 0);
});

test('a Webapp that signs a socket request in with a 401 raises the sign-in error the roster and Projects react to', async () => {
  const p = panel({ held: heldRecord, net: machine({ signedOut: true }) });
  p.context.desktopDashboardUrl = WEBAPP;
  vm.runInContext(`webappListeners.set('${WEBAPP}', 'accepted')`, p.context);
  await assert.rejects(vm.runInContext('ensureProfileWsConnection()', p.context), (error) => {
    assert.equal(error.ticketReason, 'webapp_sign_in_required');
    assert.match(error.message, /hermes webapp/);
    assert.doesNotMatch(error.message, /dashboard tab/i);
    return true;
  });
  assert.equal(p.held(), null);
});

test('with Keep Hermes Web signed in off, a held credential is never used and the roster still loads', async () => {
  const p = panel({ held: heldRecord, settings: { webappKeepSignedIn: false } });
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.equal(p.context.desktopDashboardUrl, '');
  assert.deepEqual(credentialedRequests(p.net), []);
  assert.equal(p.connects.length, 0);
});

test('Webapp off (nothing on 9120): discovery finds nothing and the roster comes from the gateway', async () => {
  const net = async (url, init = {}) => {
    if (String(url).startsWith(WEBAPP)) throw new TypeError('connection refused');
    return machine()(url, init);
  };
  const p = panel({ net });
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(p.listeners(), {});
});

// --- Projects ------------------------------------------------------------------------------------

test('Projects with the Webapp gated and nothing held says it needs Hermes Web\'s sign-in, and Try again retries the capture', async () => {
  const tabs = [];
  const tabStorage = {};
  const p = panel({ tabs, tabStorage });
  await vm.runInContext('prepareProjectsConnection()', p.context);
  assert.equal(p.context.projectsBlockedReason, 'webapp-sign-in');
  assert.equal(p.context.projectsConnectError, '', 'no raw dashboard-tab message');
  assert.equal(vm.runInContext('projectsConnectionSnapshot().blockedReason', p.context), 'webapp-sign-in');

  // The person runs `hermes webapp` and a signed-in tab appears; Try again runs prepareConnection again.
  tabs.push({ id: 4, url: `${WEBAPP}/`, active: true });
  tabStorage[4] = { [webappSessionStorageKey(WEBAPP, '')]: CREDENTIAL };
  await vm.runInContext('prepareProjectsConnection()', p.context);
  assert.equal(p.context.projectsBlockedReason, '');
  assert.equal(p.held().token, CREDENTIAL, 'the retry read the sign-in from the tab');
  assert.equal(p.context.desktopDashboardUrl, WEBAPP);
  assert.equal(p.connects.length, 1, 'Projects got its session-authority socket through a ticket');
});

test('Projects with the setting off does not claim a sign-in could fix it', async () => {
  const p = panel({ settings: { webappKeepSignedIn: false } });
  await vm.runInContext('prepareProjectsConnection()', p.context);
  assert.equal(p.context.projectsBlockedReason, '');
});

test('a sign-in error on the socket blocks Projects with the sign-in reason, not a connect error', async () => {
  const p = panel({ held: heldRecord, net: machine({ signedOut: true }) });
  p.context.desktopDashboardUrl = WEBAPP;
  vm.runInContext(`webappListeners.set('${WEBAPP}', 'accepted')`, p.context);
  await vm.runInContext('prepareProjectsConnection()', p.context);
  assert.equal(p.context.projectsBlockedReason, 'webapp-sign-in');
  assert.equal(p.context.projectsConnectError, '');
});

// --- the wiring that is not run above ------------------------------------------------------------

test('every place the panel read window.__HERMES_SESSION_TOKEN__ now falls back to the held credential', () => {
  assert.equal(slice('async function loadGatewayCapabilities(', '\n// Product mode').match(/await dashboardTokenFor\(base, await rootResponse\.text\(\)\)/g)?.length, 1);
  assert.match(slice('async function fetchBotModeRemoteAvatar(', 'botModeRemoteAvatarInflight.delete(cacheKey)'), /await dashboardTokenFor\(base, await rootResponse\.text\(\)\)/);
  assert.match(slice('async function dashboardApiRequest(', '\n// "Same as desktop normalizeAvatarImage"'), /await dashboardTokenFor\(base, await rootResponse\.text\(\)\)/);
  assert.match(slice('async function loadDashboardSessionsForProfile(', 'collectSessionPages'), /await dashboardTokenFor\(base, await rootResponse\.text\(\)\)/);
  // The one that stays is the legacy dial: a page token decides that branch, and the Webapp branch follows it.
  const dial = slice('async function ensureProfileWsConnection(', '\nfunction usesDashboardWsChatTransport(');
  assert.match(dial, /dashboardToken = extractDashboardSessionToken\(await rootResponse\.text\(\)\)/);
  assert.match(dial, /if \(!dashboardToken\) \{\s*const viaWebapp = await connectProfileViaWebapp\(baseUrl, key, readyTimeoutMs\);/);
  assert.match(dial, /if \(!freshToken\) \{\s*const viaWebapp = await connectProfileViaWebapp\(freshBase/);
  // Media, voice, models and restart pass it down to the libraries.
  assert.match(source, /fetchDashboardSessionToken as fetchDashboardSessionTokenFromPage/);
  assert.match(source, /async function fetchDashboardSessionToken\(options = \{\}\) \{\s*return fetchDashboardSessionTokenFromPage\(\{ \.\.\.options, dashboardToken: await dashboardTokenFor\(options\.baseUrl, ''\) \}\);/);
  assert.equal(source.match(/dashboardToken: await dashboardTokenFor\(/g).length >= 6, true);
});

test('the Webapp dial uses a socket ticket and puts no credential in a URL', () => {
  const dial = slice('async function connectProfileViaWebapp(', '\nfunction usesDashboardWsChatTransport(');
  assert.match(dial, /store\.mintSocketTicket\(target, \{ socket: 'gateway' \}\)/);
  assert.match(dial, /connectGatewayWithTicket\(gatewayClient, baseUrl, minted\.ticket/);
  assert.doesNotMatch(dial, /buildDashboardWsUrl/);
  assert.doesNotMatch(dial, /token=/);
  assert.doesNotMatch(dial, /console\./);
});

test('discovery hands the credential and the Hermes Web address to the library and keeps the sign-in of an open tab', () => {
  const discovery = slice('async function ensureDesktopDashboardUrl(', '\nasync function connectProfileViaWebapp(');
  assert.match(discovery, /webappUrl: webappTargetForSettings\(\)\?\.origin \|\| ''/);
  assert.match(discovery, /webappCredentialFor: \(origin\) => dashboardTokenFor\(origin, ''\)/);
  assert.match(discovery, /onWebapp: noteWebappListener/);
  assert.match(discovery, /captureWebappCredential\(\{ origin: gated \}\)/);
  assert.match(discovery, /webappListenerNeedsSignIn\(desktopDashboardUrl\)/);
});

test('loadProfiles falls back to the gateway routes when the Webapp socket needs a sign-in the panel does not hold', () => {
  const load = slice('async function loadProfiles(', '\nfunction profileSwitchDisplayName(');
  assert.match(load, /\} catch \(error\) \{/);
  assert.match(load, /error\?\.ticketReason === 'webapp_sign_in_required'/);
  assert.match(load, /loadProfilesFromGatewayRoutes\(\{ quiet, generation, gatewayUrl \}\)/);
});

test('the background keeps the sign-in of a Hermes Web tab while it is open, only when the setting is on', () => {
  assert.match(background, /createWebappCredentialStore\(\{[\s\S]*isEnabled: async \(\) => keepSignedInEnabled\(await readStoredSettings\(\)\)/);
  const listener = background.slice(background.indexOf("changeInfo?.status !== 'complete'"), background.indexOf('browserApi.tabs?.onRemoved'));
  assert.match(listener, /keepSignedInEnabled\(settings\)/);
  assert.match(listener, /resolveWebappTarget\(settings\)/);
  assert.match(listener, /webappCredentials\.capture\(target, \{ tab \}\)/);
  assert.match(background, /credentials: webappCredentials,/, 'the Assist chooser opens Hermes Web the same way');
});


// --- the paired gateway signs the socket in (no terminal, no held credential) ---------------------

const ticketPosts = (net) => net.requests.filter((request) => request.url.includes('/api/browser-extension/webapp-socket-ticket'));

test('a gateway with the pairing routes: the socket opens with its ticket, nothing held, nothing discovered', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net });
  const connection = await vm.runInContext('ensureProfileWsConnection()', p.context);
  assert.equal(connection.baseUrl, WEBAPP);
  assert.equal(p.connects.length, 1);
  const [url, protocols] = p.connects[0];
  assert.equal(url, 'ws://127.0.0.1:9120/api/ws');
  assert.deepEqual(protocols, ['hermes-gateway-v1', `hermes-gateway-ticket.${GATEWAY_SOCKET_TICKET}`]);
  assert.equal(p.held(), null, 'no credential was captured or held');
  assert.deepEqual(credentialedRequests(net), [], 'nothing was authenticated against the Webapp');
  assert.deepEqual(requestsTo(net, WEBAPP), [], 'the Webapp was never probed: the gateway named it');
  const [post] = ticketPosts(net);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.Authorization, 'Bearer gateway-key');
  assert.ok(!JSON.stringify(p.connects).includes('gateway-key'), 'the paired token never reaches the socket');
});

test('a second ask reuses the open socket and mints nothing', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net });
  const first = await vm.runInContext('ensureProfileWsConnection()', p.context);
  const second = await vm.runInContext('ensureProfileWsConnection()', p.context);
  assert.equal(second, first);
  assert.equal(ticketPosts(net).length, 1);
});

test('concurrent asks (roster, Projects, capability refresh) share one dial', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net });
  const [a, b, c] = await Promise.all([
    vm.runInContext('connectProfileViaGatewayTicket()', p.context),
    vm.runInContext('connectProfileViaGatewayTicket()', p.context),
    vm.runInContext('refreshGatewaySocket()', p.context),
  ]);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(p.connects.length, 1);
  assert.equal(ticketPosts(net).length, 1);
});

test('the rich roster comes over that socket, not from the gateway /v1/profiles', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net });
  p.context.createChatGatewayClient = () => ({
    readyState: 1, on() {}, close() {},
    connect: async () => {},
    request: async (method) => (method === 'profiles.list' ? { profiles: [{ name: 'default' }, { name: 'work' }, { name: 'rich-only' }] } : {}),
  });
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(p.context.availableProfiles.map((row) => row.name), ['default', 'work', 'rich-only']);
  assert.deepEqual(requestsTo(net, GATEWAY).filter((request) => request.url.includes('/v1/')), []);
});

test('Projects connects through the gateway ticket with no sign-in reason and no connect error', async () => {
  const p = panel({ net: machine({ routes: 'ok' }) });
  await vm.runInContext('prepareProjectsConnection()', p.context);
  assert.equal(p.context.projectsBlockedReason, '');
  assert.equal(p.context.projectsConnectError, '');
  assert.equal(p.connects.length, 1);
});

test('a gateway that says its Webapp is off: Projects says so, and the roster still loads from the gateway routes', async () => {
  const p = panel({ net: machine({ routes: 'off' }) });
  await vm.runInContext('prepareProjectsConnection()', p.context);
  assert.equal(p.context.projectsBlockedReason, 'webapp-off');
  assert.equal(p.connects.length, 0);
  const result = await p.context.loadProfiles({ quiet: true });
  assert.equal(result.status, 'ready');
  assert.deepEqual(p.context.availableProfiles.map((row) => row.name), ['default', 'work']);
});

test('an old gateway (plain 404) is asked once, then discovery and the held credential decide as before', async () => {
  const net = machine({ routes: 'absent' });
  const p = panel({ held: heldRecord, net });
  const connection = await vm.runInContext('ensureProfileWsConnection()', p.context);
  assert.equal(connection.baseUrl, WEBAPP);
  assert.equal(p.connects.length, 1);
  assert.equal(p.connects[0][1][1], `hermes-gateway-ticket.${TICKET}`, 'the held credential ticket');
  assert.equal(ticketPosts(net).length, 1, 'probed once');
  await p.context.loadProfiles({ quiet: true });
  assert.equal(ticketPosts(net).length, 1, 'and not again for a while');
});

test('after hermes webapp --sign-out the gateway signs in under the new credential: nothing held is needed', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ held: heldRecord, net });
  net.state.signedOut = true; // the held credential is dead; the gateway route does not use it
  const connection = await vm.runInContext('ensureProfileWsConnection()', p.context);
  assert.equal(connection.baseUrl, WEBAPP);
  assert.equal(p.connects[0][1][1], `hermes-gateway-ticket.${GATEWAY_SOCKET_TICKET}`);
  assert.deepEqual(credentialedRequests(net), []);
});

test('a ticket the socket refuses is minted again for the retry, never reused', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net });
  let refresh = null;
  p.context.connectGatewayWithTicket = async (client, baseUrl, ticket, options) => { refresh = options.refreshTicket; return ticket; };
  await vm.runInContext('connectProfileViaGatewayTicket()', p.context);
  assert.equal(ticketPosts(net).length, 1);
  assert.equal(await refresh(), GATEWAY_SOCKET_TICKET);
  assert.equal(ticketPosts(net).length, 2, 'the retry mints a new one');
});

test('a dial that fails leaves no connection, and the background refresh waits before trying again', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net });
  p.context.createChatGatewayClient = () => ({ readyState: 0, on() {}, close() {}, connect: async () => { throw new Error('closed before gateway.ready'); } });
  assert.equal(await vm.runInContext('connectProfileViaGatewayTicket()', p.context), null);
  assert.equal(p.read('profileWsConnection'), null);
  assert.equal(await vm.runInContext('refreshGatewaySocket()', p.context), null);
  assert.equal(ticketPosts(net).length, 1, 'cooling down');
  await vm.runInContext('refreshGatewaySocket({ force: true })', p.context);
  assert.equal(ticketPosts(net).length, 2, 'About & Diagnostics asks again');
});

test('background refresh can reuse an already held Web sign-in on gateways without automatic tickets', async () => {
  const net = machine({ routes: 'absent' });
  const p = panel({ held: heldRecord, net });
  p.context.desktopDashboardUrl = WEBAPP;
  const connection = await vm.runInContext('refreshGatewaySocket()', p.context);
  assert.ok(connection);
  assert.equal(connection.baseUrl, WEBAPP);
  assert.equal(p.connects.length, 1);
});

test('a remote connection never asks the local gateway', async () => {
  const net = machine({ routes: 'ok' });
  const p = panel({ net, gatewayMode: 'remote-api' });
  assert.equal(await vm.runInContext('connectProfileViaGatewayTicket()', p.context), null);
  assert.equal(await vm.runInContext('refreshGatewaySocket()', p.context), null);
  assert.equal(ticketPosts(net).length, 0);
});
