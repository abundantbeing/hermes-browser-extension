import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { createFirefoxWebExtensionAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

const SCOPE = Object.freeze({
  controllerId: 'controller-press',
  leaseOwnerId: 'controller-press',
  leaseId: 'lease-press',
  leaseGeneration: 1,
  tabId: 9,
  frameId: 0,
  documentGeneration: 2,
});

function frame(args) {
  return {
    command_id: 'press-command',
    approval_nonce: 'nonce-press-command',
    action: 'browser_press',
    arguments: args,
    tab_id: 9,
    frame_id: 0,
    document_generation: 2,
    deadline_at: Date.now() + 2_000,
  };
}

function pressFixture(focused) {
  const approvals = createBrowserControlApprovalStore({ ttlMs: 1_000 });
  let presses = 0;
  const adapter = {
    contract: { enabled: true, actions: ['browser_press'] },
    async inspect() {
      return { currentUrl: 'https://example.test/app', hasUnsavedContent: false, ...(focused ? { focused } : {}) };
    },
    async execute() { presses += 1; return { status: 'pressed' }; },
  };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  return { approvals, executor, presses: () => presses };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Space on a focused Delete button waits for the approval a click on it would need', async () => {
  const { approvals, executor, presses } = pressFixture({ role: 'button', name: 'Delete account', inputType: '' });
  const running = executor.execute(frame({ key: 'Space' }), { scope: SCOPE });
  await settle();
  assert.equal(presses(), 0, 'nothing is pressed before the person answers');
  const [shown] = approvals.pending();
  assert.equal(shown.reason, 'Run this consequential browser action?');
  approvals.cancelRequest(shown.approvalId);
  await running;
  assert.equal(presses(), 0);
});

test('Space on a harmless focused control just presses', async () => {
  const { approvals, executor, presses } = pressFixture({ role: 'button', name: 'Open menu', inputType: '' });
  const outcome = await executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  assert.equal(outcome.ok, true);
  assert.equal(presses(), 1);
  assert.equal(approvals.pending().length, 0);
});

test('Space asks first when the page could not say what has focus', async () => {
  const { approvals, executor, presses } = pressFixture(null);
  const running = executor.execute(frame({ key: 'Space' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  assert.match(shown.reason, /may activate whatever has focus/);
  assert.equal(presses(), 0);
  approvals.cancelRequest(shown.approvalId);
  await running;
});

test('Control+ Enter is judged as the Enter it dispatches', async () => {
  const { approvals, executor, presses } = pressFixture({ role: 'textbox', name: 'Message', inputType: 'text' });
  const running = executor.execute(frame({ key: 'Control+ Enter' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  assert.equal(shown.reason, 'Press Enter to submit the current form or message?');
  assert.equal(presses(), 0);
  approvals.cancelRequest(shown.approvalId);
  await running;
});

// The probe the adapter injects reads document.activeElement; run it against a small fake.
function probeFor(activeElement) {
  const document = {
    activeElement,
    body: { tagName: 'BODY' },
    documentElement: { tagName: 'HTML' },
    querySelectorAll: () => [],
  };
  const api = {
    tabs: { get: async () => ({ id: 9, url: 'https://example.test/app', title: 'App' }) },
    scripting: {
      executeScript: async ({ func, args }) => [{ result: vm.runInNewContext(`(${func.toString()})(...args)`, { document, args }) }],
    },
  };
  return createFirefoxWebExtensionAdapter({ browserApi: api }).inspect({ tabId: 9, frameId: 0 });
}

const element = (tagName, attrs = {}) => ({
  tagName,
  getAttribute: (name) => attrs[name] ?? null,
  ...attrs.props,
});

test('inspect reports what has focus: role, name, input type and whether it is a frame', async () => {
  const button = await probeFor(element('BUTTON', { 'aria-label': 'Delete account', props: { type: 'submit' } }));
  assert.deepEqual(button.focused, { role: 'button', name: 'Delete account', inputType: 'submit' });

  const input = await probeFor(element('INPUT', { props: { type: 'checkbox', value: 'on', labels: [{ innerText: 'Subscribe' }] } }));
  assert.deepEqual(input.focused, { role: 'checkbox', name: 'Subscribe', inputType: 'checkbox' });

  const text = await probeFor(element('TEXTAREA', { props: { placeholder: 'Write here' } }));
  assert.equal(text.focused.role, 'textbox');

  const embedded = await probeFor(element('IFRAME', { props: { title: 'Pay' } }));
  assert.deepEqual(embedded.focused, { role: 'frame', name: 'Pay', inputType: '', inFrame: true });

  const bare = await probeFor(null);
  assert.deepEqual(bare.focused, { role: '', name: '', inputType: '' });
});

test('typing while an embedded frame has focus waits for approval, and says why', async () => {
  const { approvals, executor, presses } = pressFixture({ role: 'frame', name: 'Payment', inputType: '', inFrame: true });
  const running = executor.execute(frame({ key: '4' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  assert.equal(shown.reason, 'Press this key inside an embedded frame on the page?');
  assert.equal(presses(), 0);
  approvals.cancelRequest(shown.approvalId);
  await running;

  const navigation = pressFixture({ role: 'frame', name: 'Payment', inputType: '', inFrame: true });
  assert.equal((await navigation.executor.execute(frame({ key: 'Tab' }), { scope: SCOPE })).ok, true);
});
