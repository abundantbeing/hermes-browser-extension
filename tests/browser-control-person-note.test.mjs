// A refusal the model sees (a frame withheld a screenshot, a click would land in a frame Hermes cannot read) is also
// shown to the person, in the Hermes Control window's status line, in words that translate.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLER_WORKER_MESSAGES, createControllerServiceWorker } from '../extension/lib/controller-service-worker.mjs';
import { CONTROL_NOTES, browserControlView } from '../extension/lib/browser-control-ui.mjs';
import english from '../extension/lib/locales/en.mjs';
import {
  PRODUCT, connector, extensionSender, memoryStorage, ownedReady, settings, settle, terminalOf, uuids, waitFor,
} from './browser-control-worker-fakes.mjs';

async function noteWorker(outcomes, clock = { now: () => Date.now() }) {
  const storage = memoryStorage({ hermesBrowserSettings: settings() });
  const transport = connector();
  const worker = createControllerServiceWorker({
    storageArea: storage.area,
    connector: transport,
    product: PRODUCT,
    randomUUID: uuids(),
    extensionOrigin: 'chrome-extension://fixture',
    now: clock.now,
    executeBrowserCommand: async (frame) => outcomes[frame.command_id] || { ok: true, result: { status: 'scrolled' } },
  });
  await worker.boot();
  const ready = await ownedReady(worker, 61);
  const send = async (commandId, action) => {
    await transport.connections[0].emit({
      method: 'browser.controller.command',
      params: { command_id: commandId, action, arguments: {}, tab_id: 61, document_generation: ready.documentGeneration },
    });
    await waitFor(() => terminalOf(transport.connections[0], commandId));
    await settle();
  };
  return { worker, send };
}
const refusal = (code, message = 'refused') => ({ ok: false, error: { code, message } });

test('a screenshot that a frame withheld leaves a note for the person, and the next command clears it', async () => {
  const { worker, send } = await noteWorker({ shot: refusal('restricted_frame', 'A frame from pay.example on this page is on a page Hermes cannot read') });
  assert.equal(worker.status().lastNote, undefined);
  await send('shot', 'browser_screenshot');
  assert.deepEqual(worker.status().lastNote, { code: 'screenshot_frame', tabId: 61 });
  assert.doesNotMatch(JSON.stringify(worker.status()), /pay\.example/, 'the note carries a code, not page details');
  await send('scroll', 'browser_scroll');
  assert.equal(worker.status().lastNote, undefined);
});

test('a refused pointer action and a screenshot of a page that moved each get their own note', async () => {
  const { worker, send } = await noteWorker({
    click: refusal('restricted_frame'), moved: refusal('restricted_page'), changed: refusal('page_changed'),
  });
  await send('click', 'browser_click');
  assert.equal(worker.status().lastNote.code, 'action_frame');
  await send('moved', 'browser_screenshot');
  assert.equal(worker.status().lastNote.code, 'screenshot_page');
  await send('changed', 'browser_screenshot');
  assert.equal(worker.status().lastNote.code, 'screenshot_page');
});

test('other failures leave no note, and an old note is not shown', async () => {
  const clock = { time: 1_000_000 };
  clock.now = () => clock.time;
  const { worker, send } = await noteWorker({ other: refusal('command_error'), stale: refusal('stale_ref'), shot: refusal('restricted_frame') }, clock);
  await send('other', 'browser_click');
  await send('stale', 'browser_click');
  assert.equal(worker.status().lastNote, undefined);
  await send('shot', 'browser_screenshot');
  assert.equal(worker.status().lastNote.code, 'screenshot_frame');
  clock.time += 3 * 60_000;
  assert.equal(worker.status().lastNote, undefined);
});

// --- the window ----------------------------------------------------------------------------------------------------

const readyStatus = { connected: true, controlEnabled: true, leasedTabIds: [61], pendingCommands: 0 };
const readyView = (extra = {}) => browserControlView({
  settings: { browserControlEnabled: true },
  status: { ...readyStatus, ...extra },
  activeTab: { id: 61, url: 'https://example.com/page' },
  currentTarget: { availability: 'available', tabId: 61, leaseOwned: true },
});

test('the window says why nothing was captured or done, without page details', () => {
  const plain = readyView();
  assert.equal(plain.state, 'ready');
  assert.equal(plain.detail, 'This exact tab is attached. Hermes can operate it on the first controlled turn.');
  for (const code of Object.keys(CONTROL_NOTES)) {
    const view = readyView({ lastNote: { code, tabId: 61 } });
    assert.equal(view.state, 'ready');
    assert.equal(view.tone, 'warn');
    assert.equal(view.detail, CONTROL_NOTES[code]);
    assert.equal(view.canPause, true, 'the ready controls stay');
  }
  assert.deepEqual(Object.keys(CONTROL_NOTES).sort(), ['action_frame', 'screenshot_frame', 'screenshot_page', 'screenshot_permission']);
  // An unknown code, or a note while something else needs the person, changes nothing.
  assert.equal(readyView({ lastNote: { code: 'made_up', tabId: 61 } }).detail, plain.detail);
  assert.equal(readyView({ lastNote: { code: 'screenshot_frame', tabId: 61 }, activeAction: { action: 'browser_click', tabId: 61 } }).state, 'active');
});

test('each note is a catalogue message, so the status line translates', () => {
  const messages = new Set(Object.values(english));
  for (const text of Object.values(CONTROL_NOTES)) assert.ok(messages.has(text), text);
  assert.ok(Object.keys(english).includes('browser_control.note_screenshot_frame'));
});
