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

async function localeRuntime(locale, documentRef = null) {
  const runtime = createI18nRuntime({
    documentRef,
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
    t: runtime.t,
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

test('the group Settings button speaks the panel language', async () => {
  const { runtime, messages } = await localeRuntime('de');
  const { document } = new JSDOM('<!doctype html><body><div id="menu"></div></body>').window;
  const context = run('renderSessionMenu', {
    els: { sessionMenuList: document.getElementById('menu'), sessionSearchInput: { value: '' } },
    scheduleLiveSessionPoll: () => {},
    syncSessionMenuChrome: () => {},
    projectsTabActive: () => false,
    getProjectsController: () => ({ availability: () => ({ available: false }) }),
    sessionMenuGroups: () => [{
      label: 'Rooms',
      source: 'hermes_bot_group_threads',
      sessions: [{ id: 'group-1', kind: 'group-thread', threadId: 'main', title: 'Room', selected: false, replyCount: 0 }],
    }],
    shouldAutoOpenSessionGroup: () => true,
    openSessionGroups: new Set(),
    closedSessionGroups: new Set(),
    isSessionRenameEditorTarget: () => false,
    selectGroupThreadFromMenu: () => {},
    startNewGroupThread: () => {},
    closeFloatingPanels: () => {},
    openGroupSettingsModal: () => {},
    openSessionRenameEditor: () => {},
    activeGroupProjection: { id: 'group-1', displayName: 'Room' },
    t: runtime.t,
    translateUiText: runtime.translateText,
  }, document);
  context.renderSessionMenu();
  const button = document.querySelector('.session-action-button');
  assert.ok(button, 'the group row renders its Settings button');
  assert.equal(button.textContent, messages['ui.settings']);
  assert.equal(button.title, messages['ui.group.settings']);
  assert.equal(button.getAttribute('aria-label'), messages['ui.group.settings']);
  assert.notEqual(button.textContent, 'Settings');
  assert.notEqual(button.getAttribute('aria-label'), 'Group settings');
});

test('controls built before a language change are relabelled by the panel pass', async () => {
  const { document } = new JSDOM('<!doctype html><body><div id="root"><img data-slot="aui_generated-image" src="data:,"></div><div id="host"></div></body>').window;
  const { runtime } = await localeRuntime('de', document);
  const context = vm.createContext({
    document,
    window: document.defaultView,
    t: runtime.t,
    escapeHtml,
    openGeneratedImageLightbox: () => {},
    scheduleClassicThinkingFaces: () => {},
    THINKING_STATUSES: ['thinking'],
    classicThinkingFace: () => '(•‿•)',
    thinkingFaceStep: 0,
  });
  vm.runInContext(`${functionSource('wrapGeneratedImagesForInspection')}\n${functionSource('renderThinkingIndicator')}\nthis.wrapGeneratedImagesForInspection = wrapGeneratedImagesForInspection;\nthis.renderThinkingIndicator = renderThinkingIndicator;`, context);
  context.wrapGeneratedImagesForInspection(document.getElementById('root'));
  const host = document.getElementById('host');
  context.renderThinkingIndicator(host);
  const image = document.querySelector('.generated-image-inspectable');
  const indicator = host.querySelector('.thinking-indicator');
  const german = { image: image.getAttribute('aria-label'), thinking: indicator.getAttribute('aria-label') };

  await runtime.setLocale('ja');
  const japanese = await loadLocaleMessages('ja');
  // The panel's language-change pass does not redraw messages: the existing nodes must follow on their own.
  assert.equal(document.querySelector('.generated-image-inspectable'), image, 'the wrapper is not rebuilt');
  context.renderThinkingIndicator(host);
  assert.equal(host.querySelector('.thinking-indicator'), indicator, 'the early return keeps the node');
  assert.equal(image.getAttribute('aria-label'), japanese['ui.open.generated.image.for.closer.inspection']);
  assert.notEqual(image.getAttribute('aria-label'), german.image);
  assert.equal(indicator.getAttribute('aria-label'), japanese['ui.hermes.is.thinking.brainstorming.contemplating.reasoning.proces.3e8d81c0']);
  assert.notEqual(indicator.getAttribute('aria-label'), german.thinking);
});

test('subagent and group controls are relabelled when the language changes', async () => {
  const { document } = new JSDOM('<!doctype html><body><div id="stack"><button id="toggle"></button><span id="summary"></span><ul id="list"></ul><div id="detail"></div></div><div id="menu"></div></body>').window;
  const { runtime } = await localeRuntime('de', document);
  const item = { id: 'sub-1', status: 'running', goal: 'Read the docs', acceptingSteer: true, stream: [{ text: 'started' }] };
  const sessionGroups = [{
    label: 'Rooms',
    source: 'hermes_bot_group_threads',
    sessions: [{ id: 'group-1', kind: 'group-thread', threadId: 'main', title: 'Room', selected: false, replyCount: 0 }],
  }];
  const context = vm.createContext({
    document,
    window: document.defaultView,
    els: {
      subagentStack: document.getElementById('stack'),
      subagentStackToggle: document.getElementById('toggle'),
      subagentStackSummary: document.getElementById('summary'),
      subagentStackList: document.getElementById('list'),
      subagentStackDetail: document.getElementById('detail'),
      sessionMenuList: document.getElementById('menu'),
      sessionSearchInput: { value: '' },
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
    scheduleLiveSessionPoll: () => {},
    syncSessionMenuChrome: () => {},
    projectsTabActive: () => false,
    getProjectsController: () => ({ availability: () => ({ available: false }) }),
    sessionMenuGroups: () => sessionGroups,
    shouldAutoOpenSessionGroup: () => true,
    openSessionGroups: new Set(),
    closedSessionGroups: new Set(),
    isSessionRenameEditorTarget: () => false,
    selectGroupThreadFromMenu: () => {},
    startNewGroupThread: () => {},
    closeFloatingPanels: () => {},
    openGroupSettingsModal: () => {},
    openSessionRenameEditor: () => {},
    activeGroupProjection: { id: 'group-1', displayName: 'Room' },
    t: runtime.t,
    translateUiText: runtime.translateText,
  });
  vm.runInContext(`${functionSource('renderSubagentStack')}\n${functionSource('renderSessionMenu')}\nthis.renderSubagentStack = renderSubagentStack;\nthis.renderSessionMenu = renderSessionMenu;`, context);
  context.renderSubagentStack();
  context.renderSessionMenu();
  const [steer, stop] = document.querySelectorAll('.subagent-stack-icon');
  const input = document.getElementById('subagentSteerInput');
  const settings = document.querySelector('.session-action-button');
  const before = { steer: steer.getAttribute('aria-label'), placeholder: input.placeholder, settings: settings.textContent };

  await runtime.setLocale('ja');
  const japanese = await loadLocaleMessages('ja');
  assert.equal(steer.getAttribute('aria-label'), japanese['ui.steer.this.subagent']);
  assert.equal(steer.title, japanese['ui.steer.this.subagent']);
  assert.equal(stop.getAttribute('aria-label'), japanese['ui.stop.this.subagent']);
  assert.equal(stop.title, japanese['ui.stop.this.subagent']);
  assert.equal(input.placeholder, japanese['ui.steer.this.subagent']);
  assert.notEqual(steer.getAttribute('aria-label'), before.steer);
  assert.notEqual(input.placeholder, before.placeholder);
  assert.equal(settings.textContent, japanese['ui.settings']);
  assert.equal(settings.title, japanese['ui.group.settings']);
  assert.equal(settings.getAttribute('aria-label'), japanese['ui.group.settings']);
  assert.notEqual(settings.textContent, before.settings);
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
