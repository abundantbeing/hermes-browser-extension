import assert from 'node:assert/strict';
import test from 'node:test';

import { webappSessionStorageKey } from '../extension/lib/webapp-credential.mjs';
import { createSettingsSaveHarness, sidepanelSource } from './helpers/settings-save-harness.mjs';

const local = { connectionMode: 'local', gatewayUrl: 'http://127.0.0.1:8642' };
const ORIGIN = 'http://127.0.0.1:9120';
const CREDENTIAL = `cred-${'0123456789'.repeat(4)}`.slice(0, 43);
const TICKET = `tick-${'abcdefghij'.repeat(4)}`.slice(0, 43);
const heldRecord = { origin: ORIGIN, basePath: '', token: CREDENTIAL, capturedAt: 1 };

// The real openHermesWeb() and credential store from sidepanel.js, with only the browser stubbed.
async function panel({ settings = local, tabs = [], held = null, tabStorage = {}, fetchImpl } = {}) {
  const h = await createSettingsSaveHarness({ settings });
  const calls = { create: [], update: [], fetch: [], toasts: [], executed: [] };
  const session = held ? { hermesWebappCredential: held } : {};
  const kv = {};
  h.scope.browserApi = {
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((entry) => entry.id === id),
      create: async (info) => { calls.create.push(info); return { id: 50 }; },
      update: async (id, info) => { calls.update.push([id, info]); },
    },
    windows: { update: async () => {} },
    permissions: { request: async () => true },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        calls.executed.push(target.tabId);
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
      local: { get: async (key) => ({ [key]: kv[key] }), set: async (patch) => { Object.assign(kv, patch); } },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (patch) => { Object.assign(session, patch); },
        remove: async (key) => { delete session[key]; },
      },
    },
  };
  h.scope.showOperationToast = (toast) => calls.toasts.push(toast);
  h.scope.webappDialog = null;
  h.scope.webappOpening = false;
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = h.document;
  globalThis.fetch = async (url, init = {}) => {
    calls.fetch.push([String(url), init]);
    if (fetchImpl) return fetchImpl(String(url), init);
    if (init.method === 'POST' && String(url).endsWith('/api/webapp/window-ticket')) {
      return init.headers['X-Hermes-Session-Token'] === CREDENTIAL
        ? { status: 200, ok: true, json: async () => ({ ticket: TICKET }) }
        : { status: 401, ok: false, json: async () => ({}) };
    }
    if (String(url).endsWith('/api/profiles')) return { status: 200, ok: true, json: async () => ({ profiles: [] }) };
    return { status: 200, type: 'basic', ok: true };
  };
  return {
    h, calls, session,
    open: () => h.fn('openHermesWeb')(),
    close() {
      globalThis.document = previous.document;
      globalThis.fetch = previous.fetch;
      h.close();
    },
  };
}

test('with the sign-in held and no tab open, the real button opens a new tab already signed in', async () => {
  const p = await panel({ settings: { ...local, activeProfile: 'work' }, held: heldRecord });
  try {
    await p.open();
    assert.deepEqual(p.calls.create, [{ url: `${ORIGIN}/webapp/launch#ticket=${TICKET}&query=profile%3Dwork`, active: true }]);
    assert.deepEqual(p.calls.toasts, [], 'nothing to tell the person: it is simply signed in');
    const posts = p.calls.fetch.filter(([, init]) => init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0][0], `${ORIGIN}/api/webapp/window-ticket`);
    assert.equal(posts[0][1].headers['X-Hermes-Session-Token'], CREDENTIAL);
    for (const [url] of p.calls.fetch) assert.ok(!url.includes(CREDENTIAL));
    assert.ok(!JSON.stringify(p.calls.create).includes(CREDENTIAL));
  } finally {
    p.close();
  }
});

test('the real button keeps the sign-in of an open signed-in tab, so closing it does not end the sign-in', async () => {
  const tabs = [{ id: 8, windowId: 2, url: `${ORIGIN}/#/chat`, active: true }];
  const p = await panel({ tabs, tabStorage: { 8: { [webappSessionStorageKey(ORIGIN, '')]: CREDENTIAL } } });
  try {
    await p.open();
    assert.deepEqual(p.calls.update, [[8, { active: true }]]);
    assert.deepEqual(p.calls.executed, [8]);
    assert.equal(p.session.hermesWebappCredential.token, CREDENTIAL);
    tabs.length = 0;
    await p.h.fn('openHermesWeb')();
    assert.equal(p.calls.create.length, 1);
    assert.match(p.calls.create[0].url, /\/webapp\/launch#ticket=/);
  } finally {
    p.close();
  }
});

test('with Keep Hermes Web signed in off, the real button reads no tab, holds nothing and mints nothing', async () => {
  const tabs = [{ id: 8, windowId: 2, url: `${ORIGIN}/`, active: true }];
  const p = await panel({
    settings: { ...local, webappKeepSignedIn: false }, tabs, held: heldRecord,
    tabStorage: { 8: { [webappSessionStorageKey(ORIGIN, '')]: CREDENTIAL } },
  });
  try {
    await p.open();
    assert.deepEqual(p.calls.executed, [], 'no page was read');
    assert.deepEqual(p.calls.fetch, []);
    tabs.length = 0;
    await p.h.fn('openHermesWeb')();
    assert.deepEqual(p.calls.create, [{ url: `${ORIGIN}/`, active: true }], 'the plain address, not a launch link');
    assert.deepEqual(p.calls.fetch.filter(([, init]) => init.method === 'POST'), []);
  } finally {
    p.close();
  }
});

test('a sign-out that replaced the credential opens the sign-in page and forgets the dead sign-in', async () => {
  const p = await panel({
    held: heldRecord,
    fetchImpl: async (url, init) => (init.method === 'POST' ? { status: 401, ok: false, json: async () => ({}) } : { status: 200, type: 'basic', ok: true }),
  });
  try {
    await p.open();
    assert.deepEqual(p.calls.create, [{ url: `${ORIGIN}/`, active: true }]);
    assert.equal(p.session.hermesWebappCredential, undefined);
    assert.deepEqual(p.calls.toasts.map(({ detail }) => detail), ['webapp.hint_local_kept']);
  } finally {
    p.close();
  }
});

test('the button clicks and the dialog retry both run the one opener that keeps the sign-in', () => {
  assert.match(sidepanelSource, /credentials: webappCredentialStore\(\),/);
  assert.match(sidepanelSource, /onRetry: \(\) => \{ void openHermesWeb\(\); \}/);
});
