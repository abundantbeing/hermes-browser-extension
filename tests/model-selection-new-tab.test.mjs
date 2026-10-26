// Issue #119: a stored model choice must survive new tabs and catalog refreshes.
// The panel tests run the real sidepanel.js functions through the startup
// sequence a new tab performs, against the catalog shapes that triggered the bug.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as common from '../extension/lib/common.mjs';
import { friendlyModelName } from '../extension/lib/model-friendly-name.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `sidepanel.js still defines ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `sidepanel.js still has ${end} after ${start}`);
  return source.slice(from, to);
};
const optional = (start, end) => (source.includes(start) ? between(start, end) : '');

// The startup cache never stores gateway alias rows, and this gateway lists
// OpenRouter first: row 0 is a lane with no credits left (the reporter's 402).
const FABLE = { id: 'openrouter::anthropic/claude-fable-5.1', rawModelId: 'anthropic/claude-fable-5.1', label: 'anthropic/claude-fable-5.1', provider: 'openrouter', providerLabel: 'OpenRouter', source: 'registry', runtimeSelectable: true };
const SOL = { id: 'openrouter::openai/gpt-6.1-sol', rawModelId: 'openai/gpt-6.1-sol', label: 'openai/gpt-6.1-sol', provider: 'openrouter', providerLabel: 'OpenRouter', source: 'registry', runtimeSelectable: true };
const OPUS = { id: 'anthropic::claude-opus-5-5', rawModelId: 'claude-opus-5-5', label: 'claude-opus-5-5', provider: 'anthropic', providerLabel: 'Anthropic', source: 'registry', runtimeSelectable: true };
const GATEWAY_DEFAULT = { id: 'hermes-agent', rawModelId: 'hermes-agent', label: 'hermes-agent (gateway default)', provider: '', providerLabel: 'Hermes gateway', gatewayAlias: true, gatewayDefault: true, current: true, source: 'gateway', runtimeSelectable: true };
const STARTUP_CACHE = [FABLE, SOL, OPUS];

function panel(stored) {
  const writes = [];
  const context = vm.createContext({
    settings: { ...common.DEFAULT_SETTINGS, ...stored },
    availableModels: [],
    selectedModelProvider: '',
    modelSelectionVersion: 0,
    pendingModelRuntimeAck: null,
    sessionRoutesAvailable: null,
    DEFAULT_SETTINGS: common.DEFAULT_SETTINGS,
    normalizeBrowserModelBinding: common.normalizeBrowserModelBinding,
    resolveBrowserEffectiveModel: common.resolveBrowserEffectiveModel,
    resolveCatalogModelIdForBinding: common.resolveCatalogModelIdForBinding,
    resolveStoredModelSelection: common.resolveStoredModelSelection,
    normalizeHermesModels: common.normalizeHermesModels,
    isModelRuntimeSelectable: common.isModelRuntimeSelectable,
    modelDisplayName: common.modelDisplayName,
    friendlyModelName,
    modelRuntimeStatus: common.modelRuntimeStatus,
    updateBrowserModelScope: common.updateBrowserModelScope,
    translateUiText: (text) => text,
    modelProviderLabel: (model) => model?.providerLabel || model?.provider || '',
    els: {
      currentModelName: { textContent: '', title: '' },
      modelMenu: { hidden: true },
      modelMenuButton: { setAttribute() {} },
      modelSearchInput: { focus() {} },
    },
    updateModelButtonMeta() {},
    renderModelMenu() {},
    renderInlineAssistModelOptions() {},
    renderModelRuntimeOptions() {},
    renderContextWindow() {},
    updateDockFloatingAnchor() {},
    setStatus() {},
    syncSessionModelLock: async () => ({ state: 'pending' }),
    browserApi: { storage: { local: { set: async (value) => { writes.push(JSON.parse(JSON.stringify(value))); } } } },
  });
  vm.runInContext([
    between('function modelBindingFromModel(', 'function modelBindingFromSession('),
    optional('function unlistedModelSelectionRow(', 'function renderModelOptions('),
    between('function renderModelOptions(', 'async function applyAssistSelectedModel('),
    between('function applySelectedModel(', 'async function requestSessionModelLock('),
  ].join('\n'), context);
  return {
    context,
    writes,
    // What loadModels() does after building a catalog (the startup cache, then the live one).
    load(models) {
      context.availableModels = common.normalizeHermesModels(models, context.settings.model);
      context.renderModelOptions(context.availableModels);
      context.applySelectedModel(context.settings.model, { persist: false });
    },
    // Any later save (a session switch, a settings change) writes the in-memory settings.
    save() { return context.browserApi.storage.local.set({ hermesBrowserSettings: context.settings }); },
  };
}

const aliasBinding = { modelId: 'hermes-agent', rawModelId: 'hermes-agent', provider: '', contextTokens: 0, gatewayAlias: true, gatewayDefault: true };

test('#119: a new tab keeps the saved Gateway default instead of the first catalog row', async () => {
  const tab = panel({ model: 'hermes-agent', sessionId: 'new-tab', extensionPreferredModel: aliasBinding, sessionModelBindings: {} });

  tab.load(STARTUP_CACHE);
  assert.equal(tab.context.settings.model, 'hermes-agent', 'the startup cache has no alias rows; that is not "nothing chosen"');
  assert.equal(tab.context.els.currentModelName.textContent, 'Hermes Agent', 'the footer names the saved choice, not row 0');
  assert.equal(tab.context.settings.extensionPreferredModel.modelId, 'hermes-agent');
  assert.equal(tab.context.settings.extensionPreferredModel.gatewayDefault, true, 're-applying the choice keeps its saved binding');

  // The live catalog lists the gateway default, but not first.
  tab.load([FABLE, SOL, GATEWAY_DEFAULT, OPUS]);
  assert.equal(tab.context.settings.model, 'hermes-agent');
  assert.equal(tab.context.els.currentModelName.textContent, 'Hermes Agent');

  await tab.save();
  const saved = tab.writes.at(-1).hermesBrowserSettings;
  assert.equal(saved.model, 'hermes-agent', 'nothing persists the first row over the saved choice');
  assert.equal(saved.extensionPreferredModel.modelId, 'hermes-agent');
  assert.equal(saved.sessionModelBindings['new-tab'].modelId, 'hermes-agent');
});

test('#119: a fresh install still starts on the gateway default, not the first provider row', () => {
  const tab = panel({ model: 'hermes-agent', sessionId: 'first-run', extensionPreferredModel: null, sessionModelBindings: {} });
  tab.load([FABLE, GATEWAY_DEFAULT, OPUS]);
  assert.equal(tab.context.settings.model, 'hermes-agent');
});

test('#119: a saved model the catalog does not list stays chosen, with its saved provider', () => {
  const opusBinding = { modelId: OPUS.id, rawModelId: OPUS.rawModelId, provider: 'anthropic', contextTokens: 0 };
  const tab = panel({ model: OPUS.id, sessionId: 'new-tab', extensionPreferredModel: opusBinding, sessionModelBindings: {} });

  tab.load([FABLE, SOL]);
  assert.equal(tab.context.settings.model, OPUS.id, 'never swapped for another lane');
  assert.equal(tab.context.els.currentModelName.textContent, 'Opus 5.5', 'shown by its friendly model name, no provider or dashes');
  assert.equal(tab.context.settings.extensionPreferredModel.provider, 'anthropic', 'the placeholder row does not become the provider');
  assert.equal(tab.context.settings.extensionPreferredModel.rawModelId, OPUS.rawModelId);

  tab.load([GATEWAY_DEFAULT, FABLE, SOL, OPUS]);
  assert.equal(tab.context.settings.model, OPUS.id);
  assert.equal(tab.context.settings.extensionPreferredModel.provider, 'anthropic');
});

test('resolveStoredModelSelection: catalog order is presentation, not preference', () => {
  const resolve = common.resolveStoredModelSelection;
  // A listed choice is kept wherever it sits, the alias included.
  assert.deepEqual(resolve({ selectedId: 'hermes-agent', models: [FABLE, GATEWAY_DEFAULT] }), { modelId: 'hermes-agent', listed: true, fallback: false });
  assert.equal(resolve({ selectedId: OPUS.id, models: [FABLE, OPUS] }).modelId, OPUS.id);
  // The default alias follows the gateway's own default row (a named profile advertises its own id).
  const riku = { ...GATEWAY_DEFAULT, id: 'riku', rawModelId: 'riku', label: 'riku (gateway default)' };
  assert.equal(resolve({ selectedId: 'hermes-agent', models: [FABLE, riku] }).modelId, 'riku');
  const placeholder = { id: 'riku', label: 'riku', owner: 'selected', source: 'selected', runtimeSelectable: false };
  assert.equal(resolve({ selectedId: 'riku', binding: { modelId: 'riku', gatewayDefault: true }, models: [FABLE, GATEWAY_DEFAULT, placeholder] }).modelId, 'hermes-agent');
  // Catalogs without alias rows (the startup cache, dashboard catalogs) keep the gateway default as chosen.
  assert.deepEqual(resolve({ selectedId: 'hermes-agent', models: STARTUP_CACHE }), { modelId: 'hermes-agent', listed: false, fallback: false });
  // An unlisted id stays chosen; normalizeHermesModels lists it as a placeholder row.
  assert.deepEqual(resolve({ selectedId: 'gone', models: [FABLE, { id: 'gone', source: 'selected', runtimeSelectable: false }] }), { modelId: 'gone', listed: false, fallback: false });
  // Discovery-only rows cannot route: the gateway default, never the first row.
  const external = { id: 'local-llm::qwen', rawModelId: 'qwen', provider: 'local-llm', source: 'external', runtimeSelectable: false };
  assert.deepEqual(resolve({ selectedId: external.id, models: [external, FABLE, GATEWAY_DEFAULT] }), { modelId: 'hermes-agent', listed: true, fallback: true });
  assert.equal(resolve({ selectedId: external.id, models: [external, FABLE, OPUS] }).modelId, FABLE.id, 'without a default row: the first routable row');
  assert.equal(resolve({ selectedId: '', models: [] }).modelId, 'hermes-agent');
});

test('dashboard session.create never sends the gateway default alias as a model', () => {
  const pick = common.dashboardSessionModelParams;
  assert.deepEqual(pick({ model: 'hermes-agent', provider: '' }), {}, 'no override: the profile default runs');
  assert.deepEqual(pick({ model: 'riku', gatewayDefault: true }), {});
  assert.deepEqual(pick({ model: 'claude-opus-5-5', provider: 'anthropic' }), { model: 'claude-opus-5-5', provider: 'anthropic' });
  assert.deepEqual(pick({ model: 'claude-opus-5-5' }), { model: 'claude-opus-5-5' });
  // Every session.create on the dashboard socket goes through the guard.
  const createBlocks = [];
  // A canonical socket's create goes through sessionCreateParamsFor(client, { ... }), which maps the same object.
  for (const found of source.matchAll(/createParams: (?:sessionCreateParamsFor\(connection\.client, )?\{/g)) {
    const at = found.index;
    let depth = 0;
    let end = at + found[0].length - 1;
    do {
      const char = source.charAt(end);
      if (char === '{') depth++; else if (char === '}') depth--;
      end++;
    } while (depth > 0 && end < source.length);
    createBlocks.push(source.slice(at, end));
  }
  assert.equal(createBlocks.length, 3);
  for (const block of createBlocks) {
    const topLevel = block.replace(/\.\.\.dashboardSessionModelParams\(\{[\s\S]*?\}\)/g, '');
    assert.doesNotMatch(topLevel, /^\s*model:/m, `session.create sends a raw model:\n${block}`);
    assert.match(block, /dashboardSessionModelParams\(|currentDashboardModelParams\(/);
  }
});
