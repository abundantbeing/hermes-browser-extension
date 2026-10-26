import assert from 'node:assert/strict';
import test from 'node:test';

import { openHermesWebapp } from '../extension/lib/hermes-webapp.mjs';
import {
  WEBAPP_TICKET_PATHS,
  WEBAPP_TICKET_REASONS as REASON,
  createWebappGatewayTickets,
  webappTicketLaunchUrl,
} from '../extension/lib/webapp-gateway-tickets.mjs';
import { createWebappCredentialStore, webappSessionStorageKey } from '../extension/lib/webapp-credential.mjs';

const GATEWAY = 'http://127.0.0.1:8642';
const WEBAPP = 'http://127.0.0.1:9120';
const TOKEN = `paired-${'0123456789abcdef'.repeat(4)}`;
const TICKET = `tick-${'abcdefghij'.repeat(4)}`.slice(0, 43);
const SOCKET_TICKET = `sock-${'klmnopqrst'.repeat(4)}`.slice(0, 43);
const CREDENTIAL = `cred-${'0123456789'.repeat(4)}`.slice(0, 43);

const reply = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const refusal = (status, code, message = 'no') => reply(status, { error: { code, message } });

function gateway(handler, connection = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return handler(String(url), init, requests.length);
  };
  let clock = 1000;
  const tickets = createWebappGatewayTickets({
    getConnection: () => ({ gatewayUrl: GATEWAY, token: TOKEN, local: true, ...connection }),
    fetchImpl,
    now: () => clock,
  });
  return { tickets, requests, advance: (ms) => { clock += ms; } };
}

const windowOk = () => reply(200, { ticket: TICKET, webapp_url: WEBAPP, expires_in_seconds: 30 });
const socketOk = () => reply(200, { ticket: SOCKET_TICKET, ws_url: 'ws://127.0.0.1:9120/api/ws', ttl_seconds: 30 });

// --- the module ----------------------------------------------------------------------------------

test('a window ticket is a POST to the paired gateway with the bearer token, nothing else', async () => {
  const g = gateway(windowOk);
  const result = await g.tickets.windowTicket({ profile: 'work' });
  assert.deepEqual(result, { ok: true, ticket: TICKET, webappUrl: WEBAPP, origin: WEBAPP, expiresInSeconds: 30 });
  const [request] = g.requests;
  assert.equal(request.url, `${GATEWAY}${WEBAPP_TICKET_PATHS.window}?profile=work`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.body, undefined);
});

test('the default profile and an odd name add no profile query', async () => {
  const g = gateway(windowOk);
  await g.tickets.windowTicket({ profile: 'default' });
  await g.tickets.windowTicket({ profile: '../x' });
  await g.tickets.windowTicket({});
  assert.deepEqual(g.requests.map((r) => r.url), Array(3).fill(`${GATEWAY}${WEBAPP_TICKET_PATHS.window}`));
});

test('a socket ticket answers the ticket and the Webapp socket URL', async () => {
  const g = gateway(socketOk);
  const result = await g.tickets.socketTicket({ profile: 'work' });
  assert.deepEqual(result, { ok: true, ticket: SOCKET_TICKET, wsUrl: 'ws://127.0.0.1:9120/api/ws', baseUrl: WEBAPP, origin: WEBAPP, ttlSeconds: 30 });
  assert.equal(g.requests[0].url, `${GATEWAY}${WEBAPP_TICKET_PATHS.socket}?profile=work`);
});

test('a reply that names another host, a wrong path or a malformed ticket is refused', async () => {
  for (const body of [
    { ticket: SOCKET_TICKET, ws_url: 'ws://evil.example:9120/api/ws' },
    { ticket: SOCKET_TICKET, ws_url: 'ws://127.0.0.1:9120/api/pty' },
    { ticket: SOCKET_TICKET, ws_url: 'ws://127.0.0.1:9120/api/ws?token=x' },
    { ticket: 'bad ticket!', ws_url: 'ws://127.0.0.1:9120/api/ws' },
    { ticket: SOCKET_TICKET },
  ]) {
    const g = gateway(() => reply(200, body));
    assert.deepEqual(await g.tickets.socketTicket(), { ok: false, reason: REASON.INVALID }, JSON.stringify(body));
  }
  for (const body of [
    { ticket: TICKET, webapp_url: 'https://example.com' },
    { ticket: TICKET, webapp_url: 'http://evil.example:9120' },
    { ticket: 'short', webapp_url: WEBAPP },
    { webapp_url: WEBAPP },
  ]) {
    const g = gateway(() => reply(200, body));
    assert.deepEqual(await g.tickets.windowTicket(), { ok: false, reason: REASON.INVALID }, JSON.stringify(body));
  }
});

test('the launch URL carries the ticket and the profile in the fragment, on the gateway-named origin', () => {
  assert.equal(webappTicketLaunchUrl(WEBAPP, TICKET, { profile: 'work' }), `${WEBAPP}/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`);
  assert.equal(webappTicketLaunchUrl('http://localhost:9300', TICKET), `http://localhost:9300/webapp/launch#ticket=${TICKET}`);
  assert.equal(webappTicketLaunchUrl('https://example.com', TICKET), '');
  assert.equal(webappTicketLaunchUrl(WEBAPP, 'x'), '');
});

test('each answer a gateway can give maps to one reason', async () => {
  const cases = [
    [() => refusal(404, 'webapp_off'), REASON.OFF],
    [() => refusal(404, 'webapp_not_private'), REASON.NOT_PRIVATE],
    [() => refusal(404, 'webapp_unavailable'), REASON.UNAVAILABLE],
    [() => refusal(503, 'webapp_starting'), REASON.STARTING],
    [() => refusal(404, 'profile_not_found'), REASON.PROFILE],
    [() => refusal(400, 'invalid_profile'), REASON.PROFILE],
    [() => refusal(429, 'webapp_tickets_exhausted'), REASON.BUSY],
    [() => refusal(403, 'webapp_ticket_loopback_only'), REASON.FORBIDDEN],
    [() => reply(401, { error: { code: 'gateway_auth_failed' } }), REASON.UNAUTHORIZED],
    [() => reply(404, {}), REASON.ABSENT],
    [() => { throw new TypeError('connection refused'); }, REASON.UNREACHABLE],
    [() => reply(500, {}), REASON.UNREACHABLE],
  ];
  for (const [handler, reason] of cases) {
    const g = gateway(handler);
    const result = await g.tickets.windowTicket({ force: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
});

test('a gateway without the routes (a plain 404) is asked once, then remembered for a while and asked again after', async () => {
  const g = gateway(() => reply(404, {}));
  assert.equal((await g.tickets.socketTicket()).reason, REASON.ABSENT);
  const again = await g.tickets.socketTicket();
  assert.deepEqual({ reason: again.reason, cached: again.cached }, { reason: REASON.ABSENT, cached: true });
  assert.equal((await g.tickets.windowTicket()).reason, REASON.ABSENT, 'both routes share what one taught');
  assert.equal(g.requests.length, 1, 'one request per connection');
  assert.equal(g.tickets.status().routes, 'absent');
  g.advance(3 * 60_000);
  await g.tickets.socketTicket();
  assert.equal(g.requests.length, 2, 'a gateway upgraded meanwhile is noticed');
});

test('a click asks again whatever was remembered, and a Webapp that is off is not remembered past a short while', async () => {
  let answer = () => refusal(404, 'webapp_off');
  const g = gateway(() => answer());
  assert.equal((await g.tickets.socketTicket()).reason, REASON.OFF);
  assert.equal((await g.tickets.socketTicket()).cached, true);
  answer = windowOk;
  assert.equal((await g.tickets.windowTicket()).cached, true, 'still remembered');
  assert.equal((await g.tickets.windowTicket({ force: true })).ok, true, 'the click got through');
  assert.deepEqual(g.tickets.status(), { routes: 'present', webapp: 'serving', reason: '' });
});

test('a changed connection forgets what the old one taught', async () => {
  let token = TOKEN;
  const requests = [];
  const tickets = createWebappGatewayTickets({
    getConnection: () => ({ gatewayUrl: GATEWAY, token, local: true }),
    fetchImpl: async (url) => { requests.push(url); return reply(404, {}); },
  });
  await tickets.socketTicket();
  await tickets.socketTicket();
  assert.equal(requests.length, 1);
  token = `other-${TOKEN}`;
  await tickets.socketTicket();
  assert.equal(requests.length, 2);
});

test('transient answers are never remembered', async () => {
  for (const handler of [() => refusal(503, 'webapp_starting'), () => reply(401, {}), () => { throw new TypeError('x'); }, () => refusal(429, 'webapp_tickets_exhausted')]) {
    const g = gateway(handler);
    await g.tickets.windowTicket();
    await g.tickets.windowTicket();
    assert.equal(g.requests.length, 2);
  }
});

test('a remote gateway, a non-loopback address or no token never leaves the panel', async () => {
  for (const connection of [{ local: false }, { gatewayUrl: 'https://hermes.example.com' }, { gatewayUrl: 'http://192.168.1.5:8642' }, { token: '' }]) {
    const g = gateway(windowOk, connection);
    const result = await g.tickets.windowTicket({ force: true });
    assert.equal(result.ok, false);
    assert.ok([REASON.NOT_LOCAL, REASON.NO_TOKEN].includes(result.reason));
    assert.equal(g.requests.length, 0);
  }
});

test('the token is never in a URL, a body, the result or the status', async () => {
  const g = gateway(windowOk);
  const result = await g.tickets.windowTicket({ profile: 'work', force: true });
  assert.ok(!JSON.stringify(g.requests.map((r) => [r.url, r.init.body])).includes(TOKEN));
  assert.ok(!JSON.stringify([result, g.tickets.status()]).includes(TOKEN));
});

// --- the Hermes Web button ----------------------------------------------------------------------

const local = { connectionMode: 'local', gatewayUrl: GATEWAY };
const tab = (id, url) => ({ id, url, windowId: 1, active: false });

function browser({ tabs = [], tabStorage = {}, probeStatus = 200, keep = true } = {}) {
  const calls = { create: [], update: [], probe: [] };
  const sessionStore = {};
  const scriptingApi = {
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
  };
  const credentials = createWebappCredentialStore({
    storageSession: {
      get: async (key) => ({ [key]: sessionStore[key] }),
      set: async (patch) => { Object.assign(sessionStore, patch); },
      remove: async (key) => { delete sessionStore[key]; },
    },
    scriptingApi,
    isEnabled: () => keep,
    tabsApi: { query: async () => tabs, get: async (id) => tabs.find((t) => t.id === id) },
    fetchImpl: async () => reply(200, {}),
  });
  return {
    calls,
    sessionStore,
    credentials,
    options: {
      tabsApi: {
        query: async () => tabs,
        create: async (info) => { calls.create.push(info); return { id: 99, ...info }; },
        update: async (id, info) => { calls.update.push([id, info]); return { id }; },
      },
      windowsApi: { update: async () => {} },
      permissionsApi: { request: async () => true },
      storageArea: { get: async () => ({}), set: async () => {} },
      fetchImpl: async (url) => { calls.probe.push(String(url)); return { status: probeStatus, type: 'basic' }; },
    },
  };
}

test('Open Hermes Web with the new routes: a signed-in tab opens from a window ticket, no credential, no terminal', async () => {
  const g = gateway(windowOk);
  const b = browser();
  const result = await openHermesWebapp({ settings: { ...local, activeProfile: 'work' }, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.deepEqual({ status: result.status, hint: result.hint, signedIn: result.signedIn, via: result.via }, { status: 'opened', hint: 'signed-in', signedIn: true, via: 'gateway' });
  assert.deepEqual(b.calls.create, [{ url: `${WEBAPP}/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`, active: true }]);
  assert.deepEqual(b.calls.probe, [], 'the ticket is the reachability check');
  assert.equal(b.sessionStore.hermesWebappCredential, undefined, 'nothing is held');
  assert.ok(!JSON.stringify(b.calls.create).includes(TOKEN));
});

test('the button follows the Webapp the gateway names (another port), unless the user typed an address', async () => {
  const other = () => reply(200, { ticket: TICKET, webapp_url: 'http://127.0.0.1:9300', expires_in_seconds: 30 });
  const b = browser();
  const followed = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: gateway(other).tickets });
  assert.equal(followed.status, 'opened');
  assert.equal(b.calls.create[0].url, `http://127.0.0.1:9300/webapp/launch#ticket=${TICKET}`);

  const typed = browser();
  const refused = await openHermesWebapp({ settings: { ...local, hermesWebAddress: 'http://127.0.0.1:9400' }, ...typed.options, credentials: typed.credentials, tickets: gateway(other).tickets });
  assert.equal(refused.status, 'opened');
  assert.equal(typed.calls.create[0].url, 'http://127.0.0.1:9400/', 'a typed address is never swapped for the gateway\'s');
  assert.equal(refused.hint, 'local-kept');
});

test('an open signed-in tab is focused and costs the gateway nothing', async () => {
  const g = gateway(windowOk);
  const b = browser({ tabs: [tab(4, `${WEBAPP}/`)], tabStorage: { 4: { [webappSessionStorageKey(WEBAPP, '')]: CREDENTIAL } } });
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.deepEqual({ status: result.status, tabId: result.tabId }, { status: 'focused', tabId: 4 });
  assert.equal(g.requests.length, 0);
});

test('an open tab that shows the sign-in page is passed over for a signed-in one when the sign-in can be read from it', async () => {
  const g = gateway(windowOk);
  const b = browser({ tabs: [tab(4, `${WEBAPP}/`)] });
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.equal(result.status, 'opened');
  assert.equal(result.via, 'gateway');
  assert.deepEqual(b.calls.update, [], 'the sign-in page was not raised');
  assert.equal(g.requests.length, 1);
});

test('with the keep setting off no tab is read, so an open tab is simply focused', async () => {
  const g = gateway(windowOk);
  const b = browser({ tabs: [tab(4, `${WEBAPP}/`)], keep: false });
  const result = await openHermesWebapp({ settings: { ...local, webappKeepSignedIn: false }, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.deepEqual({ status: result.status, tabId: result.tabId }, { status: 'focused', tabId: 4 });
  assert.equal(g.requests.length, 0);
});

test('with the keep setting off the routes still sign the tab in (they hold nothing)', async () => {
  const g = gateway(windowOk);
  const b = browser({ keep: false });
  const result = await openHermesWebapp({ settings: { ...local, webappKeepSignedIn: false }, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.equal(result.via, 'gateway');
});

test('an old gateway (plain 404): the held credential still signs the tab in, as before', async () => {
  const g = gateway(() => reply(404, {}));
  const b = browser();
  await b.credentials.hold({ origin: WEBAPP, basePath: '', token: CREDENTIAL });
  const credentials = { ...b.credentials, mintWindowTicket: async () => ({ ok: true, ticket: TICKET }) };
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials, tickets: g.tickets });
  assert.deepEqual({ status: result.status, hint: result.hint }, { status: 'opened', hint: 'signed-in' });
  assert.equal(result.via, undefined, 'not the gateway');
  assert.equal(g.requests.length, 1);
});

test('an old gateway with nothing held opens the sign-in page with the first-sign-in hint', async () => {
  const g = gateway(() => reply(404, {}));
  const b = browser();
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.deepEqual({ status: result.status, hint: result.hint }, { status: 'opened', hint: 'local-kept' });
  assert.deepEqual(b.calls.create, [{ url: `${WEBAPP}/`, active: true }]);
});

test('Webapp off on a gateway with the routes: unreachable, and no terminal step is left to suggest', async () => {
  const g = gateway(() => refusal(404, 'webapp_off'));
  const b = browser({ probeStatus: 0 });
  b.options.fetchImpl = async () => { throw new TypeError('connection refused'); };
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.deepEqual(result, { status: 'unreachable', address: WEBAPP, routes: 'present', webapp: REASON.OFF });
});

test('an unreachable Webapp on an old gateway keeps suggesting the commands', async () => {
  const g = gateway(() => reply(404, {}));
  const b = browser();
  b.options.fetchImpl = async () => { throw new TypeError('connection refused'); };
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.routes, undefined);
});

test('a Webapp behind sign-in (not private) opens its address with the account hint, never the hermes webapp one', async () => {
  const g = gateway(() => refusal(404, 'webapp_not_private'));
  const b = browser();
  const result = await openHermesWebapp({ settings: local, ...b.options, credentials: b.credentials, tickets: g.tickets });
  assert.deepEqual({ status: result.status, hint: result.hint }, { status: 'opened', hint: 'account' });
});

test('a remote Webapp never asks the local gateway for a ticket', async () => {
  const g = gateway(windowOk);
  const b = browser();
  const result = await openHermesWebapp({
    settings: { connectionMode: 'remote', hermesWebAddress: 'https://hermes.example.com' },
    ...b.options, credentials: b.credentials, tickets: g.tickets,
  });
  assert.equal(result.status, 'opened');
  assert.equal(g.requests.length, 0);
});
