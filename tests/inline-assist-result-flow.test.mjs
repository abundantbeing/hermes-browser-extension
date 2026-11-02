import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';

const ORIGINAL = 'a rough first draft';

async function boot(settings = {}) {
  const env = bootAssist({ settings: { inlineAssistDefaultRoute: 'background', inlineAssistModel: 'gpt-6.1-terra', ...settings } });
  const launcher = await focusField(env);
  env.w.document.getElementById('field').value = ORIGINAL;
  env.userClick(launcher);
  await env.sleep(60);
  return { env, root: env.root(), panel: env.root().querySelector('.panel'), field: env.w.document.getElementById('field') };
}

const requests = (env) => env.sent.filter((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST').map((message) => message.request);

async function deliverLast(env, text = 'A drafted reply.') {
  const request = requests(env).at(-1);
  assert.ok(request, 'a draft was requested');
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text, sessionId: 's1', sessionTitle: 'Inline assist' });
  await env.sleep(60);
}

const labels = (root, selector) => [...root.querySelectorAll(selector)].map((item) => item.textContent.trim());
const buttonNamed = (root, selector, name) => [...root.querySelectorAll(selector)].find((item) => item.textContent.trim() === name);

test('Again from the bar asks where to run in the quick menu\'s layout, with Back and Close, and leaves the draft in place', async () => {
  const { env, root, panel, field } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  env.userClick(root.querySelector('.route[data-route="background"]'));
  await env.sleep(60);
  await deliverLast(env);
  assert.equal(field.value, 'A drafted reply.');
  env.userClick(buttonNamed(root, '.bar-actions button', 'Again'));
  await env.sleep(60);
  assert.equal(panel.dataset.view, 'routing');
  assert.equal(panel.dataset.mode, 'quick', 'padded like the quick menu, not squeezed into the bar');
  assert.equal(field.value, 'A drafted reply.', 'nothing is undone until a place is picked');
  assert.ok(root.querySelector('.sheet-nav .sheet-back'), 'Back');
  assert.ok(root.querySelector('.sheet-nav .sheet-close'), 'Close');
  env.userClick(root.querySelector('.sheet-back'));
  await env.sleep();
  assert.equal(panel.dataset.mode, 'bar');
  assert.equal(root.querySelector('.bar-title').textContent, 'Draft in place');
  assert.equal(field.value, 'A drafted reply.');
});

test('picking a place after Again undoes the draft first and runs from the original text', async () => {
  const { env, root, field } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  env.userClick(root.querySelector('.route[data-route="background"]'));
  await env.sleep(60);
  await deliverLast(env);
  env.userClick(buttonNamed(root, '.bar-actions button', 'Again'));
  await env.sleep(60);
  env.userClick(root.querySelector('.route[data-route="background"]'));
  await env.sleep(60);
  assert.equal(field.value, ORIGINAL);
  assert.equal(requests(env).at(-1).draftText, ORIGINAL);
});

test('Close on the chooser closes Assist', async () => {
  const { env, root, panel } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  assert.equal(panel.dataset.view, 'routing');
  env.userClick(root.querySelector('.sheet-close'));
  await env.sleep();
  assert.equal(panel.hidden, true);
});

test('Back on the chooser from the full panel returns to the actions', async () => {
  const { env, root, panel } = await boot({ inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  assert.equal(panel.dataset.view, 'routing');
  assert.equal(root.querySelector('.sheet-close'), null, 'the full panel\'s header already has its ×');
  env.userClick(root.querySelector('.sheet-back'));
  await env.sleep();
  assert.ok(root.querySelector('.actions .action'), 'the actions again');
});
