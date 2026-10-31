import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
  tabId: 7,
  frameId: 0,
  documentGeneration: 3,
});

const frame = (action, args = {}) => ({
  command_id: 'command-1',
  action,
  arguments: args,
  tab_id: scope.tabId,
  frame_id: scope.frameId,
  document_generation: scope.documentGeneration,
});

const CARD_PAGE = {
  title: 'Pay now',
  url: 'https://example.test/checkout/pay',
  text: 'Card number 4111 1111 1111 1111. Billing address 1 Main Street.',
  nodes: [{ role: 'textbox', name: 'Card number', backendDOMNodeId: 61 }],
};

// The page the probe judged is a cart; by the time the snapshot was read it had moved on.
function redirectingAdapter(landing = CARD_PAGE) {
  return {
    contract: { enabled: true, actions: ['browser_snapshot', 'browser_press', 'browser_click'] },
    inspect: async () => ({ currentUrl: 'https://example.test/cart', hasUnsavedContent: false }),
    settle: async () => ({ navigated: false, url: 'https://example.test/cart', title: 'Cart', timedOut: false }),
    execute: async (action) => (action === 'browser_snapshot' ? landing : { status: 'ok' }),
  };
}

function makeExecutor(adapter) {
  const refs = createBrowserControlRefStore();
  const executor = createBrowserControlExecutor({ adapter, approvals: createBrowserControlApprovalStore(), refs });
  return { executor, refs };
}

test('browser_snapshot discards a page that moved to a restricted address while it was read', async () => {
  const { executor, refs } = makeExecutor(redirectingAdapter());
  const outcome = await executor.execute(frame('browser_snapshot'), { scope });
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.error.code, 'sensitive_action_blocked');
  assert.doesNotMatch(JSON.stringify(outcome), /4111|Billing|Card number/);
  assert.equal(refs.resolve({ ...scope, ref: '@e1' }).ok, false, 'no ref from the restricted page is live');
});

test('a fragment route to a restricted page counts too', async () => {
  const landing = { ...CARD_PAGE, url: 'https://example.test/app#/checkout' };
  const { executor } = makeExecutor(redirectingAdapter(landing));
  const outcome = await executor.execute(frame('browser_snapshot'), { scope });
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(JSON.stringify(outcome), /4111/);
});

test('the page state after an action discards a page that moved to a restricted address meanwhile', async () => {
  const { executor, refs } = makeExecutor(redirectingAdapter());
  const outcome = await executor.execute(frame('browser_press', { key: 'Tab' }), { scope });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.result.snapshot_error, 'restricted_page');
  assert.equal(outcome.result.snapshot, undefined);
  assert.doesNotMatch(JSON.stringify(outcome), /4111|Billing|Card number|Pay now|checkout\/pay/);
  assert.equal(outcome.result.url, 'https://example.test', 'only the origin is named');
  assert.equal('title' in outcome.result, false);
  assert.equal(refs.resolve({ ...scope, ref: '@e1' }).ok, false);
});

test('an ordinary snapshot is unaffected', async () => {
  const landing = { title: 'Cart', url: 'https://example.test/cart', text: 'Two items.', nodes: [{ role: 'button', name: 'Continue', backendDOMNodeId: 62 }] };
  const { executor } = makeExecutor(redirectingAdapter(landing));
  const outcome = await executor.execute(frame('browser_snapshot'), { scope });
  assert.equal(outcome.ok, true);
  assert.match(outcome.result.text || JSON.stringify(outcome.result), /Two items\./);
});
