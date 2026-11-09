import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createAddConnectionDialog } from '../extension/lib/add-connection-dialog.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function openWindow({ probe = async () => ({ ok: true, status: 'ok' }), show = {} } = {}) {
  const dom = new JSDOM(html, { url: 'chrome-extension://hermes/sidepanel.html' });
  const root = dom.window.document;
  const added = [];
  const opened = [];
  const savedOptions = [];
  let closed = 0;
  const dialog = createAddConnectionDialog({
    root,
    translate,
    probe,
    openAddress: (address) => opened.push(address),
    onAdd: async (made) => { added.push(made); },
    onSaveOptions: async (options) => { savedOptions.push(options); },
    onClose: () => { closed += 1; },
  });
  dialog.show(show);
  const $ = (selector) => root.querySelector(selector);
  const type = (selector, value) => {
    const input = $(selector);
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const press = (selector, key, init = {}) => $(selector).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
  return {
    dom, root, dialog, added, opened, savedOptions, $, type, press,
    closed: () => closed,
    step: () => [...root.querySelectorAll('[data-add-step]')].find((panel) => !panel.hidden)?.dataset.addStep,
    click: async (selector) => { $(selector).click(); await tick(); },
  };
}

test('the window opens on where the connection is, with a local gateway chosen', () => {
  const w = openWindow();
  assert.equal(w.step(), 'where');
  assert.equal($check(w, 'local'), 'true');
  assert.equal(w.$('#addConnectionTitle').textContent, 'addconn.title_where');
  assert.match(w.$('#addConnectionSteps').textContent, /"current":1,"total":3/);
  assert.equal(w.$('#addConnectionBack').hidden, true, 'there is nothing to go back to on the first step');
  assert.equal(w.$('#addConnectionNext').textContent, 'ui.next');
});

function $check(w, type) {
  return w.$(`[data-add-type="${type}"]`).getAttribute('aria-checked');
}

test('Next walks the steps, Back returns, and the last step adds', async () => {
  const w = openWindow();
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'signin');
  assert.equal(w.$('#addConnectionBack').hidden, false);
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'options');
  assert.equal(w.$('#addConnectionNext').textContent, 'addconn.add');
  await w.click('#addConnectionBack');
  assert.equal(w.step(), 'signin');
});

test('Hermes Cloud is one step and adds straight away without a test', async () => {
  let probed = 0;
  const w = openWindow({ probe: async () => { probed += 1; return { ok: true, status: 'ok' }; } });
  await w.click('[data-add-type="cloud"]');
  assert.equal(w.$('#addConnectionAddressField').hidden, true);
  assert.equal(w.$('#addConnectionNext').textContent, 'addconn.add');
  await w.click('#addConnectionNext');
  assert.equal(probed, 0);
  assert.equal(w.added.length, 1);
  assert.equal(w.added[0].connection.connectionMode, 'cloud');
  assert.equal(w.dialog.isOpen(), false);
});

test('a remote connection is held on its step until the address and key are given', async () => {
  const w = openWindow();
  await w.click('[data-add-type="remote"]');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'where');
  assert.equal(w.$('#addConnectionAddressError').hidden, false);
  assert.equal(w.$('#addConnectionAddressError').textContent, 'addconn.err_address_required');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  assert.equal(w.$('#addConnectionAddressError').hidden, true, 'typing clears the message');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'signin');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'signin');
  assert.equal(w.$('#addConnectionKeyError').textContent, 'addconn.err_key_required');
  w.type('#addConnectionKey', 'a-key');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'options');
});

test('choosing Browser asks for no key and says what happens next', async () => {
  const w = openWindow();
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  await w.click('#addConnectionNext');
  await w.click('[data-add-method="browser"]');
  assert.equal(w.$('#addConnectionKeyField').hidden, true);
  assert.equal(w.$('#addConnectionBrowserNote').hidden, false);
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'options');
});

test('a connection that tests well is added with its name and settings, and the window closes', async () => {
  const probes = [];
  const w = openWindow({ probe: async (request) => { probes.push(request); return { ok: true, status: 'ok' }; } });
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  w.type('#addConnectionName', '  Studio  ');
  await w.click('#addConnectionNext');
  w.type('#addConnectionKey', 'studio-key');
  await w.click('#addConnectionNext');
  await w.click('#addConnectionAddHeader');
  w.type('[data-header-field="name"]', 'X-Proxy-Token');
  w.type('[data-header-field="value"]', 'proxy-value');
  await w.click('#addConnectionNext');
  const { signal, ...asked } = probes[0];
  assert.ok(signal && typeof signal.addEventListener === 'function', 'the test can be cancelled');
  assert.deepEqual(asked, {
    gatewayUrl: 'https://hermes.example.com', apiKey: 'studio-key', headers: [{ name: 'X-Proxy-Token', value: 'proxy-value' }],
  });
  assert.equal(w.added[0].name, 'Studio');
  assert.equal(w.added[0].connection.apiKey, 'studio-key');
  assert.deepEqual(w.added[0].connection.connectionHeaders, [{ name: 'X-Proxy-Token', value: 'proxy-value' }]);
  assert.equal(w.dialog.isOpen(), false);
  assert.equal(w.closed(), 1);
});

test('a connection that fails its test is not added, and can be retried or added untested', async () => {
  let answer = { ok: false, status: 'unreachable' };
  const w = openWindow({ probe: async () => answer });
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://box.example.com');
  await w.click('#addConnectionNext');
  w.type('#addConnectionKey', 'k');
  await w.click('#addConnectionNext');
  await w.click('#addConnectionNext');
  assert.equal(w.added.length, 0);
  assert.equal(w.dialog.isOpen(), true);
  assert.equal(w.$('#addConnectionResult').hidden, false);
  assert.match(w.$('#addConnectionResult').textContent, /addconn\.result_unreachable addconn\.result_cert/);
  assert.equal(w.$('#addConnectionNext').textContent, 'addconn.try_again');
  assert.equal(w.$('#addConnectionAnyway').hidden, false);
  assert.equal(w.$('#addConnectionOpenAddress').hidden, false, 'an https address can be opened so the browser can ask about its certificate');
  await w.click('#addConnectionOpenAddress');
  assert.deepEqual(w.opened, ['https://box.example.com']);
  answer = { ok: true, status: 'ok' };
  await w.click('#addConnectionNext');
  assert.equal(w.added.length, 1);
});

test('Add without testing skips the test, and a plain http address offers no certificate help', async () => {
  const w = openWindow({ probe: async () => ({ ok: false, status: 'unauthorized' }) });
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'http://192.168.1.20:8642');
  await w.click('#addConnectionNext');
  w.type('#addConnectionKey', 'wrong');
  await w.click('#addConnectionNext');
  await w.click('#addConnectionNext');
  assert.match(w.$('#addConnectionResult').textContent, /addconn\.result_unauthorized/);
  assert.equal(w.$('#addConnectionOpenAddress').hidden, true);
  await w.click('#addConnectionAnyway');
  assert.equal(w.added.length, 1);
});

test('signing in through the browser to a dashboard is not tested before it is added', async () => {
  let probed = 0;
  const w = openWindow({ probe: async () => { probed += 1; return { ok: true, status: 'ok' }; } });
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  await w.click('#addConnectionNext');
  await w.click('[data-add-method="browser"]');
  await w.click('#addConnectionNext');
  await w.click('#addConnectionNext');
  assert.equal(probed, 0);
  assert.equal(w.added[0].connection.connectionTransport, 'remote-dashboard');
});

test('header rows are added and removed, refused when the browser owns the name, and capped at ten', async () => {
  const w = openWindow();
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  await w.click('#addConnectionNext');
  w.type('#addConnectionKey', 'k');
  await w.click('#addConnectionNext');
  await w.click('#addConnectionAddHeader');
  w.type('[data-header-field="name"]', 'Host');
  w.type('[data-header-field="value"]', 'x');
  await w.click('#addConnectionNext');
  assert.equal(w.added.length, 0, 'a refused header holds the step');
  assert.equal(w.$('[data-header-error="0"]').textContent, 'addconn.err_header_blocked');
  await w.click('[data-header-remove="0"]');
  assert.equal(w.root.querySelectorAll('.add-connection-header-row').length, 0);
  for (let count = 0; count < 12; count += 1) await w.click('#addConnectionAddHeader');
  assert.equal(w.root.querySelectorAll('.add-connection-header-row').length, 10);
  assert.equal(w.$('#addConnectionAddHeader').disabled, true);
});

test('Escape closes the window, and Enter that picks an input-method character does not move on', async () => {
  const w = openWindow();
  w.press('#addConnectionAddress', 'Enter', { isComposing: true });
  await tick();
  assert.equal(w.step(), 'where');
  w.press('#addConnectionAddress', 'Enter');
  await tick();
  assert.equal(w.step(), 'signin', 'a plain Enter is Next');
  w.press('#addConnectionKey', 'Escape');
  assert.equal(w.dialog.isOpen(), false);
});

test('the certificate group is for a remote gateway only', async () => {
  const w = openWindow();
  assert.equal(w.$('#addConnectionCertGroup').hidden, true);
  await w.click('[data-add-type="remote"]');
  assert.equal(w.$('#addConnectionCertGroup').hidden, false);
  w.$('#addConnectionTrust').click();
  w.type('#addConnectionAddress', 'https://box.example.com');
  await w.click('#addConnectionNext');
  w.type('#addConnectionKey', 'k');
  await w.click('#addConnectionNext');
  await w.click('#addConnectionNext');
  assert.equal(w.added[0].connection.connectionTrustSelfSigned, true);
});

const inUse = {
  connectionMode: 'remote', gatewayUrl: 'https://hermes.example.com', apiKey: 'k',
  connectionHeaders: [{ name: 'X-Proxy-Token', value: 'proxy-value' }], connectionTrustSelfSigned: true,
};

test('Options opens on one step for the connection in use, with what it has now', async () => {
  const w = openWindow({ show: { mode: 'options', name: 'Studio', connection: inUse } });
  assert.equal(w.step(), 'options');
  assert.equal(w.$('#addConnectionKicker').textContent, 'Studio');
  assert.equal(w.$('#addConnectionBack').hidden, true);
  assert.equal(w.$('#addConnectionSteps').hidden, true, 'one step needs no count');
  assert.equal(w.$('#addConnectionNext').textContent, 'addconn.save_options');
  assert.equal(w.$('[data-header-field="name"]').value, 'X-Proxy-Token');
  assert.equal(w.$('[data-header-field="value"]').value, 'proxy-value');
  assert.equal(w.$('#addConnectionTrust').checked, true);
  assert.equal(w.$('#addConnectionCertGroup').hidden, false);
});

test('saving options hands over the headers and the certificate note without testing or adding anything', async () => {
  let probed = 0;
  const w = openWindow({ probe: async () => { probed += 1; return { ok: true, status: 'ok' }; }, show: { mode: 'options', name: 'Studio', connection: inUse } });
  await w.click('#addConnectionAddHeader');
  w.type('[data-header-field="name"][data-header-index="1"]', 'X-Tenant');
  w.type('[data-header-field="value"][data-header-index="1"]', 'acme');
  w.$('#addConnectionTrust').click();
  await w.click('#addConnectionNext');
  assert.deepEqual(w.savedOptions, [{
    headers: [{ name: 'X-Proxy-Token', value: 'proxy-value' }, { name: 'X-Tenant', value: 'acme' }],
    trustSelfSigned: false,
  }]);
  assert.equal(probed, 0);
  assert.equal(w.added.length, 0);
  assert.equal(w.dialog.isOpen(), false);
});

test('clearing every header saves an empty list, and a refused header keeps the window open', async () => {
  const w = openWindow({ show: { mode: 'options', name: 'Studio', connection: inUse } });
  w.type('[data-header-field="name"]', 'Cookie');
  await w.click('#addConnectionNext');
  assert.equal(w.savedOptions.length, 0);
  assert.equal(w.$('[data-header-error="0"]').textContent, 'addconn.err_header_blocked');
  await w.click('[data-header-remove="0"]');
  await w.click('#addConnectionNext');
  assert.deepEqual(w.savedOptions, [{ headers: [], trustSelfSigned: true }]);
});

test('Add after Options starts again from the first step with an empty draft', async () => {
  const w = openWindow({ show: { mode: 'options', name: 'Studio', connection: inUse } });
  w.dialog.hide();
  w.dialog.show();
  assert.equal(w.step(), 'where');
  assert.equal(w.$('#addConnectionKicker').textContent, 'addconn.kicker');
  assert.equal(w.root.querySelectorAll('.add-connection-header-row').length, 0);
});

function pendingProbe() {
  const asked = [];
  return {
    asked,
    probe: (request) => new Promise((resolve) => { asked.push({ request, resolve }); }),
  };
}

async function fillRemote(w) {
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  await w.click('#addConnectionNext');
  w.type('#addConnectionKey', 'studio-key');
  await w.click('#addConnectionNext');
}

test('closing the window while the test is waiting cancels it, and a late answer adds nothing', async () => {
  const pending = pendingProbe();
  const w = openWindow({ probe: pending.probe });
  await fillRemote(w);
  await w.click('#addConnectionNext');
  assert.equal(pending.asked.length, 1);
  assert.equal(w.$('#addConnectionClose').disabled, false);
  await w.click('#addConnectionClose');
  assert.equal(pending.asked[0].request.signal.aborted, true, 'the request itself is cancelled');
  pending.asked[0].resolve({ ok: true, status: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(w.added.length, 0, 'no connection was added');
  assert.equal(w.dialog.isOpen(), false);
});

test('Escape cancels a waiting test the same way as the close button', async () => {
  const pending = pendingProbe();
  const w = openWindow({ probe: pending.probe });
  await fillRemote(w);
  await w.click('#addConnectionNext');
  w.press('#addConnectionKey', 'Escape');
  pending.asked[0].resolve({ ok: true, status: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(w.added.length, 0);
});

test('a test left over from a closed window never reaches a window opened after it', async () => {
  const pending = pendingProbe();
  const w = openWindow({ probe: pending.probe });
  await fillRemote(w);
  await w.click('#addConnectionNext');
  w.dialog.hide();
  w.dialog.show();
  await fillRemote(w);
  await w.click('#addConnectionNext');
  assert.equal(pending.asked.length, 2);
  pending.asked[0].resolve({ ok: true, status: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(w.added.length, 0, 'the old answer is not the new window\'s');
  pending.asked[1].resolve({ ok: true, status: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(w.added.length, 1, 'the new window\'s own answer adds');
  assert.equal(w.added[0].connection.apiKey, 'studio-key');
});

test('closing while the connection is being saved waits for the save instead of leaving it half done', async () => {
  let finishSave;
  const dom = new JSDOM(html, { url: 'chrome-extension://hermes/sidepanel.html' });
  const root = dom.window.document;
  const added = [];
  const dialog = createAddConnectionDialog({
    root,
    translate,
    probe: async () => ({ ok: true, status: 'ok' }),
    onAdd: (made) => new Promise((resolve) => { added.push(made); finishSave = resolve; }),
  });
  dialog.show();
  root.querySelector('[data-add-type="remote"]').click();
  const address = root.querySelector('#addConnectionAddress');
  address.value = 'https://hermes.example.com';
  address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelector('#addConnectionNext').click();
  await tick();
  const key = root.querySelector('#addConnectionKey');
  key.value = 'studio-key';
  key.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelector('#addConnectionNext').click();
  await tick();
  root.querySelector('#addConnectionNext').click();
  await tick();
  await tick();
  assert.equal(added.length, 1);
  root.querySelector('#addConnectionClose').click();
  assert.equal(dialog.isOpen(), true, 'the save is under way and the window stays until it ends');
  finishSave();
  await tick();
  assert.equal(dialog.isOpen(), false);
});

test('Options puts focus inside the window, on something the person can see', () => {
  const w = openWindow({ show: { mode: 'options', name: 'Studio', connection: { ...inUse, connectionHeaders: [] } } });
  assert.ok(w.$('#addConnectionDialog').contains(w.root.activeElement), 'focus is in the window');
  assert.equal(w.root.activeElement.id, 'addConnectionAddHeader');
  const withHeader = openWindow({ show: { mode: 'options', name: 'Studio', connection: inUse } });
  assert.equal(withHeader.root.activeElement.dataset.headerField, 'name', 'the first header name when there is one');
  const adding = openWindow();
  assert.equal(adding.root.activeElement.dataset.addType, 'local', 'Add focuses the chosen tile');
});

test('moving to a step puts focus on its chosen tile, its first field, or its first button', async () => {
  const w = openWindow();
  await w.click('[data-add-type="remote"]');
  w.type('#addConnectionAddress', 'https://hermes.example.com');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'signin');
  assert.equal(w.root.activeElement.dataset.addMethod, 'token');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'signin', 'a key is required first');
  w.type('#addConnectionKey', 'studio-key');
  await w.click('#addConnectionNext');
  assert.equal(w.step(), 'options');
  assert.equal(w.root.activeElement.id, 'addConnectionAddHeader');
  assert.notEqual(w.root.activeElement.id, 'addConnectionTrust', 'never the hidden switch input');
});

