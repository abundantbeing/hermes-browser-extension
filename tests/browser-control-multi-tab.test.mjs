// Hermes Control across several tabs: tab-list commands with no default tab, closing the tab a command
// rides on, grouping the tabs Hermes opened, adopting a tab a Hermes click opened, a tab whose page
// never reported itself, changing the attached tabs, and the tool names the model is told about.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLER_WORKER_MESSAGES, createControllerServiceWorker } from '../extension/lib/controller-service-worker.mjs';
import { TAB_LEASE_KINDS, TAB_LEASE_OWNERSHIPS } from '../extension/lib/tab-leases.mjs';
import { CONTROL_TOOL_FAMILIES, PLUGIN_TOOL_NAMES, setControlToolFamily } from '../extension/lib/control-tool-names.mjs';
import { CONTROLLER_BROWSER_CAPABILITIES } from '../extension/lib/controller-protocol.mjs';

const PRODUCT = Object.freeze({ id: 'chromium', engine: 'chromium', label: 'Chromium browser' });
const trusted = { url: 'chrome-extension://fixture/sidepanel.html', frameId: 0 };
const fromPage = (tabId) => ({ url: 'chrome-extension://fixture/sidepanel.html', frameId: 0, tab: { id: tabId, windowId: 2 } });

async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function multiTab({ execute, route, getTab, releaseTabDebugger } = {}) {
  const clock = { at: 1_000_000 };
  const values = {
    hermesBrowserSettings: {
      connectionSchemaVersion: 1, connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api',
      gatewayUrl: 'http://127.0.0.1:8642', apiKey: ['multi', 'tab', 'fixture'].join('-'), activeProfile: 'default',
      sessionId: 'multi-tab-session', browserControlEnabled: true,
    },
  };
  const storageArea = {
    async get(keys = null) {
      if (keys === null) return structuredClone(values);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]));
    },
    async set(next) { Object.assign(values, structuredClone(next)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
  const sent = [];
  const frames = [];
  let connection = null;
  let ids = 0;
  const worker = createControllerServiceWorker({
    storageArea,
    product: PRODUCT,
    randomUUID: () => `multi-tab-${++ids}`,
    extensionOrigin: 'chrome-extension://fixture',
    now: () => clock.at,
    getTab: getTab || (async (id) => ({ id, windowId: 2, url: `https://example.test/${id}` })),
    releaseTabDebugger,
    executeBrowserCommand: async (frame, context) => {
      frames.push(structuredClone(frame));
      return execute(frame, context, worker);
    },
    connector: {
      async connect(options) {
        connection = {
          ...(route ? { route } : {}),
          async send(frame) { sent.push(structuredClone(frame)); },
          async heartbeat() { return { ok: true }; },
          close() {},
          emit: (frame) => options.onFrame(structuredClone(frame)),
        };
        return connection;
      },
    },
  });
  await worker.boot();
  const ownerId = worker.status().controllerId;
  const attach = async (tabIds, kind = TAB_LEASE_KINDS.SELECTED_TABS) => {
    const result = await worker.handleMessage({
      type: CONTROLLER_WORKER_MESSAGES.leaseAcquire, kind, ownership: TAB_LEASE_OWNERSHIPS.OWNED, ownerId, tabIds, windowId: 2,
    }, trusted);
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  const ready = (tabId) => worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, fromPage(tabId));
  // A broker-v1 command: no tab_id or document generation of its own, as the plugin sends them.
  const command = async (commandId, action, args = {}) => {
    await connection.emit({ method: 'browser.controller.command', params: { command_id: commandId, action, arguments: args } });
    await settle();
    return sent.findLast((frame) => frame.params?.command_id === commandId)?.params;
  };
  // Commands on two tabs run at once: send one and carry on, then read its reply once it has finished.
  const start = async (commandId, action, args = {}) => {
    await connection.emit({ method: 'browser.controller.command', params: { command_id: commandId, action, arguments: args } });
    await settle();
  };
  const reply = (commandId) => sent.findLast((frame) => frame.params?.command_id === commandId)?.params;
  return { worker, ownerId, clock, attach, ready, command, start, reply, frames, values };
}

test('a tab list, a switch and a close need no default tab when several tabs are attached', async () => {
  const f = await multiTab({
    execute: async (frame) => {
      if (frame.action === 'browser_tabs') return { ok: true, result: { tabs: [] } };
      if (frame.action === 'browser_tab_activate') return { ok: true, result: { status: 'tab-activated' } };
      if (frame.action === 'browser_tab_close') return { ok: true, result: { status: 'tab-closed' } };
      return { ok: true, result: { status: 'scrolled' } };
    },
  });
  await f.attach([902, 903]);
  await f.ready(902);
  await f.ready(903);

  // A page action that names no tab still has to say which: the refusal lists the tabs it could use.
  const ambiguous = await f.command('scroll-any', 'browser_scroll', { direction: 'down' });
  assert.equal(ambiguous.error.code, 'ambiguous_target');
  assert.match(ambiguous.error.message, /pass tab_id, one of 902, 903/);
  assert.match(ambiguous.error.message, /browser_tabs shows each tab's title and URL/);

  const listed = await f.command('list', 'browser_tabs');
  assert.equal(listed.ok, true, JSON.stringify(listed));

  const switched = await f.command('switch', 'browser_tab_activate', { tab_id: 903 });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(f.frames.at(-1).tab_id, 903, 'a switch rides on the tab it names');

  const closed = await f.command('close', 'browser_tab_close', { tab_id: 903 });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(f.frames.at(-1).tab_id, 902, 'a close rides on another tab, so it does not end with the one it closes');
  assert.deepEqual(f.worker.status().leasedTabIds, [902]);
  assert.equal('tab_id' in closed.result, false, 'tab-list results carry no page tab');
});

test('closing the only tab Hermes acts in reports the close, not a cancel', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      // Closing a tab detaches its debugger before the close call returns.
      await worker.handleDebuggerDetach({ tabId: Number(frame.arguments.tab_id), reason: 'target_closed' });
      return { ok: true, result: { status: 'tab-closed' } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  const closed = await f.command('close-self', 'browser_tab_close', { tab_id: 911 });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.result.status, 'tab-closed');
  assert.deepEqual(f.worker.status().leasedTabIds, []);
});

test('tabs Hermes opens share one task set, so they can be grouped, and tabs attached one by one cannot', async () => {
  let nextTab = 912;
  const f = await multiTab({
    execute: async (frame) => {
      if (frame.action === 'browser_tab_create') {
        return { ok: true, result: { tab: { id: nextTab++, windowId: 2, active: false, url: frame.arguments.url } } };
      }
      return { ok: true, result: { status: 'tabs-grouped', groupId: 5 } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  assert.equal((await f.command('open-a', 'browser_tab_create', { url: 'https://example.test/a' })).ok, true);
  assert.equal((await f.command('open-b', 'browser_tab_create', { url: 'https://example.test/b' })).ok, true);
  assert.deepEqual(f.worker.status().leasedTabIds, [911, 912, 913]);

  const grouped = await f.command('group', 'browser_tab_group', { tab_ids: [912, 913] });
  assert.equal(grouped.ok, true, JSON.stringify(grouped));
  assert.equal(f.frames.at(-1).action, 'browser_tab_group');

  const mixed = await f.command('group-mixed', 'browser_tab_group', { tab_ids: [911, 912] });
  assert.equal(mixed.error.code, 'lease_not_owned');
  assert.match(mixed.error.message, /tabs Hermes opened/);
});

test('a tab a Hermes click opens is adopted, named in the result, and can be acted in at once', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      if (frame.action === 'browser_click') {
        await worker.handleTabCreated({
          id: 950, openerTabId: 911, windowId: 2, pendingUrl: 'https://example.test/next?access_token=abcdef1234567890abcdef',
        });
        return { ok: true, result: { status: 'clicked' } };
      }
      return { ok: true, result: { title: 'Next', text: 'page', refs: [] } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  const clicked = await f.command('click-link', 'browser_click', { ref: '@e1' });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.equal(clicked.result.tab_id, 911, 'a page action names the tab it ran in');
  assert.deepEqual(clicked.result.opened_tabs.map((tab) => tab.id), [950]);
  assert.doesNotMatch(JSON.stringify(clicked.result.opened_tabs), /abcdef1234567890/, 'a credential in the URL never reaches the result');
  assert.deepEqual(f.worker.status().leasedTabIds, [911, 950]);

  // Its page never reported itself to the extension, yet it can be acted in straight away.
  const read = await f.command('read-new', 'browser_snapshot', { tab_id: 950 });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.result.tab_id, 950);

  // A tab the person opens from an attached tab later, with no Hermes action running, stays theirs.
  f.clock.at += 60_000;
  assert.equal((await f.worker.handleTabCreated({ id: 951, openerTabId: 911, windowId: 2 })).adopted, false);
  // And nothing opened from a tab Hermes does not own is taken.
  assert.equal((await f.worker.handleTabCreated({ id: 952, openerTabId: 4040, windowId: 2 })).adopted, false);
  assert.deepEqual(f.worker.status().leasedTabIds, [911, 950]);
});

test('a link Hermes clicks in a background tab is adopted though Chrome names the tab in front as its opener', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      // Hermes clicks in tab 911 while the person looks at attached tab 912: Chrome records 912, the
      // tab in front of the window, as the new tab's opener.
      await worker.handleTabCreated({ id: 960, openerTabId: 912, windowId: 2, pendingUrl: 'https://example.test/next' });
      return { ok: true, result: { status: 'clicked' } };
    },
  });
  await f.attach([911, 912]);
  await f.ready(911);
  await f.ready(912);
  const clicked = await f.command('click-background', 'browser_click', { ref: '@e1', tab_id: 911 });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.deepEqual(clicked.result.opened_tabs, [{ id: 960, url: 'https://example.test/next' }]);
  assert.deepEqual([...f.worker.status().leasedTabIds].sort((a, b) => a - b), [911, 912, 960]);
});

test('a tab the person opens while a snapshot, screenshot, scroll or tab command runs, or just after, is not adopted', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      // The person ctrl-clicks a link in the attached tab while Hermes only reads or lists.
      const opened = await worker.handleTabCreated({ id: 980, openerTabId: 911, windowId: 2 });
      return { ok: true, result: { title: 'Page', text: 'page', refs: [], adopted: opened.adopted } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  const reads = [
    ['browser_snapshot', {}],
    ['browser_screenshot', {}],
    ['browser_scroll', { direction: 'down' }],
    ['browser_tabs', {}],
    ['browser_tab_activate', { tab_id: 911 }],
    ['browser_batch', { actions: [{ action: 'scroll', direction: 'down' }, { action: 'browser_hover', ref: '@e1' }] }],
  ];
  for (const [action, args] of reads) {
    const done = await f.command(`read-${action}`, action, args);
    assert.equal(done.ok, true, `${action}: ${JSON.stringify(done)}`);
    assert.equal(done.result.adopted, false, `${action} adopted a tab the person opened`);
    assert.equal(done.result.opened_tabs, undefined, `${action} named a tab the person opened`);
    // Right after one of them ended, inside the grace window, the tab is still the person's.
    assert.equal((await f.worker.handleTabCreated({ id: 981, openerTabId: 911, windowId: 2 })).adopted, false, `${action} grace`);
  }
  assert.deepEqual(f.worker.status().leasedTabIds, [911]);
});

test('a click, a key press or a batch with such a step adopts a tab opened while it runs and just after, a snapshot afterwards does not extend that', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      if (frame.arguments.opens) await worker.handleTabCreated({ id: frame.arguments.opens, openerTabId: 911, windowId: 2 });
      return { ok: true, result: { status: 'done' } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  const press = await f.command('press-link', 'browser_press', { key: 'Enter', opens: 940 });
  assert.deepEqual(press.result.opened_tabs.map((tab) => tab.id), [940]);
  const batch = await f.command('batch-click', 'browser_batch', {
    actions: [{ action: 'scroll', direction: 'down' }, { action: 'click', ref: '@e1' }], opens: 941, tab_id: 911,
  });
  assert.deepEqual(batch.result.opened_tabs.map((tab) => tab.id), [941]);
  f.clock.at += 5_000;
  const scrollOnly = await f.command('batch-scroll', 'browser_batch', { actions: [{ action: 'scroll', direction: 'down' }], opens: 942, tab_id: 911 });
  assert.equal(scrollOnly.result.opened_tabs, undefined);
  assert.deepEqual([...f.worker.status().leasedTabIds].sort((a, b) => a - b), [911, 940, 941]);

  // A page script that opens a tab a moment after a click ended: still that click's.
  assert.equal((await f.command('click-late', 'browser_click', { ref: '@e1', tab_id: 911 })).ok, true);
  f.clock.at += 2_000;
  assert.equal((await f.worker.handleTabCreated({ id: 943, openerTabId: 911, windowId: 2 })).adopted, true);
  // A snapshot in between does not start a new grace window: three seconds after the click it is over.
  assert.equal((await f.command('read-after', 'browser_snapshot', { tab_id: 911 })).ok, true);
  f.clock.at += 1_500;
  assert.equal((await f.worker.handleTabCreated({ id: 944, openerTabId: 911, windowId: 2 })).adopted, false);
  assert.deepEqual([...f.worker.status().leasedTabIds].sort((a, b) => a - b), [911, 940, 941, 943]);
});

test('commands on two tabs at once keep their own action records, so each result names the tabs its own click opened', async () => {
  const gates = new Map();
  const f = await multiTab({
    execute: async (frame) => {
      await new Promise((resolve) => { gates.set(frame.command_id, resolve); });
      return { ok: true, result: { status: 'clicked' } };
    },
  });
  await f.attach([911, 912]);
  await f.ready(911);
  await f.ready(912);
  const finish = async (commandId) => { gates.get(commandId)(); await settle(); };
  const openedIds = (commandId) => (f.reply(commandId).result.opened_tabs || []).map((tab) => tab.id);

  // The first command to finish must not clear the one still running.
  await f.start('click-a', 'browser_click', { ref: '@e1', tab_id: 911 });
  await f.start('click-b', 'browser_click', { ref: '@e1', tab_id: 912 });
  assert.equal(f.worker.status().pendingCommands, 2);
  await finish('click-a');
  assert.equal(f.worker.status().activeAction?.commandId, 'click-b', 'b is still running');
  assert.equal((await f.worker.handleTabCreated({ id: 970, openerTabId: 912, windowId: 2 })).adopted, true);
  await finish('click-b');
  assert.deepEqual(openedIds('click-b'), [970]);
  assert.deepEqual(openedIds('click-a'), []);
  assert.equal(f.worker.status().activeAction, null);

  // Either order: the second to start finishing first leaves the first one's record alone.
  await f.start('click-c', 'browser_click', { ref: '@e1', tab_id: 911 });
  await f.start('click-d', 'browser_click', { ref: '@e1', tab_id: 912 });
  await finish('click-d');
  assert.equal(f.worker.status().activeAction?.commandId, 'click-c', 'c is still running');
  assert.equal((await f.worker.handleTabCreated({ id: 971, openerTabId: 911, windowId: 2 })).adopted, true);
  await finish('click-c');
  assert.deepEqual(openedIds('click-c'), [971]);
  assert.deepEqual(openedIds('click-d'), []);

  // Both running: a tab goes to the command running in the tab that opened it.
  await f.start('click-e', 'browser_click', { ref: '@e1', tab_id: 911 });
  await f.start('click-f', 'browser_click', { ref: '@e1', tab_id: 912 });
  assert.equal((await f.worker.handleTabCreated({ id: 972, openerTabId: 911, windowId: 2 })).adopted, true);
  assert.equal((await f.worker.handleTabCreated({ id: 973, openerTabId: 912, windowId: 2 })).adopted, true);
  await finish('click-e');
  await finish('click-f');
  assert.deepEqual(openedIds('click-e'), [972]);
  assert.deepEqual(openedIds('click-f'), [973]);
  assert.equal(f.worker.status().activeAction, null);
});

test('changing the attached tabs keeps the tabs Hermes opened and lets go of the dropped tab\'s debugger', async () => {
  const released = [];
  const f = await multiTab({
    releaseTabDebugger: (tabId) => { released.push(tabId); },
    execute: async (frame) => ({ ok: true, result: { tab: { id: 912, windowId: 2, active: false, url: frame.arguments.url } } }),
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  assert.equal((await f.command('open', 'browser_tab_create', { url: 'https://example.test/work' })).ok, true);
  const replaced = await f.worker.handleMessage({
    type: CONTROLLER_WORKER_MESSAGES.scopeReplace,
    kind: TAB_LEASE_KINDS.THIS_TAB,
    tabIds: [920],
    ownerId: f.ownerId,
    expectedGeneration: f.worker.status().generation,
    expectedSettingsRevision: f.worker.status().settingsRevision,
  }, trusted);
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual([...f.worker.status().leasedTabIds].sort((a, b) => a - b), [912, 920]);
  await settle();
  assert.deepEqual(released, [911]);
});

test('a page that reports itself after the worker gave it a generation keeps it, so its refs stay valid', async () => {
  const f = await multiTab({ execute: async () => ({ ok: true, result: { title: 'Page', text: 'page', refs: [] } }) });
  await f.attach([970], TAB_LEASE_KINDS.THIS_TAB);
  // The tab is acted in before its page reported itself: the worker gives it generation 1.
  const read = await f.command('read-early', 'browser_snapshot', {});
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(f.frames.at(-1).document_generation, 1);
  // The page's own first report is that same document: still generation 1.
  assert.equal((await f.ready(970)).documentGeneration, 1);
  // A navigation is a new document, and its report starts a new generation as before.
  await f.worker.handleTabUpdated(970, { status: 'loading' });
  assert.equal((await f.ready(970)).documentGeneration, 3);
});

test('the tool names the model is told about follow the route control connected through', async () => {
  try {
    const f = await multiTab({ route: 'plugin', execute: async () => ({ ok: true, result: {} }) });
    assert.equal(f.worker.status().controlToolFamily, CONTROL_TOOL_FAMILIES.plugin);
    await f.attach([902, 903]);
    await f.ready(902);
    await f.ready(903);
    const ambiguous = await f.command('scroll-any', 'browser_scroll', { direction: 'down' });
    assert.match(ambiguous.error.message, /tab_list shows each tab's title and URL/);
    assert.doesNotMatch(ambiguous.error.message, /browser_tabs/);
  } finally {
    setControlToolFamily(CONTROL_TOOL_FAMILIES.core);
  }
});

test('every wire action has a plugin tool name, and the names are unique tab_* names', () => {
  assert.deepEqual(Object.keys(PLUGIN_TOOL_NAMES).sort(), [...CONTROLLER_BROWSER_CAPABILITIES].sort());
  const names = Object.values(PLUGIN_TOOL_NAMES);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^tab_[a-z_]+$/);
});
