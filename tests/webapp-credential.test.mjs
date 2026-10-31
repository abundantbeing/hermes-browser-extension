import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  WEBAPP_CREDENTIAL_STORAGE_KEY,
  createWebappCredentialStore,
  dashboardTokenFor,
  isCredentialOrigin,
  isHandoffUrl,
  isWebappCredential,
  keepSignedInEnabled,
  readSessionCredentialInPage,
  webappLaunchUrl,
  webappSessionStorageKey,
} from '../extension/lib/webapp-credential.mjs';

const ORIGIN = 'http://127.0.0.1:9120';
const target = { origin: ORIGIN, basePath: '', baseUrl: ORIGIN };
const CREDENTIAL = 'cred_0123456789-ABCDEFGHIJKLMNOPQRSTUVWX'.slice(0, 43).padEnd(43, 'x');
const OTHER_CREDENTIAL = 'other-0123456789_abcdefghijklmnopqrstuvwxyz'.slice(0, 43).padEnd(43, 'y');
const TICKET = 'tick_0123456789-ABCDEFGHIJKLMNOPQRSTUVWX'.slice(0, 43).padEnd(43, 'z');

assert.equal(CREDENTIAL.length, 43);
assert.equal(OTHER_CREDENTIAL.length, 43);
assert.equal(TICKET.length, 43);

function fakeSessionStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => ({ [key]: data[key] }),
    set: async (patch) => { Object.assign(data, patch); },
    remove: async (key) => { delete data[key]; },
  };
}

// chrome.scripting.executeScript that really runs `func` against a stand-in sessionStorage per tab.
function fakeScripting(storageByTab, calls = []) {
  return {
    calls,
    executeScript: async ({ target: { tabId }, func, args }) => {
      calls.push({ tabId, args });
      const previous = globalThis.sessionStorage;
      const map = storageByTab[tabId] || {};
      globalThis.sessionStorage = { getItem: (key) => (key in map ? map[key] : null) };
      try {
        return [{ result: await func(...args) }];
      } finally {
        if (previous === undefined) delete globalThis.sessionStorage;
        else globalThis.sessionStorage = previous;
      }
    },
  };
}

function tabsFor(list) {
  return {
    query: async () => list,
    get: async (id) => list.find((tab) => tab.id === id),
  };
}

function reply(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

const signedInTab = (id, url = `${ORIGIN}/`, extra = {}) => ({ id, url, active: false, ...extra });
const keyStorage = (token = CREDENTIAL, key = webappSessionStorageKey(ORIGIN, '')) => ({ [key]: token });
const acceptingFetch = () => fakeFetch((url, init) => (init.headers?.['X-Hermes-Session-Token'] ? reply(200, { profiles: [] }) : reply(401)));

// --- the credential and where it lives ---------------------------------------------------------

test('a Webapp credential is 43 characters of the URL-safe alphabet, and nothing else', () => {
  assert.equal(isWebappCredential(CREDENTIAL), true);
  assert.equal(isWebappCredential('A'.repeat(43)), true);
  for (const value of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(42)} `, `${'A'.repeat(42)}=`, null, undefined, 42, {}, ['A'.repeat(43)]]) {
    assert.equal(isWebappCredential(value), false, JSON.stringify(value));
  }
});

test('the sessionStorage key is the one the Webapp keeps its sign-in under', () => {
  assert.equal(webappSessionStorageKey('http://127.0.0.1:9120', ''), 'hermes.webapp.session.v1:["http://127.0.0.1:9120",""]');
  assert.equal(webappSessionStorageKey('http://127.0.0.1:9120', '/hermes'), 'hermes.webapp.session.v1:["http://127.0.0.1:9120","/hermes"]');
});

test('the in-page reader returns exactly one sessionStorage value and nothing when storage is unavailable', () => {
  const previous = globalThis.sessionStorage;
  try {
    const asked = [];
    globalThis.sessionStorage = { getItem: (key) => { asked.push(key); return CREDENTIAL; } };
    assert.equal(readSessionCredentialInPage('k'), CREDENTIAL);
    assert.deepEqual(asked, ['k']);
    globalThis.sessionStorage = { getItem: () => { throw new Error('blocked'); } };
    assert.equal(readSessionCredentialInPage('k'), null);
  } finally {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});

test('only the private loopback Webapp is a place the credential may come from or go to', () => {
  for (const origin of ['http://127.0.0.1:9120', 'http://localhost:9120', 'http://[::1]:9120', 'http://webapp.localhost:9120']) {
    assert.equal(isCredentialOrigin(origin), true, origin);
  }
  for (const origin of ['https://hermes.example.com', 'http://192.168.1.4:9120', 'http://hermes.example.com', 'https://127.0.0.1:9120', '', 'not a url']) {
    assert.equal(isCredentialOrigin(origin), false, origin);
  }
});

test('the launch and child-window pages are recognised as handoff pages, with or without a base path', () => {
  assert.equal(isHandoffUrl(`${ORIGIN}/webapp/launch`), true);
  assert.equal(isHandoffUrl(`${ORIGIN}/webapp/launch#ticket=x`), true);
  assert.equal(isHandoffUrl(`${ORIGIN}/webapp/window`), true);
  assert.equal(isHandoffUrl(`${ORIGIN}/webapp/window/`), true);
  assert.equal(isHandoffUrl(`${ORIGIN}/hermes/webapp/launch`, '/hermes'), true);
  assert.equal(isHandoffUrl(`${ORIGIN}/`), false);
  assert.equal(isHandoffUrl(`${ORIGIN}/#/chat`), false);
  assert.equal(isHandoffUrl(`${ORIGIN}/webapp/other`), false);
});

test('the Keep signed in setting is on unless it was turned off', () => {
  assert.equal(keepSignedInEnabled({}), true);
  assert.equal(keepSignedInEnabled(undefined), true);
  assert.equal(keepSignedInEnabled({ webappKeepSignedIn: true }), true);
  assert.equal(keepSignedInEnabled({ webappKeepSignedIn: false }), false);
});

// --- capture ------------------------------------------------------------------------------------

test('capture reads the credential from a signed-in Webapp tab, holds it in storage.session and validates it', async () => {
  const session = fakeSessionStorageArea();
  const scripting = fakeScripting({ 7: keyStorage() });
  const fetchImpl = acceptingFetch();
  const store = createWebappCredentialStore({
    storageSession: session, scriptingApi: scripting, tabsApi: tabsFor([signedInTab(7)]), fetchImpl, now: () => 1234,
  });
  const result = await store.capture(target);
  assert.deepEqual(result, { ok: true, tabId: 7, validated: true });
  assert.deepEqual(session.data[WEBAPP_CREDENTIAL_STORAGE_KEY], { origin: ORIGIN, basePath: '', token: CREDENTIAL, capturedAt: 1234 });
  assert.deepEqual(scripting.calls, [{ tabId: 7, args: [webappSessionStorageKey(ORIGIN, '')] }]);
  // One cheap authenticated GET.
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${ORIGIN}/api/profiles`);
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.headers['X-Hermes-Session-Token'], CREDENTIAL);
  assert.deepEqual(await store.held(), { origin: ORIGIN, basePath: '', token: CREDENTIAL, capturedAt: 1234 });
});

test('capture only keeps what has the credential format', async () => {
  for (const bad of [null, '', 'short', `${'A'.repeat(42)}!`, 'A'.repeat(44), '<script>alert(1)</script>']) {
    const session = fakeSessionStorageArea();
    const store = createWebappCredentialStore({
      storageSession: session, scriptingApi: fakeScripting({ 7: keyStorage(bad) }), tabsApi: tabsFor([signedInTab(7)]), fetchImpl: acceptingFetch(),
    });
    assert.deepEqual(await store.capture(target), { ok: false, reason: 'not-signed-in' }, JSON.stringify(bad));
    assert.equal(await store.held(), null);
    assert.deepEqual(session.data, {});
  }
});

test('capture never reads the launch or child-window pages, and not another origin, port, base path or a discarded tab', async () => {
  const scripting = fakeScripting({
    1: keyStorage(), 2: keyStorage(), 3: keyStorage(), 4: keyStorage(), 5: keyStorage(), 6: keyStorage(),
  });
  const tabs = [
    signedInTab(1, `${ORIGIN}/webapp/launch#ticket=abc`),
    signedInTab(2, `${ORIGIN}/webapp/window#channel=abc`),
    signedInTab(3, 'http://127.0.0.1:9121/'),
    signedInTab(4, 'https://127.0.0.1:9120/'),
    signedInTab(5, `${ORIGIN}/`, { discarded: true }),
    signedInTab(6, 'http://localhost:9120/'),
  ];
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), scriptingApi: scripting, tabsApi: tabsFor(tabs), fetchImpl: acceptingFetch() });
  assert.deepEqual(await store.capture(target), { ok: false, reason: 'no-tab' });
  assert.deepEqual(scripting.calls, [], 'no page was read');
  assert.equal(await store.held(), null);
});

test('capture from one named tab reads only that tab, and not when it is a handoff page', async () => {
  const scripting = fakeScripting({ 7: keyStorage(), 8: keyStorage() });
  const store = createWebappCredentialStore({
    storageSession: fakeSessionStorageArea(), scriptingApi: scripting, tabsApi: tabsFor([signedInTab(7), signedInTab(8)]), fetchImpl: acceptingFetch(),
  });
  assert.equal((await store.capture(target, { tab: signedInTab(8) })).tabId, 8);
  assert.deepEqual(scripting.calls.map((call) => call.tabId), [8]);
  assert.deepEqual(await store.capture(target, { tab: signedInTab(7, `${ORIGIN}/webapp/launch`) }), { ok: false, reason: 'no-tab' });
});

test('capture prefers the active tab, then the most recently used, and tries the next when one is signed out', async () => {
  const scripting = fakeScripting({ 3: keyStorage(CREDENTIAL) });
  const tabs = [
    signedInTab(1, `${ORIGIN}/`, { lastAccessed: 10 }),
    signedInTab(2, `${ORIGIN}/`, { lastAccessed: 50 }),
    signedInTab(3, `${ORIGIN}/`, { lastAccessed: 20 }),
  ];
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), scriptingApi: scripting, tabsApi: tabsFor(tabs), fetchImpl: acceptingFetch() });
  assert.equal((await store.capture(target)).tabId, 3);
  assert.deepEqual(scripting.calls.map((call) => call.tabId), [2, 3], 'tab 2 was signed out, tab 3 had the sign-in, tab 1 was never needed');
});

test('capture refuses an origin that is not a loopback Webapp, without reading any page', async () => {
  const scripting = fakeScripting({ 7: keyStorage(CREDENTIAL, webappSessionStorageKey('https://hermes.example.com', '')) });
  const store = createWebappCredentialStore({
    storageSession: fakeSessionStorageArea(), scriptingApi: scripting,
    tabsApi: tabsFor([signedInTab(7, 'https://hermes.example.com/')]), fetchImpl: acceptingFetch(),
  });
  assert.deepEqual(await store.capture({ origin: 'https://hermes.example.com', basePath: '', baseUrl: 'https://hermes.example.com' }), { ok: false, reason: 'unsupported-origin' });
  assert.deepEqual(scripting.calls, []);
});

test('capture needs the scripting API, and a tab that navigated away before the read is not trusted', async () => {
  const none = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), scriptingApi: null, tabsApi: tabsFor([signedInTab(7)]), fetchImpl: acceptingFetch() });
  assert.deepEqual(await none.capture(target), { ok: false, reason: 'scripting-unavailable' });

  const moved = { ...signedInTab(7), url: 'http://127.0.0.1:9120/' };
  const tabsApi = { query: async () => [moved], get: async () => ({ id: 7, url: 'http://127.0.0.1:5000/other' }) };
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), scriptingApi: fakeScripting({ 7: keyStorage() }), tabsApi, fetchImpl: acceptingFetch() });
  assert.deepEqual(await store.capture(target), { ok: false, reason: 'not-signed-in' });
  assert.equal(await store.held(), null);
});

test('a credential a tab still holds after a sign-out is dropped by the validation, not kept', async () => {
  const session = fakeSessionStorageArea();
  const dropped = [];
  const store = createWebappCredentialStore({
    storageSession: session, scriptingApi: fakeScripting({ 7: keyStorage() }), tabsApi: tabsFor([signedInTab(7)]),
    fetchImpl: fakeFetch(() => reply(401)), onDrop: (info) => dropped.push(info),
  });
  assert.deepEqual(await store.capture(target), { ok: false, reason: 'not-signed-in' });
  assert.equal(await store.held(), null);
  assert.deepEqual(session.data[WEBAPP_CREDENTIAL_STORAGE_KEY] ?? null, null);
  assert.deepEqual(dropped, [{ origin: ORIGIN }]);
});

test('a Webapp that does not answer during capture is not a verdict: the credential stays held, unvalidated', async () => {
  const store = createWebappCredentialStore({
    storageSession: fakeSessionStorageArea(), scriptingApi: fakeScripting({ 7: keyStorage() }), tabsApi: tabsFor([signedInTab(7)]),
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  assert.deepEqual(await store.capture(target), { ok: true, tabId: 7, validated: false });
  assert.equal((await store.held()).token, CREDENTIAL);
});

test('capturing the credential that is already held does not ask the Webapp again', async () => {
  const fetchImpl = acceptingFetch();
  const store = createWebappCredentialStore({
    storageSession: fakeSessionStorageArea(), scriptingApi: fakeScripting({ 7: keyStorage() }), tabsApi: tabsFor([signedInTab(7)]), fetchImpl,
  });
  await store.capture(target);
  const again = await store.capture(target);
  assert.deepEqual(again, { ok: true, tabId: 7, validated: false, unchanged: true });
  assert.equal(fetchImpl.calls.length, 1);
});

// --- hold, clear, and the memory fallback ------------------------------------------------------

test('hold and clear go through storage.session only, and never touch storage.local', async () => {
  const session = fakeSessionStorageArea();
  const local = fakeSessionStorageArea();
  const store = createWebappCredentialStore({ storageSession: session });
  assert.equal(await store.hold({ origin: ORIGIN, token: CREDENTIAL, capturedAt: 5 }), true);
  assert.deepEqual(session.data[WEBAPP_CREDENTIAL_STORAGE_KEY], { origin: ORIGIN, basePath: '', token: CREDENTIAL, capturedAt: 5 });
  assert.deepEqual(local.data, {});
  await store.clear();
  assert.deepEqual(session.data, {});
  assert.equal(await store.held(), null);
});

test('hold refuses a value that is not a credential, or an origin that is not a loopback Webapp', async () => {
  const session = fakeSessionStorageArea();
  const store = createWebappCredentialStore({ storageSession: session });
  assert.equal(await store.hold({ origin: ORIGIN, token: 'nope' }), false);
  assert.equal(await store.hold({ origin: 'https://hermes.example.com', token: CREDENTIAL }), false);
  assert.deepEqual(session.data, {});
});

test('a stored record that is not well formed is never returned', async () => {
  for (const bad of [{ origin: ORIGIN, token: 'short' }, { origin: 'https://evil.example', token: CREDENTIAL }, 'a string', 42, [], { token: CREDENTIAL }]) {
    const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea({ [WEBAPP_CREDENTIAL_STORAGE_KEY]: bad }) });
    assert.equal(await store.held(), null, JSON.stringify(bad));
  }
});

test('without storage.session (older Firefox) the credential lives in memory for this context only', async () => {
  const store = createWebappCredentialStore({ storageSession: undefined });
  await store.hold({ origin: ORIGIN, token: CREDENTIAL, capturedAt: 9 });
  assert.equal((await store.held()).token, CREDENTIAL);
  const another = createWebappCredentialStore({ storageSession: undefined });
  assert.equal(await another.held(), null, 'another context holds nothing');
  await store.clear();
  assert.equal(await store.held(), null);
});

test('a storage.session that throws falls back to memory instead of losing the credential or throwing', async () => {
  const broken = { get: async () => { throw new Error('denied'); }, set: async () => { throw new Error('denied'); }, remove: async () => { throw new Error('denied'); } };
  const store = createWebappCredentialStore({ storageSession: broken });
  assert.equal(await store.hold({ origin: ORIGIN, token: CREDENTIAL }), true);
  assert.equal((await store.held()).token, CREDENTIAL);
  await store.clear();
  assert.equal(await store.held(), null);
});

// --- the setting turned off --------------------------------------------------------------------

test('with the setting off nothing is captured, held, sent or minted, and what was held is not used', async () => {
  const session = fakeSessionStorageArea({ [WEBAPP_CREDENTIAL_STORAGE_KEY]: { origin: ORIGIN, basePath: '', token: CREDENTIAL, capturedAt: 1 } });
  const scripting = fakeScripting({ 7: keyStorage() });
  const fetchImpl = acceptingFetch();
  const store = createWebappCredentialStore({
    storageSession: session, scriptingApi: scripting, tabsApi: tabsFor([signedInTab(7)]), fetchImpl, isEnabled: () => false,
  });
  assert.deepEqual(await store.capture(target), { ok: false, reason: 'disabled' });
  assert.equal(await store.held(), null);
  assert.deepEqual(await store.validate(target), { ok: false, reason: 'disabled' });
  assert.deepEqual(await store.mintWindowTicket(target), { ok: false, reason: 'disabled' });
  assert.deepEqual(await store.mintSocketTicket(target), { ok: false, reason: 'disabled' });
  assert.equal(await store.tokenFor(ORIGIN, '<script>window.__HERMES_SESSION_TOKEN__ = "page-token"</script>'), 'page-token');
  assert.equal(await store.tokenFor(ORIGIN, '<title>Hermes</title>'), '');
  assert.deepEqual(scripting.calls, []);
  assert.deepEqual(fetchImpl.calls, []);
  await store.clear();
  assert.deepEqual(session.data, {}, 'turning it off clears what was held');
});

test('the setting is read each time, so turning it off and on takes effect without a new store', async () => {
  let on = true;
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), isEnabled: () => on });
  await store.hold({ origin: ORIGIN, token: CREDENTIAL });
  assert.equal((await store.held()).token, CREDENTIAL);
  on = false;
  assert.equal(await store.held(), null);
  on = true;
  assert.equal((await store.held()).token, CREDENTIAL);
  const failing = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), isEnabled: async () => { throw new Error('storage gone'); } });
  assert.equal(await failing.enabled(), true, 'an unreadable setting is the default, on');
});

// --- validation and the requests it makes ------------------------------------------------------

test('validate is one authenticated GET, and a 401 or 403 drops the credential', async () => {
  for (const status of [401, 403]) {
    const session = fakeSessionStorageArea();
    const dropped = [];
    const fetchImpl = fakeFetch(() => reply(status));
    const store = createWebappCredentialStore({ storageSession: session, fetchImpl, onDrop: (info) => dropped.push(info) });
    await store.hold({ origin: ORIGIN, token: CREDENTIAL });
    assert.deepEqual(await store.validate(target), { ok: false, reason: 'rejected', status });
    assert.equal(await store.held(), null, `${status} drops it`);
    assert.deepEqual(session.data[WEBAPP_CREDENTIAL_STORAGE_KEY] ?? null, null);
    assert.deepEqual(dropped, [{ origin: ORIGIN }]);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].init.credentials, 'omit');
  }
});

test('a server error or a Webapp that is down does not drop the credential', async () => {
  for (const handler of [() => reply(500), () => reply(503), async () => { throw new TypeError('Failed to fetch'); }]) {
    const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl: fakeFetch(handler) });
    await store.hold({ origin: ORIGIN, token: CREDENTIAL });
    assert.equal((await store.validate(target)).ok, false);
    assert.equal((await store.held()).token, CREDENTIAL);
  }
});

test('a credential held for one origin is never sent to another', async () => {
  const fetchImpl = acceptingFetch();
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl });
  await store.hold({ origin: ORIGIN, token: CREDENTIAL });
  assert.deepEqual(await store.validate({ origin: 'http://127.0.0.1:9999', baseUrl: 'http://127.0.0.1:9999' }), { ok: false, reason: 'none' });
  assert.deepEqual(await store.mintWindowTicket({ origin: 'http://localhost:9120', baseUrl: 'http://localhost:9120' }), { ok: false, reason: 'none' });
  assert.deepEqual(fetchImpl.calls, []);
});

test('the window ticket is minted by one POST with the credential in a header, and a 401 drops the credential', async () => {
  const fetchImpl = fakeFetch(() => reply(200, { ticket: TICKET }));
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl });
  await store.hold({ origin: ORIGIN, token: CREDENTIAL });
  assert.deepEqual(await store.mintWindowTicket(target), { ok: true, ticket: TICKET });
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, `${ORIGIN}/api/webapp/window-ticket`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Hermes-Session-Token'], CREDENTIAL);
  assert.ok(!url.includes(CREDENTIAL), 'never in the URL');

  const refused = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl: fakeFetch(() => reply(401)) });
  await refused.hold({ origin: ORIGIN, token: CREDENTIAL });
  assert.deepEqual(await refused.mintWindowTicket(target), { ok: false, reason: 'rejected' });
  assert.equal(await refused.held(), null);
});

test('a Webapp without the window-ticket route keeps the credential and reports it unsupported', async () => {
  for (const status of [404, 405]) {
    const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl: fakeFetch(() => reply(status)) });
    await store.hold({ origin: ORIGIN, token: CREDENTIAL });
    assert.deepEqual(await store.mintWindowTicket(target), { ok: false, reason: 'unsupported' });
    assert.equal((await store.held()).token, CREDENTIAL);
  }
});

test('a ticket that is not the shape the launch page accepts is refused', async () => {
  for (const ticket of ['', 'short', 'A'.repeat(44), `${'A'.repeat(42)}!`, 42, null, undefined]) {
    const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl: fakeFetch(() => reply(200, { ticket })) });
    await store.hold({ origin: ORIGIN, token: CREDENTIAL });
    assert.deepEqual(await store.mintWindowTicket(target), { ok: false, reason: 'unsupported' }, JSON.stringify(ticket));
  }
});

test('the socket ticket is minted for the gateway socket, with the profile only when it is a safe name', async () => {
  const fetchImpl = fakeFetch(() => reply(200, { ticket: TICKET, ttl_seconds: 30 }));
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl });
  await store.hold({ origin: ORIGIN, token: CREDENTIAL });
  assert.deepEqual(await store.mintSocketTicket(target), { ok: true, ticket: TICKET, ttlSeconds: 30 });
  assert.deepEqual(await store.mintSocketTicket(target, { profile: 'work' }), { ok: true, ticket: TICKET, ttlSeconds: 30 });
  await store.mintSocketTicket(target, { profile: 'x&token=1' });
  assert.deepEqual(fetchImpl.calls.map((call) => call.url), [
    `${ORIGIN}/api/webapp/socket-ticket?socket=gateway`,
    `${ORIGIN}/api/webapp/socket-ticket?socket=gateway&profile=work`,
    `${ORIGIN}/api/webapp/socket-ticket?socket=gateway`,
  ]);
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['X-Hermes-Session-Token'], CREDENTIAL);
    assert.ok(!call.url.includes(CREDENTIAL));
  }
});

test('a socket ticket that could not ride a WebSocket subprotocol is refused', async () => {
  for (const ticket of ['', 'has space', 'semi;colon', 'a'.repeat(201), 'ünïcode']) {
    const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea(), fetchImpl: fakeFetch(() => reply(200, { ticket })) });
    await store.hold({ origin: ORIGIN, token: CREDENTIAL });
    assert.deepEqual(await store.mintSocketTicket(target), { ok: false, reason: 'unsupported' }, JSON.stringify(ticket));
  }
});

// --- the launch URL ----------------------------------------------------------------------------

test('the launch URL carries a ticket in its fragment, the profile in the query it enters with, and never the credential', () => {
  const url = webappLaunchUrl(target, TICKET, { profile: 'work' });
  const parsed = new URL(url);
  assert.equal(parsed.origin, ORIGIN);
  assert.equal(parsed.pathname, '/webapp/launch');
  assert.equal(parsed.search, '', 'no query string: the address bar and history hold no profile or credential');
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  assert.equal(fragment.get('ticket'), TICKET);
  assert.equal(fragment.get('query'), 'profile=work');
  assert.deepEqual([...fragment.keys()].sort(), ['query', 'ticket']);
  assert.equal(url, `${ORIGIN}/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`);
  assert.ok(!url.includes(CREDENTIAL));
});

test('the launch URL has no query for the default profile, an unsafe profile or none, and honours a base path', () => {
  for (const profile of [undefined, '', 'default', 'Default', 'a b', 'x&token=1', '../x', '-x', 'a'.repeat(65), 7, null]) {
    assert.equal(webappLaunchUrl(target, TICKET, { profile }), `${ORIGIN}/webapp/launch#ticket=${TICKET}`, JSON.stringify(profile));
  }
  assert.equal(
    webappLaunchUrl({ origin: ORIGIN, basePath: '/hermes' }, TICKET, { profile: 'work' }),
    `${ORIGIN}/hermes/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`,
  );
});

test('a ticket the launch page would refuse produces no URL at all', () => {
  for (const ticket of ['', 'short', 'A'.repeat(44), `${'A'.repeat(42)}!`, null, undefined, 7]) {
    assert.equal(webappLaunchUrl(target, ticket), '', JSON.stringify(ticket));
  }
  assert.equal(webappLaunchUrl({}, TICKET), '');
});

// --- the token a dashboard call uses ----------------------------------------------------------

test('dashboardTokenFor returns the page token when there is one, else the held credential for the same origin', () => {
  const held = { origin: ORIGIN, token: CREDENTIAL };
  const injected = '<script>window.__HERMES_SESSION_TOKEN__ = "page-token"</script>';
  assert.equal(dashboardTokenFor(ORIGIN, injected, held), 'page-token', 'a legacy dashboard keeps its own token');
  assert.equal(dashboardTokenFor(ORIGIN, '<title>Hermes</title>', held), CREDENTIAL);
  assert.equal(dashboardTokenFor(`${ORIGIN}/`, '', held), CREDENTIAL);
  assert.equal(dashboardTokenFor(`${ORIGIN}/some/path?x=1`, '', held), CREDENTIAL);
  assert.equal(dashboardTokenFor('http://127.0.0.1:9119', '', held), '', 'another port is another origin');
  assert.equal(dashboardTokenFor('http://localhost:9120', '', held), '', 'another host name is another origin');
  assert.equal(dashboardTokenFor('https://hermes.example.com', '', held), '');
  assert.equal(dashboardTokenFor(ORIGIN, '', null), '');
  assert.equal(dashboardTokenFor('not a url', '', held), '');
  assert.equal(dashboardTokenFor(ORIGIN, '', { origin: ORIGIN, token: 'short' }), '');
});

test('the store tokenFor reads the held credential and follows the same rule', async () => {
  const store = createWebappCredentialStore({ storageSession: fakeSessionStorageArea() });
  assert.equal(await store.tokenFor(ORIGIN, ''), '');
  await store.hold({ origin: ORIGIN, token: CREDENTIAL });
  assert.equal(await store.tokenFor(ORIGIN, ''), CREDENTIAL);
  assert.equal(await store.tokenFor('http://127.0.0.1:1297', ''), '');
  assert.equal(await store.tokenFor(ORIGIN, '<script>window.__HERMES_SESSION_TOKEN__ = "page-token"</script>'), 'page-token');
});

// --- the credential is never logged, shown or placed in a URL ----------------------------------

test('across a full capture, validation and minting, the credential is only ever a request header', async () => {
  const logged = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(consoleMethods.map((name) => [name, console[name]]));
  for (const name of consoleMethods) console[name] = (...args) => logged.push(args);
  try {
    const fetchImpl = fakeFetch((url, init) => {
      if (!init.headers?.['X-Hermes-Session-Token']) return reply(401);
      if (url.endsWith('/api/webapp/window-ticket')) return reply(200, { ticket: TICKET });
      if (url.includes('/api/webapp/socket-ticket')) return reply(200, { ticket: TICKET, ttl_seconds: 30 });
      return reply(200, { profiles: [] });
    });
    const store = createWebappCredentialStore({
      storageSession: fakeSessionStorageArea(), scriptingApi: fakeScripting({ 7: keyStorage() }), tabsApi: tabsFor([signedInTab(7)]), fetchImpl,
    });
    await store.capture(target);
    await store.validate(target);
    await store.mintWindowTicket(target);
    await store.mintSocketTicket(target, { profile: 'work' });
    const launch = webappLaunchUrl(target, TICKET, { profile: 'work' });
    assert.ok(fetchImpl.calls.length >= 4);
    for (const call of fetchImpl.calls) {
      assert.ok(!call.url.includes(CREDENTIAL), `not in ${call.url}`);
      assert.equal(call.init.body, undefined, 'no request body carries it');
      for (const [name, value] of Object.entries(call.init.headers)) {
        if (value === CREDENTIAL) assert.equal(name, 'X-Hermes-Session-Token');
      }
    }
    assert.ok(!launch.includes(CREDENTIAL));
  } finally {
    for (const name of consoleMethods) console[name] = originals[name];
  }
  assert.deepEqual(logged.filter((args) => JSON.stringify(args).includes(CREDENTIAL)), []);
});

test('the credential module never logs, and never builds a URL with a token query', () => {
  const code = readFileSync(new URL('../extension/lib/webapp-credential.mjs', import.meta.url), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /console\./);
  assert.doesNotMatch(code, /[?&]token=/);
  assert.doesNotMatch(code, /localStorage|storage\.local|chrome\.storage\.sync/);
  assert.doesNotMatch(code, /setAccessLevel/, 'storage.session keeps its trusted-contexts default');
});

test('a different credential captured later replaces the held one (a new sign-in after hermes webapp)', async () => {
  const session = fakeSessionStorageArea();
  const storages = { 7: keyStorage(CREDENTIAL) };
  const store = createWebappCredentialStore({ storageSession: session, scriptingApi: fakeScripting(storages), tabsApi: tabsFor([signedInTab(7)]), fetchImpl: acceptingFetch() });
  await store.capture(target);
  storages[7] = keyStorage(OTHER_CREDENTIAL);
  const second = await store.capture(target);
  assert.equal(second.validated, true);
  assert.equal((await store.held()).token, OTHER_CREDENTIAL);
});
