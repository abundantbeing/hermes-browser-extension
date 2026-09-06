export function userInputWriteIsOwned({
  requestedSessionId,
  activeSessionId,
  requestedOwner,
  activeOwner,
} = {}) {
  const requestedSession = String(requestedSessionId || '').trim();
  const activeSession = String(activeSessionId || '').trim();
  return Boolean(
    requestedSession
    && requestedSession === activeSession
    && requestedOwner === activeOwner
  );
}

export function createUserInputFetchGuard() {
  const states = new Map();

  function sessionKey(sessionId) {
    return String(sessionId || '').trim();
  }

  function stateFor(sessionId) {
    const key = sessionKey(sessionId);
    const current = states.get(key) || { generation: 0, owner: null };
    return { key, current };
  }

  return {
    begin(sessionId, owner) {
      const { key, current } = stateFor(sessionId);
      const next = { generation: current.generation + 1, owner };
      states.set(key, next);
      return { generation: next.generation, owner, sessionId: key };
    },

    bind(token, owner) {
      if (!this.isCurrent(token)) return null;
      const { key, current } = stateFor(token.sessionId);
      const next = { ...current, owner };
      states.set(key, next);
      return { ...token, owner };
    },

    invalidate(sessionId = '', owner = null) {
      const { key, current } = stateFor(sessionId);
      states.set(key, { generation: current.generation + 1, owner });
    },

    isCurrent(token) {
      if (!token) return false;
      const { current } = stateFor(token.sessionId);
      return Boolean(
        token.generation === current.generation
        && token.owner === current.owner
      );
    },
  };
}
