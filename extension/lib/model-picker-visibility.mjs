// Durable, browser-scoped model-picker visibility policy.
// This filters only presentation. Runtime model discovery, registration,
// per-session bindings, and provider routing continue to use the full catalog.

export const MODEL_PICKER_VISIBILITY_SCHEMA_VERSION = 1;
export const MODEL_PICKER_VISIBILITY_STORAGE_KEY = 'hermesBrowserModelPickerVisibility';

// This is a single current operational policy seed, not a frontend catalog.
// It is copied into browser storage on first load and can be changed there by
// future visibility-management UI without touching runtime registration.
export const DEFAULT_MODEL_PICKER_VISIBLE_MODEL_IDS = Object.freeze([
  'hermes-agent',
  'openai-codex::gpt-5.6-luna-900k',
  'openai-codex::gpt-5.6-terra-900k',
  'antigravity::gemini-3.8-flash-high',
  'custom:omlx-local::qwen3.8-27b',
  'custom:omlx-local::qwen3.8-27b:hermes',
  'custom:omlx-local::qwen3.8-27b:chat',
  'custom:omlx-local::qwen3.8-27b:thinking',
]);

const asStrings = (value) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  : [];

export function normalizeModelPickerVisibility(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'all' ? 'all' : 'allowlist';
  return {
    schemaVersion: MODEL_PICKER_VISIBILITY_SCHEMA_VERSION,
    mode,
    allowedModelIds: asStrings(source.allowedModelIds),
    allowedProviderIds: asStrings(source.allowedProviderIds),
    hiddenModelIds: asStrings(source.hiddenModelIds),
    hiddenProviderIds: asStrings(source.hiddenProviderIds),
  };
}

function normalizedKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function modelPickerModelKeys(model = {}) {
  return new Set([
    model?.id,
    model?.rawModelId,
    model?.model,
  ].map(normalizedKey).filter(Boolean));
}

export function modelPickerProviderKeys(model = {}) {
  return new Set([
    model?.provider,
    model?.providerLabel,
    model?.owner,
  ].map(normalizedKey).filter(Boolean));
}

export function isModelPickerVisible(model = {}, visibility = {}, { selectedModelId = '' } = {}) {
  const policy = normalizeModelPickerVisibility(visibility);
  const modelKeys = modelPickerModelKeys(model);
  const providerKeys = modelPickerProviderKeys(model);
  const selected = normalizedKey(selectedModelId);
  if (selected && modelKeys.has(selected)) return true;
  if (policy.hiddenModelIds.some((id) => modelKeys.has(normalizedKey(id)))) return false;
  if (policy.hiddenProviderIds.some((id) => providerKeys.has(normalizedKey(id)))) return false;
  if (policy.mode === 'all') return true;
  const allowedModelIds = new Set(policy.allowedModelIds.map(normalizedKey));
  const allowedProviderIds = new Set(policy.allowedProviderIds.map(normalizedKey));
  return [...modelKeys].some((key) => allowedModelIds.has(key))
    || [...providerKeys].some((key) => allowedProviderIds.has(key));
}

export function visibleModelsForPicker(models = [], visibility = {}, options = {}) {
  return (Array.isArray(models) ? models : []).filter((model) => isModelPickerVisible(model, visibility, options));
}

export function modelPickerVisibilityStats(models = [], visibility = {}, options = {}) {
  const all = Array.isArray(models) ? models : [];
  const visible = visibleModelsForPicker(all, visibility, options);
  return {
    visible,
    visibleCount: visible.length,
    hiddenCount: Math.max(0, all.length - visible.length),
  };
}

export function modelPickerVisibilityFromAllowlist(allowedModelIds = [], { hiddenModelIds = [], hiddenProviderIds = [] } = {}) {
  return normalizeModelPickerVisibility({
    mode: 'allowlist',
    allowedModelIds,
    hiddenModelIds,
    hiddenProviderIds,
  });
}
