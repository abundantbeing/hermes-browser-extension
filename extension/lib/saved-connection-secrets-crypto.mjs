/**
 * AES-GCM protection for saved-connection sidecar secrets (chrome.storage.local).
 * The wrapping key is a non-extractable AES-256-GCM CryptoKey stored only in IndexedDB.
 * Falls back to in-memory storage when IndexedDB is unavailable (e.g. unit tests).
 */

const DB_NAME = 'hermesSavedConnectionSecrets';
const DB_VERSION = 1;
const STORE_NAME = 'meta';
const KEY_RECORD_ID = 'aes256gcm-v1';

/** @type {Map<string, Map<string, CryptoKey>>} */
const memoryDbs = new Map();

function getSubtle() {
  return globalThis.crypto?.subtle ?? null;
}

function memoryStore() {
  if (!memoryDbs.has(DB_NAME)) memoryDbs.set(DB_NAME, new Map());
  return /** @type {Map<string, CryptoKey>} */ (memoryDbs.get(DB_NAME));
}

/**
 * @param {IDBOpenDBRequest} request
 */
function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @returns {Promise<IDBDatabase|Map<string, CryptoKey>>}
 */
async function openMetaStore() {
  const idb = globalThis.indexedDB;
  if (typeof idb === 'undefined' || typeof idb.open !== 'function') {
    return memoryStore();
  }
  const request = idb.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  };
  return idbRequest(request);
}

/**
 * @param {IDBDatabase|Map<string, CryptoKey>} db
 * @param {string} id
 */
async function idbGetKey(db, id) {
  if (db instanceof Map) {
    return db.get(id) ?? null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => resolve(getReq.result?.key ?? null);
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Keeps the first key written. Every panel and the worker share this one row, so reading and
 * writing happen in one transaction: a second writer gets the stored key back, never replaces it.
 * @param {IDBDatabase|Map<string, CryptoKey>} db
 * @param {string} id
 * @param {CryptoKey} candidate
 * @returns {Promise<CryptoKey>}
 */
async function idbKeepFirstKey(db, id, candidate) {
  if (db instanceof Map) {
    if (!db.has(id)) db.set(id, candidate);
    return db.get(id);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const stored = getReq.result?.key;
      if (stored) {
        resolve(stored);
        return;
      }
      const putReq = store.put({ id, key: candidate });
      putReq.onsuccess = () => resolve(candidate);
      putReq.onerror = () => reject(putReq.error);
    };
  });
}

let cachedKeyPromise = null;

/**
 * @returns {Promise<CryptoKey|null>}
 */
export async function ensureSavedSecretsWrappingKey() {
  const subtle = getSubtle();
  if (!subtle || typeof subtle.generateKey !== 'function') return null;
  if (cachedKeyPromise) return cachedKeyPromise;
  cachedKeyPromise = (async () => {
    try {
      const db = await openMetaStore();
      const existing = await idbGetKey(db, KEY_RECORD_ID);
      if (existing) return existing;
      const candidate = await subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      return await idbKeepFirstKey(db, KEY_RECORD_ID, candidate);
    } catch {
      cachedKeyPromise = null;
      return null;
    }
  })();
  return cachedKeyPromise;
}

function toB64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return globalThis.btoa(binary);
}

function fromB64(s) {
  const str = String(s || '');
  const bin = globalThis.atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Custom headers kept with a connection's credentials: [{ name, value }]. */
export function secretBagHeaders(list) {
  return Array.isArray(list)
    ? list.map((entry) => ({ name: String(entry?.name ?? ''), value: String(entry?.value ?? '') })).filter((entry) => entry.name)
    : [];
}

/**
 * @param {{ apiKey?: string, tokenSource?: string, headers?: Array<{ name: string, value: string }> }} bag
 * @returns {Promise<{ v: number, iv: string, ct: string }|null>}
 */
export async function encryptSavedConnectionSecretBag(bag) {
  const subtle = getSubtle();
  const key = await ensureSavedSecretsWrappingKey();
  if (!subtle || !key) return null;
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const enc = new TextEncoder();
  const plain = enc.encode(JSON.stringify({
    apiKey: String(bag?.apiKey ?? ''),
    tokenSource: String(bag?.tokenSource ?? ''),
    headers: secretBagHeaders(bag?.headers),
  }));
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { v: 1, iv: toB64(iv), ct: toB64(cipher) };
}

/**
 * @param {{ v?: number, iv?: string, ct?: string }} record
 * @returns {Promise<{ apiKey: string, tokenSource: string }|null>}
 */
export async function decryptSavedConnectionSecretBag(record) {
  if (!record || record.v !== 1 || !record.iv || !record.ct) return null;
  const subtle = getSubtle();
  const key = await ensureSavedSecretsWrappingKey();
  if (!subtle || !key) return null;
  try {
    const iv = fromB64(record.iv);
    const ct = fromB64(record.ct);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const text = new TextDecoder().decode(plain);
    const parsed = JSON.parse(text);
    return {
      apiKey: String(parsed?.apiKey ?? ''),
      tokenSource: String(parsed?.tokenSource ?? ''),
      headers: secretBagHeaders(parsed?.headers),
    };
  } catch {
    return null;
  }
}

export function isEncryptedSecretRecord(value) {
  return Boolean(value && typeof value === 'object' && value.v === 1 && value.iv && value.ct);
}

export function isPlainSecretBag(value) {
  return Boolean(value && typeof value === 'object' && !value.v && ('apiKey' in value || 'tokenSource' in value));
}
