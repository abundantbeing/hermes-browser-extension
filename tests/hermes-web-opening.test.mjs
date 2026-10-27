import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HERMES_WEB_OPENING_MESSAGES,
  HERMES_WEB_OPENING_PAGE,
  HERMES_WEB_OPENING_STORAGE_KEY,
  HERMES_WEB_OPENING_TIMEOUT_MS,
  createHermesWebOpener,
  createHermesWebOpening,
  isWebappReachedUrl,
  normalizeOpeningRequest,
} from '../extension/lib/hermes-web-opening.mjs';
import { startOpeningPage } from '../extension/lib/hermes-web-opening-page.mjs';
import { openHermesWebapp } from '../extension/lib/hermes-webapp.mjs';
import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';

const TICKET = 'A'.repeat(43);
const ORIGIN = 'http://127.0.0.1:9120';
const LAUNCH = `${ORIGIN}/webapp/launch#ticket=${TICKET}`;
const EXTENSION_URL = 'chrome-extension://abc/';

// A browser with just the tabs and windows calls the hand-off makes.
function fakeBrowser({ failLaunch = false } = {}) {
  let nextId = 10;
  const tabs = new Map();
  const log = [];
  const tabsApi = {
    async create(options) {
      log.push(['create', options]);
      if (failLaunch && options.active === false) throw new Error('blocked');
      const tab = { id: nextId += 1, windowId: 3, index: tabs.size, status: 'loading', url: options.url, active: options.active };
      tabs.set(tab.id, tab);
      return tab;
    },
    async update(id, options) {
      log.push(['update', id, options]);
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      Object.assign(tabs.get(id), options);
      return tabs.get(id);
    },
    async remove(id) {
      log.push(['remove', id]);
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      tabs.delete(id);
    },
    async get(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      return { ...tabs.get(id) };
    },
  };
  const windowsApi = { async update(id, options) { log.push(['window', id, options]); } };
  const runtimeApi = { id: 'abc', getURL: (path) => `${EXTENSION_URL}${path}` };
  const store = {};
  const storageSession = {
    async get(key) { return { [key]: store[key] }; },
    async set(values) { Object.assign(store, values); },
  };
  return { tabs, log, tabsApi, windowsApi, runtimeApi, storageSession, store };
}

function opening(browser, extra = {}) {
  return createHermesWebOpening({
    tabsApi: browser.tabsApi,
    windowsApi: browser.windowsApi,
    runtimeApi: browser.runtimeApi,
    storageSession: browser.storageSession,
    ...extra,
  });
}

// --- the page that counts as "the Webapp itself" -----------------------------------------------

test('the Webapp counts as reached only on its own origin and not on the hand-off pages', () => {
  const target = { origin: ORIGIN, basePath: '' };
  assert.equal(isWebappReachedUrl(`${ORIGIN}/`, target), true);
  assert.equal(isWebappReachedUrl(`${ORIGIN}/chat?profile=work`, target), true);
  assert.equal(isWebappReachedUrl(`${ORIGIN}/webapp/launch`, target), false);
  assert.equal(isWebappReachedUrl(`${ORIGIN}/webapp/launch#ticket=${TICKET}`, target), false);
  assert.equal(isWebappReachedUrl(`${ORIGIN}/webapp/window`, target), false);
  assert.equal(isWebappReachedUrl(`${ORIGIN}/webapp/window/abc`, target), false);
  assert.equal(isWebappReachedUrl(`${ORIGIN}/webapp/launcher`, target), true);
  assert.equal(isWebappReachedUrl('http://127.0.0.1:9999/', target), false);
  assert.equal(isWebappReachedUrl('https://127.0.0.1:9120/', target), false);
  assert.equal(isWebappReachedUrl('about:blank', target), false);
  assert.equal(isWebappReachedUrl('', target), false);
  assert.equal(isWebappReachedUrl(undefined, target), false);
});

test('a Webapp served under a path prefix is reached only under that prefix', () => {
  const target = { origin: 'https://hermes.example.com', basePath: '/hermes' };
  assert.equal(isWebappReachedUrl('https://hermes.example.com/hermes/', target), true);
  assert.equal(isWebappReachedUrl('https://hermes.example.com/hermes/webapp/launch', target), false);
  assert.equal(isWebappReachedUrl('https://hermes.example.com/other', target), false);
  assert.equal(isWebappReachedUrl('https://hermes.example.com/hermesx', target), false);
});

test('only a launch page on the named origin is accepted as an opening request', () => {
  const good = normalizeOpeningRequest({ url: LAUNCH, origin: ORIGIN });
  assert.deepEqual(good, { url: LAUNCH, origin: ORIGIN, basePath: '' });
  assert.deepEqual(
    normalizeOpeningRequest({ url: 'https://h.example.com/hermes/webapp/launch#ticket=x', origin: 'https://h.example.com', basePath: '/hermes/' }),
    { url: 'https://h.example.com/hermes/webapp/launch#ticket=x', origin: 'https://h.example.com', basePath: '/hermes' },
  );
  for (const request of [
    null,
    {},
    { url: 'javascript:alert(1)', origin: ORIGIN },
    { url: 'chrome://settings/', origin: ORIGIN },
    { url: `${ORIGIN}/somewhere`, origin: ORIGIN },
    { url: LAUNCH, origin: 'http://127.0.0.1:1' },
    { url: `http://u:p@127.0.0.1:9120/webapp/launch#ticket=${TICKET}`, origin: ORIGIN },
    { url: 'https://evil.example/webapp/launch', origin: ORIGIN },
  ]) {
    assert.equal(normalizeOpeningRequest(request), null, JSON.stringify(request));
  }
});

// --- the background worker's hand-off ----------------------------------------------------------

test('start opens the branded page as the visible tab and the launch URL in a background tab beside it', async () => {
  const browser = fakeBrowser();
  const controller = opening(browser);
  const result = await controller.start({ url: LAUNCH, origin: ORIGIN });
  assert.equal(result.ok, true);
  const creates = browser.log.filter(([kind]) => kind === 'create').map(([, options]) => options);
  assert.equal(creates.length, 2);
  // The opening page: visible, and its URL is the bare page. The ticket is nowhere in it.
  assert.deepEqual(creates[0], { url: `${EXTENSION_URL}${HERMES_WEB_OPENING_PAGE}`, active: true });
  assert.ok(!creates[0].url.includes(TICKET) && !creates[0].url.includes('#') && !creates[0].url.includes('?'));
  // The launch tab: background, in the same window, next to the page.
  assert.equal(creates[1].url, LAUNCH);
  assert.equal(creates[1].active, false);
  assert.equal(creates[1].windowId, 3);
  assert.equal(result.tabId, 12);
  assert.equal(result.openingTabId, 11);
  assert.equal(controller.pendingCount(), 1);
});

test('the ticket reaches only the launch tab: not the opening page URL, and not the persisted state', async () => {
  const browser = fakeBrowser();
  const controller = opening(browser);
  await controller.start({ url: LAUNCH, origin: ORIGIN });
  assert.ok(!JSON.stringify(browser.store).includes(TICKET), 'the pending record holds no ticket');
  assert.deepEqual(Object.keys(browser.store), [HERMES_WEB_OPENING_STORAGE_KEY]);
  for (const tab of browser.tabs.values()) {
    if (tab.url.startsWith(EXTENSION_URL)) assert.ok(!tab.url.includes(TICKET));
  }
});

test('a launch tab that is still on the hand-off page changes nothing', async () => {
  const browser = fakeBrowser();
  const controller = opening(browser);
  const { tabId } = await controller.start({ url: LAUNCH, origin: ORIGIN });
  browser.log.length = 0;
  await controller.handleTabUpdated(tabId, { status: 'complete' }, { url: `${ORIGIN}/webapp/launch#ticket=${TICKET}` });
  await controller.handleTabUpdated(tabId, { status: 'loading' }, { url: `${ORIGIN}/` });
  await controller.handleTabUpdated(tabId, { status: 'complete' }, { url: `${ORIGIN}/webapp/window` });
  await controller.handleTabUpdated(999, { status: 'complete' }, { url: `${ORIGIN}/` });
  assert.deepEqual(browser.log, []);
  assert.equal(controller.pendingCount(), 1);
});

test('when the launch tab finishes loading the Webapp it is activated, its window focused, and the page closed', async () => {
  const browser = fakeBrowser();
  const controller = opening(browser);
  const { tabId, openingTabId } = await controller.start({ url: LAUNCH, origin: ORIGIN });
  browser.log.length = 0;
  await controller.handleTabUpdated(tabId, { status: 'complete' }, { url: `${ORIGIN}/` });
  assert.deepEqual(browser.log, [
    ['update', tabId, { active: true }],
    ['window', 3, { focused: true }],
    ['remove', openingTabId],
  ]);
  assert.equal(controller.pendingCount(), 0);
  assert.deepEqual(browser.store[HERMES_WEB_OPENING_STORAGE_KEY], []);
  // The close of the opening page that follows is not mistaken for the person closing it.
  browser.log.length = 0;
  await controller.handleTabRemoved(openingTabId);
  assert.deepEqual(browser.log, []);
});

test('a launch tab that is already on the Webapp by the time it is registered is shown at once', async () => {
  const browser = fakeBrowser();
  const originalCreate = browser.tabsApi.create;
  browser.tabsApi.create = async (options) => {
    const tab = await originalCreate(options);
    if (options.active === false) Object.assign(browser.tabs.get(tab.id), { status: 'complete', url: `${ORIGIN}/` });
    return tab;
  };
  const controller = opening(browser);
  const { tabId, openingTabId } = await controller.start({ url: LAUNCH, origin: ORIGIN });
  assert.ok(browser.log.some(([kind, id]) => kind === 'update' && id === tabId));
  assert.ok(browser.log.some(([kind, id]) => kind === 'remove' && id === openingTabId));
  assert.equal(controller.pendingCount(), 0);
});

test('the opening page asks for its state, and Show it anyway activates the launch tab as it is', async () => {
  const browser = fakeBrowser();
  let clock = 1_000;
  const controller = opening(browser, { now: () => clock });
  const { tabId, openingTabId } = await controller.start({ url: LAUNCH, origin: ORIGIN });
  clock = 6_000;
  const sender = { tab: { id: openingTabId } };
  assert.deepEqual(await controller.handleMessage({ type: HERMES_WEB_OPENING_MESSAGES.state }, sender), {
    ok: true, status: 'waiting', startedAt: 1_000, now: 6_000, timeoutMs: HERMES_WEB_OPENING_TIMEOUT_MS, origin: ORIGIN,
  });
  browser.log.length = 0;
  assert.deepEqual(await controller.handleMessage({ type: HERMES_WEB_OPENING_MESSAGES.show }, sender), { ok: true });
  assert.deepEqual(browser.log, [
    ['update', tabId, { active: true }],
    ['window', 3, { focused: true }],
    ['remove', openingTabId],
  ]);
});

test('a page nobody is opening for reports nothing pending, and Show closes it', async () => {
  const browser = fakeBrowser();
  const controller = opening(browser);
  browser.tabs.set(50, { id: 50, windowId: 3, url: `${EXTENSION_URL}${HERMES_WEB_OPENING_PAGE}` });
  const sender = { tab: { id: 50 } };
  assert.deepEqual(await controller.handleMessage({ type: HERMES_WEB_OPENING_MESSAGES.state }, sender), { ok: true, status: 'none' });
  await controller.handleMessage({ type: HERMES_WEB_OPENING_MESSAGES.show }, sender);
  assert.equal(browser.tabs.has(50), false);
});

test('closing the opening page shows the loading tab; closing the launch tab closes the opening page', async () => {
  const first = fakeBrowser();
  const a = opening(first);
  const startedA = await a.start({ url: LAUNCH, origin: ORIGIN });
  first.log.length = 0;
  await a.handleTabRemoved(startedA.openingTabId);
  assert.deepEqual(first.log, [['update', startedA.tabId, { active: true }], ['window', 3, { focused: true }]]);
  assert.equal(a.pendingCount(), 0);

  const second = fakeBrowser();
  const b = opening(second);
  const startedB = await b.start({ url: LAUNCH, origin: ORIGIN });
  second.log.length = 0;
  await b.handleTabRemoved(startedB.tabId);
  assert.deepEqual(second.log, [['remove', startedB.openingTabId]]);
  assert.equal(b.pendingCount(), 0);
});

test('a failure to open the launch tab closes the opening page and reports it', async () => {
  const browser = fakeBrowser({ failLaunch: true });
  const controller = opening(browser);
  const result = await controller.start({ url: LAUNCH, origin: ORIGIN });
  assert.equal(result.ok, false);
  assert.equal(browser.tabs.size, 0);
  assert.equal(controller.pendingCount(), 0);
});

test('a refused request opens nothing', async () => {
  const browser = fakeBrowser();
  const controller = opening(browser);
  const result = await controller.start({ url: 'https://evil.example/', origin: 'https://evil.example' });
  assert.deepEqual(result, { ok: false, reason: 'invalid-request' });
  assert.deepEqual(browser.log, []);
});

test('a restarted worker keeps watching the launch tab from storage.session', async () => {
  const browser = fakeBrowser();
  const { tabId, openingTabId } = await opening(browser).start({ url: LAUNCH, origin: ORIGIN });
  const restarted = opening(browser);
  assert.equal(restarted.pendingCount(), 0);
  browser.log.length = 0;
  await restarted.handleTabUpdated(tabId, { status: 'complete' }, { url: `${ORIGIN}/` });
  assert.deepEqual(browser.log.map(([kind]) => kind), ['update', 'window', 'remove']);
  assert.equal(browser.log[2][1], openingTabId);
});

test('the opening hand-off works without storage.session and without the windows API', async () => {
  const browser = fakeBrowser();
  const controller = createHermesWebOpening({ tabsApi: browser.tabsApi, runtimeApi: browser.runtimeApi });
  const { tabId, openingTabId } = await controller.start({ url: LAUNCH, origin: ORIGIN });
  browser.log.length = 0;
  await controller.handleTabUpdated(tabId, { status: 'complete' }, { url: `${ORIGIN}/` });
  assert.deepEqual(browser.log, [['update', tabId, { active: true }], ['remove', openingTabId]]);
});

// --- the panel's side and openHermesWebapp -----------------------------------------------------

test('the opener sends the launch target in a message and never throws', async () => {
  const sent = [];
  const opener = createHermesWebOpener({ sendMessage: async (message) => { sent.push(message); return { ok: true, tabId: 7 }; } });
  assert.deepEqual(await opener.open({ url: LAUNCH, origin: ORIGIN }), { ok: true, tabId: 7 });
  assert.deepEqual(sent, [{ type: HERMES_WEB_OPENING_MESSAGES.start, url: LAUNCH, origin: ORIGIN, basePath: '' }]);
  const refused = createHermesWebOpener({ sendMessage: async () => ({ ok: false, reason: 'nope' }) });
  assert.deepEqual(await refused.open({ url: LAUNCH, origin: ORIGIN }), { ok: false, reason: 'nope' });
  const broken = createHermesWebOpener({ sendMessage: async () => { throw new Error('no receiver'); } });
  assert.deepEqual(await broken.open({ url: LAUNCH, origin: ORIGIN }), { ok: false, reason: 'no receiver' });
  assert.equal((await createHermesWebOpener().open({ url: LAUNCH, origin: ORIGIN })).ok, false);
});

const local = { connectionMode: 'local', gatewayUrl: 'http://127.0.0.1:8642' };
const tickets = {
  async windowTicket() { return { ok: true, ticket: TICKET, webappUrl: ORIGIN, origin: ORIGIN }; },
  launchUrl: (webappUrl, ticket) => `${webappUrl}/webapp/launch#ticket=${ticket}`,
};

function directTabs(existing = []) {
  const created = [];
  return {
    created,
    tabsApi: {
      async query() { return existing; },
      async create(options) { created.push(options); return { id: 5 }; },
      async update() {},
    },
    windowsApi: { async update() {} },
  };
}

test('a ticketed launch goes through the opener, and the button reports the launch tab', async () => {
  const browser = directTabs();
  const calls = [];
  const opener = { async open(request) { calls.push(request); return { ok: true, tabId: 42 }; } };
  const result = await openHermesWebapp({ settings: local, ...browser, tickets, opener });
  assert.equal(result.status, 'opened');
  assert.equal(result.tabId, 42);
  assert.equal(result.signedIn, true);
  assert.deepEqual(calls, [{ url: LAUNCH, origin: ORIGIN, basePath: '' }]);
  assert.deepEqual(browser.created, [], 'the panel opens no tab itself');
});

test('an opener that cannot run falls back to opening the launch URL directly, as before', async () => {
  for (const opener of [
    { async open() { return { ok: false, reason: 'down' }; } },
    { async open() { throw new Error('gone'); } },
    {},
  ]) {
    const browser = directTabs();
    const result = await openHermesWebapp({ settings: local, ...browser, tickets, opener });
    assert.equal(result.status, 'opened');
    assert.deepEqual(browser.created, [{ url: LAUNCH, active: true }]);
  }
});

test('without an opener the launch URL opens directly, as before', async () => {
  const browser = directTabs();
  const result = await openHermesWebapp({ settings: local, ...browser, tickets });
  assert.equal(result.status, 'opened');
  assert.deepEqual(browser.created, [{ url: LAUNCH, active: true }]);
});

test('an already-open Webapp tab is only focused: no opening page, no new tab', async () => {
  const browser = directTabs([{ id: 4, url: `${ORIGIN}/`, windowId: 3, active: false }]);
  let opened = 0;
  const opener = { async open() { opened += 1; return { ok: true, tabId: 1 }; } };
  const result = await openHermesWebapp({ settings: local, ...browser, tickets, opener });
  assert.equal(result.status, 'focused');
  assert.equal(opened, 0);
  assert.deepEqual(browser.created, []);
});

test('a held sign-in launch goes through the opener with the Webapp origin and base path', async () => {
  const browser = directTabs();
  const calls = [];
  const opener = { async open(request) { calls.push(request); return { ok: true, tabId: 8 }; } };
  const credentials = {
    async enabled() { return true; },
    async held() { return true; },
    async mintWindowTicket() { return { ok: true, ticket: TICKET }; },
    launchUrl: (target, ticket) => `${target.origin}${target.basePath}/webapp/launch#ticket=${ticket}`,
    async capture() { return { ok: false }; },
  };
  const settings = { ...local, hermesWebAddress: 'http://127.0.0.1:9120' };
  const result = await openHermesWebapp({ settings, ...browser, credentials, opener });
  assert.equal(result.status, 'opened');
  assert.deepEqual(calls, [{ url: LAUNCH, origin: ORIGIN, basePath: '' }]);
});

// --- the opening page --------------------------------------------------------------------------

function timers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimer: (id) => { scheduled[id - 1].cleared = true; },
  };
}

test('the page offers Show it anyway after the remaining time on the worker clock', async () => {
  const clock = timers();
  let slow = 0;
  const sent = [];
  const page = await startOpeningPage({
    sendMessage: async (message) => { sent.push(message); return { ok: true, status: 'waiting', startedAt: 1000, now: 6000, timeoutMs: 20_000, origin: 'http://127.0.0.1:9120' }; },
    onSlow: () => { slow += 1; },
    ...clock,
  });
  assert.equal(page.status, 'waiting');
  assert.equal(page.origin, 'http://127.0.0.1:9120', 'the page learns only the Webapp address it is opening');
  assert.equal(clock.scheduled.length, 1);
  assert.equal(clock.scheduled[0].ms, 15_000);
  assert.equal(slow, 0);
  clock.scheduled[0].fn();
  clock.scheduled[0].fn();
  assert.equal(slow, 1, 'the choice is offered once');
  await page.show();
  assert.deepEqual(sent.map((message) => message.type), [HERMES_WEB_OPENING_MESSAGES.state, HERMES_WEB_OPENING_MESSAGES.show]);
  page.stop();
  assert.equal(clock.scheduled[0].cleared, true);
});

test('a page that opens after the limit already offers the choice', async () => {
  const clock = timers();
  let slow = 0;
  await startOpeningPage({
    sendMessage: async () => ({ ok: true, status: 'waiting', startedAt: 0, now: 30_000, timeoutMs: 20_000 }),
    onSlow: () => { slow += 1; },
    ...clock,
  });
  assert.equal(slow, 1);
  assert.equal(clock.scheduled.length, 0);
});

test('a page with nothing pending closes itself, and one the worker cannot answer offers the choice', async () => {
  const clock = timers();
  const sent = [];
  let slow = 0;
  const none = await startOpeningPage({
    sendMessage: async (message) => { sent.push(message.type); return message.type === HERMES_WEB_OPENING_MESSAGES.state ? { ok: true, status: 'none' } : { ok: true }; },
    onSlow: () => { slow += 1; },
    ...clock,
  });
  assert.equal(none.status, 'none');
  assert.equal(none.origin, '');
  assert.deepEqual(sent, [HERMES_WEB_OPENING_MESSAGES.state, HERMES_WEB_OPENING_MESSAGES.show]);
  assert.equal(slow, 0);
  const down = await startOpeningPage({ sendMessage: async () => { throw new Error('no receiver'); }, onSlow: () => { slow += 1; }, ...clock });
  assert.equal(down.status, 'unreachable');
  assert.equal(slow, 1);
});

// --- wiring and files --------------------------------------------------------------------------

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the background worker routes the hand-off messages for extension pages only and watches tab updates and removals', () => {
  const source = read('extension/background.js');
  assert.match(source, /\.\.\.Object\.values\(HERMES_WEB_OPENING_MESSAGES\)/);
  assert.match(source, /hermesWebOpening\.handles\(message\?\.type\)/);
  assert.match(source, /hermesWebOpening\.handleTabUpdated\(/);
  assert.match(source, /hermesWebOpening\.handleTabRemoved\(/);
  assert.match(source, /opener: hermesWebOpener/);
  assert.match(read('extension/sidepanel.js'), /opener: hermesWebOpener\(\),/);
});

test('the opening page loads only packaged files, carries no ticket and respects reduced motion', () => {
  const html = read('extension/hermes-web-opening.html');
  const css = read('extension/hermes-web-opening.css');
  const js = read('extension/hermes-web-opening.js');
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), 'no remote references');
  assert.ok(!/ticket/i.test(html + js), 'the page never handles the ticket');
  assert.match(html, /<script type="module" src="hermes-web-opening\.js">/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /assets\/img\/hermes-browser-logo-left\.svg#Layer_1/);
});

test('the opening page is the pairing approval page design, in the portal colours, with its art packaged', () => {
  const html = read('extension/hermes-web-opening.html');
  const css = read('extension/hermes-web-opening.css');
  // The rail, the pane and the dithered Hermes on both, with the globe over the wordmark.
  for (const part of ['opening-rail', 'opening-rail-statue', 'opening-globe', 'opening-pane', 'opening-statue', 'opening-statue-fill', 'opening-mark']) {
    assert.match(html, new RegExp(`class="${part}[ "]`), part);
  }
  for (const asset of ['statue', 'railstatue', 'statue-fill', 'badge', 'globe']) {
    assert.match(html, new RegExp(`assets/img/opening/${asset}\\.webp`), asset);
    assert.ok(existsSync(new URL(`../extension/assets/img/opening/${asset}.webp`, import.meta.url)), `${asset}.webp is packaged`);
  }
  assert.match(css, /--cobalt: #0505e8/);
  assert.match(css, /--paper: #f6f7fb/);
  assert.match(css, /assets\/fonts\/RulesCompressed-Medium\.woff2/);
  assert.match(css, /@media \(max-width: 860px\)/, 'the rail becomes a header band on narrow screens');
  // It is a brand page: no panel theme stylesheet or token decides its colours.
  assert.ok(!/sidepanel(?:-themes)?\.css/.test(html), 'no panel theme stylesheet');
  assert.ok(!/var\(--hermes-/.test(css), 'no panel theme tokens');
  // The rail's status and the Webapp address are filled in by the page; the strings are in every locale.
  assert.match(html, /id="openingState" data-i18n="webapp\.opening_state"/);
  assert.match(read('extension/hermes-web-opening.js'), /t\('webapp\.opening_state_slow'\)/);
});

test('the page is an extension page opened by the extension, so it is not web-accessible, and both builds ship it', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const exposed = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources);
  assert.ok(!exposed.some((resource) => resource.includes('hermes-web-opening')));
  // tabs.create/update/remove/onUpdated and windows.update need the existing "tabs" permission on both builds.
  assert.ok(manifest.permissions.includes('tabs'));
  const firefoxBuild = read('scripts/build-firefox.mjs');
  assert.match(firefoxBuild, /copyDir\(src, dest\)/);
  assert.ok(!/hermes-web-opening/.test(firefoxBuild), 'the Firefox build copies the whole extension folder and removes nothing of this page');
});

test('every opening string exists in all 21 locales, translated, with Hermes intact', async () => {
  const keys = ['webapp.opening_title', 'webapp.opening_detail', 'webapp.opening_slow', 'webapp.opening_show', 'webapp.opening_state', 'webapp.opening_state_slow'];
  const english = await loadLocaleMessages('en');
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadLocaleMessages(locale.id);
    for (const key of keys) {
      assert.equal(typeof catalog[key], 'string', `${locale.id} is missing ${key}`);
      assert.ok(catalog[key].trim());
      if (locale.id !== 'en') assert.notEqual(catalog[key], english[key], `${locale.id} ${key} is still English`);
      if (english[key].includes('Hermes')) assert.ok(catalog[key].includes('Hermes'), `${locale.id} ${key} lost "Hermes"`);
    }
  }
});
