import {
  isModelRuntimeSelectable,
  normalizeFastMode,
  normalizeReasoningEffort,
  normalizeRuntimeModelPayload,
} from './common.mjs';

function clean(value = '') {
  return String(value || '').trim();
}

export function assistModelSelectionFromSettings(settings = {}) {
  const model = clean(settings.inlineAssistRawModel || settings.inlineAssistModel);
  const provider = clean(settings.inlineAssistProvider);
  if (!model && !provider) return null;
  if (!model || !provider) {
    throw new Error('Hermes Assist model selection is incomplete. Choose both a provider and model in Assist settings.');
  }
  return { model, provider };
}

export function assistModelRoutingSupported(capabilities = {}) {
  return capabilities?.sessionChat === true && capabilities?.sessionModelLock === true;
}

export function assistModelFallbackNotice(selection = null, reason = '') {
  const model = clean(selection?.model);
  const provider = clean(selection?.provider);
  if (!model || !provider) return '';
  const explanation = clean(reason);
  return `Hermes Assist could not enforce ${provider} / ${model}${explanation ? ` (${explanation})` : ''}. Used the gateway default model instead.`;
}

export function assistModelRequestPolicy(settings = {}, capabilities = {}) {
  const selection = assistModelSelectionFromSettings(settings);
  if (!assistModelRoutingSupported(capabilities) && selection) {
    return {
      mode: 'gateway-default-fallback',
      selection: null,
      requestedSelection: selection,
      modelOptions: null,
      label: `${selection.provider} / ${selection.model}`,
    };
  }
  if (!selection) {
    return {
      mode: 'gateway-default',
      selection: null,
      modelOptions: null,
      label: 'Active Hermes Agent model',
    };
  }
  const thinkingSetting = String(settings.inlineAssistThinking || '').trim().toLowerCase();
  const thinkingEnabled = settings.inlineAssistThinkingEnabled !== false && thinkingSetting !== 'off';
  const reasoningEffort = normalizeReasoningEffort(
    settings.inlineAssistReasoningEffort || settings.inlineAssistEffort || 'low',
  );
  return {
    mode: 'session-lock',
    selection,
    modelOptions: {
      thinking: thinkingEnabled ? 'on' : 'off',
      reasoning_effort: thinkingEnabled ? reasoningEffort : 'none',
      fast: normalizeFastMode(settings.inlineAssistFastMode ?? settings.inlineAssistFast),
    },
    label: `${selection.provider} / ${selection.model}`,
  };
}

export function buildAssistModelRouteRequest(settings = {}, capabilities = {}) {
  const policy = assistModelRequestPolicy(settings, capabilities);
  if (!policy.selection) return { policy, request: {} };
  const thinkingEnabled = policy.modelOptions?.thinking !== 'off';
  const reasoningEffort = thinkingEnabled
    ? normalizeReasoningEffort(policy.modelOptions?.reasoning_effort || 'low')
    : 'none';
  const fast = normalizeFastMode(policy.modelOptions?.fast);
  const modelOptions = {
    reasoning: thinkingEnabled ? { enabled: true, effort: reasoningEffort } : { enabled: false },
    reasoning_effort: reasoningEffort,
    fast,
    service_tier: fast ? 'priority' : null,
  };
  return {
    policy,
    request: {
      model: policy.selection.model,
      provider: policy.selection.provider,
      require_model_lock: true,
      reasoning_effort: reasoningEffort,
      fast,
      model_options: modelOptions,
    },
  };
}

export function resolveAssistModelBindingFromCatalog({ settings = {}, models = [] } = {}) {
  const explicitId = clean(settings.inlineAssistModel || settings.inlineAssistRawModel);
  if (!explicitId) return null;
  const explicitProvider = clean(settings.inlineAssistProvider);
  const requestable = Array.from(models || []).filter(isModelRuntimeSelectable);
  const direct = requestable.find((model) => clean(model.id) === explicitId
    && (!explicitProvider || clean(model.provider || model.providerId || model.owner) === explicitProvider));
  const rawCandidates = requestable.filter((model) => clean(model.rawModelId || model.raw_model_id || model.model) === explicitId
    && (!explicitProvider || clean(model.provider || model.providerId || model.owner) === explicitProvider));
  const selected = direct || (rawCandidates.length === 1 ? rawCandidates[0] : null);
  if (!selected) return null;
  const provider = clean(selected.provider || selected.providerId || selected.owner);
  const modelId = clean(selected.id || selected.model || selected.rawModelId);
  const rawModelId = clean(selected.rawModelId || selected.raw_model_id || selected.model || selected.id);
  if (!provider || !modelId || !rawModelId) return null;
  return {
    inlineAssistModel: modelId,
    inlineAssistRawModel: rawModelId,
    inlineAssistProvider: provider,
  };
}

function acknowledgedRuntime(payload = {}) {
  const session = payload?.session && typeof payload.session === 'object' ? payload.session : null;
  const primary = normalizeRuntimeModelPayload(session || payload);
  if (primary.model || primary.provider) return primary;
  const choice = Array.isArray(payload?.choices) && payload.choices[0] && typeof payload.choices[0] === 'object'
    ? normalizeRuntimeModelPayload(payload.choices[0])
    : null;
  return choice || primary;
}

export function assertAssistModelSelectionAcknowledged(payload = {}, selection = null) {
  if (!selection) return null;
  const expectedModel = clean(selection.model);
  const expectedProvider = clean(selection.provider);
  if (!expectedModel || !expectedProvider) {
    throw new Error('Hermes Assist model selection is incomplete. Choose both a provider and model in Assist settings.');
  }
  const runtime = acknowledgedRuntime(payload);
  const actualModel = clean(runtime.model);
  const actualProvider = clean(runtime.provider);
  if (actualModel !== expectedModel || actualProvider !== expectedProvider) {
    throw new Error(
      `Hermes Assist refused to run because Hermes did not acknowledge the selected model (${expectedProvider} / ${expectedModel}). `
      + `Hermes acknowledged ${actualProvider || 'no provider'} / ${actualModel || 'no model'}. `
      + 'Update or restart Hermes Agent before trying again.',
    );
  }
  return { model: actualModel, provider: actualProvider };
}
