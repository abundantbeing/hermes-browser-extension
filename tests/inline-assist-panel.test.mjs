import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';

async function openPanel(settings = {}) {
  const env = bootAssist({ settings: { inlineAssistDefaultRoute: 'background', inlineAssistModel: 'gpt-6.1-terra', ...settings } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  return { env, root: env.root(), panel: env.root().querySelector('.panel'), launcher };
}

test('the full panel is 380px wide', () => {
  assert.match(loadExtensionFile('content-inline-helper.js'), /\.panel \{[^}]*width:min\(380px,calc\(100vw - 20px\)\)/);
});

test('the footer holds where it runs, auto-replace, the model and the safety line', async () => {
  const { root } = await openPanel();
  const foot = root.querySelector('.foot');
  const route = foot.querySelector('select.route-select');
  assert.ok(route, 'route control in the footer');
  assert.equal(route.value, 'background');
  assert.ok(foot.querySelector('input.toggle[data-setting="auto-replace"]'), 'auto-replace in the footer');
  assert.match(foot.textContent, /gpt-6\.1-terra/);
  assert.match(foot.textContent, /Never posts or sends\. Only this field changes\./);
  assert.equal(root.querySelector('.body input.toggle[data-setting="auto-replace"]'), null, 'no second auto-replace switch in the body');
});

test('at most four actions show; the rest sit behind More actions', async () => {
  const { env, root } = await openPanel();
  const visible = () => [...root.querySelectorAll('.actions .action')].filter((item) => !item.hidden);
  assert.equal(visible().length, 4);
  const more = root.querySelector('.more-actions');
  assert.ok(more, 'More actions button');
  env.userClick(more);
  await env.sleep();
  assert.equal(visible().length, 6);
});

test('the panel opens just below the circle, lined up with it', async () => {
  const { panel, launcher } = await openPanel();
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.top, `${parseInt(launcher.style.top, 10) + 24 + 8}px`);
  assert.equal(panel.style.left, launcher.style.left);
});

test('a finished draft offers Try again, and Shorter once it is in the field', async () => {
  const { env, root } = await openPanel();
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  assert.ok(request, 'a draft was requested');
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text: 'A drafted reply.', sessionId: 's1', sessionTitle: 'Inline assist' });
  await env.sleep(60);
  const labels = [...root.querySelectorAll('.result-actions button')].map((item) => item.textContent.trim());
  assert.ok(labels.includes('Try again'), labels.join(', '));
  assert.ok(labels.includes('Shorter'), labels.join(', '));
});

test('the full panel keeps square controls; only the quick menu tool chips are rounded', () => {
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(loadExtensionFile('content-inline-helper.js'))[1];
  assert.doesNotMatch(/\.local-actions \.action \{[^}]*\}/.exec(css)?.[0] || '', /border-radius/);
  assert.match(css, /\.quick-chip \{[^}]*border-radius:999px/);
});
