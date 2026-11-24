import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createBrowserControlDialog } from '../extension/lib/browser-control-dialog.mjs';

function fixture({ selected = [10] } = {}) {
  const { document } = parseHTML('<html><body><button id="launch"></button><dialog><button id="close"></button><select id="scope"><option value="this-tab">This tab</option><option value="selected-tabs">Selected tabs</option><option value="task-set">Task set</option></select><small id="help"></small><fieldset id="tabs"><div id="list"></div></fieldset><button id="apply"></button><small id="hint"></small></dialog></body></html>');
  const dialog = document.querySelector('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new document.defaultView.Event('close')); };
  const calls = [];
  const byId = id => document.getElementById(id);
  // linkedom exposes a getter-only select.value; provide the browser setter contract.
  Object.defineProperty(byId('scope'), 'value', { value: 'this-tab', writable: true });
  const ui = createBrowserControlDialog({ dialog, launcher: byId('launch'), closeButton: byId('close'), focusFallback: null,
    label: () => 'Hermes Control', refresh: () => {},
    scopeInput: byId('scope'), scopeHelp: byId('help'), tabsField: byId('tabs'), tabsList: byId('list'), applyButton: byId('apply'), scopeHint: byId('hint'),
    getScope: () => 'this-tab', getSelectedTabIds: () => selected, translate: key => key,
    loadTabs: async () => [{ id: 10, title: 'First', url: 'https://example.test/1' }, { id: 12, title: 'Second', url: 'https://example.test/2' }, { id: 14, title: 'Settings', url: 'chrome://settings/' }],
    applyScope: async value => { calls.push(value); },
  });
  const render = (state = 'ready', canChangeScope = true) => ui.render({ enabled: true, view: { state, tone: 'ok', title: state, detail: '' }, canChangeScope });
  return { document, dialog, ui, byId, calls, render };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

test('dialog permits explicit multi-tab selection and apply without leaving the menu', async () => {
  const f = fixture(); f.render(); f.byId('launch').click(); await settle();
  f.byId('scope').value = 'selected-tabs';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  assert.equal(f.byId('tabs').hidden, false);
  const boxes = [...f.byId('list').querySelectorAll('input')];
  assert.equal(boxes.length, 3, 'restricted pages stay listed');
  assert.equal(boxes[2].disabled, true, 'a restricted page cannot be selected');
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new f.document.defaultView.Event('change'));
  f.byId('apply').click(); await settle();
  assert.deepEqual(f.calls, [{ scope: 'selected-tabs', tabIds: [10, 12] }]);
  assert.equal(f.dialog.open, true);
});

test('restricted tabs appear as disabled rows that say why they are unavailable', async () => {
  const f = fixture(); f.render(); f.byId('launch').click(); await settle();
  f.byId('scope').value = 'selected-tabs';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  const rows = [...f.byId('list').querySelectorAll('.browser-control-tab-option')];
  assert.equal(rows.length, 3, 'every open tab is listed');
  assert.equal(rows[0].classList.contains('is-restricted'), false);
  assert.equal(rows[0].querySelector('input').disabled, false);
  const restricted = rows[2];
  assert.equal(restricted.classList.contains('is-restricted'), true);
  assert.equal(restricted.querySelector('input').disabled, true);
  assert.equal(restricted.querySelector('input').checked, false);
  assert.equal(restricted.querySelector('small').textContent, 'browser_control.tab_restricted');
  assert.equal(restricted.querySelector('span > span').textContent, 'Settings');
});

test('a restricted tab that was selected before cannot be carried into the applied scope', async () => {
  const f = fixture({ selected: [10, 14] });
  f.render(); f.byId('launch').click(); await settle();
  f.byId('scope').value = 'selected-tabs';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  f.byId('apply').click(); await settle();
  assert.deepEqual(f.calls, [{ scope: 'selected-tabs', tabIds: [10] }]);
});

test('the visible scope helper names the chosen scope', async () => {
  const f = fixture(); f.render(); f.byId('launch').click(); await settle();
  assert.equal(f.byId('help').textContent, 'browser_control.help_scope_this_tab');
  f.byId('scope').value = 'task-set';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  assert.equal(f.byId('help').textContent, 'browser_control.help_scope_task_set');
  f.byId('scope').value = 'selected-tabs';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  assert.equal(f.byId('help').textContent, 'browser_control.help_scope_selected_tabs');
});

test('poll rendering does not erase an uncommitted scope draft', async () => {
  const f = fixture(); f.render(); f.byId('launch').click(); await settle();
  f.byId('scope').value = 'task-set';
  f.byId('scope').dispatchEvent(new f.document.defaultView.Event('change'));
  f.render();
  assert.equal(f.byId('scope').value, 'task-set');
});

test('busy authority disables the visible scope input and apply control', async () => {
  const f = fixture(); f.render('active', false); f.byId('launch').click(); await settle();
  assert.equal(f.byId('scope').disabled, true);
  assert.equal(f.byId('apply').disabled, true);
});

test('dialog flair arms on activation but does not restart on each status poll', async () => {
  const f = fixture(); f.render();
  const event = new f.document.defaultView.Event('click'); event.detail = 1;
  f.byId('launch').dispatchEvent(event); await settle();
  assert.equal(f.dialog.classList.contains('is-energized'), true);
  f.dialog.classList.remove('is-energized');
  f.render();
  assert.equal(f.dialog.classList.contains('is-energized'), false);
});

test('a background approval opens the existing card and stays visible when Control is off', async () => {
  const f = fixture();
  f.ui.render({
    enabled: false,
    view: { state: 'approval', tone: 'warn', title: 'Approval needed', detail: 'Click "Continue"?', autoOpen: true, autoOpenKey: 'a1' },
  });
  await settle();
  assert.equal(f.byId('launch').hidden, false);
  assert.equal(f.dialog.open, true);
});

test('a background approval opens the card once per request and stays closed after the person dismisses it', async () => {
  const f = fixture();
  const view = (approvalId) => ({
    state: 'approval', tone: 'warn', title: 'Approval needed', detail: 'Click "Continue"?',
    autoOpen: true, autoOpenKey: approvalId,
  });
  f.ui.render({ enabled: false, view: view('a1') });
  await settle();
  assert.equal(f.dialog.open, true);
  f.byId('close').click();
  assert.equal(f.dialog.open, false);
  // The 750 ms status poll renders the same request again: it must not reopen the card.
  for (let poll = 0; poll < 3; poll += 1) f.ui.render({ enabled: false, view: view('a1') });
  await settle();
  assert.equal(f.dialog.open, false, 'a dismissed card stays closed for the same request');
  assert.equal(f.byId('launch').hidden, false, 'the launcher still lets the person reopen it');
  f.ui.render({ enabled: false, view: view('a2') });
  await settle();
  assert.equal(f.dialog.open, true, 'the next request opens the card once');
});
