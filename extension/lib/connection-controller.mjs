export const CONNECTION_STATES = Object.freeze({
  IDLE: 'idle',
  DISCOVERING: 'discovering',
  AUTHENTICATING: 'authenticating',
  SELECTING: 'selecting',
  CONNECTING: 'connecting',
  READY: 'ready',
  DEGRADED: 'degraded',
  ERROR: 'error',
});

const VALID_STATES = new Set(Object.values(CONNECTION_STATES));

export function createConnectionController({ onChange = () => {} } = {}) {
  let generation = 0;
  let current = Object.freeze({
    generation,
    status: CONNECTION_STATES.IDLE,
    mode: 'local',
    transport: 'local-api',
    detail: Object.freeze({}),
    reason: '',
  });

  function publish(next) {
    current = Object.freeze({
      ...next,
      detail: Object.freeze({ ...(next.detail || {}) }),
    });
    onChange(current);
    return current;
  }

  return {
    begin({ mode, transport, detail = {} }) {
      generation += 1;
      publish({
        generation,
        status: CONNECTION_STATES.CONNECTING,
        mode,
        transport,
        detail,
        reason: '',
      });
      return generation;
    },

    transition(candidate, status, detail = {}) {
      if (!VALID_STATES.has(status)) {
        throw new Error(`Unknown connection state: ${status}`);
      }
      if (candidate !== generation) return false;
      publish({
        ...current,
        status,
        detail: { ...current.detail, ...detail },
        reason: '',
      });
      return true;
    },

    cancel(reason = 'cancelled') {
      generation += 1;
      publish({
        ...current,
        generation,
        status: CONNECTION_STATES.IDLE,
        detail: {},
        reason,
      });
    },

    isCurrent(candidate) {
      return candidate === generation;
    },

    get snapshot() {
      return current;
    },
  };
}
