import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createBrowserControlDialog } from '../extension/lib/browser-control-dialog.mjs';
import en from '../extension/lib/locales/en.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

// The window as sidepanel.html builds it, with the dialog's real help wiring.
function fixture() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document } = dom.window;
  const originals = Object.fromEntries(['document', 'MutationObserver', 'Event', 'window'].map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { document, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, window: dom.window });
  const byId = (id) => document.getElementById(id);
  const dialog = byId('browserControlDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  const tooltip = byId('browserControlTooltip');
  let helpOpen = false;
  tooltip.matches = (selector) => selector === ':popover-open' && helpOpen;
  tooltip.showPopover = () => { helpOpen = true; };
  tooltip.hidePopover = () => { helpOpen = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const ui = createBrowserControlDialog({
    dialog, launcher: byId('browserControlMenuButton'), closeButton: byId('browserControlDismissButton'),
    label: () => 'Hermes Control', refresh: () => {}, translate: (key) => en[key] || key,
    scopeInput: byId('browserControlDialogScopeInput'), tabsField: byId('browserControlDialogTabs'),
    tabsList: byId('browserControlDialogTabList'), applyButton: byId('browserControlDialogApplyScope'),
    scopeHint: byId('browserControlDialogScopeHint'), getScope: () => 'this-tab', getSelectedTabIds: () => [],
    loadTabs: async () => [], applyScope: async () => {},
  });
  const render = (view, help) => ui.render({ enabled: true, view, help, canChangeScope: false });
  const open = () => byId('browserControlMenuButton').click();
  return {
    dom, document, byId, dialog, tooltip, render, open, helpOpen: () => helpOpen,
    cleanup() {
      dom.window.close();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
}

const READY = {
  state: 'ready', tone: 'ok', title: 'This tab is ready', detail: 'This exact tab is leased. Hermes can operate it on the first controlled turn.',
};
const READY_LINE = 'This tab is ready. This exact tab is leased. Hermes can operate it on the first controlled turn.';

test('the status light is focusable and named by the full status, without a duplicate description', () => {
  const f = fixture();
  try {
    f.render(READY, { status: READY_LINE });
    f.open();
    const light = f.byId('browserControlLight');
    assert.equal(light.getAttribute('role'), 'img');
    assert.equal(light.getAttribute('tabindex'), '0');
    assert.equal(light.getAttribute('data-control-help'), 'status');
    assert.equal(light.getAttribute('aria-label'), READY_LINE, 'the name carries the same text as the tooltip');
    assert.equal(light.hasAttribute('aria-description'), false, 'the name is not repeated as a description');
  } finally { f.cleanup(); }
});

test('the status light shows the full status on hover and on keyboard focus, then hides', () => {
  const f = fixture();
  try {
    f.render(READY, { status: READY_LINE });
    f.open();
    const light = f.byId('browserControlLight');
    light.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(f.tooltip.textContent, READY_LINE);
    assert.equal(f.helpOpen(), true);
    assert.equal(light.hasAttribute('aria-describedby'), false, 'a hover does not repeat the name as a description');
    light.dispatchEvent(new f.dom.window.MouseEvent('pointerout', { bubbles: true }));
    assert.equal(f.helpOpen(), false);
    light.focus();
    assert.equal(f.tooltip.textContent, READY_LINE);
    assert.equal(f.helpOpen(), true);
    light.dispatchEvent(new f.dom.window.FocusEvent('focusout', { bubbles: true }));
    assert.equal(f.helpOpen(), false);
  } finally { f.cleanup(); }
});

test('the status light follows polls: its name and open tooltip change with the status', () => {
  const f = fixture();
  try {
    f.render(READY, { status: READY_LINE });
    f.open();
    const light = f.byId('browserControlLight');
    light.focus();
    assert.equal(f.tooltip.textContent, READY_LINE);
    const paused = 'Control paused. 1 leased tab retained. New actions are blocked.';
    f.render({ ...READY, state: 'paused', title: 'Control paused', detail: '1 leased tab retained. New actions are blocked.' }, { status: paused });
    assert.equal(light.getAttribute('aria-label'), paused);
    assert.equal(f.tooltip.textContent, paused, 'an open tooltip follows the new status');
  } finally { f.cleanup(); }
});
