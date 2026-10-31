// A key press asks about the element it would reach: the card names it, the approval is bound to it, the focus is
// read again after the wait, and an element with no role of its own is not taken for an inert one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_CONTROL_RISKS, classifyBrowserControlAction, createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';

const SCOPE = Object.freeze({
  controllerId: 'controller-bind', leaseOwnerId: 'controller-bind', leaseId: 'lease-bind', leaseGeneration: 1, tabId: 9, frameId: 0, documentGeneration: 2,
});
const frame = (args) => ({
  command_id: 'bind-command', approval_nonce: 'nonce-bind', action: 'browser_press', arguments: args, tab_id: 9, frame_id: 0, document_generation: 2, deadline_at: Date.now() + 5_000,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const APPROVAL = BROWSER_CONTROL_RISKS.APPROVAL;
const SAFE = BROWSER_CONTROL_RISKS.SAFE;
const press = (key, focused) => classifyBrowserControlAction({ action: 'browser_press', arguments: { key }, focused });

// --- focusable elements with no role of their own ------------------------------------------------------------------

test('Space on a focusable element with no role of its own is judged as the click it is', () => {
  // <div tabindex=0>Delete account</div> and the host of a closed shadow root both report "generic".
  assert.deepEqual(press(' ', { role: 'generic', name: 'Delete account', inputType: '' }), { risk: APPROVAL, reason: 'consequential-action' });
  assert.deepEqual(press('Space', { role: 'generic', name: 'Pay now', inputType: '' }), { risk: APPROVAL, reason: 'consequential-action' });
  // A role-less element that has a name is not the bare page either.
  assert.deepEqual(press(' ', { role: '', name: 'Pay now', inputType: '' }), { risk: APPROVAL, reason: 'consequential-action' });
  // With nothing to read from its label, a key it might act on still asks.
  assert.deepEqual(press(' ', { role: 'generic', name: 'Open menu', inputType: '' }), { risk: APPROVAL, reason: 'opaque-focus' });
  assert.deepEqual(press('a', { role: 'generic', name: 'Widget', inputType: '' }), { risk: APPROVAL, reason: 'opaque-focus' });
  assert.deepEqual(press('Backspace', { role: 'generic', name: '', inputType: '' }), { risk: APPROVAL, reason: 'opaque-focus' });
  // Moving around asks nothing, and a real text field or the bare page stays free.
  assert.equal(press('ArrowDown', { role: 'generic', name: 'Widget', inputType: '' }).risk, SAFE);
  assert.equal(press('Tab', { role: 'generic', name: 'Widget', inputType: '' }).risk, SAFE);
  assert.equal(press(' ', { role: 'textbox', name: 'Search', inputType: 'text' }).risk, SAFE);
  assert.equal(press(' ', { role: '', name: '', inputType: '' }).risk, SAFE);
  assert.equal(press('a', { role: 'button', name: 'Open menu', inputType: '' }).risk, SAFE);
});

// --- the card and the approval name the focused element ------------------------------------------------------------

function fixture(focusReads) {
  const approvals = createBrowserControlApprovalStore({ ttlMs: 5_000 });
  const reads = [...focusReads];
  let presses = 0;
  let inspects = 0;
  const adapter = {
    contract: { enabled: true, actions: ['browser_press'] },
    async inspect() {
      inspects += 1;
      const focused = reads.length > 1 ? reads.shift() : reads[0];
      return { currentUrl: 'https://example.test/app', hasUnsavedContent: false, ...(focused ? { focused } : {}) };
    },
    async execute() { presses += 1; return { status: 'pressed' }; },
  };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  return { approvals, executor, presses: () => presses, inspects: () => inspects };
}

test('the card says which key and which element, and the approval is bound to that element', async () => {
  const { approvals, executor } = fixture([{ role: 'generic', name: 'Delete account', inputType: '' }]);
  const running = executor.execute(frame({ key: 'Space' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  assert.equal(shown.reason, 'Press Space while "Delete account" (generic) has focus? It acts like clicking it.');
  assert.equal(shown.targetRole, 'generic');
  assert.equal(shown.targetName, 'Delete account');
  assert.ok(shown.valueHash, 'the key itself is bound too');
  approvals.cancelRequest(shown.approvalId);
  await running;
});

test('an element with an opaque role names itself and says why it asks', async () => {
  const { approvals, executor } = fixture([{ role: 'generic', name: 'Volume', inputType: '' }]);
  const running = executor.execute(frame({ key: 'a' }), { scope: SCOPE });
  await settle();
  assert.equal(approvals.pending()[0].reason, 'Press a while "Volume" (generic) has focus? Hermes cannot tell what that element does with it.');
  approvals.cancelRequest(approvals.pending()[0].approvalId);
  await running;
});

test('a name from the page cannot reorder or hide the card text', async () => {
  const { approvals, executor } = fixture([{ role: 'generic', name: `Delete\u202e\u0000 everything \n${'x'.repeat(300)}`, inputType: '' }]);
  const running = executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  // Checked character by character: a control character inside a regular expression is what the linter refuses.
  for (const hidden of ['\u202e', '\u0000', '\n']) {
    assert.equal(shown.reason.includes(hidden), false, `the card text keeps U+${hidden.codePointAt(0).toString(16)}`);
  }
  assert.ok(shown.reason.length < 220, shown.reason.length);
  approvals.cancelRequest(shown.approvalId);
  await running;
});

// --- the focus is read again after the wait ------------------------------------------------------------------------

test('the key is not pressed when focus moved to a different element while the card was open', async () => {
  const before = { role: 'generic', name: 'Cancel', inputType: '' };
  const after = { role: 'button', name: 'Delete account', inputType: '' };
  const { approvals, executor, presses } = fixture([before, after]);
  const running = executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  await settle();
  // The person approves what the card said: a key on "Cancel"... which no longer has focus.
  const [shown] = approvals.pending();
  assert.equal(approvals.grant({ ...shown, state: 'paused' }).ok, true);
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'focus_changed');
  assert.match(outcome.error.message, /Focus moved to a different element/);
  assert.equal(presses(), 0);
});

test('the key goes out when the same element still has focus after the approval', async () => {
  const same = { role: 'generic', name: 'Cancel', inputType: '', identity: '0123456789abcdef0123456789abcdef' };
  const { approvals, executor, presses, inspects } = fixture([same, { ...same }]);
  const running = executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  assert.equal(approvals.grant({ ...shown, state: 'paused' }).ok, true);
  const outcome = await running;
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(presses(), 1);
  assert.equal(inspects(), 2, 'focus was read before the card and again after it');
});

test('unknown focus cannot authorize a key, even when it stays unknown', async () => {
  const unknown = fixture([null, null]);
  const first = unknown.executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  await settle();
  assert.equal(unknown.approvals.grant({ ...unknown.approvals.pending()[0], state: 'paused' }).ok, true);
  assert.equal((await first).error.code, 'focus_changed');
  assert.equal(unknown.presses(), 0);

  const turned = fixture([null, { role: 'button', name: 'Delete account', inputType: '' }]);
  const second = turned.executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  await settle();
  assert.equal(turned.approvals.grant({ ...turned.approvals.pending()[0], state: 'paused' }).ok, true);
  assert.equal((await second).error.code, 'focus_changed');
  assert.equal(turned.presses(), 0);
});

test('a grant for one focused element does not release a press for another', async () => {
  const { approvals, executor, presses } = fixture([{ role: 'generic', name: 'Cancel', inputType: '' }]);
  const running = executor.execute(frame({ key: ' ' }), { scope: SCOPE });
  await settle();
  const [shown] = approvals.pending();
  assert.deepEqual(
    approvals.grant({ ...shown, state: 'paused', targetName: 'Delete account' }),
    { ok: false, error: 'approval_mismatch' },
  );
  assert.equal(presses(), 0);
  approvals.cancelRequest(shown.approvalId);
  await running;
});
