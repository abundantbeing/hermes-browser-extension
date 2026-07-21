const DEFAULT_STEP_ORDER = Object.freeze([
  'settings',
  'gateway',
  'capabilities',
  'models',
  'selectedModel',
  'skills',
  'profiles',
  'sessions',
  'sessionBinding',
]);

const STEP_LABELS = Object.freeze({
  settings: 'Settings',
  gateway: 'Gateway transport',
  capabilities: 'Capabilities',
  models: 'Model catalog',
  selectedModel: 'Selected model',
  skills: 'Skills',
  profiles: 'Profiles',
  sessions: 'Sessions',
  sessionBinding: 'Session binding',
});

const READY_STATUSES = new Set(['ready', 'legacy', 'fallback', 'observed', 'skipped']);
const HARD_STEPS = Object.freeze(['settings', 'gateway', 'capabilities', 'models', 'selectedModel', 'sessions', 'sessionBinding']);

function initialSteps() {
  return Object.fromEntries(DEFAULT_STEP_ORDER.map((step) => [step, { status: 'pending', detail: '' }]));
}

function normalizeStatus(status = 'pending') {
  return ['pending', 'active', 'ready', 'legacy', 'fallback', 'observed', 'skipped', 'blocked', 'unconfigured', 'unreachable', 'degraded', 'error'].includes(status)
    ? status
    : 'pending';
}

export function initialStartupReadiness(settings = {}) {
  return {
    phase: 'boot',
    gateway: {
      mode: settings.gatewayMode || 'local-api',
      url: settings.gatewayUrl || '',
      connected: false,
      state: 'pending',
      detail: '',
    },
    steps: initialSteps(),
    selectedModel: null,
    blockingError: '',
    warnings: [],
    ready: false,
  };
}

function withReadyFlag(state) {
  const ready = HARD_STEPS.every((step) => READY_STATUSES.has(state.steps?.[step]?.status));
  return { ...state, ready, phase: ready ? 'ready' : state.phase };
}

export function reduceStartupReadiness(state = initialStartupReadiness(), event = {}) {
  const next = {
    ...state,
    gateway: { ...(state.gateway || {}) },
    steps: { ...(state.steps || initialSteps()) },
    warnings: [...(state.warnings || [])],
  };
  if (event.type === 'reset') return initialStartupReadiness(event.settings || {});
  if (event.phase) next.phase = event.phase;
  if (event.gateway) next.gateway = { ...next.gateway, ...event.gateway };
  if (event.selectedModel) next.selectedModel = { ...event.selectedModel };
  if (event.warning) next.warnings.push(event.warning);
  if (event.blockingError !== undefined) next.blockingError = String(event.blockingError || '');
  if (event.step) {
    const status = normalizeStatus(event.status);
    next.steps[event.step] = {
      status,
      detail: String(event.detail || ''),
    };
    if (['unconfigured', 'unreachable', 'error'].includes(status)) {
      next.phase = status === 'unconfigured' ? 'setup-needed' : 'error';
      next.blockingError = event.detail || next.blockingError;
    }
  }
  return withReadyFlag(next);
}

export function selectedModelReadiness({ settings = {}, availableModels = [], activeSessionRuntime = {} } = {}) {
  const modelId = settings.model || '';
  const selected = availableModels.find((model) => model.id === modelId || model.rawModelId === modelId);
  if (selected) {
    const runtimeSelectable = selected.runtimeSelectable !== false;
    return {
      status: runtimeSelectable ? 'ready' : 'observed',
      detail: runtimeSelectable ? 'Selected model is requestable.' : 'Model was observed from history/catalog fallback.',
      selectedModel: selected,
    };
  }
  if (activeSessionRuntime?.model) {
    return {
      status: 'observed',
      detail: 'Using runtime-observed model until the catalog confirms it.',
      selectedModel: {
        id: activeSessionRuntime.model,
        rawModelId: activeSessionRuntime.model,
        provider: activeSessionRuntime.provider || '',
      },
    };
  }
  return { status: 'error', detail: 'No selected model is available yet.', selectedModel: null };
}

export function deriveStartupView(state = initialStartupReadiness()) {
  const steps = DEFAULT_STEP_ORDER.map((key) => ({
    key,
    label: STEP_LABELS[key] || key,
    status: state.steps?.[key]?.status || 'pending',
    detail: state.steps?.[key]?.detail || '',
  }));
  const completed = steps.filter((step) => READY_STATUSES.has(step.status)).length;
  const active = steps.find((step) => step.status === 'active' || step.status === 'pending') || steps[steps.length - 1];
  const setupNeeded = state.phase === 'setup-needed';
  const errored = state.phase === 'error' || Boolean(state.blockingError);
  return {
    visible: !state.ready,
    ready: Boolean(state.ready),
    phase: state.phase || 'boot',
    title: state.ready
      ? 'Hermes Browser ready'
      : setupNeeded
        ? 'Connect to Hermes'
        : errored
          ? 'Hermes needs attention'
          : 'Connecting Browser Extension',
    detail: state.ready
      ? 'Model, session, and runtime metadata are ready.'
      : state.blockingError || active?.detail || 'Checking settings, gateway, capabilities, models, and sessions.',
    progress: Math.round((completed / steps.length) * 100),
    steps,
  };
}
