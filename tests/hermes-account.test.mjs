import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';

import {
  ACCOUNT_REASONS,
  ACCOUNT_STORAGE_KEY,
  AccountSession,
  accountConnectionKey,
  accountOriginOf,
  accountOriginsFor,
  buildAuthorizeUrl,
  buildRedirectUri,
  createAccountStore,
  createHermesAccount,
  dialWithAccountTicket,
  generatePkce,
  hasWebRequestPermission,
  openSignInWindow,
  parseCallbackUrl,
  pickRedirectPort,
  pkceChallengeFor,
  probeAccountSupport,
  requestWebRequestPermission,
  watchForCallback,
} from '../extension/lib/hermes-account.mjs';
import { gatewayWebSocketProtocols } from '../extension/lib/gateway-ws.mjs';

const ORIGIN = 'https://hermes.example.com';
const REDIRECT = 'http://127.0.0.1:51234/hermes-browser-callback';

function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) { for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value); },
    async remove(key) { delete data[key]; },
  };
}

function json(status, payload) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function tokens(n, over = {}) {
  return { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_at: 10_000 + n, token_type: 'Bearer', provider: 'nous', user_id: 'u1', ...over };
}

function fakeEvent() {
  const listeners = new Set();
  return {
    filter: null,
    addListener(fn, filter) { listeners.add(fn); this.filter = filter; },
    removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => { for (const fn of [...listeners]) fn(...args); },
    get size() { return listeners.size; },
  };
}

// ---- PKCE ----------------------------------------------------------------------------------------------------

test('S256 challenge matches the RFC 7636 appendix B vector', async () => {
  assert.equal(await pkceChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('generatePkce gives a 43-char verifier, its S256 challenge and an unrelated 32-char state', async () => {
  const pkce = await generatePkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pkce.challenge, await pkceChallengeFor(pkce.verifier));
  assert.match(pkce.state, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(pkce.state, pkce.verifier);
  assert.notEqual((await generatePkce()).verifier, pkce.verifier);
});

// ---- Redirect and authorize URL --------------------------------------------------------------------------------

test('the redirect is the canonical RFC 8252 loopback URL the gateway accepts', () => {
  for (const random of [() => 0, () => 0.5, () => 0.999999]) {
    const port = pickRedirectPort(random);
    assert.ok(port >= 49152 && port <= 65535);
    const uri = buildRedirectUri(port);
    const parsed = new URL(uri);
    assert.equal(uri, `http://127.0.0.1:${port}/hermes-browser-callback`);
    assert.equal(parsed.host, `127.0.0.1:${port}`);
    assert.equal(parsed.hash, '');
    assert.equal(parsed.username, '');
  }
  assert.throws(() => buildRedirectUri(0));
  assert.throws(() => buildRedirectUri('abc'));
});

test('the authorize URL carries the provider, S256 challenge, loopback redirect and state, and no verifier', async () => {
  const pkce = await generatePkce();
  const url = new URL(buildAuthorizeUrl({ baseUrl: `${ORIGIN}/`, provider: 'nous', challenge: pkce.challenge, redirectUri: REDIRECT, state: pkce.state }));
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/auth/native/authorize');
  assert.equal(url.searchParams.get('provider'), 'nous');
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('state'), pkce.state);
  assert.ok(!url.href.includes(pkce.verifier));
  assert.equal(new URL(buildAuthorizeUrl({ baseUrl: `${ORIGIN}/hermes`, challenge: 'c', redirectUri: REDIRECT, state: 's' })).pathname, '/hermes/auth/native/authorize');
  assert.throws(() => buildAuthorizeUrl({ baseUrl: ORIGIN, challenge: '', redirectUri: REDIRECT, state: 's' }));
});

// ---- Code capture ---------------------------------------------------------------------------------------------

test('parseCallbackUrl accepts the redirect with the right state and nothing else', () => {
  const args = { redirectUri: REDIRECT, expectedState: 'good-state' };
  assert.deepEqual(parseCallbackUrl(`${REDIRECT}?code=abc&state=good-state`, args), { match: true, ok: true, code: 'abc' });
  // a state mismatch fails the sign-in, and the code is not returned
  assert.deepEqual(parseCallbackUrl(`${REDIRECT}?code=abc&state=evil`, args), { match: true, ok: false, reason: ACCOUNT_REASONS.STATE_MISMATCH });
  assert.deepEqual(parseCallbackUrl(`${REDIRECT}?code=abc`, args), { match: true, ok: false, reason: ACCOUNT_REASONS.STATE_MISMATCH });
  assert.deepEqual(parseCallbackUrl(`${REDIRECT}?error=access_denied&state=good-state`, args), { match: true, ok: false, reason: ACCOUNT_REASONS.PROVIDER_DENIED });
  assert.deepEqual(parseCallbackUrl(`${REDIRECT}?state=good-state`, args), { match: true, ok: false, reason: ACCOUNT_REASONS.MISSING_CODE });
  assert.deepEqual(parseCallbackUrl(`${REDIRECT}?code=a&code=b&state=good-state`, args), { match: true, ok: false, reason: ACCOUNT_REASONS.BAD_RESPONSE });
  assert.equal(parseCallbackUrl(`${REDIRECT}?code=abc&state=`, { redirectUri: REDIRECT, expectedState: '' }).ok, false);
});

test('parseCallbackUrl ignores a foreign redirect: another host, port, path or scheme', () => {
  const args = { redirectUri: REDIRECT, expectedState: 's' };
  for (const foreign of [
    'http://127.0.0.1:51235/hermes-browser-callback?code=x&state=s',
    'http://127.0.0.1:51234/other?code=x&state=s',
    'http://localhost:51234/hermes-browser-callback?code=x&state=s',
    'https://127.0.0.1:51234/hermes-browser-callback?code=x&state=s',
    'https://evil.example/hermes-browser-callback?code=x&state=s',
    'http://user@127.0.0.1:51234/hermes-browser-callback?code=x&state=s',
    'not a url',
    '',
  ]) {
    assert.deepEqual(parseCallbackUrl(foreign, args), { match: false }, foreign);
  }
});

test('watchForCallback resolves the code from the webRequest hop, filters its pattern, and removes every listener', async () => {
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  const tabsApi = { onUpdated: fakeEvent() };
  const watcher = watchForCallback({ redirectUri: REDIRECT, expectedState: 's1', webRequestApi, tabsApi, setTimer: () => 1, clearTimer: () => {} });
  assert.deepEqual(webRequestApi.onBeforeRequest.filter, { urls: ['http://127.0.0.1/hermes-browser-callback*'] });
  // a foreign page and a request on another port are ignored
  webRequestApi.onBeforeRequest.fire({ url: 'http://127.0.0.1:9999/hermes-browser-callback?code=no&state=s1' });
  webRequestApi.onBeforeRequest.fire({ url: 'https://hermes.example.com/auth/callback?code=idp&state=x' });
  webRequestApi.onBeforeRequest.fire({ url: `${REDIRECT}?code=the-code&state=s1` });
  assert.deepEqual(await watcher.done, { ok: true, code: 'the-code' });
  assert.equal(webRequestApi.onBeforeRequest.size, 0);
  assert.equal(tabsApi.onUpdated.size, 0);
  // settled once: a later hit cannot change the answer
  webRequestApi.onBeforeRequest.fire({ url: `${REDIRECT}?code=late&state=s1` });
  assert.deepEqual(await watcher.done, { ok: true, code: 'the-code' });
});

test('watchForCallback fails on a state mismatch and never hands the code over', async () => {
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  const watcher = watchForCallback({ redirectUri: REDIRECT, expectedState: 's1', webRequestApi, setTimer: () => 1, clearTimer: () => {} });
  webRequestApi.onBeforeRequest.fire({ url: `${REDIRECT}?code=stolen&state=other` });
  assert.deepEqual(await watcher.done, { ok: false, reason: ACCOUNT_REASONS.STATE_MISMATCH });
});

test('watchForCallback falls back to the tab URL without webRequest, and times out', async () => {
  const tabsApi = { onUpdated: fakeEvent() };
  const viaTab = watchForCallback({ redirectUri: REDIRECT, expectedState: 's', tabsApi, setTimer: () => 1, clearTimer: () => {} });
  tabsApi.onUpdated.fire(7, { status: 'loading' }, { id: 7, pendingUrl: `${REDIRECT}?code=c&state=s` });
  assert.deepEqual(await viaTab.done, { ok: true, code: 'c' });

  let fire = null;
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  const slow = watchForCallback({ redirectUri: REDIRECT, expectedState: 's', webRequestApi, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  fire();
  assert.deepEqual(await slow.done, { ok: false, reason: ACCOUNT_REASONS.TIMEOUT });
  assert.equal(webRequestApi.onBeforeRequest.size, 0);

  assert.deepEqual(await watchForCallback({ redirectUri: REDIRECT, expectedState: 's' }).done, { ok: false, reason: ACCOUNT_REASONS.NO_PERMISSION });
});

test('the optional webRequest permission is checked and requested by name, and a refusal is false', async () => {
  const calls = [];
  const permissionsApi = {
    contains: async (query) => { calls.push(['contains', query]); return true; },
    request: async (query) => { calls.push(['request', query]); return true; },
  };
  assert.equal(await hasWebRequestPermission(permissionsApi), true);
  assert.equal(await requestWebRequestPermission(permissionsApi), true);
  assert.deepEqual(calls, [['contains', { permissions: ['webRequest'] }], ['request', { permissions: ['webRequest'] }]]);
  assert.equal(await requestWebRequestPermission({ request: async () => { throw new Error('no gesture'); } }), false);
  assert.equal(await requestWebRequestPermission({}), false);
  assert.equal(await hasWebRequestPermission({}), false);
});

test('the sign-in opens in a popup window and closes it, with a tab as the fallback', async () => {
  const removed = [];
  const windowsApi = {
    create: async (options) => { removed.push(['create', options.type, options.url]); return { id: 9 }; },
    remove: async (id) => { removed.push(['remove', id]); },
    onRemoved: fakeEvent(),
  };
  const opened = await openSignInWindow('https://h.example/x', { windowsApi });
  windowsApi.onRemoved.fire(9);
  assert.equal(await opened.closed, true);
  await opened.close();
  assert.deepEqual(removed, [['create', 'popup', 'https://h.example/x'], ['remove', 9]]);
  const tabs = [];
  const viaTab = await openSignInWindow('https://h.example/y', { tabsApi: { create: async () => { tabs.push('create'); return { id: 3 }; }, remove: async (id) => tabs.push(`remove ${id}`) } });
  await viaTab.close();
  assert.deepEqual(tabs, ['create', 'remove 3']);
  await assert.rejects(() => openSignInWindow('u', {}), (error) => error.reason === ACCOUNT_REASONS.NO_WINDOW);
});

// ---- Origins and the remote guard ------------------------------------------------------------------------------

test('tokens go only to https, or to a loopback http listener', () => {
  assert.equal(accountOriginOf('https://hermes.example.com/path?x=1'), ORIGIN);
  assert.equal(accountOriginOf('http://127.0.0.1:9119/'), 'http://127.0.0.1:9119');
  assert.equal(accountOriginOf('http://192.168.1.5:9119'), '');
  assert.equal(accountOriginOf('http://hermes.example.com'), '');
  assert.equal(accountOriginOf('https://u:p@hermes.example.com'), '');
  assert.equal(accountOriginOf('ftp://x'), '');
});

test('a remote connection can never be signed in to on this machine, whatever loopback listener is passed', () => {
  const loopbackOrigins = ['http://127.0.0.1:9120', 'http://localhost:9119'];
  assert.deepEqual(accountOriginsFor({ gatewayMode: 'remote-api', gatewayUrl: 'https://hermes.example.com:8642/v1', loopbackOrigins }), ['https://hermes.example.com:8642']);
  assert.deepEqual(accountOriginsFor({ gatewayMode: 'remote-dashboard', gatewayUrl: 'https://hermes.example.com', loopbackOrigins }), [ORIGIN]);
  // a "remote" gateway that is itself loopback gets nothing: the local mode owns loopback
  assert.deepEqual(accountOriginsFor({ gatewayMode: 'remote-api', gatewayUrl: 'http://127.0.0.1:8642', loopbackOrigins }), []);
  assert.deepEqual(accountOriginsFor({ gatewayMode: 'remote-dashboard', gatewayUrl: 'http://127.0.0.1:9119', loopbackOrigins }), []);
  assert.deepEqual(accountOriginsFor({ gatewayMode: '', gatewayUrl: '', loopbackOrigins }), []);
  // local: only loopback origins, de-duplicated; a remote one passed in is dropped
  assert.deepEqual(accountOriginsFor({ gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', loopbackOrigins: ['http://127.0.0.1:9120', 'http://127.0.0.1:9120/', 'https://hermes.example.com'] }), ['http://127.0.0.1:9120']);
});

test('the module never requests the loopback redirect itself: every fetch goes to the account origin', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/api/auth/providers')) return json(200, { providers: [{ name: 'nous' }] });
    if (String(url).endsWith('/auth/native/token')) return json(200, tokens(1));
    return json(200, { user_id: 'u1', display_name: 'Ada', email: 'a@x.io', provider: 'nous' });
  };
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  const account = createHermesAccount({
    store: createAccountStore({ storageArea: memoryArea() }), fetchImpl, now: () => 0, webRequestApi,
    random: () => 0.1,
    openWindow: async (url) => {
      const redirect = new URL(url).searchParams.get('redirect_uri');
      const state = new URL(url).searchParams.get('state');
      queueMicrotask(() => webRequestApi.onBeforeRequest.fire({ url: `${redirect}?code=c1&state=${state}` }));
      return { close: async () => {}, closed: new Promise(() => {}) };
    },
  });
  const result = await account.signIn({ origin: 'https://hermes.example.com/dash', connectionKey: 'remote-api|https://hermes.example.com' });
  assert.equal(result.ok, true);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.equal(new URL(url).origin, ORIGIN, url);
  assert.ok(!urls.some((url) => url.includes('127.0.0.1')));
});

// ---- Sign-in, exchange, storage ---------------------------------------------------------------------------------

function harness({ responses = {}, now = () => 0, storageArea = memoryArea(), openWindow = null, webRequestApi = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined });
    const answer = responses[path];
    const next = typeof answer === 'function' ? await answer(calls.at(-1)) : answer;
    return next || json(404, {});
  };
  const store = createAccountStore({ storageArea, now: () => 1 });
  const account = createHermesAccount({ store, fetchImpl, now, openWindow, webRequestApi, random: () => 0.25 });
  return { calls, store, account, storageArea };
}

test('signIn runs authorize -> loopback code -> token exchange, stores the tokens per origin, and reads the identity', async () => {
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  let authorizeUrl = '';
  const { account, store, calls, storageArea } = harness({
    webRequestApi,
    responses: {
      '/api/auth/providers': json(200, { providers: [{ name: 'nous', display_name: 'Nous' }] }),
      '/auth/native/token': json(200, tokens(1)),
      '/api/auth/me': json(200, { user_id: 'u1', email: 'ada@example.com', display_name: 'Ada', provider: 'nous' }),
    },
    openWindow: async (url) => {
      authorizeUrl = url;
      const params = new URL(url).searchParams;
      queueMicrotask(() => webRequestApi.onBeforeRequest.fire({ url: `${params.get('redirect_uri')}?code=gw-code&state=${params.get('state')}` }));
      return { close: async () => { calls.push({ path: 'window-closed' }); }, closed: new Promise(() => {}) };
    },
  });
  const result = await account.signIn({ origin: ORIGIN, connectionKey: 'remote-dashboard|https://hermes.example.com' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.session, { origin: ORIGIN, provider: 'nous', userId: 'u1', email: 'ada@example.com', displayName: 'Ada', expiresAt: 10_001 });
  assert.ok(!JSON.stringify(result).includes('at-1'));
  assert.equal(new URL(authorizeUrl).searchParams.get('provider'), 'nous');
  const exchange = calls.find((call) => call.path === '/auth/native/token');
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.body.code, 'gw-code');
  assert.match(exchange.body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(calls.findIndex((c) => c.path === 'window-closed') < calls.findIndex((c) => c.path === '/auth/native/token'), 'the window closes before the exchange');
  const stored = await store.get(ORIGIN);
  assert.equal(stored.accessToken, 'at-1');
  assert.equal(stored.refreshToken, 'rt-1');
  assert.equal(stored.connectionKey, 'remote-dashboard|https://hermes.example.com');
  assert.ok(storageArea.data[ACCOUNT_STORAGE_KEY][ORIGIN].refreshToken);
  // /api/auth/me was asked with the bearer, no cookie
  assert.equal(calls.find((call) => call.path === '/api/auth/me').headers.Authorization, 'Bearer at-1');
});

test('with several providers the authorize URL leaves the choice to the gateway', async () => {
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  let authorizeUrl = '';
  const { account } = harness({
    webRequestApi,
    responses: { '/api/auth/providers': json(200, { providers: [{ name: 'nous' }, { name: 'basic' }] }), '/auth/native/token': json(200, tokens(1)) },
    openWindow: async (url) => {
      authorizeUrl = url;
      const params = new URL(url).searchParams;
      queueMicrotask(() => webRequestApi.onBeforeRequest.fire({ url: `${params.get('redirect_uri')}?code=c&state=${params.get('state')}` }));
      return { close: async () => {} };
    },
  });
  assert.equal((await account.signIn({ origin: ORIGIN })).ok, true);
  assert.equal(new URL(authorizeUrl).searchParams.get('provider'), '');
});

test('a password provider still ends on the loopback redirect: the /login form hands the redirect to the page script', async () => {
  // /auth/native/authorize 302s to /login for a password provider and /auth/password-login answers
  // { ok, next: <the loopback redirect with code and state> }, which the login page assigns to location.
  // From here that is one more navigation to the same redirect, seen the same way.
  const webRequestApi = { onBeforeRequest: fakeEvent() };
  const { account } = harness({
    webRequestApi,
    responses: { '/api/auth/providers': json(200, { providers: [{ name: 'basic' }] }), '/auth/native/token': json(200, tokens(2, { provider: 'basic' })) },
    openWindow: async (url) => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('provider'), 'basic');
      queueMicrotask(() => {
        webRequestApi.onBeforeRequest.fire({ url: `${ORIGIN}/login` });
        webRequestApi.onBeforeRequest.fire({ url: `${params.get('redirect_uri')}?code=pw&state=${params.get('state')}` });
      });
      return { close: async () => {} };
    },
  });
  const result = await account.signIn({ origin: ORIGIN });
  assert.equal(result.ok, true);
  assert.equal(result.session.provider, 'basic');
});

test('signIn reports a state mismatch, a closed window, a rejected exchange and an unreachable gateway', async () => {
  const run = async (opener, token) => {
    const webRequestApi = { onBeforeRequest: fakeEvent() };
    const { account, store } = harness({
      webRequestApi,
      responses: { '/api/auth/providers': json(200, { providers: [{ name: 'nous' }] }), '/auth/native/token': token },
      openWindow: (url) => opener(url, webRequestApi),
    });
    return { result: await account.signIn({ origin: ORIGIN }), store };
  };
  const mismatch = await run(async (url, api) => {
    queueMicrotask(() => api.onBeforeRequest.fire({ url: `${new URL(url).searchParams.get('redirect_uri')}?code=c&state=forged` }));
    return { close: async () => {} };
  }, json(200, tokens(1)));
  assert.deepEqual(mismatch.result, { ok: false, reason: ACCOUNT_REASONS.STATE_MISMATCH });
  assert.equal(await mismatch.store.get(ORIGIN), null);

  const closedByUser = await run(async () => ({ close: async () => {}, closed: Promise.resolve(true) }), json(200, tokens(1)));
  assert.deepEqual(closedByUser.result, { ok: false, reason: ACCOUNT_REASONS.CANCELLED });

  const accept = async (url, api) => {
    const params = new URL(url).searchParams;
    queueMicrotask(() => api.onBeforeRequest.fire({ url: `${params.get('redirect_uri')}?code=c&state=${params.get('state')}` }));
    return { close: async () => {} };
  };
  const rejected = await run(accept, json(400, { detail: 'Invalid or expired authorization code.' }));
  assert.deepEqual(rejected.result, { ok: false, reason: ACCOUNT_REASONS.EXCHANGE_REJECTED, status: 400 });
  assert.equal(await rejected.store.get(ORIGIN), null);
  const down = await run(accept, json(503, {}));
  assert.deepEqual(down.result, { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE });
});

test('only one sign-in runs at a time, and a non-account origin is refused', async () => {
  let release = () => {};
  const { account } = harness({
    webRequestApi: { onBeforeRequest: fakeEvent() },
    responses: { '/api/auth/providers': json(200, { providers: [] }) },
    openWindow: async () => ({ close: async () => {}, closed: new Promise((resolve) => { release = () => resolve(true); }) }),
  });
  const first = account.signIn({ origin: ORIGIN });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await account.signIn({ origin: ORIGIN }), { ok: false, reason: ACCOUNT_REASONS.BUSY });
  release();
  assert.equal((await first).reason, ACCOUNT_REASONS.CANCELLED);
  assert.deepEqual(await account.signIn({ origin: 'http://192.168.0.2:9119' }), { ok: false, reason: ACCOUNT_REASONS.NO_ORIGIN });
});

// ---- Refresh --------------------------------------------------------------------------------------------------

async function signedIn(over = {}) {
  const h = harness(over);
  await h.store.save(new AccountSession({ origin: ORIGIN, connectionKey: 'k', accessToken: 'at-0', refreshToken: 'rt-0', expiresAt: 100, provider: 'nous', userId: 'u1' }));
  return h;
}

test('refresh is single flight and rotates both tokens once', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await signedIn({
    now: () => 200_000, // past expiry
    responses: { '/auth/native/refresh': async () => { await gate; return json(200, tokens(1, { expires_at: 9_999_999 })); } },
  });
  const calls = [h.account.accessToken(ORIGIN), h.account.accessToken(ORIGIN), h.account.accessToken(ORIGIN)];
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.token), ['at-1', 'at-1', 'at-1']);
  assert.equal(h.calls.filter((c) => c.path === '/auth/native/refresh').length, 1);
  assert.deepEqual(h.calls.find((c) => c.path === '/auth/native/refresh').body, { refresh_token: 'rt-0', provider: 'nous' });
  assert.equal((await h.store.get(ORIGIN)).refreshToken, 'rt-1');
});

test('a fresh token is used as it is, and one within a minute of expiry is refreshed first', async () => {
  const fresh = await signedIn({ now: () => 0 });
  assert.equal((await fresh.account.accessToken(ORIGIN)).token, 'at-0');
  assert.equal(fresh.calls.length, 0);
  const soon = await signedIn({ now: () => 50_000, responses: { '/auth/native/refresh': json(200, tokens(1, { expires_at: 9_999_999 })) } });
  assert.equal((await soon.account.accessToken(ORIGIN)).token, 'at-1');
});

test('a refresh 401 session_expired clears the tokens; a 503 or a network error keeps them', async () => {
  const dead = await signedIn({ now: () => 200_000, responses: { '/auth/native/refresh': json(401, { error: 'session_expired' }) } });
  assert.deepEqual(await dead.account.accessToken(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.EXPIRED });
  assert.equal(await dead.store.get(ORIGIN), null);
  assert.deepEqual(await dead.account.accessToken(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.SIGNED_OUT });

  const down = await signedIn({ now: () => 200_000, responses: { '/auth/native/refresh': json(503, {}) } });
  assert.deepEqual(await down.account.accessToken(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE });
  assert.equal((await down.store.get(ORIGIN)).refreshToken, 'rt-0');
});

// ---- ws-ticket ------------------------------------------------------------------------------------------------

test('the ws ticket is minted with the bearer and returned only to the caller', async () => {
  const h = await signedIn({ responses: { '/api/auth/ws-ticket': json(200, { ticket: 'tk_abc-123', ttl_seconds: 30 }) } });
  const minted = await h.account.mintWsTicket(ORIGIN);
  assert.deepEqual(minted, { ok: true, ticket: 'tk_abc-123', ttlSeconds: 30, principal: { user_id: 'u1', provider: 'nous', org_id: '' } });
  const call = h.calls.find((c) => c.path === '/api/auth/ws-ticket');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer at-0');
});

test('a 401 on ws-ticket refreshes once, even for a token the clock thinks is good, and retries once', async () => {
  let ticketCalls = 0;
  const h = await signedIn({
    now: () => 0,
    responses: {
      '/api/auth/ws-ticket': ({ headers }) => { ticketCalls += 1; return headers.Authorization === 'Bearer at-1' ? json(200, { ticket: 'fresh', ttl_seconds: 30 }) : json(401, { error: 'session_expired' }); },
      '/auth/native/refresh': json(200, tokens(1, { expires_at: 9_999 })),
    },
  });
  const minted = await h.account.mintWsTicket(ORIGIN);
  assert.equal(minted.ok, true);
  assert.equal(minted.ticket, 'fresh');
  assert.equal(ticketCalls, 2);
  assert.equal(h.calls.filter((c) => c.path === '/auth/native/refresh').length, 1);
});

test('ws-ticket: refresh dead means sign in again; 503 or a network error means try later and keep the sign-in', async () => {
  const dead = await signedIn({ responses: { '/api/auth/ws-ticket': json(401, {}), '/auth/native/refresh': json(401, { error: 'session_expired' }) } });
  assert.deepEqual(await dead.account.mintWsTicket(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.EXPIRED });
  assert.equal(await dead.store.get(ORIGIN), null);
  const down = await signedIn({ responses: { '/api/auth/ws-ticket': json(503, {}) } });
  assert.deepEqual(await down.account.mintWsTicket(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE });
  assert.ok(await down.store.get(ORIGIN));
  const stillRefused = await signedIn({ responses: { '/api/auth/ws-ticket': json(401, {}), '/auth/native/refresh': json(200, tokens(1, { expires_at: 9_999 })) } });
  assert.deepEqual(await stillRefused.account.mintWsTicket(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.UNAVAILABLE });
  assert.ok(await stillRefused.store.get(ORIGIN));
  const none = harness({});
  assert.deepEqual(await none.account.mintWsTicket(ORIGIN), { ok: false, reason: ACCOUNT_REASONS.SIGNED_OUT });
  const badTicket = await signedIn({ responses: { '/api/auth/ws-ticket': json(200, { ticket: 'has space' }) } });
  assert.equal((await badTicket.account.mintWsTicket(ORIGIN)).reason, ACCOUNT_REASONS.BAD_RESPONSE);
});

test('the dial offers the ticket in the WebSocket subprotocol only, and a retry mints a new one the same way', async () => {
  const attempts = [];
  let minted = 0;
  const mint = async () => ({ ok: true, ticket: `t${++minted}`, principal: { user_id: 'u1', provider: 'nous', org_id: '' } });
  const connect = async (endpoint, protocols) => {
    attempts.push({ endpoint, protocols });
    if (attempts.length === 1) throw new Error('WebSocket closed before gateway.ready and open');
  };
  const result = await dialWithAccountTicket({ connect, mint, endpoint: 'wss://hermes.example.com/api/ws', protocolsFor: gatewayWebSocketProtocols });
  assert.equal(result.ok, true);
  assert.deepEqual(attempts, [
    { endpoint: 'wss://hermes.example.com/api/ws', protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1'] },
    { endpoint: 'wss://hermes.example.com/api/ws', protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t2'] },
  ]);
  for (const attempt of attempts) {
    assert.ok(!attempt.endpoint.includes('?'), 'no ticket in the URL');
    assert.ok(!attempt.endpoint.includes('ticket'));
  }
  // another failure is not retried
  await assert.rejects(() => dialWithAccountTicket({ connect: async () => { throw new Error('refused'); }, mint, endpoint: 'wss://x/api/ws', protocolsFor: gatewayWebSocketProtocols }), /refused/);
  // a mint that fails is a reason, not a throw
  assert.deepEqual(await dialWithAccountTicket({ connect, mint: async () => ({ ok: false, reason: ACCOUNT_REASONS.EXPIRED }), endpoint: 'wss://x/api/ws', protocolsFor: gatewayWebSocketProtocols }), { ok: false, reason: ACCOUNT_REASONS.EXPIRED });
});

// ---- Store, redaction, sign-out -----------------------------------------------------------------------------------

test('a session redacts its tokens in toString, toJSON, util.inspect, string templates and summary', async () => {
  const session = new AccountSession({ origin: ORIGIN, accessToken: 'SECRET-ACCESS', refreshToken: 'SECRET-REFRESH', expiresAt: 5, provider: 'nous', userId: 'u1' });
  for (const text of [String(session), `${session}`, JSON.stringify(session), inspect(session, { depth: 5 }), JSON.stringify(session.summary()), JSON.stringify({ session })]) {
    assert.ok(!text.includes('SECRET-ACCESS'), text);
    assert.ok(!text.includes('SECRET-REFRESH'), text);
  }
  assert.equal(session.accessToken, 'SECRET-ACCESS');
});

test('sign-out forgets the tokens for that origin only, and is local', async () => {
  const h = await signedIn({});
  await h.store.save(new AccountSession({ origin: 'https://other.example.com', accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  assert.equal(await h.account.signOut(ORIGIN), true);
  assert.equal(await h.store.get(ORIGIN), null);
  assert.ok(await h.store.get('https://other.example.com'));
  assert.equal(h.calls.length, 0, 'sign-out makes no request');
  assert.deepEqual(await h.account.status(ORIGIN), { signedIn: false });
  assert.equal(await h.account.signOut(ORIGIN), false);
});

test('a change of the connection clears the sign-ins bound to the old one', async () => {
  const h = harness({});
  await h.store.save(new AccountSession({ origin: ORIGIN, connectionKey: accountConnectionKey({ gatewayMode: 'remote-dashboard', gatewayUrl: ORIGIN }), accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  await h.store.save(new AccountSession({ origin: 'http://127.0.0.1:9120', connectionKey: accountConnectionKey({ gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642' }), accessToken: 'a2', refreshToken: 'r2', expiresAt: 1 }));
  const same = await h.store.clearUnlessConnection(accountConnectionKey({ gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642/v1' }));
  assert.deepEqual(same, [ORIGIN]);
  assert.equal(await h.store.get(ORIGIN), null);
  assert.ok(await h.store.get('http://127.0.0.1:9120'));
  assert.deepEqual(await h.store.clearUnlessConnection('remote-api|https://elsewhere'), ['http://127.0.0.1:9120']);
});

test('the store survives a reload (storage.local), ignores junk records, and falls back to memory when storage throws', async () => {
  const storageArea = memoryArea();
  const a = createAccountStore({ storageArea });
  await a.save(new AccountSession({ origin: ORIGIN, accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  assert.equal((await createAccountStore({ storageArea }).get(ORIGIN)).refreshToken, 'r');
  storageArea.data[ACCOUNT_STORAGE_KEY]['http://evil.example.com'] = { origin: 'http://evil.example.com', accessToken: 'x', refreshToken: 'y' };
  storageArea.data[ACCOUNT_STORAGE_KEY].junk = 'nope';
  assert.deepEqual((await createAccountStore({ storageArea }).list()).map((s) => s.origin), [ORIGIN]);
  const broken = createAccountStore({ storageArea: { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); } } });
  await broken.save(new AccountSession({ origin: ORIGIN, accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  assert.equal((await broken.get(ORIGIN)).refreshToken, 'r');
  assert.equal(await a.save({ origin: ORIGIN, accessToken: 'a', refreshToken: '' }), false);
});

test('onChange reports sign-in, refresh, expiry and sign-out without any token', async () => {
  const events = [];
  const store = createAccountStore({ storageArea: memoryArea() });
  await store.save(new AccountSession({ origin: ORIGIN, accessToken: 'at-0', refreshToken: 'rt-0', expiresAt: 1, provider: 'nous' }));
  const account = createHermesAccount({
    store, now: () => 100_000, onChange: (event) => events.push(event),
    fetchImpl: async () => json(401, { error: 'session_expired' }),
  });
  await account.accessToken(ORIGIN);
  assert.deepEqual(events, [{ type: 'expired', origin: ORIGIN }]);
  await store.save(new AccountSession({ origin: ORIGIN, accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
  await account.signOut(ORIGIN);
  assert.deepEqual(events.at(-1), { type: 'signed-out', origin: ORIGIN });
  assert.ok(!JSON.stringify(events).includes('rt-0'));
});

// ---- Support probe ----------------------------------------------------------------------------------------------

test('probeAccountSupport offers a sign-in only where the gateway is gated and advertises the native flow', async () => {
  const status = (payload, code = 200) => async () => json(code, payload);
  assert.deepEqual(await probeAccountSupport(ORIGIN, { fetchImpl: status({ auth_required: true, auth_providers: ['nous'], auth_flows: ['cookie', 'native_pkce'] }) }), { available: true, providers: ['nous'] });
  // the user's gateway: Webapp on 127.0.0.1:9120, ungated, nous configured
  assert.deepEqual(await probeAccountSupport('http://127.0.0.1:9120', { fetchImpl: status({ auth_required: false, auth_providers: ['nous'], auth_flows: [], nous_session_valid: 'valid' }) }), { available: false, reason: ACCOUNT_REASONS.NOT_GATED });
  assert.deepEqual(await probeAccountSupport(ORIGIN, { fetchImpl: status({ auth_required: true, auth_providers: ['nous'], auth_flows: ['cookie'] }) }), { available: false, reason: ACCOUNT_REASONS.NO_NATIVE_FLOW });
  assert.deepEqual(await probeAccountSupport(ORIGIN, { fetchImpl: status({}, 500) }), { available: false, reason: ACCOUNT_REASONS.UNREACHABLE });
  assert.deepEqual(await probeAccountSupport(ORIGIN, { fetchImpl: async () => { throw new TypeError('x'); } }), { available: false, reason: ACCOUNT_REASONS.UNREACHABLE });
  assert.deepEqual(await probeAccountSupport('http://10.0.0.2', { fetchImpl: status({}) }), { available: false, reason: ACCOUNT_REASONS.NO_ORIGIN });
});
