import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField } from './inline-assist-dom.mjs';
import { INLINE_ASSIST_EFFORTS, inlineAssistEffortIndex } from '../extension/lib/inline-assist-look.mjs';
import { MODEL_REASONING_EFFORTS } from '../extension/lib/model-runtime-options.mjs';

const ASSIST_MODEL = { inlineAssistModel: 'openai-codex::gpt-6.1-terra', inlineAssistRawModel: 'gpt-6.1-terra', inlineAssistProvider: 'openai-codex' };

async function open(settings = {}) {
  const env = bootAssist({ settings: { inlineAssistDefaultRoute: 'background', ...ASSIST_MODEL, ...settings } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  return { env, root: env.root() };
}

// Drags the slider to a step and lets go, as a person does.
function slideTo(env, range, step) {
  range.value = String(step);
  for (const type of ['input', 'change']) {
    for (const listener of env.listenersFor(range, type)) listener.call(range, { type, target: range, isTrusted: true });
  }
}

test('Assist steps through the side panel\'s effort levels, in the same order', () => {
  assert.deepEqual(INLINE_ASSIST_EFFORTS.map((effort) => effort.value), MODEL_REASONING_EFFORTS.map((effort) => effort.value));
  assert.equal(inlineAssistEffortIndex(''), 1, 'unset is Low, Assist\'s default');
  assert.equal(inlineAssistEffortIndex('extra high'), 4);
});

test('Assist options show an Effort slider right under Model, at the saved level', async () => {
  const { env, root } = await open({ inlineAssistOpenMode: 'quick', inlineAssistReasoningEffort: 'high' });
  env.userClick(root.querySelector('.quick-options'));
  await env.sleep();
  const titles = [...root.querySelectorAll('.quick-opt strong:first-child')].map((node) => node.textContent);
  assert.equal(titles[titles.indexOf('Model') + 1], 'Effort');
  const slider = root.querySelector('.quick-opt.effort-opt .effort');
  const range = slider.querySelector('input.effort-range');
  assert.equal(range.type, 'range');
  assert.equal(range.max, '6');
  assert.equal(range.value, '3');
  assert.equal(slider.querySelector('.effort-value').textContent, 'High');
  assert.equal(slider.querySelectorAll('.effort-stop').length, 7);
});

test('letting go of the slider saves Assist\'s effort, with thinking on', async () => {
  const { env, root } = await open({ inlineAssistOpenMode: 'quick', inlineAssistReasoningEffort: 'low' });
  env.userClick(root.querySelector('.quick-options'));
  await env.sleep();
  const range = root.querySelector('.effort-opt input.effort-range');
  slideTo(env, range, 5);
  await env.sleep();
  const saved = env.stored.map((write) => write.hermesBrowserSettings).filter(Boolean).at(-1);
  assert.equal(saved.inlineAssistReasoningEffort, 'max');
  assert.equal(saved.inlineAssistThinkingEnabled, true);
  assert.equal(root.querySelector('.effort-opt .effort-value').textContent, 'Max');
});

test('the full panel footer has the same slider beside the model', async () => {
  const { env, root } = await open({ inlineAssistReasoningEffort: 'minimal' });
  const controls = [...root.querySelectorAll('.foot .foot-control')];
  const effort = controls.find((control) => control.querySelector('.effort'));
  assert.ok(effort, 'an Effort control in the footer');
  assert.equal(controls.indexOf(effort), controls.findIndex((control) => control.querySelector('.dd[data-setting="model"]')) + 1);
  assert.equal(effort.querySelector('input.effort-range').value, '0');
  slideTo(env, effort.querySelector('input.effort-range'), 2);
  await env.sleep();
  assert.equal(env.stored.map((write) => write.hermesBrowserSettings).filter(Boolean).at(-1).inlineAssistReasoningEffort, 'medium');
});

test('an effort saved elsewhere moves an open slider', async () => {
  const { env, root } = await open({ inlineAssistReasoningEffort: 'low' });
  env.changeStorage({ hermesBrowserSettings: { newValue: { ...ASSIST_MODEL, inlineAssistReasoningEffort: 'ultra' } } });
  await env.sleep();
  assert.equal(root.querySelector('.foot input.effort-range').value, '6');
});

test('the quick menu names the model as people know it, with its effort', async () => {
  const { root } = await open({ inlineAssistOpenMode: 'quick', inlineAssistReasoningEffort: 'high' });
  const summary = root.querySelector('.quick-summary').textContent;
  assert.match(summary, /gpt-6\.1-terra · High$/);
  assert.doesNotMatch(summary, /openai-codex::/);
});
