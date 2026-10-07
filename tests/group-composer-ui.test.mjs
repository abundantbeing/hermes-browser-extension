import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const start = source.indexOf('function syncBotModeThreadsButton()');
const syncSource = source.slice(start, source.indexOf('\nfunction renderGroupThreadStrip()', start));

function harness() {
  const { window } = new JSDOM(html);
  const document = window.document;
  const els = {
    botModeThreadsButton: document.getElementById('botModeThreadsButton'),
    botModeNewThreadButton: document.getElementById('botModeNewThreadButton'),
  };
  const context = {
    document, els, activeGroupProjection: null,
    groupThreadsFromProjection: (room) => room.threads || [],
    translateUiText: (value) => value,
  };
  vm.createContext(context);
  vm.runInContext(`${syncSource}\nthis.sync = syncBotModeThreadsButton;`, context);
  return { context, els, document };
}

test('group toolbar icons survive repeated room updates with accessible thread counts', () => {
  const { context, els } = harness();
  context.activeGroupProjection = { threads: [{}, {}, {}] };
  context.sync();
  for (const button of Object.values(els)) {
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    assert.ok(button.querySelector('svg'), 'the control stays icon-only');
    assert.ok(button.getAttribute('aria-label'));
    assert.ok(button.title);
  }
  assert.match(els.botModeThreadsButton.title, /3/);
  const icons = Object.values(els).map((button) => button.querySelector('svg'));
  context.activeGroupProjection.threads = [];
  context.sync();
  Object.values(els).forEach((button, index) => assert.equal(button.querySelector('svg'), icons[index]));
  assert.equal(els.botModeThreadsButton.title, 'Threads');
});

test('icon controls retain the production Threads and New thread click routes', () => {
  const { context, els } = harness();
  context.activeGroupProjection = { threads: [] };
  context.sync();
  let opened = 0;
  let started = 0;
  context.openGroupThreadMenu = () => { opened += 1; };
  context.startNewGroupThread = () => { started += 1; };
  const bindingStart = source.indexOf("  els.botModeThreadsButton?.addEventListener('click'");
  const bindings = source.slice(bindingStart, source.indexOf("  els.groupThreadExitButton?.addEventListener", bindingStart));
  vm.runInContext(bindings, context);
  els.botModeThreadsButton.click();
  els.botModeNewThreadButton.click();
  assert.equal(opened, 1);
  assert.equal(started, 1);
});

test('leaving a group hides its thread controls without adding a context notice', () => {
  const { context, els, document } = harness();
  assert.equal(document.getElementById('groupPageContextNotice'), null);
  context.activeGroupProjection = { threads: [] };
  context.sync();
  assert.equal(document.getElementById('groupPageContextNotice'), null);
  context.activeGroupProjection = null;
  context.sync();
  Object.values(els).forEach((button) => {
    assert.equal(button.hidden, true);
    assert.equal(button.disabled, true);
  });
});
