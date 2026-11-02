import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

import { SIDE_PANEL_REFUSED_REASON, assistSessionTitle, handOffInlineDraftToSidePanel } from '../extension/lib/inline-assist-handoff.mjs';

test('an Assist chat is named for Assist, its site as people write it, and a readable time', () => {
  const at = new Date(2026, 10, 2, 4, 13, 21);
  const title = assistSessionTitle({ adapterId: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=abc123' }, { date: at, suffix: 'abcd' });
  assert.match(title, /^Hermes Assist · YouTube · /);
  assert.match(title, /4:13:21/);
  assert.match(title, / · abcd$/);
  assert.doesNotMatch(title, /\d{4}-\d{2}-\d{2}|\.\d{3}/, 'no raw timestamp');
});

test('a site without its own adapter is named by its host', () => {
  const title = assistSessionTitle({ adapterId: 'generic', pageUrl: 'https://news.example.com/story' }, { suffix: 'abcd' });
  assert.match(title, /^Hermes Assist · news\.example\.com · /);
});

test('background runs and side-panel chats share the same Assist name', async () => {
  const [background, sidepanel] = await Promise.all([
    readFile(new URL('../extension/background.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  ]);
  assert.match(background, /const sessionTitle = assistSessionTitle\(request, \{ suffix: sessionId\.slice\(-4\) \}\);/);
  assert.doesNotMatch(background, /toISOString\(\)\.replace\('T', ' '\)/);
  assert.match(sidepanel, /assistSessionTitle\(request, \{ suffix: String\(request\.requestId \|\| ''\)\.slice\(-4\) \}\)/);
  assert.doesNotMatch(sidepanel, /\nfunction assistSessionTitle\(/);
});

function sessionStorage() {
  const store = {};
  return {
    store,
    set: async (patch) => { Object.assign(store, patch); },
    remove: async (key) => { delete store[key]; },
  };
}

const queued = { requestId: 'req-1', route: 'current', tabId: 4 };

test('the side panel starts opening before anything is awaited, while the click still counts', async () => {
  const storage = sessionStorage();
  let opened = false;
  const pending = handOffInlineDraftToSidePanel({
    queued,
    storageKey: 'draft',
    sessionStorage: storage,
    openSidePanel: () => { opened = true; return Promise.resolve(true); },
    sidePanelIsOpen: async () => false,
  });
  assert.equal(opened, true, 'sidePanel.open was called in the same turn as the message');
  assert.deepEqual(await pending, { ok: true, requestId: 'req-1', sidePanel: true });
  assert.deepEqual(storage.store.draft, queued, 'the request waits for the panel');
});

test('a panel that was already open takes the request even when the open call is refused', async () => {
  const storage = sessionStorage();
  const result = await handOffInlineDraftToSidePanel({
    queued,
    storageKey: 'draft',
    sessionStorage: storage,
    openSidePanel: () => Promise.reject(new Error('may only be called in response to a user gesture')),
    sidePanelIsOpen: async () => true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(storage.store.draft, queued);
});

test('no panel and no way to open one: the request is withdrawn and the page says what to do', async () => {
  const storage = sessionStorage();
  const result = await handOffInlineDraftToSidePanel({
    queued,
    storageKey: 'draft',
    sessionStorage: storage,
    openSidePanel: () => { throw new Error('sidePanel unavailable'); },
    sidePanelIsOpen: async () => false,
  });
  assert.deepEqual(result, { ok: false, requestId: 'req-1', reason: SIDE_PANEL_REFUSED_REASON });
  assert.equal('draft' in storage.store, false);
  assert.match(SIDE_PANEL_REFUSED_REASON, /Run in background/);
});
