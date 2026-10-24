// Replay state that outlives a single gateway client.
//
// A gateway stamps every event with a per-session `seq` and keeps a bounded ring; a reconnecting client
// asks `session.events.since {last_seen}` for what it missed. The `replay_epoch` in gateway.ready says
// which gateway process those numbers belong to (a restart resets the counters). The client keeps its
// watermarks in memory, so a NEW client (the panel builds one for every reconnect) started with nothing
// and never asked. This store keeps them per endpoint, outside any client, bounded, and (when a storage
// area is given) in storage.session so a panel reload keeps them too.
//
// Keys are the session ids the gateway stamps events with: the session authority's durable id, or a
// legacy runtime's id, which survives a reconnect while the runtime lives. The epoch check voids every
// mark when the gateway restarted, and a gateway that reports no epoch voids them too (see the client).

const STORAGE_KEY = 'hermesReplayWatermarks';
const PERSIST_DELAY_MS = 1000;

function clean(value) {
  return String(value ?? '').trim();
}

function cleanMarks(raw, maxSessions) {
  const marks = new Map();
  if (!raw || typeof raw !== 'object') return marks;
  for (const [sessionId, seq] of Object.entries(raw)) {
    const id = clean(sessionId);
    const number = Number(seq);
    if (!id || !Number.isFinite(number) || number <= 0) continue;
    marks.set(id, Math.floor(number));
  }
  while (marks.size > maxSessions) marks.delete(marks.keys().next().value);
  return marks;
}

export function createReplayWatermarks({
  maxEndpoints = 8,
  maxSessions = 64,
  storage = null,
  storageKey = STORAGE_KEY,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  // endpoint -> { epoch, marks: Map<sessionId, seq> }, least recently used first.
  const endpoints = new Map();
  // Endpoints this page dropped: they must also leave the shared record when it is merged.
  const removed = new Set();
  let timer = null;

  function touch(key, entry) {
    endpoints.delete(key);
    endpoints.set(key, entry);
    while (endpoints.size > maxEndpoints) endpoints.delete(endpoints.keys().next().value);
  }

  function snapshot() {
    return Object.fromEntries([...endpoints].map(([key, entry]) => [key, {
      epoch: entry.epoch,
      watermarks: Object.fromEntries(entry.marks),
    }]));
  }

  // Every panel of the browser shares one storage.session record. Writing this page's snapshot over
  // it would drop the other panels' endpoints, so what is stored is read first and merged: other
  // endpoints stay, and on the same endpoint and epoch the higher mark per session wins (a gateway's
  // seq only grows within an epoch). A different epoch is a restarted gateway: this page's wins.
  function mergeWithStored(stored, ours) {
    const merged = new Map();
    if (stored && typeof stored === 'object') {
      for (const [key, entry] of Object.entries(stored)) {
        const endpoint = clean(key);
        const epoch = clean(entry?.epoch);
        const marks = cleanMarks(entry?.watermarks, maxSessions);
        if (!endpoint || !epoch || !marks.size || removed.has(endpoint)) continue;
        merged.set(endpoint, { epoch, marks });
      }
    }
    for (const [key, entry] of Object.entries(ours)) {
      const prior = merged.get(key);
      const marks = new Map();
      if (prior && prior.epoch === entry.epoch) for (const [id, seq] of prior.marks) marks.set(id, seq);
      for (const [id, seq] of Object.entries(entry.watermarks)) marks.set(id, Math.max(Number(seq), marks.get(id) || 0));
      while (marks.size > maxSessions) marks.delete(marks.keys().next().value);
      merged.delete(key);
      merged.set(key, { epoch: entry.epoch, marks });
    }
    while (merged.size > maxEndpoints) merged.delete(merged.keys().next().value);
    return Object.fromEntries([...merged].map(([key, entry]) => [key, { epoch: entry.epoch, watermarks: Object.fromEntries(entry.marks) }]));
  }

  async function persistMerged() {
    let value = snapshot();
    try {
      value = mergeWithStored((await storage.get(storageKey))?.[storageKey], value);
    } catch {
      // Unreadable storage: write this page's own snapshot, as before.
    }
    await storage.set({ [storageKey]: value });
    removed.clear();
    return true;
  }

  function persistNow() {
    timer = null;
    if (!storage?.set) return Promise.resolve(false);
    try {
      if (storage.get) return persistMerged().catch(() => false);
      return Promise.resolve(storage.set({ [storageKey]: snapshot() })).then(() => true, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  // Events arrive many times a second; one write per second is enough for a reload to resume.
  function schedulePersist() {
    if (!storage?.set || timer) return;
    timer = setTimer(persistNow, PERSIST_DELAY_MS);
    timer?.unref?.();
  }

  return {
    // The store one gateway client reads at construction and writes as it advances.
    forEndpoint(endpoint) {
      const key = clean(endpoint);
      if (!key) return null;
      return {
        load() {
          const entry = endpoints.get(key);
          if (!entry?.epoch || !entry.marks.size) return null;
          return { epoch: entry.epoch, watermarks: Object.fromEntries(entry.marks) };
        },
        save({ epoch = '', watermarks = {} } = {}) {
          const marks = cleanMarks(watermarks, maxSessions);
          const known = clean(epoch);
          if (!known || !marks.size) {
            if (endpoints.delete(key)) { removed.add(key); schedulePersist(); }
            return;
          }
          removed.delete(key);
          touch(key, { epoch: known, marks });
          schedulePersist();
        },
      };
    },
    // Read what a previous panel page saved. Never replaces something already learned in this page.
    async hydrate() {
      if (!storage?.get) return false;
      try {
        const stored = (await storage.get(storageKey))?.[storageKey];
        if (!stored || typeof stored !== 'object') return false;
        for (const [key, entry] of Object.entries(stored).slice(-maxEndpoints)) {
          const endpoint = clean(key);
          const epoch = clean(entry?.epoch);
          const marks = cleanMarks(entry?.watermarks, maxSessions);
          if (!endpoint || !epoch || !marks.size || endpoints.has(endpoint)) continue;
          endpoints.set(endpoint, { epoch, marks });
        }
        while (endpoints.size > maxEndpoints) endpoints.delete(endpoints.keys().next().value);
        return true;
      } catch {
        return false;
      }
    },
    flush() {
      if (timer) clearTimer(timer);
      return persistNow();
    },
    forget(endpoint) {
      const key = clean(endpoint);
      // Even an endpoint this page never held may be in the shared record.
      endpoints.delete(key);
      removed.add(key);
      schedulePersist();
    },
    get size() {
      return endpoints.size;
    },
  };
}
