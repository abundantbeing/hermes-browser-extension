import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  MESSAGE_LAYOUT_DEFAULT,
  RESPONSE_STYLE_DEFAULT,
  normalizeMessageLayout,
  normalizeResponseStyle,
  responsePresentationFromSettings,
  responseStyleInstructions,
  shouldShowOnboarding,
  withResponsePresentationUpdate,
} from '../extension/lib/response-presentation.mjs';
import { ONBOARDING_STEPS, createOnboardingFlow } from '../extension/lib/onboarding-flow.mjs';

const THEMES = [
  { value: 'nous', name: 'Nous', description: 'Blue', preview: { bg: '#00f', panel: '#00f', text: '#fff', muted: '#ddd', accent: '#fff' } },
  { value: 'mono', name: 'Mono', description: 'Gray', preview: { bg: '#111', panel: '#111', text: '#eee', muted: '#999', accent: '#222' } },
];

function click(element, window) {
  element.dispatchEvent(new window.Event('click', { bubbles: true }));
}

function mountFlow(overrides = {}) {
  const { document, window } = parseHTML('<!doctype html><html><body><section id="host" hidden></section></body></html>');
  const host = document.getElementById('host');
  const state = { theme: 'nous', responseStyle: 'vivid', messageLayout: 'bubbles' };
  const calls = [];
  const flow = createOnboardingFlow({
    host,
    themes: THEMES,
    translate: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key),
    getState: () => state,
    onSelectTheme: (theme) => { state.theme = theme; calls.push(['theme', theme]); },
    onSelectStyle: (style) => { state.responseStyle = style; calls.push(['style', style]); },
    onSelectLayout: (layout) => { state.messageLayout = layout; calls.push(['layout', layout]); },
    onFinish: (detail) => calls.push(['finish', detail.reason]),
    ...overrides,
  });
  return { document, window, host, flow, state, calls };
}

test('presentation preferences normalize and keep other settings', () => {
  assert.equal(RESPONSE_STYLE_DEFAULT, 'rich');
  assert.equal(MESSAGE_LAYOUT_DEFAULT, 'bubbles');
  assert.equal(normalizeResponseStyle('VIVID'), 'vivid');
  assert.equal(normalizeResponseStyle('markdown'), 'rich');
  assert.equal(normalizeMessageLayout('user-bubble'), 'user-bubble');
  assert.equal(normalizeMessageLayout('left'), 'bubbles');
  assert.deepEqual(responsePresentationFromSettings({}), { responseStyle: 'rich', messageLayout: 'bubbles' });
  const next = withResponsePresentationUpdate({ appearanceTheme: 'mono', responseStyle: 'rich' }, { responseStyle: 'plain' });
  assert.deepEqual(next, { appearanceTheme: 'mono', responseStyle: 'plain' });
  assert.equal(withResponsePresentationUpdate({}, { messageLayout: '<script>' }).messageLayout, 'bubbles');
});

test('setup shows once for a new user only', () => {
  assert.equal(shouldShowOnboarding({}), true);
  assert.equal(shouldShowOnboarding({ completed: true }), false);
  assert.equal(shouldShowOnboarding({ legacyIntroSeen: true }), false, 'an existing user who used the panel skips it');
  assert.equal(shouldShowOnboarding({ messageCount: 2 }), false);
  assert.equal(shouldShowOnboarding({ completed: true, forced: true }), true, 'Settings can run it again');
});

test('response style system notes: rich and vivid add nothing (Vivid rides in each turn), plain asks for no Markdown', () => {
  assert.equal(responseStyleInstructions('rich'), '');
  assert.equal(responseStyleInstructions('vivid'), '', 'a session prompt saved under Vivid could not follow a later switch');
  assert.match(responseStyleInstructions('plain'), /no Markdown/);
});

test('setup walks theme, style, layout and finish, applying each choice live', () => {
  const { host, flow, calls, window } = mountFlow();
  assert.deepEqual(ONBOARDING_STEPS, ['theme', 'style', 'layout', 'finish']);
  assert.equal(host.hidden, true);
  flow.open();
  assert.equal(host.hidden, false);
  assert.equal(flow.step, 'theme');
  assert.equal(host.querySelectorAll('[data-onboarding-theme]').length, 2);
  assert.equal(host.querySelector('[data-onboarding-theme="nous"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-onboarding-back]'), null, 'no Back on the first step');

  click(host.querySelector('[data-onboarding-theme="mono"]'), window);
  assert.deepEqual(calls.at(-1), ['theme', 'mono']);
  assert.equal(host.querySelector('[data-onboarding-theme="mono"]').getAttribute('aria-checked'), 'true');

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'style');
  const styles = [...host.querySelectorAll('[data-onboarding-style]')].map((node) => node.dataset.onboardingStyle);
  assert.deepEqual(styles, ['vivid', 'rich', 'plain']);
  click(host.querySelector('[data-onboarding-style="plain"]'), window);
  assert.deepEqual(calls.at(-1), ['style', 'plain']);

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'layout');
  const layouts = [...host.querySelectorAll('[data-onboarding-layout]')].map((node) => node.dataset.onboardingLayout);
  assert.deepEqual(layouts, ['bubbles', 'user-bubble']);
  click(host.querySelector('[data-onboarding-layout="user-bubble"]'), window);
  assert.deepEqual(calls.at(-1), ['layout', 'user-bubble']);

  click(host.querySelector('[data-onboarding-back]'), window);
  assert.equal(flow.step, 'style');
  click(host.querySelector('[data-onboarding-next]'), window);
  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'finish');
  assert.equal(host.querySelector('[data-onboarding-skip]'), null, 'the finish step has no Skip');
  const summary = host.querySelector('.onboarding-summary').textContent;
  assert.match(summary, /Mono/);
  assert.match(summary, /responses\.style\.plain/);
  assert.match(summary, /responses\.layout\.user_bubble/);
  assert.equal(host.querySelector('[data-onboarding-next]').textContent, 'onboarding.start');

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.deepEqual(calls.at(-1), ['finish', 'done']);
  assert.equal(flow.isOpen, false);
  assert.equal(host.hidden, true);
});

test('Skip ends setup and keeps what was picked', () => {
  const { host, flow, calls, window } = mountFlow();
  flow.open({ step: 'style' });
  click(host.querySelector('[data-onboarding-style="rich"]'), window);
  click(host.querySelector('[data-onboarding-skip]'), window);
  assert.deepEqual(calls, [['style', 'rich'], ['finish', 'skip']]);
  assert.equal(flow.isOpen, false);
});

test('setup copy never names another product and escapes theme names', () => {
  const { host, flow } = mountFlow({ themes: [{ value: 'x', name: '<img src=x onerror=alert(1)>', preview: {} }] });
  flow.open();
  assert.equal(host.querySelector('img'), null);
  const english = fs.readFileSync(new URL('../extension/lib/locales/en.mjs', import.meta.url), 'utf8');
  const setupCopy = english.split('\n').filter((line) => /"(onboarding|responses)\./.test(line)).join('\n');
  assert.ok(setupCopy.length > 0);
  assert.doesNotMatch(setupCopy, /iMessage|WhatsApp|Telegram|ChatGPT|Messenger/i);
});

test('side panel replaces the old first-run block with setup and offers it again in Settings', () => {
  const html = fs.readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="onboardingFlow"[^>]*hidden/);
  assert.match(html, /id="responseStyleChoices"/);
  assert.match(html, /id="messageLayoutChoices"/);
  assert.match(html, /id="rerunOnboardingButton"/);
  assert.doesNotMatch(js, /THE PAGE IS THE PROMPT/);
  assert.match(js, /ONBOARDING_COMPLETED_STORAGE_KEY/);
  assert.match(js, /els\.rerunOnboardingButton\?\.addEventListener\('click'[\s\S]{0,120}openOnboarding\(\)/);
});
