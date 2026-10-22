import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createMessageThreadUi } from '../extension/lib/message-thread-ui.mjs';

function fixture(options = {}) {
  const { document, window } = parseHTML('<html><body><section id="messages"></section></body></html>');
  const root = document.querySelector('#messages');
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(node) { this.targets.push(node); }
    disconnect() { this.targets = []; }
  }
  const controller = createMessageThreadUi({
    root, document, window, ResizeObserver: Observer, requestFrame: (callback) => callback(),
    locale: () => 'en-US', now: () => new Date(2026, 8, 30, 14).getTime(),
    ...options,
  });
  const add = (record, extra = {}) => {
    const row = document.createElement('div'); row.className = 'message-row';
    const node = document.createElement('article'); node.className = `message ${record.role}`;
    node.innerHTML = '<div class="message-content">reply</div>'; row.append(node);
    controller.attach({ row, node, record, ...extra }); root.append(row);
    return { row, node };
  };
  return { root, document, window, controller, add, observers };
}
const ts = new Date(2026, 8, 30, 12).getTime();

test('one shared observer watches bubble and row; reset releases detached nodes', () => {
  const f = fixture(); f.add({ role: 'user', ts }); f.add({ role: 'assistant', ts });
  assert.equal(f.observers.length, 1); assert.equal(f.observers[0].targets.length, 4);
  f.controller.reset(); assert.equal(f.observers[0].targets.length, 0);
});
test('1:1 user and restored assistant rails both carry their time and copy', () => {
  const f = fixture(); const a = f.add({ role: 'user', ts }); const b = f.add({ role: 'assistant', ts });
  assert.ok(a.row.querySelector('time'), 'a 1:1 user message shows its time');
  const time = b.row.querySelector('.message-rail > time.message-time');
  assert.ok(time, 'a restored 1:1 assistant reply shows its stored time');
  assert.equal(time.getAttribute('datetime'), new Date(ts).toISOString());
  assert.equal(time.textContent, a.row.querySelector('time').textContent, 'same format as the user time');
  assert.ok(b.row.querySelector('.message-action-copy'), 'a 1:1 assistant reply still gets copy');
});
test('a live reply shows no time while streaming, then the time it finished', () => {
  let clock = ts; const f = fixture({ now: () => clock });
  const record = { role: 'assistant', ts: null };
  const a = f.add(record, { streaming: true });
  assert.equal(a.row.querySelector('time'), null, 'no time while the reply streams');
  assert.ok(a.row.querySelector('.message-rail .message-action-copy'), 'the rail is already there, so the time adds no row');
  clock = ts + 90_000;
  f.controller.setStreaming(a.row, false);
  const time = a.row.querySelector('.message-rail > time.message-time');
  assert.ok(time, 'the finished reply shows its time');
  assert.equal(time.getAttribute('datetime'), new Date(ts + 90_000).toISOString());
  assert.equal(record.ts, ts + 90_000, 'the finish time stays on the record for later rail renders');
  assert.equal(a.row.querySelectorAll('.message-rail').length, 1);
  assert.equal(a.row.querySelector('.message-action-copy').disabled, false);
  f.controller.refreshActions();
  assert.equal(a.row.querySelector('time').getAttribute('datetime'), new Date(ts + 90_000).toISOString());
});
test('a streamed reply that already has a known time keeps it', () => {
  let clock = ts; const f = fixture({ now: () => clock });
  const a = f.add({ role: 'assistant', ts }, { streaming: true });
  assert.equal(a.row.querySelector('time'), null);
  clock = ts + 60_000; f.controller.setStreaming(a.row, false);
  assert.equal(a.row.querySelector('time').getAttribute('datetime'), new Date(ts).toISOString());
});
test('restored assistant without a stored time stays timeless', () => {
  const f = fixture(); const a = f.add({ role: 'assistant', ts: null });
  assert.equal(a.row.querySelector('time'), null, 'unknown stays unknown, never the load time');
});
test('room assistant receives its known time without gaining edit controls', () => {
  const f = fixture({ canRewind: () => true }); const a = f.add({ role: 'assistant', ts }, { room: true });
  assert.ok(a.row.querySelector('time')); assert.equal(a.row.querySelector('.message-action-edit'), null);
});
test('unknown timestamp creates neither a time nor a calendar divider', () => {
  const f = fixture(); const a = f.add({ role: 'user', ts: null });
  assert.equal(a.row.querySelector('time'), null); assert.equal(f.root.querySelector('.message-day-divider'), null);
});
test('day dividers skip unknown times and preserve last known day', () => {
  const f = fixture(); f.add({ role: 'user', ts }); f.add({ role: 'assistant', ts: null });
  f.add({ role: 'user', ts: ts + 1000 });
  assert.equal(f.root.querySelectorAll('.message-day-divider').length, 1);
});
test('run grouping requires same role, speaker and thread and no new day', () => {
  const f = fixture(); const a = f.add({ role: 'assistant', ts, speaker: 'alpha', thread: 'one' });
  const b = f.add({ role: 'assistant', ts, speaker: 'alpha', thread: 'one' });
  const c = f.add({ role: 'assistant', ts, speaker: 'beta', thread: 'one' });
  assert.ok(a.row.classList.contains('has-run-next')); assert.ok(b.row.classList.contains('is-run-continuation'));
  assert.equal(c.row.classList.contains('is-run-continuation'), false);
});
test('history rows never animate; explicitly new rows animate only once', () => {
  const f = fixture(); const a = f.add({ role: 'user', ts }); const b = f.add({ role: 'user', ts }, { entering: true });
  assert.equal(a.row.classList.contains('is-entering'), false); assert.ok(b.row.classList.contains('is-entering'));
  b.row.dispatchEvent(new f.window.Event('animationend')); assert.equal(b.row.classList.contains('is-entering'), false);
});
test('only one row is pinned and outside click or Escape unpins it', () => {
  const f = fixture(); const a = f.add({ role: 'user', ts }); const b = f.add({ role: 'assistant', ts });
  a.node.dispatchEvent(new f.window.Event('click', { bubbles: true })); assert.ok(a.row.classList.contains('is-pinned'));
  b.node.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(a.row.classList.contains('is-pinned'), false); assert.ok(b.row.classList.contains('is-pinned'));
  const escape = new f.window.Event('keydown'); Object.defineProperty(escape, 'key', { value: 'Escape' });
  f.document.dispatchEvent(escape); assert.equal(b.row.classList.contains('is-pinned'), false);
  a.node.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  f.document.body.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(a.row.classList.contains('is-pinned'), false);
});
test('text selection and interactive descendants never toggle message pins', () => {
  const f = fixture(); const a = f.add({ role: 'user', ts });
  f.window.getSelection = () => ({ isCollapsed: false, anchorNode: a.node });
  a.node.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(a.row.classList.contains('is-pinned'), false);
  f.window.getSelection = () => null;
  const link = f.document.createElement('a'); a.node.append(link);
  link.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  assert.equal(a.row.classList.contains('is-pinned'), false);
});
test('assistant placement stays below even when ample room exists', () => {
  const f = fixture(); const a = f.add({ role: 'assistant', ts });
  Object.defineProperty(a.row, 'clientWidth', { value: 500 });
  Object.defineProperty(a.node, 'offsetWidth', { value: 100 });
  Object.defineProperty(a.row.querySelector('.message-rail'), 'scrollWidth', { value: 50 });
  f.controller.applyPlacement(a.row); assert.equal(a.row.dataset.actions, 'below');
});
test('streaming copy is disabled until explicitly enabled', () => {
  const f = fixture(); const a = f.add({ role: 'assistant', ts }, { streaming: true });
  assert.equal(a.row.querySelector('.message-action-copy').disabled, true);
});
test('refreshActions removes gated edit and restore instead of disabling them', () => {
  let allowed = true; const f = fixture({ canRewind: () => allowed });
  const a = f.add({ role: 'user', ts }); assert.ok(a.row.querySelector('.message-action-edit'));
  allowed = false; f.controller.refreshActions(); assert.equal(a.row.querySelector('.message-action-edit'), null);
});
