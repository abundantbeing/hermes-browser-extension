// The welcome screen before step one: not a step, drawn in the suggested
// language with the English words beneath, two buttons, no Back, and gone for a
// rerun or a returning user.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

import { SUPPORTED_LOCALES, loadLocaleMessages, localeMetadata } from '../extension/lib/i18n-registry.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { createOnboardingFlow } from '../extension/lib/onboarding-flow.mjs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const js = read('extension/sidepanel.js');
const css = read('extension/sidepanel.css');

function click(element, window) {
  element.dispatchEvent(new window.Event('click', { bubbles: true }));
}

function keydown(element, window, name) {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  event.key = name;
  element.dispatchEvent(event);
  return event;
}

function mount({ locale = 'ar' } = {}) {
  const { document, window } = parseHTML('<!doctype html><html dir="ltr"><body><section id="host" hidden></section></body></html>');
  const host = document.getElementById('host');
  const state = {
    theme: 'nous', colorMode: 'dark', resolvedMode: 'dark', fontProfile: 'signature', responseStyle: 'vivid', messageLayout: 'bubbles',
    connection: { connected: false, status: '' },
    language: { current: 'en', selected: locale, copy: { locale, title: 'اللغة', body: 'ب' }, english: { title: 'Choose your language' } },
    welcome: {
      copy: { locale, title: 'مرحبًا بك', body: 'لنبدأ', start: 'ابدأ', skip: 'تخطي الإعداد' },
      english: { title: 'Welcome to Hermes Browser', body: 'Let us set it up.', start: 'Get started', skip: 'Skip setup' },
      greetings: [{ lang: 'en', dir: 'ltr', text: 'Welcome' }, { lang: 'ar', dir: 'rtl', text: 'مرحبًا' }],
    },
  };
  const calls = [];
  const flow = createOnboardingFlow({
    host,
    languages: SUPPORTED_LOCALES,
    translate: (key) => key,
    getState: () => state,
    onLeaveStep: (step) => calls.push(['leave', step]),
    onFinish: (detail) => calls.push(['finish', detail.reason]),
    reducedMotion: () => true,
    wait: () => Promise.resolve(),
  });
  return { document, window, host, flow, state, calls };
}

test('a first run opens on the welcome, which is not a step', () => {
  const { host, flow } = mount();
  flow.open({ welcome: true });
  assert.equal(flow.step, 'welcome');
  assert.equal(flow.welcoming, true);
  assert.equal(host.dataset.step, 'welcome');
  assert.deepEqual(flow.steps, ['language', 'theme', 'font', 'style', 'layout', 'connect'], 'the six steps are unchanged');
  assert.equal(host.querySelectorAll('.onboarding-progress i').length, 0, 'no progress dots on the welcome');
  assert.equal(host.querySelector('.onboarding-count').textContent, '', 'no "Step X of N"');
  assert.equal(host.querySelector('.onboarding-count').hidden, true);
  assert.equal(host.querySelector('.onboarding-nav').hidden, true, 'no Back or Next');
  assert.equal(host.querySelector('[data-onboarding-skip]').hidden, true, 'the welcome has its own Skip setup');
});

test('a rerun (no welcome flag) goes straight to the language step', () => {
  const { host, flow } = mount();
  flow.open();
  assert.equal(flow.step, 'language');
  assert.equal(flow.welcoming, false);
  assert.equal(host.querySelector('.onboarding-welcome'), null);
  assert.equal(host.querySelector('.onboarding-count').hidden, false);
});

test('the welcome is drawn in the suggested language with the English words beneath', () => {
  const { host, flow } = mount();
  flow.open({ welcome: true });
  const title = host.querySelector('#onboardingStepTitle');
  assert.equal(title.textContent, 'مرحبًا بك');
  assert.equal(title.getAttribute('lang'), 'ar');
  assert.equal(title.getAttribute('dir'), 'rtl');
  const english = host.querySelector('.onboarding-title-english');
  assert.equal(english.textContent, 'Welcome to Hermes Browser');
  assert.equal(english.getAttribute('lang'), 'en');
  assert.equal(english.getAttribute('dir'), 'ltr');
  assert.equal(host.querySelector('.onboarding-body-english').textContent, 'Let us set it up.');
  assert.equal(host.querySelector('[data-onboarding-start] span').textContent, 'ابدأ');
  assert.equal(host.querySelector('[data-onboarding-start] small').textContent, 'Get started');
  assert.equal(host.querySelector('[data-onboarding-skip-setup] span').textContent, 'تخطي الإعداد');
  assert.equal(host.querySelector('[data-onboarding-skip-setup] small').textContent, 'Skip setup');
  const greetings = host.querySelector('.onboarding-welcome-greetings');
  assert.equal(greetings.getAttribute('aria-hidden'), 'true', 'decoration, the heading says it');
  assert.deepEqual([...greetings.querySelectorAll('span')].map((span) => [span.getAttribute('lang'), span.getAttribute('dir')]), [['en', 'ltr'], ['ar', 'rtl']]);
});

test('an English suggestion has no second English line', () => {
  const { host, flow, state } = mount({ locale: 'en' });
  state.welcome.copy = { locale: 'en', title: 'Welcome to Hermes Browser', body: 'Let us set it up.', start: 'Get started', skip: 'Skip setup' };
  flow.open({ welcome: true });
  assert.equal(host.querySelector('.onboarding-title-english'), null);
  assert.equal(host.querySelector('.onboarding-body-english'), null);
  assert.equal(host.querySelector('[data-onboarding-start] small'), null);
});

test('Get started goes to the language step with nothing committed and no way back', () => {
  const { host, flow, calls, window } = mount();
  flow.open({ welcome: true });
  const start = host.querySelector('[data-onboarding-start]');
  assert.ok(start && start.tagName === 'BUTTON' && start.type === 'button', 'a real button: Enter and Space work');
  click(start, window);
  assert.equal(flow.step, 'language');
  assert.equal(flow.welcoming, false);
  assert.deepEqual(calls, [], 'leaving the welcome never commits the suggested language');
  assert.equal(host.querySelectorAll('.onboarding-progress i').length, 6);
  assert.equal(host.querySelector('[data-onboarding-back]').hidden, true, 'no Back to a welcome');
  assert.equal(host.querySelector('.onboarding-count').hidden, false);
});

test('Skip setup ends setup like Skip but never keeps the suggested language: nobody saw the language step', async () => {
  const { host, flow, calls, window } = mount();
  flow.open({ welcome: true });
  click(host.querySelector('[data-onboarding-skip-setup]'), window);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['finish', 'skip']], 'the same finish reason as Skip, and no step was left, so no language is applied or saved');
  assert.equal(flow.isOpen, false);
  assert.equal(flow.welcoming, false);
});

test('Skip on the language step itself still keeps the suggestion it showed', async () => {
  const { host, flow, calls, window } = mount();
  flow.open({ welcome: true });
  click(host.querySelector('[data-onboarding-start]'), window);
  click(host.querySelector('[data-onboarding-skip]'), window);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['leave', 'language'], ['finish', 'skip']]);
});

test('Escape, the arrows and a swipe do nothing on the welcome', () => {
  const { host, flow, window } = mount();
  flow.open({ welcome: true });
  const target = host.querySelector('.onboarding-title');
  assert.equal(keydown(target, window, 'Escape').defaultPrevented, false);
  keydown(target, window, 'ArrowRight');
  keydown(target, window, 'ArrowLeft');
  assert.equal(flow.step, 'welcome');
  assert.equal(flow.isOpen, true);
  const pointer = (type, x, y) => {
    const event = new window.Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, clientY: y, isPrimary: true });
    host.querySelector('.onboarding-stage').dispatchEvent(event);
  };
  pointer('pointerdown', 300, 200);
  pointer('pointerup', 120, 205);
  assert.equal(flow.step, 'welcome', 'a swipe does not skip the welcome');
});

test('the panel opens a first run on the welcome and a rerun at the language step', () => {
  const maybe = js.match(/function maybeOpenOnboarding\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(maybe, /openOnboarding\(\{ welcome: true \}\);/);
  assert.match(js, /els\.rerunOnboardingButton\?\.addEventListener\('click', \(\) => \{\s*closeSettingsDialog\(\);\s*openOnboarding\(\{ rerun: true \}\);/, 'no welcome on a rerun');
  assert.match(js, /flow\.open\(\{ step, includeConnect, origin, welcome \}\);/);
  assert.match(maybe, /shouldShowOnboarding\(\{ completed: onboardingCompleted, legacyIntroSeen: browserIntroSeen/, 'returning users never reach it');
});

test("the welcome state is the suggested language's own words, with the English words beside them", async () => {
  const start = js.indexOf('function onboardingWelcomeState(');
  const source = js.slice(start, js.indexOf('\n}\n', start) + 3);
  const make = (onboardingLanguage) => {
    const context = { SUPPORTED_LOCALES, localeMetadata, formatMessage, getLocale: () => 'en', onboardingLanguage };
    vm.createContext(context);
    vm.runInContext(source, context);
    return JSON.parse(JSON.stringify(vm.runInContext('onboardingWelcomeState()', context)));
  };
  const state = make({ suggested: 'ar', picked: '', suggestionActive: true });
  const arabic = await loadLocaleMessages('ar');
  const english = await loadLocaleMessages('en');
  assert.equal(state.copy.locale, 'ar');
  assert.equal(state.copy.title, arabic['onboarding.welcome.title']);
  assert.equal(state.copy.start, arabic['onboarding.welcome.start']);
  assert.equal(state.english.title, english['onboarding.welcome.title']);
  assert.equal(state.english.skip, english['onboarding.welcome.skip']);
  assert.deepEqual(state.greetings.map((entry) => entry.lang), ['en', 'ar', 'zh-CN', 'es', 'hi', 'ja']);
  assert.equal(state.greetings.find((entry) => entry.lang === 'ar').dir, 'rtl');
  assert.equal(state.greetings.find((entry) => entry.lang === 'ja').text, (await loadLocaleMessages('ja'))['onboarding.welcome.greeting']);
  assert.equal(make({ suggested: '', picked: '', suggestionActive: false }).copy.locale, 'en', 'English when nothing is suggested');
});

test('the five welcome strings exist in all 21 locales', async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadLocaleMessages(locale.id);
    for (const key of ['title', 'body', 'greeting', 'start', 'skip']) {
      assert.equal(typeof catalog[`onboarding.welcome.${key}`], 'string', `${locale.id} ${key}`);
      assert.ok(catalog[`onboarding.welcome.${key}`].length > 0);
    }
    assert.match(catalog['onboarding.welcome.title'], /Hermes Browser/, `${locale.id} keeps the product name`);
  }
});

test('the welcome art is the existing ink mask plus a CSS-only dither, static, theme-tinted and quiet under reduced motion', () => {
  assert.match(css, /\.onboarding\[data-step="welcome"\]::before \{ opacity: 0\.27; \}/, 'the gate art comes up to strength');
  const dither = css.match(/\.onboarding\[data-step="welcome"\]::after \{[^}]*\}/)?.[0] || '';
  assert.match(dither, /repeating-conic-gradient\(var\(--startup-fg\) 0 25%, transparent 0 50%\)/, 'an ordered checker in the theme ink, no image and no script');
  assert.match(dither, /image-rendering: pixelated;/);
  assert.doesNotMatch(dither, /url\(/);
  assert.match(css, /html\[data-hermes-mode="light"\] \.onboarding\[data-step="welcome"\]::before \{ opacity: 0\.16; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.onboarding-welcome-greetings span \{ animation: none; \} \}/);
  assert.match(css, /\.onboarding-welcome \{[^}]*width: min\(100%, 340px\);/);
});
