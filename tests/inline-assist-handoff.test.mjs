import assert from 'node:assert/strict';
import test from 'node:test';

import { SIDE_PANEL_REFUSED_REASON, handOffInlineDraftToSidePanel } from '../extension/lib/inline-assist-handoff.mjs';

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
