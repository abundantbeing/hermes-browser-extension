// Setup's first step: language. Every supported locale by its own name, the
// browser's best match preselected as a suggestion, a pick applied at once
// through Settings' own call, and nothing shown to someone who already ran it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

import { SUPPORTED_LOCALES, localeMetadata, loadLocaleMessages, matchSupportedLocale, suggestLocale } from '../extension/lib/i18n-registry.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { ONBOARDING_STEPS, createOnboardingFlow } from '../extension/lib/onboarding-flow.mjs';

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

function mount({ language = { current: 'en', selected: 'ar' }, direction = 'ltr' } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html dir="${direction}"><body><section id="host" hidden></section></body></html>`);
  const host = document.getElementById('host');
  const state = {
    theme: 'nous', colorMode: 'dark', resolvedMode: 'dark', fontProfile: 'signature', responseStyle: 'vivid', messageLayout: 'bubbles',
    connection: { connected: false, status: '' },
    language: {
      ...language,
      copy: { locale: language.selected, title: 'عنوان', body: 'نص' },
      english: { title: 'Choose your language' },
    },
  };
  const calls = [];
  const flow = createOnboardingFlow({
    host,
    themes: [],
    languages: SUPPORTED_LOCALES,
    translate: (key) => (state.language.current === 'ar' ? `ar:${key}` : key),
    getState: () => state,
    onSelectLanguage: (locale) => {
      calls.push(['language', locale]);
      state.language = { ...state.language, selected: locale, current: locale, copy: { locale, title: `title-${locale}`, body: 'b' } };
    },
    onLeaveStep: (step) => calls.push(['leave', step]),
    onFinish: (detail) => calls.push(['finish', detail.reason]),
    reducedMotion: () => true,
    wait: () => Promise.resolve(),
  });
  return { document, window, host, flow, state, calls };
}

test('setup begins with the language step, ahead of theme, and Connect stays last', () => {
  assert.deepEqual(ONBOARDING_STEPS, ['language', 'theme', 'font', 'style', 'layout', 'connect']);
  const { flow } = mount();
  flow.open();
  assert.equal(flow.step, 'language', 'the default first step');
  assert.equal(flow.steps.at(-1), 'connect');
});

test('the browser UI language list picks the best supported match, English when nothing fits', () => {
  assert.equal(matchSupportedLocale('ar-SA'), 'ar');
  assert.equal(matchSupportedLocale('de-CH'), 'de');
  assert.equal(matchSupportedLocale('zh-Hant-TW'), 'zh-TW');
  assert.equal(matchSupportedLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(matchSupportedLocale('pt-PT'), 'pt-BR');
  assert.equal(matchSupportedLocale('en_AU'), 'en');
  assert.equal(matchSupportedLocale('he'), '', 'an unsupported language matches nothing');
  assert.equal(matchSupportedLocale(''), '');
  assert.equal(suggestLocale(['he', 'fr-CA', 'de']), 'fr', 'the first language the panel speaks');
  assert.equal(suggestLocale(['', 'sv']), 'en');
  assert.equal(suggestLocale([]), 'en');
  assert.equal(suggestLocale(), 'en');
});

test('the step lists all 21 supported locales by their own names, from the registry', () => {
  const { host, flow } = mount();
  flow.open();
  const cards = [...host.querySelectorAll('[data-onboarding-language]')];
  assert.equal(cards.length, 21);
  assert.deepEqual(cards.map((card) => card.dataset.onboardingLanguage), SUPPORTED_LOCALES.map((locale) => locale.id), 'the registry order, no second list');
  assert.deepEqual(cards.map((card) => card.querySelector('.onboarding-language-name').textContent), SUPPORTED_LOCALES.map((locale) => locale.nativeName));
  for (const name of ['العربية', '日本語', 'Deutsch', 'Português (Brasil)', 'हिन्दी', 'ไทย']) {
    assert.ok(cards.some((card) => card.textContent.includes(name)), `${name} is listed as written in that language`);
  }
  for (const card of cards) {
    const locale = SUPPORTED_LOCALES.find((entry) => entry.id === card.dataset.onboardingLanguage);
    assert.equal(card.getAttribute('lang'), locale.id, 'each name is tagged with its own language');
    assert.equal(card.getAttribute('dir'), locale.direction);
  }
  assert.ok(!/onboarding-language-name[^>]*>[^<]*…/.test(host.innerHTML), 'no names are truncated in the markup');
});

test('the language cards are a radio group with a roving tab stop on the preselected one', () => {
  const { host, flow } = mount({ language: { current: 'en', selected: 'ar' } });
  flow.open();
  const group = host.querySelector('.onboarding-language-grid');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.getAttribute('aria-label'), 'عنوان', 'named by the step heading');
  const cards = [...group.querySelectorAll('[role="radio"]')];
  assert.equal(cards.length, 21);
  assert.deepEqual(cards.filter((card) => card.getAttribute('aria-checked') === 'true').map((card) => card.dataset.onboardingLanguage), ['ar']);
  assert.deepEqual(cards.filter((card) => card.getAttribute('tabindex') === '0').map((card) => card.dataset.onboardingLanguage), ['ar'], 'one tab stop');
  assert.ok(cards.filter((card) => card.dataset.onboardingLanguage !== 'ar').every((card) => card.getAttribute('tabindex') === '-1'));
  assert.ok(cards.every((card) => card.tagName === 'BUTTON' && card.type === 'button'), 'real buttons, operable from the keyboard');
  assert.ok(cards.every((card) => card.dataset.radioKey.startsWith('language:')));
});

test('the heading is in the preselected language with the English line under it', () => {
  const { host, flow, state } = mount({ language: { current: 'en', selected: 'ar' } });
  flow.open();
  const title = host.querySelector('#onboardingStepTitle');
  assert.equal(title.textContent, 'عنوان');
  assert.equal(title.getAttribute('lang'), 'ar');
  assert.equal(title.getAttribute('dir'), 'rtl');
  const english = host.querySelector('.onboarding-title-english');
  assert.equal(english.textContent, 'Choose your language');
  assert.equal(english.getAttribute('lang'), 'en');
  assert.equal(english.getAttribute('dir'), 'ltr');
  assert.equal(host.querySelector('.onboarding-body').textContent, 'نص');
  state.language = { ...state.language, selected: 'en', copy: { locale: 'en', title: 'Choose your language', body: 'b' } };
  flow.render();
  assert.equal(host.querySelector('.onboarding-title-english'), null, 'no second English line when the heading already is English');
});

test('a pick is applied at once through the host call, and it moves the selection', () => {
  const { host, flow, calls, window } = mount({ language: { current: 'en', selected: 'en' } });
  flow.open();
  click(host.querySelector('[data-onboarding-language="ar"]'), window);
  assert.deepEqual(calls, [['language', 'ar']]);
  assert.equal(host.querySelector('[data-onboarding-language="ar"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-onboarding-language="en"]').getAttribute('aria-checked'), 'false');
  assert.equal(host.querySelector('#onboardingStepTitle').textContent, 'title-ar');
});

test('arrow keys move the pick along the reading direction and Home/End jump', () => {
  const ltr = mount({ language: { current: 'en', selected: 'en' } });
  ltr.flow.open();
  keydown(ltr.host.querySelector('[data-onboarding-language="en"]'), ltr.window, 'ArrowRight');
  assert.equal(ltr.calls.at(-1)[1], 'es', 'Right is the next language in LTR');
  keydown(ltr.host.querySelector('[data-onboarding-language="es"]'), ltr.window, 'End');
  assert.equal(ltr.calls.at(-1)[1], 'da');
  assert.equal(ltr.flow.step, 'language', 'arrows inside the group never turn the page');
  const rtl = mount({ direction: 'rtl', language: { current: 'ar', selected: 'ar' } });
  rtl.flow.open();
  const arabicIndex = SUPPORTED_LOCALES.findIndex((locale) => locale.id === 'ar');
  keydown(rtl.host.querySelector('[data-onboarding-language="ar"]'), rtl.window, 'ArrowLeft');
  assert.equal(rtl.calls.at(-1)[1], SUPPORTED_LOCALES[(arabicIndex + 1) % SUPPORTED_LOCALES.length].id, 'Left is the next language in RTL');
});

test('leaving the step (Next, Back, finishing) tells the host, so a suggestion nobody picked can be kept', async () => {
  const next = mount();
  next.flow.open();
  click(next.host.querySelector('[data-onboarding-next]'), next.window);
  assert.deepEqual(next.calls, [['leave', 'language']]);
  assert.equal(next.flow.step, 'theme');
  click(next.host.querySelector('[data-onboarding-back]'), next.window);
  assert.deepEqual(next.calls, [['leave', 'language'], ['leave', 'theme']]);
  assert.equal(next.flow.step, 'language');
  const skip = mount();
  skip.flow.open();
  click(skip.host.querySelector('[data-onboarding-skip]'), skip.window);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(skip.calls.slice(0, 2), [['leave', 'language'], ['finish', 'skip']], 'Skip on step one keeps the suggestion first, then ends setup');
});

test('a new language redraws the shell too, and the step count reads in it', () => {
  const { host, flow, state } = mount({ language: { current: 'en', selected: 'en' } });
  flow.open();
  assert.equal(host.querySelector('[data-onboarding-skip]').textContent, 'onboarding.skip');
  state.language = { ...state.language, current: 'ar', selected: 'ar' };
  flow.render();
  assert.equal(host.querySelector('[data-onboarding-skip]').textContent, 'ar:onboarding.skip', 'Skip was drawn once, in the old language; now it follows');
  assert.equal(host.querySelector('.onboarding-count').textContent, 'ar:onboarding.step_count');
  assert.equal(flow.step, 'language', 'the redraw keeps the step');
});

test('a six-step count: progress dots and "step X of N"', () => {
  const { host, flow, window } = mount();
  flow.open();
  assert.equal(host.querySelectorAll('.onboarding-progress i').length, 6);
  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(host.querySelectorAll('.onboarding-progress i.done').length, 1);
  assert.equal(host.querySelector('.onboarding-progress i.active'), host.querySelectorAll('.onboarding-progress i')[1]);
});

// ---- the panel's wiring, run against the real functions ----

function fn(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return js.slice(start, js.indexOf('\n}\n', start) + 3);
}

function panelContext(overrides = {}) {
  const calls = [];
  const context = {
    SUPPORTED_LOCALES,
    localeMetadata,
    formatMessage,
    suggestLocale,
    onboardingLanguage: { suggested: '', picked: '', suggestionActive: false },
    explicitLocaleStored: false,
    currentLocale: 'en',
    getLocale: () => context.currentLocale,
    setLocale: (value) => { calls.push(['setLocale', value]); return Promise.resolve(value); },
    trackInstantSave: (pane, work) => { calls.push(['track', pane]); return work; },
    browserApi: { i18n: { getUILanguage: () => 'ar-EG' } },
    navigator: { languages: ['ar-EG', 'en'] },
    console,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(['chooseOnboardingLanguage', 'keepSuggestedOnboardingLanguage', 'browserLanguageSuggestion', 'onboardingLanguageState'].map(fn).join('\n'), context);
  return { context, calls };
}

test('the browser suggestion comes from its UI language, then navigator.languages', () => {
  const { context } = panelContext();
  assert.equal(vm.runInContext('browserLanguageSuggestion()', context), 'ar');
  const second = panelContext({ browserApi: { i18n: { getUILanguage: () => 'xx' } }, navigator: { languages: ['sv', 'ja-JP'] } });
  assert.equal(vm.runInContext('browserLanguageSuggestion()', second.context), 'ja');
  const none = panelContext({ browserApi: {}, navigator: {} });
  assert.equal(vm.runInContext('browserLanguageSuggestion()', none.context), 'en');
});

test('picking a card calls setLocale (the Settings call) inside the same appearance save wrapper', () => {
  const { context, calls } = panelContext();
  vm.runInContext("chooseOnboardingLanguage('ar')", context);
  assert.deepEqual(calls, [['setLocale', 'ar'], ['track', 'appearance']]);
  assert.equal(vm.runInContext('onboardingLanguage.picked', context), 'ar');
  assert.equal(vm.runInContext('onboardingLanguage.suggestionActive', context), false);
  assert.match(js, /els\.languageSelect\?\.addEventListener\('change', \(\) => \{\s*trackInstantSave\('appearance', setLocale\(els\.languageSelect\.value\)\)/, 'Settings makes exactly this call');
});

test('Next or Skip on the step keeps a suggestion nobody picked, and only then', () => {
  const kept = panelContext();
  vm.runInContext("onboardingLanguage = { suggested: 'ar', picked: '', suggestionActive: true }", kept.context);
  vm.runInContext('keepSuggestedOnboardingLanguage()', kept.context);
  assert.deepEqual(kept.calls, [['setLocale', 'ar'], ['track', 'appearance']]);
  assert.equal(vm.runInContext('onboardingLanguage.suggestionActive', kept.context), false);
  vm.runInContext('keepSuggestedOnboardingLanguage()', kept.context);
  assert.equal(kept.calls.length, 2, 'kept once');

  const already = panelContext({ currentLocale: 'ar' });
  vm.runInContext("onboardingLanguage = { suggested: 'ar', picked: '', suggestionActive: true }", already.context);
  vm.runInContext('keepSuggestedOnboardingLanguage()', already.context);
  assert.deepEqual(already.calls, [], 'the language already in force needs no write');

  const picked = panelContext();
  vm.runInContext("onboardingLanguage = { suggested: 'ar', picked: '', suggestionActive: true }", picked.context);
  vm.runInContext("chooseOnboardingLanguage('de')", picked.context);
  vm.runInContext('keepSuggestedOnboardingLanguage()', picked.context);
  assert.deepEqual(picked.calls.map((call) => call[1]), ['de', 'appearance'], 'a pick is never overwritten by the suggestion');

  const rerun = panelContext();
  vm.runInContext("onboardingLanguage = { suggested: 'ja', picked: '', suggestionActive: false }", rerun.context);
  vm.runInContext('keepSuggestedOnboardingLanguage()', rerun.context);
  assert.deepEqual(rerun.calls, [], 'a rerun never changes the saved language by leaving the step');
});

test("the step's state: the suggestion, flagged as one, in its own language; the English title beside it", async () => {
  const { context } = panelContext();
  vm.runInContext("onboardingLanguage = { suggested: 'ar', picked: '', suggestionActive: true }", context);
  const state = JSON.parse(JSON.stringify(vm.runInContext('onboardingLanguageState()', context)));
  const arabic = await loadLocaleMessages('ar');
  const english = await loadLocaleMessages('en');
  assert.equal(state.current, 'en');
  assert.equal(state.selected, 'ar');
  assert.equal(state.copy.locale, 'ar');
  assert.equal(state.copy.title, arabic['onboarding.language.title']);
  assert.equal(state.copy.body, formatMessage(arabic['onboarding.language.body_suggested'], { language: 'العربية' }, 'ar'), 'it says this is only a suggestion, naming the language');
  assert.equal(state.english.title, english['onboarding.language.title']);

  vm.runInContext("onboardingLanguage = { suggested: 'ja', picked: '', suggestionActive: false }", context);
  const rerun = JSON.parse(JSON.stringify(vm.runInContext('onboardingLanguageState()', context)));
  assert.equal(rerun.selected, 'ja', 'a rerun preselects the saved language');
  const japanese = await loadLocaleMessages('ja');
  assert.equal(rerun.copy.body, japanese['onboarding.language.body'], 'and does not call it a suggestion');
});

test('setup opens at the language step; first run suggests, a rerun or a stored choice preselects the saved language', () => {
  const open = fn('openOnboarding');
  assert.match(open, /\{ step = 'language', includeConnect = !isConnected\(\), rerun = false \} = \{\}/);
  assert.match(open, /\(rerun \|\| explicitLocaleStored\)\s*\? \{ suggested: getLocale\(\), picked: '', suggestionActive: false \}\s*: \{ suggested: browserLanguageSuggestion\(\), picked: '', suggestionActive: true \}/);
  assert.match(js, /els\.rerunOnboardingButton\?\.addEventListener\('click', \(\) => \{\s*closeSettingsDialog\(\);\s*openOnboarding\(\{ rerun: true \}\);/);
  assert.match(js, /onSelectLanguage: \(locale\) => chooseOnboardingLanguage\(locale\),\s*onLeaveStep: \(step\) => \{ if \(step === 'language'\) keepSuggestedOnboardingLanguage\(\); \}/);
  assert.match(js, /languages: SUPPORTED_LOCALES,/, 'the registry, not a second list');
  assert.match(js, /explicitLocaleStored = typeof stored\[LOCALE_STORAGE_KEY\] === 'string'/);
  const maybe = fn('maybeOpenOnboarding');
  assert.match(maybe, /shouldShowOnboarding\(\{ completed: onboardingCompleted, legacyIntroSeen: browserIntroSeen/, 'completed or legacy users never get setup, so never this step');
});

test('the strings exist in all 21 locales with {language} intact', async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadLocaleMessages(locale.id);
    for (const key of ['onboarding.language.title', 'onboarding.language.body', 'onboarding.language.body_suggested']) {
      assert.equal(typeof catalog[key], 'string', `${locale.id} ${key}`);
    }
    assert.match(catalog['onboarding.language.body_suggested'], /\{language\}/, `${locale.id} keeps {language}`);
    assert.match(catalog['onboarding.language.body'], /Hermes/, `${locale.id} keeps the product name`);
  }
});

test('the language grid wraps long names and follows the reading direction', () => {
  assert.match(css, /\.onboarding-language-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(132px, 1fr\)\);/);
  const card = css.match(/\.onboarding-language-card \{[^}]*\}/)?.[0] || '';
  assert.match(card, /padding-inline: 8px 26px;/);
  assert.match(card, /text-align: start;/);
  const name = css.match(/\.onboarding-language-name \{[^}]*\}/)?.[0] || '';
  assert.match(name, /overflow-wrap: anywhere;/);
  assert.doesNotMatch(name, /text-overflow|white-space: nowrap|overflow: hidden/, 'names are never clipped');
  assert.match(css, /\.onboarding-language-card:focus-visible \{ outline: 2px solid var\(--hermes-accent\); outline-offset: 2px; \}/, 'visible keyboard focus');
  assert.match(css, /\.onboarding-language-card \.presentation-card-check \{[^}]*inset-inline-end: 8px;/);
});

test('the language step gives its room to the grid: the sample conversation keeps its row but takes no height', () => {
  assert.match(css, /\.onboarding\[data-step="language"\] \.onboarding-preview \{ max-height: 0; visibility: hidden; \}/);
});
