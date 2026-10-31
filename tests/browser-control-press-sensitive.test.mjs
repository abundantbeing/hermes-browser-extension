// browser_press follows the same sensitive-field rules browser_type does, fails closed when focus is unknown, and
// refuses key names it cannot send instead of dispatching a no-op and calling it pressed.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } from '../extension/lib/browser-control-safety.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createChromiumCdpAdapter, createFirefoxWebExtensionAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';

const press = (key, focused, extra = {}) => classifyBrowserControlAction({
  action: 'browser_press',
  arguments: typeof key === 'string' ? { key } : key,
  ...(focused === undefined ? {} : { focused }),
  ...extra,
});
const BLOCKED = BROWSER_CONTROL_RISKS.BLOCKED;
const APPROVAL = BROWSER_CONTROL_RISKS.APPROVAL;
const SAFE = BROWSER_CONTROL_RISKS.SAFE;

const EDITING_KEYS = ['a', '4', ' ', 'Space', 'Backspace', 'Delete', 'Control+x', 'Meta+x', 'Shift+Delete', 'Control+Backspace', 'Control+z'];

test('a key that types or deletes is blocked in a password field, as browser_type is', () => {
  const password = { role: 'textbox', name: '', inputType: 'password' };
  for (const key of [...EDITING_KEYS, 'Control+v', 'Shift+Insert']) {
    const decision = press(key, password);
    assert.equal(decision.risk, BLOCKED, key);
    assert.equal(decision.reason, 'sensitive-credential-field', key);
  }
});

test('a key that types or deletes is blocked in a card, one-time-code or credential field, by label or by autocomplete', () => {
  for (const [focused, reason] of [
    [{ role: 'textbox', name: 'Card number', inputType: 'text' }, 'sensitive-payment-field'],
    [{ role: 'textbox', name: 'CVV', inputType: 'text' }, 'sensitive-payment-field'],
    [{ role: 'textbox', name: 'Number', inputType: 'text', autocomplete: 'cc-number' }, 'sensitive-payment-field'],
    [{ role: 'textbox', name: 'Verification code', inputType: 'text' }, 'sensitive-mfa-field'],
    [{ role: 'textbox', name: 'Code', inputType: 'text', autocomplete: 'one-time-code' }, 'sensitive-mfa-field'],
    [{ role: 'textbox', name: 'API key', inputType: 'text' }, 'sensitive-credential-field'],
    [{ role: 'textbox', name: 'Pass', inputType: 'text', autocomplete: 'current-password' }, 'sensitive-credential-field'],
  ]) {
    for (const key of ['a', '7', 'Backspace', 'Delete']) {
      const decision = press(key, focused);
      assert.equal(decision.risk, BLOCKED, `${key} in ${JSON.stringify(focused)}`);
      assert.equal(decision.reason, reason);
    }
  }
});

test('moving around in a sensitive field, selecting and copying stay allowed, and Enter asks as it always did', () => {
  const password = { role: 'textbox', name: 'Password', inputType: 'password' };
  for (const key of ['Tab', 'Shift+Tab', 'ArrowLeft', 'Home', 'End', 'Escape', 'Control+a']) assert.equal(press(key, password).risk, SAFE, key);
  assert.equal(press('Control+c', password).risk, SAFE);
  assert.equal(press('Control+Insert', password).risk, SAFE);
  assert.equal(press('Enter', password).reason, 'submission-key');
});

test('an ordinary text field takes characters and deletes freely', () => {
  const search = { role: 'textbox', name: 'Search', inputType: 'text' };
  for (const key of ['a', 'Backspace', 'Delete', ' ', 'Control+x', 'Shift+Delete']) assert.equal(press(key, search).risk, SAFE, key);
  assert.equal(press('a', { role: '', name: '', inputType: '' }).risk, SAFE, 'the bare page');
});

test('a frame labelled as a payment or sign-in field is blocked for typing, any other frame asks', () => {
  assert.equal(press('4', { role: 'frame', name: 'Secure card number input frame', inputType: '', inFrame: true }).risk, BLOCKED);
  assert.deepEqual(press('4', { role: 'frame', name: 'Chat widget', inputType: '', inFrame: true }), { risk: APPROVAL, reason: 'framed-focus' });
});

test('with focus unknown, a key that would type or delete asks; Space asks about activation; movement does not', () => {
  for (const key of ['a', '4', 'Backspace', 'Delete', 'Shift+Delete', 'Control+x']) {
    assert.deepEqual(press(key, undefined), { risk: APPROVAL, reason: 'unknown-focus' }, key);
  }
  assert.deepEqual(press(' ', undefined), { risk: APPROVAL, reason: 'activation-key' });
  for (const key of ['Tab', 'ArrowDown', 'Escape', 'Control+a', 'Control+c', 'Control+Insert', 'PageDown']) assert.equal(press(key, undefined).risk, SAFE, key);
  assert.equal(press('Enter', undefined).reason, 'submission-key');
  assert.equal(press('Control+v', undefined).reason, 'clipboard-paste');
});

test('Ctrl+Insert is a copy, Shift+Delete a cut', () => {
  assert.deepEqual(press('Control+Insert', { role: 'textbox', name: 'Notes', inputType: 'text' }), { risk: SAFE, reason: 'clipboard-copy' });
  assert.deepEqual(press('Control+Insert', undefined), { risk: SAFE, reason: 'clipboard-copy' });
  assert.deepEqual(press('Shift+Delete', undefined), { risk: APPROVAL, reason: 'unknown-focus' });
  assert.equal(press('Shift+Delete', { role: 'textbox', name: 'Card number', inputType: 'text' }).risk, BLOCKED);
});

// --- key names -----------------------------------------------------------------------------------------------------

function debuggerFake() {
  const calls = [];
  const api = {
    tabs: { get: async () => ({ url: 'https://example.com/', status: 'complete', active: true, windowId: 1 }) },
    // What the real probe reads on a page with nothing focused: the page itself.
    scripting: { executeScript: async () => [{ result: { focused: { role: '', name: '', inputType: '' } } }] },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method, params) => { calls.push([method, params]); return {}; },
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  };
  return { api, calls };
}
const dispatchedKeys = (calls) => calls.filter((call) => call[0] === 'Input.dispatchKeyEvent').map((call) => call[1]);
const pressKey = async (key) => {
  const fake = debuggerFake();
  const adapter = createChromiumCdpAdapter({ browserApi: fake.api });
  try {
    await adapter.execute('browser_press', { key }, { scope: { tabId: 1 }, signal: new AbortController().signal });
    return { sent: dispatchedKeys(fake.calls) };
  } catch (error) {
    return { error, sent: dispatchedKeys(fake.calls) };
  } finally {
    await adapter.dispose();
  }
};

test('names people use for ordinary keys are mapped to the key, not dispatched as nothing', async () => {
  for (const [spelling, expectedKey, code, vk] of [
    ['PgDn', 'PageDown', 'PageDown', 34], ['PgUp', 'PageUp', 'PageUp', 33], ['Page Down', 'PageDown', 'PageDown', 34],
    ['Del', 'Delete', 'Delete', 46], ['Ins', 'Insert', 'Insert', 45],
    ['Up', 'ArrowUp', 'ArrowUp', 38], ['Down arrow', 'ArrowDown', 'ArrowDown', 40], ['Left', 'ArrowLeft', 'ArrowLeft', 37], ['Right', 'ArrowRight', 'ArrowRight', 39],
    ['Spacebar', ' ', 'Space', 32], ['Numpad Enter'.replace(' ', ''), 'Enter', 'NumpadEnter', 13],
    ['KeyV', 'v', 'KeyV', 86], ['Digit4', '4', 'Digit4', 52],
  ]) {
    const { sent, error } = await pressKey(spelling);
    assert.equal(error, undefined, spelling);
    assert.equal(sent[0].key, expectedKey, spelling);
    assert.equal(sent[0].code, code, spelling);
    assert.equal(sent[0].windowsVirtualKeyCode, vk, `${spelling} carries a key code`);
  }
});

test('a key name Hermes cannot send is refused, naming the key, and nothing is dispatched', async () => {
  for (const key of ['Foo', 'Hyper', 'ContextMenu', 'Shift', 'Control', '😀', 'F13']) {
    const { sent, error } = await pressKey(key);
    assert.ok(error, `${key} is refused`);
    assert.match(error.message, new RegExp(key === '😀' ? '😀' : key));
    assert.deepEqual(sent, [], key);
    const decision = press(key, { role: '', name: '', inputType: '' });
    assert.equal(decision.risk, BLOCKED);
    assert.equal(decision.reason, 'invalid-key');
    assert.match(decision.message, /could not understand the key|is a modifier/);
    assert.match(decision.message, /Enter, Tab, Escape/, 'it says what is accepted');
  }
});

test('the model is told which key could not be understood, in words', async () => {
  const adapter = {
    contract: { enabled: true, actions: ['browser_press'] },
    inspect: async () => ({ currentUrl: 'https://example.test/app', hasUnsavedContent: false, focused: { role: '', name: '', inputType: '' } }),
    execute: async () => ({ status: 'pressed' }),
  };
  const executor = createBrowserControlExecutor({ adapter, approvals: createBrowserControlApprovalStore(), refs: createBrowserControlRefStore() });
  const frame = (args) => ({ command_id: 'k1', action: 'browser_press', arguments: args, tab_id: 1, frame_id: 0, document_generation: 1 });
  const scope = { controllerId: 'c', leaseOwnerId: 'c', leaseId: 'l', tabId: 1, frameId: 0, documentGeneration: 1 };
  const outcome = await executor.execute(frame({ key: 'PgDownn' }), { scope });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'sensitive_action_blocked');
  assert.match(outcome.error.message, /Hermes could not understand the key "PgDownn"/);
  assert.notEqual(outcome.error.message, 'invalid-key');
  const modifier = await executor.execute(frame({ key: 'Win+e' }), { scope });
  assert.match(modifier.error.message, /Unsupported key modifier: Win/);
  const empty = await executor.execute(frame({ key: '  ' }), { scope });
  assert.match(empty.error.message, /No key was given/);
});

test('a refused press into a password field says why and what to do', async () => {
  const adapter = {
    contract: { enabled: true, actions: ['browser_press'] },
    inspect: async () => ({ currentUrl: 'https://example.test/login', hasUnsavedContent: false, focused: { role: 'textbox', name: '', inputType: 'password' } }),
    execute: async () => { throw new Error('must not be sent'); },
  };
  const executor = createBrowserControlExecutor({ adapter, approvals: createBrowserControlApprovalStore(), refs: createBrowserControlRefStore() });
  const outcome = await executor.execute(
    { command_id: 'k2', action: 'browser_press', arguments: { key: 'p' }, tab_id: 1, frame_id: 0, document_generation: 1 },
    { scope: { controllerId: 'c', leaseOwnerId: 'c', leaseId: 'l', tabId: 1, frameId: 0, documentGeneration: 1 } },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'sensitive_action_blocked');
  assert.match(outcome.error.message, /password or credential fields/);
  assert.match(outcome.error.message, /Ask the person/);
});

// --- the focus probe -----------------------------------------------------------------------------------------------

function probeFor(activeElement) {
  const document = { activeElement, body: { tagName: 'BODY' }, documentElement: { tagName: 'HTML' }, querySelectorAll: () => [] };
  const api = {
    tabs: { get: async () => ({ id: 9, url: 'https://example.test/app', title: 'App' }) },
    scripting: {
      executeScript: async ({ func, args }) => [{ result: vm.runInNewContext(`(${func.toString()})(...args)`, { document, args }) }],
    },
  };
  return createFirefoxWebExtensionAdapter({ browserApi: api }).inspect({ tabId: 9, frameId: 0 });
}
const element = (tagName, attrs = {}) => ({ tagName, getAttribute: (name) => attrs[name] ?? null, ...attrs.props });

test('the probe never reads what is typed into a field, and reports its autocomplete hint', async () => {
  const typed = await probeFor(element('INPUT', { props: { type: 'text', value: 'hunter2', autocomplete: 'cc-number' } }));
  assert.equal(typed.focused.name, '', 'a typed value is not a name');
  assert.equal(typed.focused.autocomplete, 'cc-number');
  assert.doesNotMatch(JSON.stringify(typed), /hunter2/);
  const password = await probeFor(element('INPUT', { props: { type: 'password', value: 'secret-pass' } }));
  assert.equal(password.focused.inputType, 'password');
  assert.doesNotMatch(JSON.stringify(password), /secret-pass/);
  const editor = await probeFor(element('DIV', { props: { isContentEditable: true, innerText: 'my private draft' } }));
  assert.equal(editor.focused.role, 'textbox');
  assert.doesNotMatch(JSON.stringify(editor), /private draft/);
  // A button is named by its value, as before.
  const submit = await probeFor(element('INPUT', { props: { type: 'submit', value: 'Pay now' } }));
  assert.equal(submit.focused.name, 'Pay now');
});
