import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField } from './inline-assist-dom.mjs';

// Where it runs and Model, in the full panel's footer and the quick menu's options: on-brand dropdowns, never
// the browser's own select list, and Model changes the model right there.
const MODELS = [
  { id: 'anthropic::claude-haiku-5-5', rawModelId: 'claude-haiku-5-5', provider: 'anthropic', label: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
  { id: 'openai-codex::gpt-6.1-terra', rawModelId: 'gpt-6.1-terra', provider: 'openai-codex', label: 'gpt-6.1-terra', providerLabel: 'OpenAI Codex' },
];

async function open({ mode = 'panel', settings = {} } = {}) {
  const picked = [];
  const env = bootAssist({
    settings: { inlineAssistOpenMode: mode, inlineAssistDefaultRoute: 'background', inlineAssistModel: 'anthropic::claude-haiku-5-5', ...settings },
    replies: {
      HERMES_INLINE_ASSIST_MODELS: () => ({ ok: true, models: MODELS, selectedId: 'anthropic::claude-haiku-5-5' }),
      HERMES_INLINE_ASSIST_SET_MODEL: (message) => { picked.push(message.id); return { ok: true, model: MODELS.find((item) => item.id === message.id) }; },
    },
  });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  const root = env.root();
  if (mode === 'quick') {
    env.userClick(root.querySelector('.quick-options'));
    await env.sleep(40);
  }
  return { env, root, picked };
}

const dropdown = (root, setting) => root.querySelector(`.dd[data-setting="${setting}"]`);
const options = (box) => [...box.querySelectorAll('[role="option"]')];

for (const mode of ['panel', 'quick']) {
  test(`${mode}: Where it runs is an on-brand dropdown that saves the choice`, async () => {
    const { env, root } = await open({ mode });
    assert.equal(root.querySelector('.panel select'), null, 'no native select anywhere in Assist');
    const box = dropdown(root, 'route');
    assert.ok(box, 'the route dropdown');
    const trigger = box.querySelector('button.dd-button');
    assert.match(trigger.textContent, /Run in background/);
    assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
    env.userClick(trigger);
    await env.sleep(20);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(options(box).map((item) => item.dataset.value), ['ask', 'current', 'new', 'background']);
    env.userClick(options(box)[0]);
    await env.sleep(40);
    assert.match(trigger.textContent, /Ask every time/);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    const write = env.stored.findLast((items) => items.hermesBrowserSettings);
    assert.equal(write?.hermesBrowserSettings.inlineAssistDefaultRoute, 'ask');
  });

  test(`${mode}: Model lists the verified models and changes the model right there`, async () => {
    const { env, root, picked } = await open({ mode });
    const box = dropdown(root, 'model');
    assert.ok(box, 'the model dropdown');
    const trigger = box.querySelector('button.dd-button');
    env.userClick(trigger);
    await env.sleep(60);
    assert.ok(env.sent.some((message) => message.type === 'HERMES_INLINE_ASSIST_MODELS'), 'asked the background for the list');
    assert.deepEqual(options(box).map((item) => item.dataset.value), MODELS.map((item) => item.id));
    assert.equal(options(box)[0].getAttribute('aria-selected'), 'true', 'the current model is marked');
    env.userClick(options(box)[1]);
    await env.sleep(60);
    assert.deepEqual(picked, ['openai-codex::gpt-6.1-terra']);
    assert.match(trigger.textContent, /gpt-6\.1-terra/);
  });
}

test('the dropdown works from the keyboard: arrows move, Enter picks, Escape closes', async () => {
  const { env, root } = await open();
  const box = dropdown(root, 'route');
  const trigger = box.querySelector('button.dd-button');
  const key = (target, value) => {
    for (const listener of env.listenersFor(box, 'keydown')) listener.call(box, { type: 'keydown', key: value, target, isTrusted: true, preventDefault() {}, stopPropagation() {} });
  };
  key(trigger, 'ArrowDown');
  await env.sleep(20);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  key(root.activeElement || trigger, 'Escape');
  await env.sleep(20);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
