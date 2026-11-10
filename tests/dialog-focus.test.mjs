import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createAddConnectionDialog } from '../extension/lib/add-connection-dialog.mjs';
import { createDeleteConnectionDialog } from '../extension/lib/delete-connection-dialog.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const connections = [
  { id: 'default', name: 'Home', summary: 'Local gateway', active: true },
  { id: 'lab', name: 'Lab', summary: 'Remote gateway', active: false },
];

function page() {
  const dom = new JSDOM(`${html}<button id="behind">behind</button>`, { url: 'chrome-extension://hermes/sidepanel.html' });
  return { dom, root: dom.window.document, behind: dom.window.document.getElementById('behind') };
}

test('focus that something behind the Delete window takes comes straight back inside it', () => {
  const { root, behind } = page();
  const dialog = createDeleteConnectionDialog({ root });
  dialog.show({ connections });
  const dialogNode = root.getElementById('deleteConnectionDialog');
  behind.focus();
  assert.ok(dialogNode.contains(root.activeElement), 'focus is back in the window');
  root.querySelector('[data-delete-id="lab"]').click();
  behind.focus();
  assert.equal(root.activeElement.dataset.deleteId, 'lab', 'on the chosen connection');
});

test('focus taken from the Add window comes back to the step it is on', () => {
  const { root, behind } = page();
  const dialog = createAddConnectionDialog({ root });
  dialog.show();
  behind.focus();
  assert.equal(root.activeElement.dataset.addType, 'local');
});

test('once a window is closed it no longer pulls focus', () => {
  const { root, behind } = page();
  const del = createDeleteConnectionDialog({ root });
  del.show({ connections });
  del.hide();
  const add = createAddConnectionDialog({ root });
  add.show();
  add.hide();
  behind.focus();
  assert.equal(root.activeElement, behind);
});
