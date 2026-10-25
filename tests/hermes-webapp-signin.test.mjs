import assert from 'node:assert/strict';
import test from 'node:test';

import { WEBAPP_SIGN_IN_HINT_STORAGE_KEY, openHermesWebapp } from '../extension/lib/hermes-webapp.mjs';
import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';
import {
  createWebappCredentialStore,
  webappLaunchUrl,
  webappSessionStorageKey,
} from '../extension/lib/webapp-credential.mjs';

const local = { connectionMode: 'local', gatewayUrl: 'http://127.0.0.1:8642' };
const ORIGIN = 'http://127.0.0.1:9120';
const CREDENTIAL = `cred-${'0123456789'.repeat(4)}`.slice(0, 43);
const TICKET = `tick-${'abcdefghij'.repeat(4)}`.slice(0, 43);
assert.equal(CREDENTIAL.length, 43);
assert.equal(TICKET.length, 43);

const tab = (id, url, extra = {}) => ({ id, url, windowId: 1, active: false, ...extra });

// A browser whose every call is recorded in one ordered list, so the order of the button's steps is visible.
function fakeBrowser({ tabs = [], fetchImpl, storage = {} } = {}) {
  const order = [];
  const calls = { create: [], update: [], fetch: [] };
  const store = { ...storage };
  return {
    order,
    calls,
    store,
    tabsApi: {
      query: async () => tabs,
      create: async (info) => { order.push('create'); calls.create.push(info); return { id: 99, ...info }; },
      update: async (id, info) => { order.push('focus'); calls.update.push([id, info]); return { id }; },
    },
    windowsApi: { update: async () => {} },
    permissionsApi: { request: async () => true, contains: async () => true },
    storageArea: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (patch) => { Object.assign(store, patch); },
    },
    fetchImpl: async (url, init) => {
      order.push('probe');
      calls.fetch.push([url, init]);
      return fetchImpl ? fetchImpl(url, init) : { status: 200, type: 'basic' };
    },
  };
}

// Stand-in for the credential store that records the order it is used in.
function fakeCredentials(browser, {
  enabled = true,
  held = null,
  capture = () => ({ ok: false, reason: 'no-tab' }),
  mint = () => ({ ok: true, ticket: TICKET }),
} = {}) {
  const state = { held };
  return {
    state,
    enabled: async () => { browser.order.push('enabled'); return enabled; },
    held: async () => { browser.order.push('held'); return state.held; },
    capture: async (target, options = {}) => {
      browser.order.push(options.tab ? `capture:tab${options.tab.id}` : 'capture:all');
      const result = await capture(target, options);
      if (result.ok) state.held = { origin: target.origin, token: CREDENTIAL };
      return result;
    },
    mintWindowTicket: async () => { browser.order.push('mint'); return mint(); },
    launchUrl: webappLaunchUrl,
  };
}

const heldRecord = { origin: ORIGIN, basePath: '', token: CREDENTIAL, capturedAt: 1 };
const steps = (browser) => browser.order.filter((step) => step !== 'enabled');

// --- the button's order ------------------------------------------------------------------------

test('1. an open Hermes Web tab is focused and its sign-in is captured, and nothing else happens', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, `${ORIGIN}/`)] });
  const credentials = fakeCredentials(browser, { capture: () => ({ ok: true, tabId: 4 }) });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.deepEqual({ status: result.status, tabId: result.tabId }, { status: 'focused', tabId: 4 });
  assert.deepEqual(steps(browser), ['capture:tab4', 'focus']);
  assert.deepEqual(browser.calls.create, []);
  assert.deepEqual(browser.calls.fetch, []);
});

test('1. a focused tab is still focused when the sign-in cannot be captured from it and none is held', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, `${ORIGIN}/`)] });
  const credentials = fakeCredentials(browser, { capture: () => ({ ok: false, reason: 'not-signed-in' }) });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.equal(result.status, 'focused', 'the tab shows the instructions for running hermes webapp');
  assert.deepEqual(steps(browser), ['capture:tab4', 'held', 'focus']);
});

test('1. a handoff page that is still redeeming its ticket is focused, not replaced', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, `${ORIGIN}/webapp/launch`)] });
  const credentials = fakeCredentials(browser, { held: heldRecord, capture: () => ({ ok: false, reason: 'no-tab' }) });
  assert.equal((await openHermesWebapp({ settings: local, ...browser, credentials })).status, 'focused');
  assert.deepEqual(browser.calls.create, []);
});

test('2. with a held sign-in and no tab, a new tab opens already signed in: the ticket in the fragment, never the credential', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser, { held: heldRecord });
  const result = await openHermesWebapp({ settings: { ...local, activeProfile: 'work' }, ...browser, credentials });
  assert.deepEqual({ status: result.status, hint: result.hint, signedIn: result.signedIn }, { status: 'opened', hint: 'signed-in', signedIn: true });
  assert.deepEqual(steps(browser), ['held', 'mint', 'create']);
  assert.deepEqual(browser.calls.create, [{ url: `${ORIGIN}/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`, active: true }]);
  assert.deepEqual(browser.calls.fetch, [], 'the ticket mint is the reachability check');
  assert.ok(!JSON.stringify(browser.calls.create).includes(CREDENTIAL));
  assert.equal(new URL(browser.calls.create[0].url).search, '');
  assert.equal(browser.store[WEBAPP_SIGN_IN_HINT_STORAGE_KEY], undefined, 'no sign-in hint is spent on a signed-in open');
});

test('2. the default profile adds no query to the launch URL', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser, { held: heldRecord });
  await openHermesWebapp({ settings: { ...local, activeProfile: 'default' }, ...browser, credentials });
  assert.deepEqual(browser.calls.create, [{ url: `${ORIGIN}/webapp/launch#ticket=${TICKET}`, active: true }]);
});

test('2. an open tab that is signed out does not stand in the way of a held sign-in', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, `${ORIGIN}/`)] });
  const credentials = fakeCredentials(browser, { held: heldRecord, capture: () => ({ ok: false, reason: 'not-signed-in' }) });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.equal(result.status, 'opened');
  assert.deepEqual(steps(browser), ['capture:tab4', 'held', 'held', 'mint', 'create'], 'it is not focused first');
  assert.deepEqual(browser.calls.update, []);
});

test('3. with nothing held and no tab to read, a signed-in tab found elsewhere is captured and used', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser, { capture: () => ({ ok: true, tabId: 8 }) });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.equal(result.status, 'opened');
  assert.equal(result.hint, 'signed-in');
  assert.deepEqual(steps(browser), ['held', 'capture:all', 'held', 'mint', 'create']);
  assert.match(browser.calls.create[0].url, /\/webapp\/launch#ticket=/);
});

test('3. a tab that closed while it was being focused falls back to the held sign-in', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, `${ORIGIN}/`)] });
  browser.tabsApi.update = async () => { throw new Error('No tab with id: 4'); };
  const credentials = fakeCredentials(browser, { capture: () => ({ ok: true, tabId: 4 }) });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.equal(result.status, 'opened');
  assert.deepEqual(steps(browser), ['capture:tab4', 'held', 'mint', 'create']);
});

test('4. with no sign-in anywhere, the sign-in page opens and the hint says to run hermes webapp once', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser);
  const result = await openHermesWebapp({ settings: { ...local, activeProfile: 'work' }, ...browser, credentials });
  assert.deepEqual({ status: result.status, hint: result.hint }, { status: 'opened', hint: 'local-kept' });
  assert.deepEqual(steps(browser), ['held', 'capture:all', 'probe', 'create']);
  assert.deepEqual(browser.calls.create, [{ url: `${ORIGIN}/?profile=work`, active: true }]);
  // Said once, as before.
  assert.equal((await openHermesWebapp({ settings: local, ...browser, credentials })).hint, '');
});

test('4. a refused window ticket drops to the sign-in page rather than opening a dead link', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser, { held: heldRecord, mint: () => ({ ok: false, reason: 'rejected' }) });
  credentials.held = async () => { browser.order.push('held'); return heldRecord; };
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.equal(result.status, 'opened');
  assert.equal(browser.calls.create[0].url, `${ORIGIN}/`);
  assert.ok(!browser.calls.create[0].url.includes('launch'));
});

test('the unreachable dialog still appears when nothing answers, with or without a held sign-in', async () => {
  for (const held of [null, heldRecord]) {
    const browser = fakeBrowser({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    const credentials = fakeCredentials(browser, { held, mint: () => ({ ok: false, reason: 'unreachable' }) });
    credentials.held = async () => held;
    assert.deepEqual(await openHermesWebapp({ settings: local, ...browser, credentials }), { status: 'unreachable', address: ORIGIN });
    assert.deepEqual(browser.calls.create, []);
  }
});

test('with the setting off the button never touches the credential and opens as it always did', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser, { enabled: false, held: heldRecord });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials });
  assert.deepEqual({ status: result.status, hint: result.hint }, { status: 'opened', hint: 'local' }, 'the original hint: the tab stays signed in, nothing is kept');
  assert.deepEqual(steps(browser), ['probe', 'create']);

  const withTab = fakeBrowser({ tabs: [tab(4, `${ORIGIN}/`)] });
  const off = fakeCredentials(withTab, { enabled: false, held: heldRecord });
  assert.equal((await openHermesWebapp({ settings: local, ...withTab, credentials: off })).status, 'focused');
  assert.deepEqual(steps(withTab), ['focus']);
});

test('behind a sign-in gate (a remote address) the hint is the account one and the credential is not involved', async () => {
  const browser = fakeBrowser();
  const credentials = fakeCredentials(browser, { held: heldRecord });
  const result = await openHermesWebapp({
    settings: { connectionMode: 'remote', gatewayUrl: 'https://hermes.example.com', hermesWebAddress: 'https://web.example.com' },
    ...browser,
    credentials,
  });
  assert.deepEqual({ status: result.status, hint: result.hint }, { status: 'opened', hint: 'account' });
  assert.equal(browser.calls.create[0].url, 'https://web.example.com/');
});

// --- the button against the real store, with only the browser stubbed --------------------------

test('a signed-in tab, then a closed tab: the sign-in kept from the first opens the second already signed in', async () => {
  const session = {};
  const storages = { 4: { [webappSessionStorageKey(ORIGIN, '')]: CREDENTIAL } };
  const tabs = [tab(4, `${ORIGIN}/`)];
  const browser = fakeBrowser({ tabs });
  const requests = [];
  const store = createWebappCredentialStore({
    storageSession: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (patch) => { Object.assign(session, patch); },
      remove: async (key) => { delete session[key]; },
    },
    scriptingApi: {
      executeScript: async ({ target, func, args }) => {
        const previous = globalThis.sessionStorage;
        globalThis.sessionStorage = { getItem: (key) => storages[target.tabId]?.[key] ?? null };
        try {
          return [{ result: await func(...args) }];
        } finally {
          if (previous === undefined) delete globalThis.sessionStorage;
          else globalThis.sessionStorage = previous;
        }
      },
    },
    tabsApi: { query: async () => tabs, get: async (id) => tabs.find((entry) => entry.id === id) },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.headers['X-Hermes-Session-Token'] !== CREDENTIAL) return { status: 401, ok: false, json: async () => ({}) };
      return String(url).endsWith('/window-ticket')
        ? { status: 200, ok: true, json: async () => ({ ticket: TICKET }) }
        : { status: 200, ok: true, json: async () => ({ profiles: [] }) };
    },
  });

  const first = await openHermesWebapp({ settings: local, ...browser, credentials: store });
  assert.equal(first.status, 'focused');
  assert.equal(browser.calls.create.length, 0);
  assert.equal(session.hermesWebappCredential.token, CREDENTIAL, 'captured from the open tab');

  tabs.length = 0; // the person closes the tab
  const second = await openHermesWebapp({ settings: { ...local, activeProfile: 'work' }, ...browser, credentials: store });
  assert.equal(second.status, 'opened');
  assert.equal(browser.calls.create.length, 1);
  assert.equal(browser.calls.create[0].url, `${ORIGIN}/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`);
  const mint = requests.find((request) => String(request.url).endsWith('/api/webapp/window-ticket'));
  assert.equal(mint.init.method, 'POST');
  assert.equal(mint.init.headers['X-Hermes-Session-Token'], CREDENTIAL);
  for (const request of requests) assert.ok(!String(request.url).includes(CREDENTIAL));
});

test('after hermes webapp --sign-out the held sign-in is dropped by the first request, and the sign-in page opens', async () => {
  const session = { hermesWebappCredential: heldRecord };
  const browser = fakeBrowser();
  const store = createWebappCredentialStore({
    storageSession: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (patch) => { Object.assign(session, patch); },
      remove: async (key) => { delete session[key]; },
    },
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }),
  });
  const result = await openHermesWebapp({ settings: local, ...browser, credentials: store });
  assert.equal(result.status, 'opened');
  assert.equal(browser.calls.create[0].url, `${ORIGIN}/`);
  assert.equal(session.hermesWebappCredential, undefined, 'the dead credential is gone');
});

// --- the new strings ---------------------------------------------------------------------------

const NEW_KEYS = [
  'webapp.keep_signed_in_label', 'webapp.keep_signed_in_hint', 'webapp.hint_signed_in',
  'webapp.hint_local_kept', 'webapp.sign_in_needed', 'projects.unavailable.webapp_sign_in',
];

test('the sign-in strings exist in all 21 locales, translated, naming the commands and keeping the product names', async () => {
  const english = await loadLocaleMessages('en');
  assert.equal(SUPPORTED_LOCALES.length, 21);
  for (const key of NEW_KEYS) assert.equal(typeof english[key], 'string', `en is missing ${key}`);
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadLocaleMessages(locale.id);
    for (const key of NEW_KEYS) {
      assert.equal(typeof catalog[key], 'string', `${locale.id} is missing ${key}`);
      assert.ok(catalog[key].trim(), `${locale.id} ${key} is empty`);
      if (locale.id !== 'en') assert.notEqual(catalog[key], english[key], `${locale.id} ${key} is still English`);
      assert.ok(catalog[key].includes('Hermes'), `${locale.id} ${key} lost "Hermes"`);
    }
    for (const key of ['webapp.hint_local_kept', 'webapp.sign_in_needed', 'projects.unavailable.webapp_sign_in']) {
      assert.ok(catalog[key].includes('hermes webapp'), `${locale.id} ${key} must name the command`);
    }
    assert.ok(catalog['webapp.keep_signed_in_hint'].includes('hermes webapp --sign-out'), `${locale.id} must name the sign-out command`);
  }
});
