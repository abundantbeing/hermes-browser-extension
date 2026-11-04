import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField } from './inline-assist-dom.mjs';

async function openQuick({ url, settings = {} } = {}) {
  const env = bootAssist({ url, settings: { inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'background', inlineAssistModel: 'gpt-6.1-terra', ...settings } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  return { env, root: env.root(), panel: env.root().querySelector('.panel') };
}

const trustedKey = (env, element, key, target = element) => {
  for (const listener of env.listenersFor(element, 'keydown')) {
    listener.call(element, { type: 'keydown', key, target, isTrusted: true, preventDefault() {}, stopPropagation() {}, composedPath: () => [target] });
  }
};

async function finishDraft(env, root, text = 'A drafted reply.') {
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  assert.ok(request, 'a draft was requested');
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text, sessionId: 's1', sessionTitle: 'Inline assist' });
  await env.sleep(60);
}

test('the quick menu opens at the circle with an ask line, four numbered actions, chips, options and Full panel', async () => {
  const { root, panel } = await openQuick();
  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.mode, 'quick');
  assert.ok(root.querySelector('input.quick-input'), 'Ask Hermes… line');
  const items = [...root.querySelectorAll('.quick-item')];
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.querySelector('.quick-num').textContent), ['1', '2', '3', '4']);
  assert.equal(root.querySelectorAll('.quick-chip').length, 2);
  assert.ok(root.querySelector('.quick-options'), 'gear');
  assert.ok(root.querySelector('.quick-full'), 'Full panel');
  assert.match(root.querySelector('.quick-summary').textContent, /gpt-6\.1-terra/);
});

test('pressing 2 in the menu runs the second action; digits typed in the ask line do not', async () => {
  const { env, root, panel } = await openQuick();
  env.w.document.getElementById('field').value = 'a rough first draft';
  const input = root.querySelector('input.quick-input');
  trustedKey(env, panel, '2', input);
  await env.sleep(40);
  assert.equal(env.sent.some((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST'), false);
  const second = root.querySelectorAll('.quick-item')[1].dataset.actionId;
  trustedKey(env, panel, '2', panel);
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  assert.equal(request?.actionId, second);
});

test('Full panel switches this run to the full panel', async () => {
  const { env, root, panel } = await openQuick();
  env.userClick(root.querySelector('.quick-full'));
  await env.sleep(40);
  assert.equal(panel.dataset.mode, 'full');
  assert.ok(root.querySelector('.actions .action'));
});

test('the draft lands in the field with a slim bar: Keep, Undo, Again, Shorter, Copy', async () => {
  const { env, root, panel } = await openQuick();
  await finishDraft(env, root);
  assert.equal(panel.dataset.mode, 'bar');
  assert.equal(env.w.document.getElementById('field').value, 'A drafted reply.');
  const labels = [...root.querySelectorAll('.bar-actions button')].map((item) => item.textContent.trim());
  for (const label of ['Keep', 'Undo', 'Again', 'Shorter', 'Copy']) assert.ok(labels.includes(label), labels.join(', '));
});

test('where Assist cannot write into the field, the bar previews the draft with Copy first', async () => {
  const { env, root, panel } = await openQuick({ url: 'https://chatgpt.com/' });
  env.w.document.getElementById('field').value = 'write me a prompt';
  await finishDraft(env, root, 'line one\nline two\nline three\nline four');
  assert.equal(panel.dataset.mode, 'bar');
  assert.equal(env.w.document.getElementById('field').value, 'write me a prompt');
  assert.match(root.querySelector('.bar-preview').textContent, /line one/);
  assert.equal(root.querySelector('.bar-actions button.main').textContent.trim(), 'Copy');
});

test('Quick menu, beside Try again in the full panel, goes back to the bar with the draft still up', async () => {
  const { env, root, panel } = await openQuick({ url: 'https://chatgpt.com/' });
  env.w.document.getElementById('field').value = 'write me a prompt';
  await finishDraft(env, root, 'line one\nline two');
  env.userClick(root.querySelector('.bar-head .bar-return'));
  await env.sleep(20);
  assert.equal(panel.dataset.mode, 'full');
  const followUps = [...root.querySelectorAll('.follow-ups button')].map((item) => item.textContent.trim());
  assert.deepEqual(followUps.slice(0, 2), ['Try again', 'Quick menu']);
  env.userClick([...root.querySelectorAll('.follow-ups button')][1]);
  await env.sleep(20);
  assert.equal(panel.dataset.mode, 'bar');
  assert.match(root.querySelector('.bar-preview').textContent, /line one/);
  assert.ok(root.querySelector('.bar-head .bar-return'), 'the way back to the full panel stays');
});

test('Esc on the bar closes it and never undoes the draft', async () => {
  const { env, root, panel } = await openQuick();
  await finishDraft(env, root);
  trustedKey(env, env.w.document, 'Escape', panel);
  await env.sleep(20);
  assert.equal(panel.hidden, true);
  assert.equal(env.w.document.getElementById('field').value, 'A drafted reply.');
});

test('a run from the quick menu that fails shows why in the bar, with Try again', async () => {
  const { env, root, panel } = await openQuick();
  env.w.document.getElementById('field').value = 'a rough first draft';
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: false, reason: 'Hermes Assist failed (502).' });
  await env.sleep(60);
  assert.equal(panel.hidden, false, 'the failure is visible');
  assert.equal(panel.dataset.mode, 'bar');
  assert.match(panel.textContent, /Hermes Assist failed \(502\)\./);
  const again = [...root.querySelectorAll('.bar-actions button')].find((item) => /Try again/.test(item.textContent));
  assert.ok(again, 'Try again');
  env.userClick(again);
  await env.sleep(60);
  assert.equal(env.sent.filter((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST').length, 2, 'the same action runs again');
});

test('the options button is the pixel settings cog, centred in its circle', async () => {
  const { root } = await openQuick();
  const gear = root.querySelector('.quick-options');
  const icon = gear.querySelector('svg[data-icon="settings-cog"]');
  assert.ok(icon, 'the pixelarticons settings cog, as on the side panel’s Settings button');
  assert.equal(gear.textContent.trim(), '', 'no text glyph');
  assert.equal(gear.getAttribute('aria-label'), 'Assist options');
  const css = /style\.textContent = `([\s\S]*?)`;/.exec((await import('./inline-assist-dom.mjs')).loadExtensionFile('content-inline-helper.js'))[1];
  assert.match(/\.quick-options \{[^}]*\}/.exec(css)[0], /display:grid; place-items:center; padding:0;/);
});

test('a screen opened from the quick menu, such as Where should Hermes work?, keeps the panel padding', async () => {
  const { env, root, panel } = await openQuick({ settings: { inlineAssistDefaultRoute: 'ask' } });
  env.w.document.getElementById('field').value = 'a rough first draft';
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(80);
  assert.match(root.querySelector('.route-title')?.textContent || '', /Where should Hermes work/i);
  assert.equal(panel.dataset.mode, 'quick');
  assert.equal(panel.dataset.view, 'routing');
  const css = /style\.textContent = `([\s\S]*?)`;/.exec((await import('./inline-assist-dom.mjs')).loadExtensionFile('content-inline-helper.js'))[1];
  assert.match(css, /\.panel\[data-mode="quick"\]:not\(\[data-view="quick"\]\):not\(\[data-view="quick-options"\]\) \.body \{ padding:12px; gap:11px; \}/);
});

test('the bar under the field sits clear of the circle', async () => {
  const { env, root, panel } = await openQuick();
  await finishDraft(env, root);
  const launcher = root.querySelector('.launcher');
  const circleBottom = Number.parseFloat(launcher.style.top) + 24;
  assert.ok(Number.parseFloat(panel.style.top) >= circleBottom + 8 || Number.parseFloat(panel.style.top) + panel.getBoundingClientRect().height <= Number.parseFloat(launcher.style.top) - 8, `bar top ${panel.style.top}, circle ${launcher.style.top}`);
});

test('a run started from the bar that fails stays a slim bar, with a plain Back button', async () => {
  const { env, root, panel } = await openQuick();
  await finishDraft(env, root);
  const again = [...root.querySelectorAll('.bar-actions button')].find((item) => /Again/.test(item.textContent));
  env.userClick(again);
  await env.sleep(60);
  const request = env.sent.filter((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST').at(-1).request;
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: false, reason: 'Hermes Assist failed (502).' });
  await env.sleep(60);
  assert.equal(panel.dataset.mode, 'bar');
  assert.equal(root.querySelector('.route-title'), null, 'not the full panel failure screen');
  assert.match(root.querySelector('.bar-preview').textContent, /Hermes Assist failed \(502\)/);
});

test('a result bar capped to a gap keeps its size: measuring the capped bar never uncaps it again', async () => {
  const { env, root, panel } = await openQuick();
  env.w.document.getElementById('field').value = 'a rough first draft';
  await finishDraft(env, root);
  assert.equal(panel.dataset.mode, 'bar');
  env.w.innerHeight = 550;
  const NATURAL = 132;
  const box = (left, top, width, height) => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} });
  env.w.Element.prototype.getBoundingClientRect = function rect() {
    if (this === panel) {
      const cap = Number.parseFloat(this.style.maxHeight);
      return box(100, 0, 560, Number.isFinite(cap) ? Math.min(NATURAL, cap) : NATURAL);
    }
    if (this.id === 'field') return box(100, 100, 600, 340);
    return box(0, 0, 0, 0);
  };
  const heights = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    env.resized(panel);
    await env.sleep(60);
    heights.push(panel.style.maxHeight);
  }
  assert.deepEqual(heights, Array(4).fill('94px'), 'neither side holds the whole bar, so it stays capped to the 94px gap on every placement');
});
