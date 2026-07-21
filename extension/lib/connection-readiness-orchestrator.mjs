const STAGES = Object.freeze([
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

const TICKET_TRANSPORTS = new Set(['cloud-ticket-ws', 'remote-dashboard']);

function isTicketTransport(transport = '') {
  return TICKET_TRANSPORTS.has(String(transport || '').trim());
}

function detailFor(value, fallback = '') {
  if (typeof value === 'string') return value;
  return String(value?.detail || fallback || '');
}

function eventFor(stage, status, detail = '', extras = {}) {
  return {
    type: 'stage',
    phase: stage,
    step: stage,
    status,
    detail,
    ...extras,
  };
}

export class ReadinessStageError extends Error {
  constructor(stage, cause) {
    const detail = cause?.message || String(cause || `Readiness failed during ${stage}.`);
    super(`${stage}: ${detail}`);
    this.name = 'ReadinessStageError';
    this.stage = stage;
    this.retryable = true;
    this.cause = cause;
  }
}

function requireOperation(operations, name) {
  if (typeof operations?.[name] !== 'function') {
    throw new Error(`Missing readiness operation: ${name}`);
  }
  return operations[name];
}

/**
 * Runs the one lifecycle that can dismiss the startup gate. Transport
 * connection alone never returns ready: ticket transports must supply a durable
 * session id first, while API transports may explicitly declare the legacy
 * OpenAI-compatible fallback. Each event is intentionally renderer-agnostic so the
 * sidepanel can keep its existing DOM/reducer boundary.
 */
export async function runCanonicalConnectionReadiness({
  mode = 'local',
  transport = 'local-api',
  operations = {},
  onEvent = () => {},
} = {}) {
  let resolvedMode = mode;
  let resolvedTransport = transport;
  const emit = (event) => onEvent(event);
  let currentStage = 'settings';
  let sessionId = '';

  const runStage = async (stage, operation, { allowFallback = false } = {}) => {
    currentStage = stage;
    emit(eventFor(stage, 'active'));
    try {
      const result = await requireOperation(operations, operation)();
      const requestedStatus = String(result?.status || '').trim();
      const status = requestedStatus || (result?.ok === false && allowFallback ? 'fallback' : 'ready');
      const detail = detailFor(result);
      if (status === 'error' || status === 'unreachable' || status === 'unconfigured') {
        throw new Error(detail || `${stage} did not become ready.`);
      }
      emit(eventFor(stage, status, detail, result?.gateway ? { gateway: result.gateway } : {}));
      return result;
    } catch (error) {
      if (allowFallback) {
        const detail = error?.message || String(error);
        emit(eventFor(stage, 'fallback', detail));
        return { ok: false, status: 'fallback', detail };
      }
      throw error;
    }
  };

  try {
    const restoredSettings = await runStage('settings', 'restoreSettings');
    resolvedMode = String(restoredSettings?.mode || resolvedMode || 'local');
    resolvedTransport = String(restoredSettings?.transport || resolvedTransport || 'local-api');
    const ticketTransport = isTicketTransport(resolvedTransport);
    const gateway = await runStage('gateway', 'connectGateway');
    await runStage('capabilities', 'loadCapabilities');
    await runStage('models', 'loadModels');
    await runStage('selectedModel', 'selectModel');

    if (ticketTransport) {
      emit(eventFor('skills', 'skipped', 'Ticket transport does not expose REST skills.'));
      emit(eventFor('profiles', 'skipped', 'Ticket transport does not expose REST profiles.'));
    } else {
      await runStage('skills', 'loadSkills');
      await runStage('profiles', 'loadProfiles');
    }

    await runStage('sessions', 'loadSessions', { allowFallback: true });
    const binding = await runStage('sessionBinding', 'bindSession');
    sessionId = String(binding?.sessionId || '').trim();
    if (!sessionId && (ticketTransport || binding?.status !== 'fallback')) {
      throw new Error('No durable Hermes session was bound.');
    }

    const result = { ready: true, mode: resolvedMode, transport: resolvedTransport, sessionId, gateway };
    emit({ type: 'ready', phase: 'ready', ...result });
    return result;
  } catch (cause) {
    const error = cause instanceof ReadinessStageError ? cause : new ReadinessStageError(currentStage, cause);
    const failureStatus = ['unconfigured', 'unreachable', 'error'].includes(error.cause?.readinessStatus)
      ? error.cause.readinessStatus
      : 'error';
    emit(eventFor(currentStage, failureStatus, error.cause?.message || error.message, { blockingError: error.message }));
    const failedAt = STAGES.indexOf(currentStage);
    for (const stage of STAGES.slice(failedAt + 1)) {
      emit(eventFor(stage, 'blocked', `Blocked by ${currentStage} failure.`));
    }
    throw error;
  }
}

export function ticketTransportClosedReadiness({ sessionId = '' } = {}) {
  const detail = 'Dashboard socket closed. Reconnect to resume the bound session.';
  return {
    phase: 'reconnecting',
    gateway: { connected: false, state: 'reconnecting', detail },
    step: 'gateway',
    status: 'degraded',
    detail,
    sessionId: String(sessionId || ''),
  };
}
