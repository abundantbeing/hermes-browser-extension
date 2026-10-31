// Hermes Control across several tabs: tab-list commands with no default tab, closing the tab a command
// rides on, grouping the tabs Hermes opened, never attaching a tab that opens by itself, a tab whose page
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

// A tab that opens from a tab Hermes acts in is never attached by itself: Hermes's click and the person's are
// both trusted input, so the extension cannot tell whose the tab is. The action only hears that one opened.
const NOT_ATTACHED_NOTE = /not attached.*ask the person to attach it/i;

test('a tab that opens while a Hermes click runs is not attached, and the result only says a tab opened', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      if (frame.action === 'browser_click') {
        const opened = await worker.handleTabCreated({
          id: 950, openerTabId: 911, windowId: 2, pendingUrl: 'https://bank.example/account?access_token=abcdef1234567890abcdef',
        });
        assert.equal(opened.adopted, false);
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
  assert.equal(clicked.result.opened_tabs, undefined, 'no tab is named as one Hermes can use');
  assert.equal(clicked.result.opened_tabs_not_attached, 1);
  assert.match(clicked.result.opened_tabs_note, NOT_ATTACHED_NOTE);
  assert.doesNotMatch(JSON.stringify(clicked.result), /bank\.example|abcdef1234567890|950/, 'neither its address nor its id reaches the model');
  assert.deepEqual(f.worker.status().leasedTabIds, [911]);

  // The model cannot act in it either.
  const read = await f.command('read-new', 'browser_snapshot', { tab_id: 950 });
  assert.equal(read.ok, false, JSON.stringify(read));
  assert.equal(f.frames.some((frame) => frame.command_id === 'read-new'), false, 'nothing ran in the unattached tab');
});

test('a tab the person opens during a Hermes action, or a moment after one, is never attached', async () => {
  let opening = null;
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      // The person ctrl-clicks a link in the attached tab while Hermes's click, key press, typing or batch runs.
      if (opening) assert.equal((await worker.handleTabCreated(opening)).adopted, false);
      return { ok: true, result: { status: 'done' } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  const actions = [
    ['browser_click', { ref: '@e1' }],
    ['browser_press', { key: 'Enter' }],
    ['browser_type', { ref: '@e1', text: 'x' }],
    ['browser_batch', { actions: [{ action: 'scroll', direction: 'down' }, { action: 'click', ref: '@e1' }] }],
  ];
  let id = 940;
  for (const [action, args] of actions) {
    id += 1;
    opening = { id, openerTabId: 911, windowId: 2, pendingUrl: 'https://mail.example/' };
    const done = await f.command(`during-${action}`, action, args);
    assert.equal(done.ok, true, `${action}: ${JSON.stringify(done)}`);
    assert.equal(done.result.opened_tabs_not_attached, 1, `${action} hears that a tab opened`);
    // Right after the action ended, and within what used to be a three-second grace window: still the person's.
    for (const later of [0, 500, 2_000, 499]) {
      f.clock.at += later;
      assert.equal((await f.worker.handleTabCreated({ id: id + 100 + later, openerTabId: 911, windowId: 2 })).adopted, false, `${action} +${later}ms`);
    }
  }
  assert.deepEqual(f.worker.status().leasedTabIds, [911]);
});

test('a tab that opens while a snapshot, screenshot, scroll or tab command runs is not even reported', async () => {
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      const opened = await worker.handleTabCreated({ id: 980, openerTabId: 911, windowId: 2 });
      return { ok: true, result: { title: 'Page', text: 'page', refs: [], adopted: opened.adopted, reported: opened.reported === true } };
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
    assert.equal(done.result.reported, false, `${action} reported a tab the person opened`);
    assert.equal(done.result.opened_tabs_not_attached, undefined, action);
  }
  assert.deepEqual(f.worker.status().leasedTabIds, [911]);
});

test('a tab opened from a tab Hermes does not own, or while control is paused or off, is neither attached nor reported', async () => {
  let opening = null;
  const f = await multiTab({
    execute: async (frame, context, worker) => {
      const opened = await worker.handleTabCreated(opening);
      return { ok: true, result: { status: 'clicked', reported: opened.reported === true, adopted: opened.adopted } };
    },
  });
  await f.attach([911], TAB_LEASE_KINDS.THIS_TAB);
  await f.ready(911);
  opening = { id: 990, openerTabId: 4040, windowId: 2 };
  const foreign = await f.command('click-foreign', 'browser_click', { ref: '@e1' });
  assert.deepEqual([foreign.result.adopted, foreign.result.reported], [false, false]);
  assert.equal(foreign.result.opened_tabs_not_attached, undefined);

  // Paused, then turned off: a tab opening from the attached tab is left alone.
  const base = f.values.hermesBrowserSettings;
  for (const change of [{ browserControlPaused: true }, { browserControlEnabled: false }]) {
    await f.worker.syncSettings({ ...base, ...change });
    assert.deepEqual(await f.worker.handleTabCreated({ id: 991, openerTabId: 911, windowId: 2 }), { ok: true, adopted: false }, JSON.stringify(change));
  }
  assert.equal(f.worker.status().leasedTabIds.includes(991), false);
});

test('commands on two tabs at once each hear only of tabs opened while they run, and none is attached', async () => {
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
  const opened = (commandId) => f.reply(commandId).result.opened_tabs_not_attached || 0;
  const leased = () => [...f.worker.status().leasedTabIds].sort((a, b) => a - b);

  // The first command to finish must not clear the one still running.
  await f.start('click-a', 'browser_click', { ref: '@e1', tab_id: 911 });
  await f.start('click-b', 'browser_click', { ref: '@e1', tab_id: 912 });
  assert.equal(f.worker.status().pendingCommands, 2);
  await finish('click-a');
  assert.equal(f.worker.status().activeAction?.commandId, 'click-b', 'b is still running');
  assert.equal((await f.worker.handleTabCreated({ id: 970, openerTabId: 912, windowId: 2 })).adopted, false);
  await finish('click-b');
  assert.equal(opened('click-b'), 1);
  assert.equal(opened('click-a'), 0);

  // Both running: a tab is counted for the command running in the tab that opened it.
  await f.start('click-e', 'browser_click', { ref: '@e1', tab_id: 911 });
  await f.start('click-f', 'browser_click', { ref: '@e1', tab_id: 912 });
  assert.equal((await f.worker.handleTabCreated({ id: 972, openerTabId: 911, windowId: 2 })).adopted, false);
  assert.equal((await f.worker.handleTabCreated({ id: 973, openerTabId: 911, windowId: 2 })).adopted, false);
  assert.equal((await f.worker.handleTabCreated({ id: 974, openerTabId: 912, windowId: 2 })).adopted, false);
  await finish('click-e');
  await finish('click-f');
  assert.equal(opened('click-e'), 2);
  assert.equal(opened('click-f'), 1);
  assert.equal(f.worker.status().activeAction, null);
  assert.deepEqual(leased(), [911, 912], 'only the tabs the person attached');
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
