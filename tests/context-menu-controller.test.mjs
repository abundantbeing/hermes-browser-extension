import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_MENU_CONFIG_STORAGE_KEY,
  CONTEXT_MENU_ROOT_ID,
  browserMenuIdForItem,
  normalizeContextMenuConfig,
} from '../extension/lib/context-menu-config.mjs';
import { createContextMenuController } from '../extension/lib/context-menu-controller.mjs';

function createHarness({ config, settings = {}, waitForInitialGet = false, failFirstRemove = false, failCreateTitle = '' } = {}) {
  const localState = {
    [CONTEXT_MENU_CONFIG_STORAGE_KEY]: config,
    hermesBrowserSettings: settings,
  };
  const sessionState = {};
  const localWrites = [];
  const sessionWrites = [];
  const menuCreates = [];
  const sentMessages = [];
  const opens = [];
  const events = [];
  let releaseInitialGet = null;
  let initialGetReleased = !waitForInitialGet;
  let removeCalls = 0;

  const chromeApi = {
    runtime: { lastError: null },
    storage: {
      local: {
        async get(keys) {
          events.push('local:get');
          if (!initialGetReleased) {
            await new Promise((resolve) => { releaseInitialGet = resolve; });
            initialGetReleased = true;
          }
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => key in localState).map((key) => [key, localState[key]]));
        },
        async set(value) {
          localWrites.push(structuredClone(value));
          Object.assign(localState, structuredClone(value));
        },
      },
      session: {
        async get(key) {
          return key in sessionState ? { [key]: structuredClone(sessionState[key]) } : {};
        },
        async set(value) {
          sessionWrites.push(structuredClone(value));
          Object.assign(sessionState, structuredClone(value));
        },
      },
    },
    contextMenus: {
      async removeAll() {
        removeCalls += 1;
        if (failFirstRemove && removeCalls === 1) throw new Error('remove failed');
      },
      create(options, callback) {
        menuCreates.push(structuredClone(options));
        if (options.title === failCreateTitle) throw new Error('create failed');
        callback?.();
      },
    },
    tabs: {
      async sendMessage(...args) {
        sentMessages.push(structuredClone(args));
        return { ok: true };
      },
    },
  };

  const controller = createContextMenuController({
    chromeApi,
    now: () => 1_000,
    translate: (key, fallback) => key ? `translated:${key}` : fallback,
    digestContextUrl: async () => 'a'.repeat(64),
    openHermesSurface(tab) {
      events.push('open');
      opens.push(structuredClone(tab));
      return Promise.resolve(true);
    },
  });

  return {
    chromeApi,
    controller,
    events,
    localState,
    localWrites,
    menuCreates,
    opens,
    releaseInitialGet() { releaseInitialGet?.(); },
    sentMessages,
    sessionState,
    sessionWrites,
    get removeCalls() { return removeCalls; },
  };
}

function promptItem(id = 'custom-prompt') {
  return {
    id,
    title: 'Custom prompt',
    titleKey: '',
    enabled: true,
    contexts: ['selection', 'link'],
    action: { type: 'prompt', prompt: 'Inspect this target.' },
  };
}

test('cold prompt clicks start opening Hermes before config hydration and persist the exact request', async () => {
  const item = promptItem();
  const harness = createHarness({
    waitForInitialGet: true,
    config: { version: 1, revision: 4, items: [item] },
    settings: { contextMenuDefaultRoute: 'background' },
  });
  const clickPromise = harness.controller.handleClick({
    menuItemId: browserMenuIdForItem(item, 4),
    frameId: 6,
    pageUrl: 'https://example.com/post?view=reader',
    linkUrl: 'https://docs.example.com/page?debug=1',
    selectionText: ' selected ',
  }, { id: 17, windowId: 9, url: 'https://example.com/post' });

  assert.deepEqual(harness.events, ['open', 'local:get'], 'the user-gesture open must begin before the first await');
  assert.equal(harness.sessionWrites.length, 0);
  harness.releaseInitialGet();
  const result = await clickPromise;

  assert.equal(result.ok, true);
  assert.equal(harness.opens.length, 1);
  assert.equal(harness.sessionWrites.length, 1);
  assert.deepEqual(harness.sessionState.hermesBrowserContextMenuRequest, [{
    version: 1,
    itemId: 'custom-prompt',
    actionType: 'prompt',
    prompt: 'Inspect this target.',
    route: 'background',
    trigger: 'link',
    selection: 'selected',
    pageUrl: 'https://example.com/post',
    sourceUrlDigest: 'a'.repeat(64),
    resourceUrl: 'https://docs.example.com/page',
    tabId: 17,
    windowId: 9,
    frameId: 6,
    createdAt: 1_000,
    expiresAt: 301_000,
  }]);
});

test('rapid prompt clicks queue independently and attached surfaces claim only their source tab', async () => {
  const item = promptItem();
  const harness = createHarness({ config: { version: 1, revision: 0, items: [item] } });
  await Promise.all([
    harness.controller.handleClick({
      menuItemId: browserMenuIdForItem(item),
      pageUrl: 'https://example.com/first',
      selectionText: 'first',
    }, { id: 17, windowId: 9, url: 'https://example.com/first' }),
    harness.controller.handleClick({
      menuItemId: browserMenuIdForItem(item),
      pageUrl: 'https://example.com/second',
      selectionText: 'second',
    }, { id: 18, windowId: 9, url: 'https://example.com/second' }),
  ]);

  assert.equal(harness.sessionState.hermesBrowserContextMenuRequest.length, 2);
  const second = await harness.controller.handleMessage({ type: 'HERMES_CONTEXT_MENU_REQUEST_CLAIM', sourceTabId: 18 });
  const first = await harness.controller.handleMessage({ type: 'HERMES_CONTEXT_MENU_REQUEST_CLAIM', sourceTabId: 17 });
  const empty = await harness.controller.handleMessage({ type: 'HERMES_CONTEXT_MENU_REQUEST_CLAIM', sourceTabId: 17 });
  assert.equal(second.request.tabId, 18);
  assert.equal(first.request.tabId, 17);
  assert.deepEqual(empty, { ok: false, reason: 'no-pending-request' });
  assert.deepEqual(harness.sessionState.hermesBrowserContextMenuRequest, []);
});

test('cold inline clicks target the exact clicked frame without opening Hermes', async () => {
  const item = {
    id: 'inline-improve',
    title: 'Improve',
    enabled: true,
    contexts: ['editable'],
    action: { type: 'inline', actionId: 'improve' },
  };
  const harness = createHarness({ config: { version: 1, revision: 0, items: [item] } });
  const result = await harness.controller.handleClick({
    menuItemId: browserMenuIdForItem(item),
    frameId: 12,
    editable: true,
    pageUrl: 'https://example.com/editor',
  }, { id: 22, windowId: 3, url: 'https://example.com/editor' });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.sentMessages, [[
    22,
    { type: 'HERMES_INLINE_CONTEXT_ACTION', actionId: 'improve' },
    { frameId: 12 },
  ]]);
  assert.deepEqual(harness.opens, []);
  assert.deepEqual(harness.sessionWrites, []);
});

test('menu configuration creates typed child ids, translates only built-ins, and preserves explicit empty state', async () => {
  const builtIn = normalizeContextMenuConfig(undefined).items[0];
  const custom = promptItem('custom-title');
  const harness = createHarness({ config: { version: 1, revision: 2, items: [builtIn, custom] } });
  await harness.controller.configure();

  assert.equal(harness.removeCalls, 1);
  assert.equal(harness.menuCreates[0].id, CONTEXT_MENU_ROOT_ID);
  assert.equal(harness.menuCreates[1].id, browserMenuIdForItem(builtIn, 2));
  assert.equal(harness.menuCreates[1].title, `translated:${builtIn.titleKey}`);
  assert.equal(harness.menuCreates[2].title, 'Custom prompt');

  const emptyHarness = createHarness({ config: { version: 1, revision: 9, items: [] } });
  await emptyHarness.controller.configure();
  assert.equal(emptyHarness.removeCalls, 1);
  assert.deepEqual(emptyHarness.menuCreates, []);
});

test('concurrent targeted mutations serialize against the latest revision', async () => {
  const first = promptItem('first');
  const second = promptItem('second');
  const harness = createHarness({ config: { version: 1, revision: 0, items: [first, second] } });

  const [updated, disabled, moved] = await Promise.all([
    harness.controller.mutate({ type: 'update', id: 'first', patch: { title: 'Updated first' } }),
    harness.controller.mutate({ type: 'update', id: 'second', patch: { enabled: false } }),
    harness.controller.mutate({ type: 'move', id: 'second', offset: -1 }),
  ]);

  assert.deepEqual([updated.revision, disabled.revision, moved.revision], [1, 2, 3]);
  assert.deepEqual(harness.localWrites.map((write) => write[CONTEXT_MENU_CONFIG_STORAGE_KEY].revision), [1, 2, 3]);
  const finalConfig = harness.localState[CONTEXT_MENU_CONFIG_STORAGE_KEY];
  assert.deepEqual(finalConfig.items.map((item) => item.id), ['second', 'first']);
  assert.equal(finalConfig.items[0].enabled, false);
  assert.equal(finalConfig.items[1].title, 'Updated first');
});

test('a failed rebuild does not poison the controller queue', async () => {
  const harness = createHarness({
    config: { version: 1, revision: 0, items: [promptItem()] },
    failFirstRemove: true,
  });
  await assert.rejects(harness.controller.configure(), /remove failed/);
  await harness.controller.configure();
  assert.equal(harness.removeCalls, 2);
  assert.equal(harness.menuCreates.length, 2);
});

test('malformed browser ids fail closed without storage reads or UI changes', async () => {
  const harness = createHarness({ config: { version: 1, revision: 0, items: [promptItem()] } });
  const result = await harness.controller.handleClick({ menuItemId: 'javascript:alert(1)' }, { id: 2 });
  assert.deepEqual(result, { ok: false, reason: 'unknown-menu-item' });
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.opens, []);
  assert.deepEqual(harness.sessionWrites, []);
});

test('stale persistent menu revisions fail closed after configuration changes', async () => {
  const item = promptItem();
  const harness = createHarness({ config: { version: 1, revision: 3, items: [item] } });
  const result = await harness.controller.handleClick({
    menuItemId: browserMenuIdForItem(item, 2),
    pageUrl: 'https://example.com/post',
    selectionText: 'selected',
  }, { id: 17, windowId: 9, url: 'https://example.com/post' });
  assert.deepEqual(result, { ok: false, reason: 'stale-menu-revision' });
  assert.deepEqual(harness.sessionWrites, []);
});

test('failed menu creation restores the last good tree and does not persist the rejected config', async () => {
  const original = promptItem();
  const harness = createHarness({
    config: { version: 1, revision: 0, items: [original] },
    failCreateTitle: 'Broken action',
  });
  await harness.controller.configure();
  await assert.rejects(harness.controller.mutate({
    type: 'add',
    item: {
      id: 'broken-action',
      title: 'Broken action',
      contexts: ['selection'],
      action: { type: 'prompt', prompt: 'Break.' },
    },
  }), /create failed/);

  assert.equal(harness.localState[CONTEXT_MENU_CONFIG_STORAGE_KEY].items.length, 1);
  assert.equal(harness.localWrites.length, 0);
  assert.deepEqual(
    harness.menuCreates.slice(-2).map((item) => item.id),
    [CONTEXT_MENU_ROOT_ID, browserMenuIdForItem(original)],
  );
});
