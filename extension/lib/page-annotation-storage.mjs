export const PAGE_ANNOTATION_STORAGE_KEY = 'hermes:pageAnnotationSessions:v1';
export const PAGE_ANNOTATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PAGE_ANNOTATION_MAX_PINS = 12;

function asMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function sessionKey(session) {
  return String(session?.tabId || '');
}

function metadataOnly(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    schemaVersion: Number(session.schemaVersion) || 1,
    sessionId: String(session.sessionId || ''),
    tabId: Number(session.tabId) || 0,
    safeUrl: String(session.safeUrl || ''),
    documentKey: String(session.documentKey || ''),
    nextNumber: Number(session.nextNumber) || 1,
    updatedAt: Number(session.updatedAt) || Date.now(),
    expiresAt: Number(session.expiresAt) || (Date.now() + PAGE_ANNOTATION_TTL_MS),
    pins: Array.isArray(session.pins) ? session.pins.slice(0, PAGE_ANNOTATION_MAX_PINS).map((pin) => ({
      ...pin,
      imageDataUrl: undefined,
      note: String(pin.note || '').slice(0, 4_000),
    })) : [],
  };
}

async function readStore(storageArea) {
  const stored = await storageArea.get(PAGE_ANNOTATION_STORAGE_KEY);
  return asMap(stored?.[PAGE_ANNOTATION_STORAGE_KEY]);
}

async function writeStore(storageArea, map) {
  await storageArea.set({ [PAGE_ANNOTATION_STORAGE_KEY]: map });
}

export async function persistPageAnnotationSession({ storageArea, images, session, imageBlobs = {} } = {}) {
  if (!storageArea?.get || !storageArea?.set) return null;
  const meta = metadataOnly(session);
  if (!meta?.tabId) return null;
  const map = await readStore(storageArea);
  map[sessionKey(meta)] = meta;
  await writeStore(storageArea, map);
  if (images?.put) {
    for (const [id, blob] of Object.entries(imageBlobs || {})) {
      await images.put(id, blob);
    }
  }
  return meta;
}

export async function loadPageAnnotationSession({
  storageArea,
  images,
  tabId,
  safeUrl,
  documentKey,
  fallback = null,
} = {}) {
  try {
    const map = await readStore(storageArea);
    const stored = map[String(tabId)] || null;
    if (!stored) return { session: fallback || null, images: {} };
    const imageMap = {};
    if (images?.get) {
      for (const pin of stored.pins || []) {
        if (pin.imageRef) imageMap[pin.imageRef] = await images.get(pin.imageRef);
      }
    }
    if (String(stored.safeUrl) !== String(safeUrl) || String(stored.documentKey) !== String(documentKey)) {
      return { session: stored, images: imageMap, status: 'stale' };
    }
    return { session: stored, images: imageMap, status: 'ok' };
  } catch {
    return { session: fallback || null, images: {}, status: 'error' };
  }
}

export async function restorePageAnnotationSession(options = {}) {
  const loaded = await loadPageAnnotationSession(options);
  if (loaded.status === 'stale') return loaded;
  if (loaded.session && String(loaded.session.documentKey) !== String(options.documentKey)) {
    return { ...loaded, status: 'stale' };
  }
  return { ...loaded, status: loaded.session ? 'ok' : 'missing' };
}

export async function clearPageAnnotationSession({ storageArea, images, tabId } = {}) {
  const map = await readStore(storageArea);
  const stored = map[String(tabId)];
  delete map[String(tabId)];
  await writeStore(storageArea, map);
  if (stored && images?.delete) {
    for (const pin of stored.pins || []) {
      if (pin.imageRef) await images.delete(pin.imageRef);
    }
  }
  return true;
}

export async function pruneExpiredPageAnnotationSessions({ storageArea, images, now = Date.now() } = {}) {
  const map = await readStore(storageArea);
  let pruned = 0;
  for (const [key, session] of Object.entries(map)) {
    if (Number(session?.expiresAt) > now) continue;
    delete map[key];
    pruned += 1;
    if (images?.delete) {
      for (const pin of session.pins || []) {
        if (pin.imageRef) await images.delete(pin.imageRef);
      }
    }
  }
  await writeStore(storageArea, map);
  return pruned;
}

export function createPageAnnotationImageStore() {
  const memory = new Map();
  let dbPromise = null;

  function openDb() {
    if (!globalThis.indexedDB) return null;
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        const request = globalThis.indexedDB.open('hermes-page-annotations-v1', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    }
    return dbPromise;
  }

  return {
    async put(id, blob) {
      memory.set(id, blob);
      const db = await openDb();
      if (!db) return;
      await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put(blob, id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    },
    async get(id) {
      if (memory.has(id)) return memory.get(id);
      const db = await openDb();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction('images', 'readonly');
        const request = tx.objectStore('images').get(id);
        request.onsuccess = () => {
          if (request.result) memory.set(id, request.result);
          resolve(request.result || null);
        };
        request.onerror = () => resolve(null);
      });
    },
    async delete(id) {
      memory.delete(id);
      const db = await openDb();
      if (!db) return;
      await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    },
  };
}
