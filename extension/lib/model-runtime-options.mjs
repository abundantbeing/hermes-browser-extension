export const MODEL_REASONING_EFFORTS = Object.freeze([
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
]);

const VALID_REASONING_EFFORTS = new Set(MODEL_REASONING_EFFORTS.map((option) => option.value));

export function normalizeModelRuntimeOptions(value = {}) {
  const rawEffort = String(value?.reasoningEffort || '').trim().toLowerCase();
  const reasoningEffort = ['extra-high', 'extra_high', 'extra high'].includes(rawEffort)
    ? 'xhigh'
    : (VALID_REASONING_EFFORTS.has(rawEffort) ? rawEffort : 'medium');
  const fastMode = Boolean(value?.fastMode);
  const requestedTier = String(value?.serviceTier || '').trim().toLowerCase();
  return {
    thinkingEnabled: value?.thinkingEnabled !== false,
    reasoningEffort,
    fastMode,
    serviceTier: requestedTier === 'priority' || fastMode ? 'priority' : null,
  };
}

export function modelRuntimeOptionsPayload(value = {}) {
  const options = normalizeModelRuntimeOptions(value);
  return {
    reasoning: options.thinkingEnabled
      ? { enabled: true, effort: options.reasoningEffort }
      : { enabled: false },
    fast: options.fastMode,
    service_tier: options.serviceTier,
  };
}

export function modelRuntimeCapabilities(model = {}) {
  const supportsReasoning = model?.reasoning !== false && model?.supportsReasoning !== false;
  return {
    reasoning: supportsReasoning,
    thinking: supportsReasoning,
    fast: model?.fast !== false && model?.supportsFast !== false,
  };
}
