import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAccountStore,
  createHermesAccount,
  openSignInWindow,
  publicSignInBase,
} from '../extension/lib/hermes-account.mjs';

// A gateway with webapp.public_url hands its identity provider <public_url>/auth/callback, and only that address
// gets the sign-in cookie back. A sign-in started on http://127.0.0.1:9120 lost the cookie on the way back, the
// gateway answered 400 missing_pkce_cookie on the public address, and the panel waited for good.

const LOCAL = 'http://127.0.0.1:9120';
const PUBLIC = 'https://zenzo.example.ts.net';

test('the public address is read from the provider page that names the callback', () => {
  const idp = `https://portal.example.com/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(`${PUBLIC}/auth/callback`)}&state=s`;
  assert.equal(publicSignInBase(idp, LOCAL), PUBLIC);
  assert.equal(publicSignInBase(`https://portal.example.com/a?redirect_uri=${encodeURIComponent(`${PUBLIC}/hermes/auth/callback`)}`, LOCAL), `${PUBLIC}/hermes`);
});

test('the public address is read from a callback that landed there', () => {
  assert.equal(publicSignInBase(`${PUBLIC}/auth/callback?code=c&state=s`, LOCAL), PUBLIC);
});

test('nothing moves when the callback is on the address the sign-in started on, or names no callback', () => {
  assert.equal(publicSignInBase(`${LOCAL}/auth/callback?code=c`, LOCAL), '');
  assert.equal(publicSignInBase(`https://portal.example.com/a?redirect_uri=${encodeURIComponent(`${LOCAL}/auth/callback`)}`, LOCAL), '');
  assert.equal(publicSignInBase('https://portal.example.com/login', LOCAL), '');
  assert.equal(publicSignInBase(`https://portal.example.com/a?redirect_uri=${encodeURIComponent('http://127.0.0.1:5555/hermes-browser-callback')}`, LOCAL), '');
  assert.equal(publicSignInBase(`https://portal.example.com/a?redirect_uri=${encodeURIComponent('javascript:alert(1)//auth/callback')}`, LOCAL), '');
  assert.equal(publicSignInBase('not a url', LOCAL), '');
  // A remote sign-in never moves to this machine.
  assert.equal(publicSignInBase(`http://127.0.0.1:9120/auth/callback?code=c`, PUBLIC), '');
  assert.equal(publicSignInBase(`http://evil.example/auth/callback?code=c`, LOCAL), '', 'plain http off this machine is no account address');
});

test('the sign-in window can be sent on to another address', async () => {
  const updates = [];
  const opened = await openSignInWindow('https://h.example/x', {
    windowsApi: { create: async () => ({ id: 9, tabs: [{ id: 41 }] }), remove: async () => {}, onRemoved: null },
    tabsApi: { update: async (id, props) => { updates.push([id, props.url]); } },
  });
  assert.equal(opened.tabId, 41);
  await opened.navigate('https://h.example/y');
  assert.deepEqual(updates, [[41, 'https://h.example/y']]);
});

function fakeEvent() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), fire: (...a) => { for (const fn of [...listeners]) fn(...a); } };
}

function memoryArea() {
  const data = {};
  return {
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  };
}

const json = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
const locks = { request: (_n, cb) => Promise.resolve().then(cb) };

test('a sign-in started on the loopback address finishes on the public address and stores the tokens', async () => {
  const tabsApi = { onUpdated: fakeEvent() };
  const visited = [];
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const path = new URL(url).pathname;
    if (path === '/api/auth/providers') return json(200, { providers: [{ name: 'nous' }] });
    if (path === '/auth/native/token') return json(200, { access_token: 'at', refresh_token: 'rt', expires_at: 99, provider: 'nous', user_id: 'u' });
    return json(404, {});
  };
  const account = createHermesAccount({
    store: createAccountStore({ storageArea: memoryArea(), locks }),
    fetchImpl,
    tabsApi,
    random: () => 0.5,
    openWindow: async (url) => {
      visited.push(url);
      const first = new URL(url).searchParams;
      // The gateway sends the window to its provider, naming the public callback.
      queueMicrotask(() => tabsApi.onUpdated.fire(41, { url: `https://portal.example.com/authorize?redirect_uri=${encodeURIComponent(`${PUBLIC}/auth/callback`)}` }, { id: 41 }));
      return {
        tabId: 41,
        close: async () => {},
        closed: new Promise(() => {}),
        navigate: async (next) => {
          visited.push(next);
          const again = new URL(next).searchParams;
          assert.equal(again.get('state'), first.get('state'), 'the same sign-in, moved');
          assert.equal(again.get('code_challenge'), first.get('code_challenge'));
          queueMicrotask(() => tabsApi.onUpdated.fire(41, { url: `${again.get('redirect_uri')}?code=gw&state=${again.get('state')}` }, { id: 41 }));
        },
      };
    },
  });
  const result = await account.signIn({ origin: LOCAL });
  assert.equal(result.ok, true);
  assert.equal(visited.length, 2);
  assert.ok(visited[0].startsWith(`${LOCAL}/auth/native/authorize?`));
  assert.ok(visited[1].startsWith(`${PUBLIC}/auth/native/authorize?`));
  assert.ok(fetched.some((url) => url === `${LOCAL}/auth/native/token`), 'the code is redeemed where the sign-in is kept');
});

test('the move happens once, and only for the sign-in window', async () => {
  const tabsApi = { onUpdated: fakeEvent() };
  const moves = [];
  const account = createHermesAccount({
    store: createAccountStore({ storageArea: memoryArea(), locks }),
    fetchImpl: async () => json(200, { providers: [{ name: 'nous' }] }),
    tabsApi,
    signInTimeoutMs: 50,
    openWindow: async () => {
      queueMicrotask(async () => {
        tabsApi.onUpdated.fire(7, { url: `${PUBLIC}/auth/callback?code=x` }, { id: 7 });
        await Promise.resolve();
        assert.equal(moves.length, 0, 'another tab must not restart sign-in');
        tabsApi.onUpdated.fire(41, { url: `${PUBLIC}/auth/callback?code=x` }, { id: 41 });
        tabsApi.onUpdated.fire(41, { url: `${PUBLIC}/auth/callback?code=y` }, { id: 41 });
      });
      return { tabId: 41, close: async () => {}, navigate: async (url) => { moves.push(url); } };
    },
  });
  const result = await account.signIn({ origin: LOCAL });
  assert.equal(result.ok, false);
  assert.equal(moves.length, 1);
});

test('webRequest granted after the account client was made is still used', async () => {
  const granted = { webRequest: null };
  const account = createHermesAccount({
    store: createAccountStore({ storageArea: memoryArea(), locks }),
    fetchImpl: async (url) => (new URL(url).pathname === '/auth/native/token'
      ? json(200, { access_token: 'at', refresh_token: 'rt', expires_at: 99 })
      : json(200, { providers: [{ name: 'nous' }] })),
    webRequestApi: () => granted.webRequest,
    openWindow: async (url) => {
      const params = new URL(url).searchParams;
      queueMicrotask(() => granted.webRequest.onBeforeRequest.fire({ url: `${params.get('redirect_uri')}?code=c&state=${params.get('state')}` }));
      return { close: async () => {} };
    },
  });
  granted.webRequest = { onBeforeRequest: fakeEvent() };
  const result = await account.signIn({ origin: PUBLIC });
  assert.equal(result.ok, true);
});
