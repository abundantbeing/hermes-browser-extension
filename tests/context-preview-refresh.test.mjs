import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTEXT_SCOPE_MODES } from '../extension/lib/context-scope.mjs';
import {
  contextPreviewEventApplies,
  createContextPreviewScheduler,
  previewKeepsPageContext,
  sessionSwitchedFromSettings,
} from '../extension/lib/context-preview-refresh.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const followMode = CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE;
const pinnedMode = CONTEXT_SCOPE_MODES.PINNED_TAB;
const chatOnlyMode = CONTEXT_SCOPE_MODES.CHAT_ONLY;

// Fake clock so the debounce is tested without real timers.
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      nextId += 1;
      timers.set(nextId, { at: now + ms, fn });
      return nextId;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a burst of preview events runs one refresh after the debounce delay', async () => {
  const clock = fakeClock();
  const runs = [];
  const scheduler = createContextPreviewScheduler({
    run: (events) => runs.push(events),
    delayMs: 400,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  scheduler.schedule({ kind: 'activated', tabId: 1 });
  clock.advance(200);
  scheduler.schedule({ kind: 'updated', tabId: 1 });
  clock.advance(399);
  await flush();
  assert.equal(runs.length, 0, 'the window restarts with each new event');
  clock.advance(1);
  await flush();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].map((event) => event.kind), ['activated', 'updated']);
});

test('a turn that is streaming defers the preview refresh until it ends', async () => {
  const clock = fakeClock();
  let streaming = true;
  const runs = [];
  const scheduler = createContextPreviewScheduler({
    run: (events) => runs.push(events),
    isStreaming: () => streaming,
    delayMs: 400,
    streamingRetryMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  scheduler.schedule({ kind: 'focus' });
  clock.advance(400);
  await flush();
  assert.equal(runs.length, 0, 'nothing runs while the turn streams');
  streaming = false;
  clock.advance(1000);
  await flush();
  assert.equal(runs.length, 1, 'the deferred refresh runs once the turn ends');
});

test('follow-active scope refreshes for the window active tab, not background tabs', () => {
  const state = { scopeMode: followMode, activeTabId: 1 };
  assert.equal(contextPreviewEventApplies({ kind: 'activated', tabId: 1 }, state), true);
  assert.equal(contextPreviewEventApplies({ kind: 'updated', tabId: 1 }, state), true);
  assert.equal(contextPreviewEventApplies({ kind: 'updated', tabId: 9 }, state), false, 'a background tab finishing a load is ignored');
  assert.equal(contextPreviewEventApplies({ kind: 'activated', tabId: 9 }, state), false, 'another window activating its tab is ignored');
  assert.equal(contextPreviewEventApplies({ kind: 'updated', tabId: 1 }, { scopeMode: followMode, activeTabId: null }), false);
});

test('focus and session events refresh in follow-active scope', () => {
  const state = { scopeMode: followMode, activeTabId: 1 };
  assert.equal(contextPreviewEventApplies({ kind: 'focus' }, state), true);
  assert.equal(contextPreviewEventApplies({ kind: 'session' }, state), true);
});

test('pinned scope only follows the pinned tab updates, as the tab listeners did before', () => {
  const state = { scopeMode: pinnedMode, pinnedTabId: 7, activeTabId: 1 };
  assert.equal(contextPreviewEventApplies({ kind: 'activated', tabId: 1 }, state), false);
  assert.equal(contextPreviewEventApplies({ kind: 'activated', tabId: 7 }, state), false);
  assert.equal(contextPreviewEventApplies({ kind: 'updated', tabId: 7 }, state), true);
  assert.equal(contextPreviewEventApplies({ kind: 'updated', tabId: 1 }, state), false);
  assert.equal(contextPreviewEventApplies({ kind: 'focus' }, state), false);
  assert.equal(contextPreviewEventApplies({ kind: 'session' }, state), true);
});

test('chat-only scope never refreshes the preview from any event', () => {
  const state = { scopeMode: chatOnlyMode, activeTabId: 1, pinnedTabId: null };
  for (const event of [{ kind: 'activated', tabId: 1 }, { kind: 'updated', tabId: 1 }, { kind: 'focus' }, { kind: 'session' }]) {
    assert.equal(contextPreviewEventApplies(event, state), false, JSON.stringify(event));
  }
});

test('page text survives a preview refresh only while the tab and URL are unchanged', () => {
  const tab = { id: 4, url: 'https://example.com/a' };
  assert.equal(previewKeepsPageContext(tab, { id: 4, url: 'https://example.com/a' }), true);
  assert.equal(previewKeepsPageContext(tab, { id: 4, url: 'https://example.com/b' }), false, 'SPA URL change drops the old text');
  assert.equal(previewKeepsPageContext(tab, { id: 5, url: 'https://example.com/a' }), false);
  assert.equal(previewKeepsPageContext(null, tab), false);
  assert.equal(previewKeepsPageContext(tab, null), false);
});

test('a settings write counts as a session switch only when the durable session changes', () => {
  assert.equal(sessionSwitchedFromSettings({ sessionId: 'a' }, { sessionId: 'b' }), true);
  assert.equal(sessionSwitchedFromSettings({ sessionId: 'a', sessionTitle: 'x' }, { sessionId: 'a', sessionTitle: 'y' }), false);
  assert.equal(sessionSwitchedFromSettings({}, { sessionId: 'b' }), true);
  assert.equal(sessionSwitchedFromSettings({ sessionId: 'a' }, { sessionId: '' }), false);
});

test('side panel wires tab, navigation, window focus and session switches to the preview', () => {
  const source = read('extension/sidepanel.js');
  assert.match(source, /onActivated\?\.addListener\?\.\(\(activeInfo\) => \{\s*scheduleContextPreviewRefresh\(\{ kind: 'activated', tabId: activeInfo\?\.tabId \}\);/);
  assert.match(source, /onUpdated\?\.addListener\?\.\(\(tabId, changeInfo\) => \{[\s\S]*?scheduleContextPreviewRefresh\(\{ kind: 'updated', tabId \}\);/);
  assert.match(source, /onFocusChanged\?\.addListener\?\.\(\(windowId\) => \{\s*if \(windowId === WINDOW_ID_NONE\) return;\s*scheduleContextPreviewRefresh\(\{ kind: 'focus' \}\);/);
  assert.match(source, /sessionSwitchedFromSettings\(changes\.hermesBrowserSettings\.oldValue, changes\.hermesBrowserSettings\.newValue\)[\s\S]*?kind: 'session'/);
});

test('auto-refresh never runs the full capture path', () => {
  const source = read('extension/sidepanel.js');
  const region = source.slice(
    source.indexOf('async function refreshContextPreview()'),
    source.indexOf('function scheduleContextPreviewRefresh('),
  );
  assert.ok(region.length > 0);
  assert.doesNotMatch(region, /getPageContext|sendContentMessage|HERMES_GET_PAGE_CONTEXT|getYoutubeTranscript|executeScript|refreshContext\(/);
  // Tab listeners that used to call the full capture now only schedule the preview.
  const listeners = source.slice(source.indexOf('browserApi.tabs?.onActivated'), source.indexOf('browserApi.tabs?.onRemoved'));
  assert.doesNotMatch(listeners, /refreshContext\(\)/);
});

test('the preview checks consent before it reads any tab', () => {
  const source = read('extension/sidepanel.js');
  const body = source.slice(
    source.indexOf('async function runContextPreviewEvents('),
    source.indexOf('function scheduleContextPreviewRefresh('),
  );
  const gate = body.indexOf('effectiveContextGate(contextScope)');
  const tabRead = body.indexOf('activeTab()');
  assert.ok(gate >= 0 && tabRead > gate, 'the consent gate must run before any tab read');
  assert.match(body, /CHAT_ONLY\) return currentContext/);
});

test('send still performs the full fresh capture', () => {
  const source = read('extension/sidepanel.js');
  assert.match(source, /gatedContextOverride \|\| await refreshContext\(\);/);
});
