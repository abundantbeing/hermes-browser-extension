import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createWebappDialog } from '../extension/lib/hermes-webapp-dialog.mjs';
import { WEBAPP_DOCS_URL, WEBAPP_SETUP_COMMANDS } from '../extension/lib/hermes-webapp.mjs';
import { createSettingsSaveHarness, sidepanelHtml, sidepanelSource } from './helpers/settings-save-harness.mjs';

const local = { connectionMode: 'local', gatewayUrl: 'http://127.0.0.1:8642' };
const remote = { connectionMode: 'remote', gatewayUrl: 'https://hermes.example.com' };
const sidepanelDocument = () => new JSDOM(sidepanelHtml, { url: 'chrome-extension://hermes/sidepanel.html' }).window.document;

// --- the button, run through the real openHermesWeb() with the real markup ----------------------

async function panel({ settings = local, tabs = [], fetchImpl = async () => ({ status: 200, type: 'basic' }), grant = true } = {}) {
  const h = await createSettingsSaveHarness({ settings });
  const calls = { create: [], update: [], request: [], fetch: [], toasts: [] };
  const store = {};
  h.scope.browserApi = {
    tabs: {
      query: async () => tabs,
      create: async (info) => { calls.create.push(info); return { id: 50 }; },
      update: async (id, info) => { calls.update.push([id, info]); },
    },
    windows: { update: async () => {} },
    permissions: { request: async (req) => { calls.request.push(req); return grant; } },
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (patch) => { Object.assign(store, patch); },
      },
    },
  };
  h.scope.showOperationToast = (toast) => calls.toasts.push(toast);
  h.scope.webappDialog = null;
  h.scope.webappOpening = false;
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = h.document;
  globalThis.fetch = async (url, init) => { calls.fetch.push([url, init]); return fetchImpl(url, init); };
  const dialog = h.document.getElementById('webappDialog');
  return {
    h, calls, dialog,
    open: () => h.fn('openHermesWeb')(),
    visibleReasons: () => [...dialog.querySelectorAll('[data-webapp-reason]')].filter((node) => !node.hidden).map((node) => node.dataset.webappReason),
    close() {
      globalThis.document = previous.document;
      globalThis.fetch = previous.fetch;
      h.close();
    },
  };
}

test('the Hermes Web button is wired to the real opener, not to a notice', () => {
  assert.match(sidepanelSource, /els\.openFullViewButton\?\.addEventListener\('click', \(\) => \{\s*void openHermesWeb\(\);\s*\}\);/);
  assert.doesNotMatch(sidepanelSource, /showWebDeprecationNotice|hideWebDeprecationNotice|webDeprecation/);
  assert.doesNotMatch(sidepanelHtml + sidepanelSource, /being worked on|no longer opens Hermes Web/i);
  const document = sidepanelDocument();
  const button = document.getElementById('openFullViewButton');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.ok(button.querySelector('svg[aria-hidden="true"]'), 'an icon button');
  assert.equal(button.getAttribute('aria-label'), 'Hermes Web', 'its accessible name');
  assert.equal(button.getAttribute('data-i18n-aria-label'), 'ui.hermes.web');
  assert.equal(button.getAttribute('title'), 'Open Hermes Web');
  assert.equal(button.getAttribute('data-i18n-title'), 'webapp.open_title');
});

test('with Hermes Web already open in a tab, the button just switches to it', async () => {
  const p = await panel({ tabs: [{ id: 8, windowId: 2, url: 'http://127.0.0.1:9120/#/chat' }] });
  try {
    await p.open();
    assert.deepEqual(p.calls.update, [[8, { active: true }]]);
    assert.deepEqual(p.calls.create, []);
    assert.deepEqual(p.calls.fetch, []);
    assert.equal(p.dialog.hidden, true);
    assert.deepEqual(p.calls.toasts, []);
  } finally {
    p.close();
  }
});

test('with the Webapp on and answering, the button opens it and shows the sign-in hint once', async () => {
  const p = await panel({ settings: { ...local, activeProfile: 'work' } });
  try {
    await p.open();
    assert.deepEqual(p.calls.create, [{ url: 'http://127.0.0.1:9120/?profile=work', active: true }]);
    assert.equal(p.dialog.hidden, true);
    // The panel keeps the sign-in by default, so the hint says it will after the one `hermes webapp`.
    assert.deepEqual(p.calls.toasts.map(({ title, detail }) => ({ title, detail })), [{ title: 'webapp.opened_title', detail: 'webapp.hint_local_kept' }]);
    assert.equal(p.calls.fetch[0][1].credentials, 'omit');

    await p.open();
    assert.equal(p.calls.create.length, 2);
    assert.equal(p.calls.toasts.length, 1, 'the hint is shown once, not on every open');
  } finally {
    p.close();
  }
});

test('with Keep Hermes Web signed in turned off, the hint is the one that promises nothing is kept', async () => {
  const p = await panel({ settings: { ...local, webappKeepSignedIn: false } });
  try {
    await p.open();
    assert.deepEqual(p.calls.toasts.map(({ detail }) => detail), ['webapp.hint_local']);
  } finally {
    p.close();
  }
});

test('behind a sign-in gate the hint points to the page instead of to the command', async () => {
  const p = await panel({ settings: { ...remote, hermesWebAddress: 'https://web.example.com' } });
  try {
    await p.open();
    assert.deepEqual(p.calls.create, [{ url: 'https://web.example.com/', active: true }]);
    assert.equal(p.calls.toasts[0].detail, 'webapp.hint_account');
    assert.deepEqual(p.calls.request, [{ origins: ['https://web.example.com/*'] }]);
  } finally {
    p.close();
  }
});

test('with the Webapp off, a dialog shows the address that did not answer and the three commands', async () => {
  const p = await panel({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  try {
    await p.open();
    assert.deepEqual(p.calls.create, []);
    assert.equal(p.dialog.hidden, false);
    assert.equal(p.dialog.getAttribute('role'), 'dialog');
    assert.equal(p.dialog.getAttribute('aria-modal'), 'true');
    assert.equal(p.dialog.ownerDocument.activeElement, p.dialog, 'focus moves into the dialog');
    assert.deepEqual(p.visibleReasons(), ['unreachable']);
    const address = p.dialog.querySelector('#webappDialogAddress');
    assert.equal(address.hidden, false);
    assert.equal(address.textContent, 'http://127.0.0.1:9120');
    assert.deepEqual([...p.dialog.querySelectorAll('.webapp-command code')].map((node) => node.textContent), [...WEBAPP_SETUP_COMMANDS]);
    assert.deepEqual(p.calls.toasts, []);
  } finally {
    p.close();
  }
});

test('a remote connection with no address, a bad address and a declined permission each say so', async () => {
  const none = await panel({ settings: remote });
  try {
    await none.open();
    assert.deepEqual(none.visibleReasons(), ['needs-address']);
    assert.equal(none.dialog.querySelector('#webappDialogAddress').hidden, true);
    assert.deepEqual(none.calls.fetch, []);
  } finally {
    none.close();
  }
  const bad = await panel({ settings: { ...local, hermesWebAddress: 'https://user:pw@web.example.com' } });
  try {
    await bad.open();
    assert.deepEqual(bad.visibleReasons(), ['invalid-address']);
    assert.doesNotMatch(bad.dialog.textContent, /user:pw|web\.example\.com/, 'a refused address is never echoed');
    assert.deepEqual(bad.calls.fetch, []);
  } finally {
    bad.close();
  }
  const denied = await panel({ grant: false });
  try {
    await denied.open();
    assert.deepEqual(denied.visibleReasons(), ['permission-denied']);
    assert.equal(denied.dialog.querySelector('#webappDialogAddress').textContent, 'http://127.0.0.1:9120');
    assert.deepEqual(denied.calls.fetch, []);
  } finally {
    denied.close();
  }
});

test('Check again closes the dialog, returns focus to the button and tries once more', async () => {
  let up = false;
  const p = await panel({ fetchImpl: async () => { if (!up) throw new TypeError('down'); return { status: 200, type: 'basic' }; } });
  try {
    await p.open();
    assert.equal(p.dialog.hidden, false);
    up = true;
    p.h.document.getElementById('webappDialogRetry').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(p.dialog.hidden, true);
    assert.equal(p.h.document.activeElement, p.h.els.openFullViewButton);
    assert.equal(p.calls.create.length, 1, 'the retry opened it');
  } finally {
    p.close();
  }
});

// --- the dialog itself --------------------------------------------------------------------------

function dialogOn(document, extra = {}) {
  const clipboardWrites = [];
  const dialog = createWebappDialog({
    root: document,
    translate: (key) => key,
    clipboard: { writeText: async (text) => { clipboardWrites.push(text); } },
    ...extra,
  });
  return { dialog, clipboardWrites };
}

test('each command has its own copy button, named and described, that copies exactly that command', async () => {
  const document = sidepanelDocument();
  const { dialog, clipboardWrites } = dialogOn(document);
  dialog.show({ reason: 'unreachable', address: 'http://127.0.0.1:9120' });
  const buttons = [...document.querySelectorAll('#webappDialog .webapp-copy')];
  assert.equal(buttons.length, 3);
  for (const [index, button] of buttons.entries()) {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('data-i18n-aria-label'), 'webapp.copy_command');
    assert.ok(button.getAttribute('aria-label'));
    assert.ok(button.querySelector('svg[aria-hidden="true"]'));
    assert.equal(document.getElementById(button.getAttribute('aria-describedby')).textContent, WEBAPP_SETUP_COMMANDS[index]);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(clipboardWrites.at(-1), WEBAPP_SETUP_COMMANDS[index]);
    assert.equal(button.getAttribute('aria-label'), 'ui.copied');
    assert.equal(button.classList.contains('copied'), true);
    assert.equal(document.getElementById('webappCopyStatus').textContent, 'ui.copied', 'announced to a screen reader');
  }
  assert.deepEqual(clipboardWrites, [...WEBAPP_SETUP_COMMANDS]);
  dialog.hide();
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')), ['webapp.copy_command', 'webapp.copy_command', 'webapp.copy_command']);
});

test('a refused clipboard write leaves the copy button as it was', async () => {
  const document = sidepanelDocument();
  const { dialog } = dialogOn(document, { clipboard: { writeText: async () => { throw new Error('denied'); } } });
  dialog.show({ reason: 'unreachable', address: 'http://127.0.0.1:9120' });
  const button = document.querySelector('#webappDialog .webapp-copy');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(button.classList.contains('copied'), false);
});

test('the docs link is the documented page, opens safely, and the markup has no unowned text', () => {
  const document = sidepanelDocument();
  const link = document.getElementById('webappDocsLink');
  assert.equal(link.getAttribute('href'), WEBAPP_DOCS_URL);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel'), /noopener/);
  assert.match(link.getAttribute('rel'), /noreferrer/);
  for (const code of document.querySelectorAll('#webappDialog code')) assert.ok(code.hasAttribute('data-i18n-invariant'));
  assert.deepEqual(
    [...document.querySelectorAll('#webappDialog .webapp-command code')].map((node) => node.textContent),
    [...WEBAPP_SETUP_COMMANDS],
  );
  assert.equal(document.getElementById('webappDialog').getAttribute('aria-labelledby'), 'webappDialogTitle');
  assert.equal(document.getElementById('webappDialog').getAttribute('aria-describedby'), 'webappDialogDetail');
});

test('Escape closes the dialog, and Tab stays inside it', () => {
  const document = sidepanelDocument();
  let closed = 0;
  const { dialog } = dialogOn(document, { onClose: () => { closed += 1; } });
  dialog.show({ reason: 'unreachable', address: 'http://127.0.0.1:9120' });
  const root = document.getElementById('webappDialog');
  const stops = [...root.querySelectorAll('button, a[href]')];
  const last = stops.at(-1);
  last.focus();
  const tab = new document.defaultView.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  last.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(document.activeElement, stops[0], 'Tab from the last control wraps to the first');
  const back = new document.defaultView.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  stops[0].dispatchEvent(back);
  assert.equal(document.activeElement, last, 'Shift+Tab from the first control wraps to the last');
  root.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(root.hidden, true);
  assert.equal(closed, 1);
});

// --- the Settings field --------------------------------------------------

test('the Settings field is a url input that Save reads, with its own label and hint', async () => {
  const document = sidepanelDocument();
  const input = document.getElementById('hermesWebAddressInput');
  assert.equal(input.getAttribute('type'), 'url');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  assert.equal(input.closest('label').querySelector('span').getAttribute('data-i18n'), 'webapp.setting_label');
  assert.equal(document.getElementById('hermesWebAddressHint').getAttribute('data-i18n'), 'webapp.setting_hint');
  assert.ok(input.closest('#settingsPane-connections'), 'it lives with the connection settings');

  const h = await createSettingsSaveHarness({ settings: { ...local, hermesWebAddress: 'https://old.example.com' } });
  try {
    h.els.hermesWebAddressInput.value = '';
    await h.save();
    assert.equal(h.store.hermesBrowserSettings.hermesWebAddress, '', 'clearing it returns to automatic');
  } finally {
    h.close();
  }
});
