import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { MODEL_EFFORTS, escapeHtml, normalizeFastMode, normalizeReasoningEffort } from '../extension/lib/common.mjs';
import { createI18nRuntime, LOCALE_STORAGE_KEY } from '../extension/lib/i18n.mjs';
import { loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';

// These controls are built in sidepanel.js at run time, so the static HTML check in check-i18n.mjs never
// sees them. Each test runs the real function from sidepanel.js against a real locale catalog.

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in sidepanel.js`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

async function localeRuntime(locale) {
  const runtime = createI18nRuntime({
    documentRef: null,
    storageArea: { get: async () => ({ [LOCALE_STORAGE_KEY]: locale }), set: async () => {} },
    storageEvents: null,
  });
  await runtime.init();
  return { runtime, messages: await loadLocaleMessages(locale) };
}

function run(name, globals, document) {
  const context = vm.createContext({ document, window: document.defaultView, ...globals });
  vm.runInContext(`${functionSource(name)}\nthis.${name} = ${name};`, context);
  return context;
}

// Words that read the same in some languages (German "Minimal", "Max", "Ultra") are left out.
const ENGLISH_CONTROL_TEXT = /\b(?:Options|Bot options|Hermes Assist options|Thinking|Fast|Medium|Extra High|Steer this subagent|Stop this subagent|Not accepting steer|Open generated image for closer inspection|Hermes is thinking)\b/;

async function renderOptionsMenu(locale, target) {
  const { runtime, messages } = await localeRuntime(locale);
  const { document } = new JSDOM('<!doctype html><body><div id="list"></div></body>').window;
  const list = document.getElementById('list');
  const context = run('renderModelRuntimeOptions', {
    els: { modelOptionsList: list, modelMenu: { hidden: false } },
    modelSelectionTarget: target,
    settings: { sessionId: 'session-1', thinkingEnabled: true, fastMode: false, reasoningEffort: 'medium' },
    inlineAssistRuntimeOptions: () => ({ thinkingEnabled: true, fastMode: false, reasoningEffort: 'medium' }),
    currentRoomMemberRuntimeOptions: () => ({ state: 'ok', thinkingEnabled: true, fastMode: false, reasoningEffort: 'medium' }),
    MODEL_EFFORTS,
    normalizeFastMode,
    normalizeReasoningEffort,
    escapeHtml,
    t: runtime.t,
    translateUiText: runtime.translateText,
    createEffortControl: () => document.createElement('div'),
    browserApi: { storage: { local: { set: async () => {} } } },
    setRoomMemberRuntimeOption: () => {},
    setModelRuntimeOption: () => {},
  }, document);
  context.renderModelRuntimeOptions();
  return { list, messages };
}

test('the model options menu speaks the panel language', async () => {
  for (const [target, headingKey] of [['chat', 'ui.options'], ['assist', 'assist.options_heading'], ['room-member', 'ui.bot.options']]) {
    const { list, messages } = await renderOptionsMenu('de', target);
    assert.equal(list.querySelector('.model-options-heading').textContent, messages[headingKey], target);
    const toggles = [...list.querySelectorAll('.model-toggle-option span')].map((node) => node.textContent);
    assert.deepEqual(toggles, [messages['ui.thinking'], messages['ui.fast']], target);
    const efforts = [...list.querySelectorAll('.model-effort-option span')].map((node) => node.textContent);
    assert.deepEqual(efforts, MODEL_EFFORTS.map((item) => messages[`settings.models.effort.${item.value}`]), target);
    assert.doesNotMatch(list.textContent, ENGLISH_CONTROL_TEXT, `${target} menu still shows English`);
  }
});

test('the model options menu keeps its English wording in English', async () => {
  const { list } = await renderOptionsMenu('en', 'chat');
  assert.equal(list.querySelector('.model-options-heading').textContent, 'Options');
  assert.deepEqual([...list.querySelectorAll('.model-toggle-option span')].map((node) => node.textContent), ['Thinking', 'Fast']);
  assert.equal(list.querySelector('[data-effort="medium"] span').textContent, 'Medium');
});

test('the thinking indicator announces itself in the panel language', async () => {
  const { runtime } = await localeRuntime('ja');
  const { document } = new JSDOM('<!doctype html><body><div id="host"></div></body>').window;
  const host = document.getElementById('host');
  const context = run('renderThinkingIndicator', {
    scheduleClassicThinkingFaces: () => {},
    THINKING_STATUSES: ['thinking'],
    classicThinkingFace: () => '(•‿•)',
    thinkingFaceStep: 0,
    escapeHtml,
    translateUiText: runtime.translateText,
  }, document);
  context.renderThinkingIndicator(host);
  const label = host.querySelector('.thinking-indicator').getAttribute('aria-label');
  assert.ok(label);
  assert.doesNotMatch(label, /Hermes is thinking/);
  assert.match(label, /Hermes/, 'the protected product name stays');
});

test('the generated image inspection control is labelled in the panel language', async () => {
  const { runtime, messages } = await localeRuntime('de');
  const { document } = new JSDOM('<!doctype html><body><div id="root"><img data-slot="aui_generated-image" src="data:,"></div></body>').window;
  const context = run('wrapGeneratedImagesForInspection', { t: runtime.t, openGeneratedImageLightbox: () => {} }, document);
  context.wrapGeneratedImagesForInspection(document.getElementById('root'));
  assert.equal(document.querySelector('.generated-image-inspectable').getAttribute('aria-label'), messages['ui.open.generated.image.for.closer.inspection']);
});

test('the subagent steer and stop controls are labelled in the panel language', async () => {
  const { runtime, messages } = await localeRuntime('de');
  const { document } = new JSDOM('<!doctype html><body><div id="stack"><button id="toggle"></button><span id="summary"></span><ul id="list"></ul><div id="detail"></div></div></body>').window;
  const item = { id: 'sub-1', status: 'running', goal: 'Read the docs', acceptingSteer: true, stream: [{ text: 'started' }] };
  const globals = {
    els: {
      subagentStack: document.getElementById('stack'),
      subagentStackToggle: document.getElementById('toggle'),
      subagentStackSummary: document.getElementById('summary'),
      subagentStackList: document.getElementById('list'),
      subagentStackDetail: document.getElementById('detail'),
    },
    currentSubagentItems: () => [item],
    activeSubagentView: (items) => items,
    ensureSubagentTimer: () => {},
    scheduleSubagentRosterPoll: () => {},
    subagentStackSummary: () => '1 running',
    formatSubagentElapsed: () => '5s',
    subagentSelectedId: 'sub-1',
    subagentExpanded: true,
    subagentSteerDraft: '',
    subagentControlBusy: false,
    subagentControlError: '',
    SUBAGENT_STEER_ICON: '<svg></svg>',
    SUBAGENT_STOP_ICON: '■',
    runSelectedSubagentControl: async () => {},
    t: runtime.t,
  };
  const context = run('renderSubagentStack', globals, document);
  context.renderSubagentStack();
  const [steer, stop] = document.querySelectorAll('.subagent-stack-icon');
  assert.equal(steer.getAttribute('aria-label'), messages['ui.steer.this.subagent']);
  assert.equal(steer.title, messages['ui.steer.this.subagent']);
  assert.equal(stop.getAttribute('aria-label'), messages['ui.stop.this.subagent']);
  assert.equal(document.getElementById('subagentSteerInput').placeholder, messages['ui.steer.this.subagent']);

  item.acceptingSteer = false;
  context.renderSubagentStack();
  assert.equal(document.getElementById('subagentSteerInput').placeholder, messages['ui.not.accepting.steer']);
});

test('every new control string exists in every locale', async () => {
  const keys = ['ui.bot.options', 'ui.fast', 'ui.steer.this.subagent', 'ui.stop.this.subagent', 'ui.not.accepting.steer', 'ui.open.generated.image.for.closer.inspection', 'ui.group.settings'];
  const { SUPPORTED_LOCALES } = await import('../extension/lib/i18n-registry.mjs');
  const english = await loadLocaleMessages('en');
  for (const locale of SUPPORTED_LOCALES) {
    const messages = await loadLocaleMessages(locale.id);
    for (const key of keys) {
      assert.equal(typeof messages[key], 'string', `${locale.id} ${key}`);
      if (locale.id !== 'en') assert.notEqual(messages[key], english[key], `${locale.id} ${key} is still English`);
    }
  }
});
