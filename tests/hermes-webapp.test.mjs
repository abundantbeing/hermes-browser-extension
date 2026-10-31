import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEBAPP_DEFAULT_ADDRESS,
  WEBAPP_DOCS_URL,
  WEBAPP_SETUP_COMMANDS,
  WEBAPP_SIGN_IN_HINT_STORAGE_KEY,
  findOpenWebappTab,
  isLocalGatewayConnection,
  openHermesWebapp,
  probeWebapp,
  resolveWebappTarget,
  takeWebappSignInHint,
  validateWebappAddress,
  webappOriginPattern,
} from '../extension/lib/hermes-webapp.mjs';
import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';

const local = { connectionMode: 'local', gatewayUrl: 'http://127.0.0.1:8642' };
const remote = { connectionMode: 'remote', gatewayUrl: 'https://hermes.example.com' };

// --- address resolution and validation ---------------------------------------------------------

test('a plain http or https address is accepted and normalised to an origin and a path prefix', () => {
  assert.deepEqual(validateWebappAddress('http://127.0.0.1:9120'), {
    ok: true, origin: 'http://127.0.0.1:9120', basePath: '', baseUrl: 'http://127.0.0.1:9120',
  });
  assert.equal(validateWebappAddress('  https://hermes.example.com/  ').baseUrl, 'https://hermes.example.com');
  assert.equal(validateWebappAddress('https://hermes.example.com/hermes/').baseUrl, 'https://hermes.example.com/hermes');
  assert.equal(validateWebappAddress('http://[::1]:9120').origin, 'http://[::1]:9120');
  assert.equal(validateWebappAddress('HTTPS://Hermes.Example.com').origin, 'https://hermes.example.com');
});

test('addresses with the wrong scheme, credentials, queries, fragments or path tricks are refused', () => {
  const refused = [
    '', '   ', 'hermes.example.com', 'ftp://hermes.example.com', 'javascript:alert(1)', 'file:///etc/passwd',
    'chrome-extension://abc/app.html', 'data:text/html,hi', '//hermes.example.com', 'https://',
    'https://user@hermes.example.com', 'https://user:secret@hermes.example.com', 'https://@hermes.example.com',
    'http://127.0.0.1:9120?token=abc', 'http://127.0.0.1:9120/?profile=x', 'http://127.0.0.1:9120#token',
    'https://hermes.example.com/a/../b', 'https://hermes.example.com/./a', 'https://hermes.example.com/%2e%2e/a',
    'https://hermes.example.com/a%2Fb', 'https://hermes.example.com/a%5cb', 'https://hermes.example.com/a%00',
    'https://hermes.example.com//a', 'https://hermes.example.com/a//b', 'https://hermes.example.com\\a',
    'https://hermes.example.com/a b', 'https://hermes.example.com/\u0000', 'https://hermes.example.com:99999',
    `https://hermes.example.com/${'a'.repeat(3000)}`, 42, null, undefined, {},
  ];
  for (const value of refused) {
    assert.equal(validateWebappAddress(value).ok, false, `must refuse ${JSON.stringify(value)}`);
  }
});

test('a local connection with no setting uses the default loopback address', () => {
  const target = resolveWebappTarget({ ...local, hermesWebAddress: '' });
  assert.equal(target.ok, true);
  assert.equal(target.source, 'local-default');
  assert.equal(target.baseUrl, WEBAPP_DEFAULT_ADDRESS);
  assert.equal(target.url, 'http://127.0.0.1:9120/');
  assert.equal(target.loopback, true);
  // Settings saved by older builds have neither a mode nor the new field.
  assert.equal(resolveWebappTarget({}).ok, true);
  assert.equal(resolveWebappTarget({ gatewayMode: 'local-api' }).baseUrl, WEBAPP_DEFAULT_ADDRESS);
});

test('a remote or cloud connection never guesses an address', () => {
  for (const settings of [
    remote,
    { connectionMode: 'remote', connectionTransport: 'remote-api', gatewayUrl: 'http://192.168.1.20:8642' },
    { connectionMode: 'cloud', gatewayUrl: '' },
    { gatewayMode: 'remote-dashboard', gatewayUrl: 'https://hermes.example.com' },
    // Local mode pointed at a non-loopback gateway is not "this computer".
    { connectionMode: 'local', gatewayUrl: 'http://192.168.1.20:8642' },
  ]) {
    assert.deepEqual(resolveWebappTarget(settings), { ok: false, reason: 'needs-address' }, JSON.stringify(settings));
    assert.equal(isLocalGatewayConnection(settings), false);
  }
});

test('the setting wins on any connection, and an invalid setting is reported, not replaced by a guess', () => {
  const remoteTarget = resolveWebappTarget({ ...remote, hermesWebAddress: 'https://web.example.com/hermes' });
  assert.equal(remoteTarget.ok, true);
  assert.equal(remoteTarget.source, 'setting');
  assert.equal(remoteTarget.url, 'https://web.example.com/hermes/');
  assert.equal(remoteTarget.loopback, false);

  const localTarget = resolveWebappTarget({ ...local, hermesWebAddress: 'http://localhost:9300' });
  assert.equal(localTarget.baseUrl, 'http://localhost:9300');
  assert.equal(localTarget.loopback, true);

  for (const settings of [local, remote]) {
    assert.deepEqual(resolveWebappTarget({ ...settings, hermesWebAddress: 'https://user:pw@web.example.com' }), { ok: false, reason: 'invalid-address' });
    assert.deepEqual(resolveWebappTarget({ ...settings, hermesWebAddress: 'not a url' }), { ok: false, reason: 'invalid-address' });
  }
});

test('the active profile is added as ?profile=, and only a safe non-default name', () => {
  assert.equal(resolveWebappTarget({ ...local, activeProfile: 'work' }).url, 'http://127.0.0.1:9120/?profile=work');
  assert.equal(resolveWebappTarget({ ...remote, hermesWebAddress: 'https://web.example.com/hermes', activeProfile: 'team.a-1' }).url,
    'https://web.example.com/hermes/?profile=team.a-1');
  for (const profile of ['', '  ', 'default', 'Default', 'a b', 'x&token=1', 'x#y', '../x', '-x', 'a'.repeat(65), 7, null]) {
    assert.equal(resolveWebappTarget({ ...local, activeProfile: profile }).url, 'http://127.0.0.1:9120/', `profile ${JSON.stringify(profile)}`);
  }
});

test('the opened address never carries a credential: the only query is the profile', () => {
  const secrets = {
    apiKey: 'sk-live-0123456789', agentToken: 'agent-secret', remoteDashboardSession: { token: 'dash-secret', ticket: 't' },
    trustedDashboardOrigin: 'http://127.0.0.1:9119', tokenSource: 'pairing',
  };
  for (const settings of [{ ...local, ...secrets, activeProfile: 'work' }, { ...remote, ...secrets, hermesWebAddress: 'https://web.example.com' }]) {
    const target = resolveWebappTarget(settings);
    const url = new URL(target.url);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    assert.deepEqual([...url.searchParams.keys()].filter((key) => key !== 'profile'), []);
    for (const secret of ['sk-live-0123456789', 'agent-secret', 'dash-secret']) assert.ok(!target.url.includes(secret));
  }
  assert.equal(webappOriginPattern(resolveWebappTarget({ ...local, hermesWebAddress: 'http://127.0.0.1:9300/x' })), 'http://127.0.0.1/*');
  assert.equal(webappOriginPattern(resolveWebappTarget({ ...remote, hermesWebAddress: 'https://web.example.com:8443' })), 'https://web.example.com/*');
});

// --- reuse an already open tab -----------------------------------------------------------------

const tab = (id, url, extra = {}) => ({ id, url, windowId: 1, active: false, ...extra });

test('a tab already on the Webapp is found by origin, path prefix and profile', async () => {
  const target = resolveWebappTarget({ ...local, activeProfile: 'work' });
  const tabs = [
    tab(1, 'http://127.0.0.1:9121/'),
    tab(2, 'https://127.0.0.1:9120/'),
    tab(3, 'http://127.0.0.1:9120/', { active: true }),
    tab(4, 'http://127.0.0.1:9120/#/session/abc?profile=other'),
    tab(5, 'http://127.0.0.1:9120/?profile=work', { lastAccessed: 5 }),
    tab(6, 'about:blank'),
    { id: 7 },
    tab(-1, 'http://127.0.0.1:9120/'),
  ];
  const selectedProfile = async (entry) => entry.id === 5 ? 'work' : 'default';
  assert.equal((await findOpenWebappTab({ query: async () => tabs }, target, { selectedProfile })).id, 5, 'the tab on the right profile wins');
  assert.equal(await findOpenWebappTab({ query: async () => tabs.filter((entry) => entry.id !== 5) }, target, { selectedProfile }), null, 'a different profile is not reused');
  assert.equal(await findOpenWebappTab({ query: async () => [tabs[0], tabs[1], tabs[5]] }, target), null);
  assert.equal(await findOpenWebappTab({ query: async () => { throw new Error('x'); } }, target), null);
  assert.equal(await findOpenWebappTab({}, target), null);

  const prefixed = resolveWebappTarget({ ...remote, hermesWebAddress: 'https://web.example.com/hermes' });
  const prefixTabs = [tab(1, 'https://web.example.com/'), tab(2, 'https://web.example.com/hermesx'), tab(3, 'https://web.example.com/hermes/#/x')];
  assert.equal((await findOpenWebappTab({ query: async () => prefixTabs }, prefixed, { selectedProfile })).id, 3);
});

function fakeBrowser({ tabs = [], fetchImpl, grant = true, storage = {} } = {}) {
  const calls = { create: [], update: [], windows: [], request: [], contains: [], fetch: [] };
  const store = { ...storage };
  return {
    calls,
    store,
    selectedProfile: async () => 'default',
    tabsApi: {
      query: async () => tabs,
      create: async (info) => { calls.create.push(info); return { id: 99, ...info }; },
      update: async (id, info) => { calls.update.push([id, info]); return { id }; },
    },
    windowsApi: { update: async (id, info) => { calls.windows.push([id, info]); } },
    permissionsApi: {
      request: async (req) => { calls.request.push(req); return grant; },
      contains: async (req) => { calls.contains.push(req); return grant; },
    },
    storageArea: {
      get: async (key) => ({ [key]: store[key] }),
      set: async (patch) => { Object.assign(store, patch); },
    },
    fetchImpl: async (url, init) => {
      calls.fetch.push([url, init]);
      return fetchImpl ? fetchImpl(url, init) : { status: 200, type: 'basic' };
    },
  };
}

test('with a tab already open the button focuses it and neither probes nor opens another', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, 'http://127.0.0.1:9120/', { windowId: 3 })] });
  const result = await openHermesWebapp({ settings: local, ...browser });
  assert.deepEqual({ status: result.status, tabId: result.tabId }, { status: 'focused', tabId: 4 });
  assert.deepEqual(browser.calls.update, [[4, { active: true }]]);
  assert.deepEqual(browser.calls.windows, [[3, { focused: true }]]);
  assert.deepEqual(browser.calls.create, []);
  assert.deepEqual(browser.calls.fetch, []);
});

test('a focus that fails because the tab just closed falls back to opening a fresh one', async () => {
  const browser = fakeBrowser({ tabs: [tab(4, 'http://127.0.0.1:9120/')] });
  browser.tabsApi.update = async () => { throw new Error('No tab with id: 4'); };
  const result = await openHermesWebapp({ settings: local, ...browser });
  assert.equal(result.status, 'opened');
  assert.equal(browser.calls.create.length, 1);
});

// --- opening a new tab, and the unreachable case -----------------------------------------------

test('when something answers, Hermes Web opens in a new active tab at the profile address', async () => {
  const browser = fakeBrowser();
  const result = await openHermesWebapp({ settings: { ...local, activeProfile: 'work' }, ...browser });
  assert.equal(result.status, 'opened');
  assert.deepEqual(browser.calls.create, [{ url: 'http://127.0.0.1:9120/?profile=work', active: true }]);
  assert.deepEqual(browser.calls.request, [{ origins: ['http://127.0.0.1/*'] }], 'permission is asked first, for the one origin');
});

test('the reachability check sends no credentials, cookies, referrer or headers', async () => {
  const browser = fakeBrowser();
  await openHermesWebapp({
    settings: { ...local, apiKey: 'sk-live-0123456789', activeProfile: 'work', remoteDashboardSession: { token: 'dash-secret' } },
    ...browser,
  });
  assert.equal(browser.calls.fetch.length, 1);
  const [url, init] = browser.calls.fetch[0];
  assert.equal(url, 'http://127.0.0.1:9120/');
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers, undefined);
  assert.equal(init.body, undefined);
  assert.ok(!JSON.stringify([url, init]).includes('sk-live'));
  assert.ok(!JSON.stringify([url, init]).includes('dash-secret'));
});

test('nothing answering, or the wrong kind of answer, is reported as unreachable and opens nothing', async () => {
  const down = fakeBrowser({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(await openHermesWebapp({ settings: local, ...down }), { status: 'unreachable', address: 'http://127.0.0.1:9120' });
  assert.deepEqual(down.calls.create, []);
  assert.equal(down.calls.fetch.length, 2, 'a blocked read is retried once without reading the answer');

  for (const status of [404, 500, 502, 503]) {
    const other = fakeBrowser({ fetchImpl: async () => ({ status, type: 'basic' }) });
    assert.equal((await openHermesWebapp({ settings: local, ...other })).status, 'unreachable', `HTTP ${status}`);
    assert.deepEqual(other.calls.create, []);
  }
  const slow = fakeBrowser({ fetchImpl: async () => { const error = new Error('t'); error.name = 'TimeoutError'; throw error; } });
  assert.equal((await openHermesWebapp({ settings: local, ...slow })).status, 'unreachable');
  assert.equal(slow.calls.fetch.length, 1, 'a timeout is not retried');
});

test('the Webapp counts as reachable on a page, a redirect to sign-in or a sign-in refusal', async () => {
  const target = resolveWebappTarget(local);
  for (const response of [{ status: 200 }, { status: 302 }, { status: 401 }, { status: 403 }, { type: 'opaqueredirect', status: 0 }]) {
    assert.equal((await probeWebapp(target, { fetchImpl: async () => response })).reachable, true, JSON.stringify(response));
  }
  // The browser refused to let the page read the answer: an answer still proves a listener.
  const blocked = async (url, init) => { if (init.mode === 'cors') throw new TypeError('CORS'); return { type: 'opaque', status: 0 }; };
  assert.deepEqual(await probeWebapp(target, { fetchImpl: blocked }), { reachable: true, status: 0, opaque: true });
});

test('connection setups that cannot work are reported before anything is requested or fetched', async () => {
  const noAddress = fakeBrowser();
  assert.deepEqual(await openHermesWebapp({ settings: remote, ...noAddress }), { status: 'needs-address' });
  const invalid = fakeBrowser();
  assert.deepEqual(await openHermesWebapp({ settings: { ...local, hermesWebAddress: 'ftp://x' }, ...invalid }), { status: 'invalid-address' });
  for (const browser of [noAddress, invalid]) {
    assert.deepEqual(browser.calls.request, []);
    assert.deepEqual(browser.calls.fetch, []);
    assert.deepEqual(browser.calls.create, []);
  }
});

test('a declined host permission stops before any request is made', async () => {
  const denied = fakeBrowser({ grant: false });
  assert.deepEqual(await openHermesWebapp({ settings: local, ...denied }), { status: 'permission-denied', address: 'http://127.0.0.1:9120' });
  assert.deepEqual(denied.calls.fetch, []);
  assert.deepEqual(denied.calls.create, []);
});

test('the background worker checks the permission instead of asking, since it has no user gesture', async () => {
  const browser = fakeBrowser();
  const result = await openHermesWebapp({ settings: local, ...browser, permissionMode: 'contains' });
  assert.equal(result.status, 'opened');
  assert.deepEqual(browser.calls.request, []);
  assert.deepEqual(browser.calls.contains, [{ origins: ['http://127.0.0.1/*'] }]);
  const denied = fakeBrowser({ grant: false });
  assert.equal((await openHermesWebapp({ settings: local, ...denied, permissionMode: 'contains' })).status, 'permission-denied');
});

test('a failure to create the tab is reported, not thrown', async () => {
  const browser = fakeBrowser();
  browser.tabsApi.create = async () => { throw new Error('tabs.create refused'); };
  const result = await openHermesWebapp({ settings: local, ...browser });
  assert.equal(result.status, 'open-failed');
  assert.equal(result.reason, 'tabs.create refused');
});

// --- the one-time sign-in hint -----------------------------------------------------------------

test('the sign-in hint is returned once per kind, then never again', async () => {
  const browser = fakeBrowser();
  const first = await openHermesWebapp({ settings: local, ...browser });
  assert.equal(first.hint, 'local');
  assert.deepEqual(browser.store[WEBAPP_SIGN_IN_HINT_STORAGE_KEY], { local: true });
  assert.equal((await openHermesWebapp({ settings: local, ...browser })).hint, '');

  const remoteTarget = { ...remote, hermesWebAddress: 'https://web.example.com' };
  assert.equal((await openHermesWebapp({ settings: remoteTarget, ...browser })).hint, 'account', 'a behind-sign-in address gets its own hint');
  assert.equal((await openHermesWebapp({ settings: remoteTarget, ...browser })).hint, '');
  assert.deepEqual(browser.store[WEBAPP_SIGN_IN_HINT_STORAGE_KEY], { local: true, account: true });
});

test('an unreadable store only means the hint can repeat', async () => {
  const target = resolveWebappTarget(local);
  assert.equal(await takeWebappSignInHint({ get: async () => { throw new Error('x'); }, set: async () => {} }, target), 'local');
  assert.equal(await takeWebappSignInHint(undefined, target), 'local');
});

// --- what the user is told to run --------------------------------------------------------------

test('the setup commands and the docs link are the documented ones', () => {
  assert.deepEqual([...WEBAPP_SETUP_COMMANDS], ['hermes config set webapp.enabled true', 'hermes gateway restart', 'hermes webapp']);
  assert.equal(WEBAPP_DOCS_URL, 'https://hermes-agent.nousresearch.com/docs/user-guide/desktop#use-the-desktop-workspace-from-a-browser');
});

// --- locale coverage ---------------------------------------------------------------------------

const WEBAPP_KEYS = [
  'webapp.open_title', 'webapp.opened_title', 'webapp.open_failed', 'webapp.dialog_title', 'webapp.dialog_body',
  'webapp.reason_unreachable', 'webapp.reason_permission', 'webapp.reason_needs_address', 'webapp.reason_invalid_address',
  'webapp.copy_command', 'webapp.docs_link', 'webapp.try_again', 'webapp.hint_local', 'webapp.hint_account',
  'webapp.setting_label', 'webapp.setting_hint', 'webapp.assist_detail',
  'webapp.opening_title', 'webapp.opening_detail', 'webapp.opening_slow', 'webapp.opening_show',
];

test('every Hermes Web string exists in all 21 locales, translated, with its protected words intact', async () => {
  assert.equal(SUPPORTED_LOCALES.length, 21);
  const english = await loadLocaleMessages('en');
  for (const key of WEBAPP_KEYS) assert.equal(typeof english[key], 'string', `en is missing ${key}`);
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadLocaleMessages(locale.id);
    for (const key of WEBAPP_KEYS) {
      assert.equal(typeof catalog[key], 'string', `${locale.id} is missing ${key}`);
      assert.ok(catalog[key].trim(), `${locale.id} ${key} is empty`);
      if (locale.id !== 'en') assert.notEqual(catalog[key], english[key], `${locale.id} ${key} is still English`);
      if (english[key].includes('Hermes')) assert.ok(catalog[key].includes('Hermes'), `${locale.id} ${key} lost "Hermes"`);
      if (/https?:\/\/[^\s)]+/.test(english[key])) assert.ok(catalog[key].includes(WEBAPP_DEFAULT_ADDRESS), `${locale.id} ${key} lost the address`);
    }
    // The commands are never translated: the hint names the one to run.
    assert.ok(catalog['webapp.hint_local'].includes('hermes webapp'), `${locale.id} hint_local must name the command`);
    assert.ok(!catalog['webapp.dialog_title'].includes('being worked on'));
  }
});
