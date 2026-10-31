import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createOnboardingFlow } from '../extension/lib/onboarding-flow.mjs';

function mount() {
  const { document, window } = parseHTML('<!doctype html><html><body><section id="host" hidden></section></body></html>');
  const host = document.getElementById('host');
  const state = {
    theme: 'nous', colorMode: 'dark', resolvedMode: 'dark', fontProfile: 'signature', responseStyle: 'vivid', messageLayout: 'bubbles',
    connection: { connected: false, busy: false, status: '' },
  };
  const flow = createOnboardingFlow({
    host,
    themes: [{ value: 'nous', name: 'Nous', description: 'Blue', preview: { bg: '#0000ee', panel: '#0000ee', text: '#fff', muted: '#ddd', accent: '#fff' } }],
    translate: (key) => key,
    getState: () => state,
    reducedMotion: () => true,
    wait: () => Promise.resolve(),
  });
  const node = document.createElement('div');
  node.className = 'pairing-approval';
  node.innerHTML = '<iframe class="pairing-approval-frame"></iframe>';
  return { document, window, host, flow, state, node };
}

const status = (host) => host.querySelector('.onboarding-connect-status span')?.textContent;

test("the approval page sits in setup's Connect step", () => {
  const { host, flow, node } = mount();
  flow.open({ step: 'connect' });
  assert.equal(host.querySelector('.onboarding-approval-slot'), null, 'no slot until there is a page to show');
  assert.equal(flow.setApproval(node), true);
  const slot = host.querySelector('.onboarding-stage .onboarding-approval-slot');
  assert.ok(slot, 'the slot is inside the Connect step');
  assert.ok(slot.contains(node));
  assert.ok(host.classList.contains('is-approving'), 'setup can make room for it');
  assert.ok(host.querySelector('.onboarding-connect').classList.contains('is-approving'));
});

test('a status update while approving does not reload the page being read', () => {
  const { host, flow, state, node } = mount();
  flow.open({ step: 'connect' });
  flow.setApproval(node);
  const iframe = node.querySelector('iframe');
  const stage = host.querySelector('.onboarding-stage');
  state.connection = { connected: false, busy: true, busyLabel: 'Connecting...', status: 'Waiting for Hermes Desktop approval...' };
  flow.render();
  flow.render();
  assert.equal(host.querySelector('.onboarding-stage'), stage);
  assert.equal(host.querySelector('.pairing-approval'), node, 'the same element, still in place');
  assert.equal(node.querySelector('iframe'), iframe);
  assert.equal(node.isConnected, true);
  assert.equal(status(host), 'Waiting for Hermes Desktop approval...', 'the words still follow the live state');
  assert.equal(host.querySelector('[data-onboarding-connect]').disabled, true);
});

test('when the connection lands the step reads as connected and drops its buttons', () => {
  const { host, flow, state, node } = mount();
  flow.open({ step: 'connect' });
  flow.setApproval(node);
  state.connection = { connected: true, busy: false, status: '' };
  flow.render();
  assert.equal(status(host), 'onboarding.connect.connected');
  assert.ok(host.querySelector('.onboarding-connect').classList.contains('is-connected'));
  assert.equal(host.querySelector('.onboarding-connect-actions').hidden, true);
});

test('taking the page away restores the plain Connect step', () => {
  const { host, flow, node } = mount();
  flow.open({ step: 'connect' });
  flow.setApproval(node);
  assert.equal(flow.setApproval(null), false);
  assert.equal(host.querySelector('.onboarding-approval-slot'), null);
  assert.equal(host.querySelector('.pairing-approval'), null);
  assert.equal(host.classList.contains('is-approving'), false);
  assert.ok(host.querySelector('[data-onboarding-connect]'), 'the Connect button is back');
});

test('the page waits in the wings when setup is on another step, and comes back with the Connect step', () => {
  const { host, flow, node } = mount();
  flow.open({ step: 'layout' });
  assert.equal(flow.setApproval(node), false, 'nothing to hold it on this step');
  assert.equal(host.classList.contains('is-approving'), false, 'setup keeps its preview and layout elsewhere');
  flow.open({ step: 'connect' });
  assert.ok(host.querySelector('.onboarding-approval-slot').contains(node));
  assert.ok(host.classList.contains('is-approving'));
});

test('a closed setup holds nothing and accepts no page', () => {
  const { host, flow, node } = mount();
  assert.equal(flow.setApproval(node), false);
  flow.open({ step: 'connect' });
  flow.setApproval(node);
  flow.close();
  assert.equal(host.hidden, true);
  assert.equal(host.querySelector('.pairing-approval'), null);
});

// Focus while Connect works: pressing it disables the very button that has the keyboard.
// linkedom keeps no focus, so give this window a real-enough one: focus() moves
// activeElement unless the element is disabled (which is what a browser does).
function withFocus(window, document) {
  let current = null;
  Object.defineProperty(document, 'activeElement', { get: () => current ?? document.body, configurable: true });
  window.HTMLElement.prototype.focus = function focus() { if (!this.disabled) current = this; };
  return { get active() { return current; } };
}

test('pressing Connect keeps the keyboard inside setup: focus moves to the status line, not a disabled button', () => {
  const { window, document, host, flow, state } = mount();
  const focus = withFocus(window, document);
  flow.open({ step: 'connect' });
  const connect = host.querySelector('[data-onboarding-connect]');
  connect.focus();
  assert.equal(focus.active, connect, 'the press leaves focus on Connect');
  state.connection = { connected: false, busy: true, busyLabel: 'Connecting...', status: 'Waiting for approval' };
  flow.render();
  const statusLine = host.querySelector('.onboarding-connect-status');
  assert.equal(statusLine.getAttribute('tabindex'), '-1', 'focusable by script, not a tab stop');
  assert.equal(host.querySelector('[data-onboarding-connect]').disabled, true);
  assert.equal(focus.active, statusLine, 'the keys stay in the dialog');
  // While the approval page holds the step, the update patches in place and the keyboard still stays in the dialog.
  const approving = mount();
  const approvingFocus = withFocus(approving.window, approving.document);
  approving.flow.open({ step: 'connect' });
  approving.flow.setApproval(approving.node);
  const button = approving.host.querySelector('[data-onboarding-connect]');
  button.focus();
  approving.state.connection = { connected: false, busy: true, status: 'Waiting for Hermes Desktop approval...' };
  approving.flow.render();
  assert.equal(approvingFocus.active, approving.host.querySelector('.onboarding-connect-status'));
});

test('an enabled Connect keeps its focus across a redraw, and the actions hidden once connected hand it to the status line', () => {
  const { window, document, host, flow, state } = mount();
  const focus = withFocus(window, document);
  flow.open({ step: 'connect' });
  const connect = host.querySelector('[data-onboarding-connect]');
  connect.focus();
  state.connection = { connected: false, busy: false, failed: true, status: 'The gateway said no' };
  flow.render();
  assert.equal(focus.active, host.querySelector('[data-onboarding-connect]'), 'a failed attempt leaves Connect usable and focused');
  state.connection = { connected: true, busy: false, status: '' };
  flow.render();
  assert.equal(focus.active, host.querySelector('.onboarding-connect-status'), 'the buttons are hidden now; the keyboard stays in setup');
});

test('the status line keeps the keyboard when the step is drawn again after Connect ends', () => {
  const { window, document, host, flow, state } = mount();
  const focus = withFocus(window, document);
  flow.open({ step: 'connect' });
  host.querySelector('[data-onboarding-connect]').focus();
  state.connection = { connected: false, busy: true, status: 'Connecting' };
  flow.render();
  const busyLine = host.querySelector('.onboarding-connect-status');
  assert.equal(focus.active, busyLine);
  // The attempt fails: the step is rebuilt (the status node is a new one) and Connect is usable again.
  state.connection = { connected: false, busy: false, failed: true, status: 'The gateway said no' };
  flow.render();
  const failedLine = host.querySelector('.onboarding-connect-status');
  assert.notEqual(failedLine, busyLine, 'the status node was replaced by the rebuild');
  assert.equal(focus.active, failedLine, 'focus did not fall to the page body');
  assert.equal(host.querySelector('.onboarding-connect-status span').textContent, 'The gateway said no');
});
