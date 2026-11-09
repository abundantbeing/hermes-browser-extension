import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createDeleteConnectionDialog } from '../extension/lib/delete-connection-dialog.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const connections = [
  { id: 'default', name: 'Home', summary: 'Local gateway · 127.0.0.1:8642', active: false },
  { id: 'work', name: 'Work', summary: 'Remote gateway · work.example.test', active: true },
  { id: 'lab', name: 'Home lab', summary: 'Remote gateway · 10.0.0.4:8642', active: false },
];

function openWindow({ onDelete = async () => {} } = {}) {
  const dom = new JSDOM(html, { url: 'chrome-extension://hermes/sidepanel.html' });
  const root = dom.window.document;
  const deleted = [];
  let closed = 0;
  const dialog = createDeleteConnectionDialog({
    root,
    translate,
    onDelete: async (id) => { deleted.push(id); await onDelete(id); },
    onClose: () => { closed += 1; },
  });
  dialog.show({ connections });
  const $ = (selector) => root.querySelector(selector);
  return {
    dom, root, dialog, deleted, $, closed: () => closed,
    rows: () => [...root.querySelectorAll('[data-delete-id]')],
    click: async (selector) => { $(selector).click(); await tick(); },
    press: (key) => $('#deleteConnectionDialog').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  };
}

test('the window lists every connection, names the one in use, and chooses nothing to begin with', () => {
  const w = openWindow();
  assert.deepEqual(w.rows().map((row) => row.querySelector('.conn-mode-title').textContent), ['Home', 'Work', 'Home lab']);
  assert.match(w.rows()[1].querySelector('.conn-mode-desc').textContent, /connections\.in_use$/);
  assert.doesNotMatch(w.rows()[0].querySelector('.conn-mode-desc').textContent, /in_use/);
  assert.ok(w.rows().every((row) => row.getAttribute('aria-checked') === 'false' && row.getAttribute('role') === 'radio'));
  assert.equal(w.$('#deleteConnectionConfirm').disabled, true, 'Delete waits for a choice');
  assert.equal(w.$('#deleteConnectionChosen').hidden, true);
  assert.ok(w.rows().every((row) => row.querySelector('.conn-mode-check')), 'each choice carries the square mark');
});

test('choosing a connection names it and enables Delete; choosing another moves the choice', async () => {
  const w = openWindow();
  await w.click('[data-delete-id="lab"]');
  assert.equal(w.$('#deleteConnectionChosen').hidden, false);
  assert.match(w.$('#deleteConnectionChosen').textContent, /connections\.delete_confirm .*Home lab/);
  assert.equal(w.$('#deleteConnectionConfirm').disabled, false);
  await w.click('[data-delete-id="default"]');
  assert.deepEqual(w.rows().map((row) => row.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.match(w.$('#deleteConnectionChosen').textContent, /Home"/);
});

test('Delete removes exactly the chosen connection, whether or not it is the one in use, and closes', async () => {
  for (const [id, label] of [['lab', 'one that is not in use'], ['work', 'the one in use']]) {
    const w = openWindow();
    await w.click(`[data-delete-id="${id}"]`);
    await w.click('#deleteConnectionConfirm');
    assert.deepEqual(w.deleted, [id], label);
    assert.equal(w.dialog.isOpen(), false);
    assert.equal(w.closed(), 1);
  }
});

test('Cancel, the close button and Escape leave without deleting anything', async () => {
  for (const leave of [(w) => w.click('#deleteConnectionCancel'), (w) => w.click('#deleteConnectionClose'), async (w) => { w.press('Escape'); }]) {
    const w = openWindow();
    await w.click('[data-delete-id="lab"]');
    await leave(w);
    assert.deepEqual(w.deleted, []);
    assert.equal(w.dialog.isOpen(), false);
  }
});

test('a refused delete keeps the window open with the choice, and says so', async () => {
  const w = openWindow({ onDelete: async () => { throw new Error('refused'); } });
  await w.click('[data-delete-id="lab"]');
  await w.click('#deleteConnectionConfirm');
  assert.equal(w.dialog.isOpen(), true);
  assert.equal(w.$('#deleteConnectionError').hidden, false);
  assert.equal(w.rows()[2].getAttribute('aria-checked'), 'true');
  assert.equal(w.$('#deleteConnectionConfirm').disabled, false, 'it can be tried again');
});

test('the window cannot be closed while the delete is under way', async () => {
  let finish;
  const w = openWindow({ onDelete: () => new Promise((resolve) => { finish = resolve; }) });
  await w.click('[data-delete-id="lab"]');
  await w.click('#deleteConnectionConfirm');
  w.press('Escape');
  assert.equal(w.dialog.isOpen(), true, 'Escape waits');
  finish();
  await tick();
  assert.equal(w.dialog.isOpen(), false);
});

test('focus starts on the first connection, inside the window', () => {
  const w = openWindow();
  assert.equal(w.root.activeElement, w.rows()[0]);
});

test('opening it again starts with nothing chosen', async () => {
  const w = openWindow();
  await w.click('[data-delete-id="lab"]');
  w.dialog.hide();
  w.dialog.show({ connections });
  assert.equal(w.$('#deleteConnectionConfirm').disabled, true);
  assert.ok(w.rows().every((row) => row.getAttribute('aria-checked') === 'false'));
});

test('while a delete runs, focus pulled outside comes back to a control that still takes it', async () => {
  let finish;
  const w = openWindow({ onDelete: () => new Promise((resolve) => { finish = resolve; }) });
  await w.click('[data-delete-id="lab"]');
  await w.click('#deleteConnectionConfirm');
  assert.ok(w.rows().every((row) => row.disabled), 'every row is disabled while it runs');
  const outside = w.root.createElement('button');
  w.root.body.append(outside);
  outside.focus();
  assert.equal(w.root.activeElement, w.$('#deleteConnectionClose'), 'focus lands on the enabled close button, not a disabled row');
  w.press('Escape');
  assert.equal(w.dialog.isOpen(), true, 'Escape still reaches the window and waits');
  finish();
  await tick();
  assert.equal(w.dialog.isOpen(), false);
});
