import {
  CUSTOM_THEME_MAX_COUNT,
  CUSTOM_THEME_MAX_INPUT_BYTES,
  CUSTOM_THEME_MAX_RECORD_BYTES,
  CUSTOM_THEME_MAX_STORE_BYTES,
  CUSTOM_THEME_STORAGE_KEY,
  normalizeThemeDocument,
  serializeThemeDocument,
} from './custom-themes.mjs';

const STORE_VERSION = 1;
const CUSTOM_THEME_ID_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_KEYS = Object.freeze(['id', 'source', 'sourceId', 'sourceVersion', 'installedAt', 'document']);
const encoder = new TextEncoder();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function byteLength(value) {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function failure(status, code, message, details = {}) {
  return { ok: false, status, themes: [], error: { code, message, ...details } };
}

function storageFailure(code, error) {
  return failure('error', code, error instanceof Error ? error.message : String(error));
}

function normalizedDocumentRecord(document) {
  const publicDocument = JSON.parse(serializeThemeDocument(document));
  const normalized = normalizeThemeDocument(publicDocument);
  return JSON.parse(JSON.stringify(normalized));
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function inspectRecord(record, index) {
  if (!isPlainObject(record)) return { ok: false, code: 'invalid-record', message: `Theme record ${index} must be a plain object` };
  const recordBytes = byteLength(record);
  if (recordBytes > CUSTOM_THEME_MAX_RECORD_BYTES) {
    return { ok: false, code: 'record-too-large', message: `Theme record ${index} exceeds ${CUSTOM_THEME_MAX_RECORD_BYTES} bytes`, bytes: recordBytes };
  }
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length || keys.some((key) => !RECORD_KEYS.includes(key))) {
    return { ok: false, code: 'invalid-record', message: `Theme record ${index} has an invalid shape` };
  }
  if (!CUSTOM_THEME_ID_RE.test(record.id)) return { ok: false, code: 'invalid-record', message: `Theme record ${index} has an invalid ID` };
  if (!['import', 'vscode-marketplace'].includes(record.source)) return { ok: false, code: 'invalid-record', message: `Theme record ${index} has an invalid source` };
  if (record.source === 'import' && (record.sourceId !== null || record.sourceVersion !== null)) {
    return { ok: false, code: 'invalid-record', message: `Imported theme record ${index} cannot carry remote source metadata` };
  }
  if (record.source === 'vscode-marketplace') {
    if (typeof record.sourceId !== 'string' || !/^[\w-]+\.[\w-]+$/.test(record.sourceId) || record.sourceId.length > 200) {
      return { ok: false, code: 'invalid-record', message: `Marketplace theme record ${index} has an invalid source ID` };
    }
    if (typeof record.sourceVersion !== 'string' || !record.sourceVersion || record.sourceVersion.length > 100) {
      return { ok: false, code: 'invalid-record', message: `Marketplace theme record ${index} has an invalid source version` };
    }
  }
  if (!isCanonicalIsoTimestamp(record.installedAt)) {
    return { ok: false, code: 'invalid-record', message: `Theme record ${index} has an invalid installation timestamp` };
  }
  try {
    const normalized = normalizedDocumentRecord(record.document);
    if (canonicalJson(normalized) !== canonicalJson(record.document)) {
      return { ok: false, code: 'invalid-record', message: `Theme record ${index} is not normalized` };
    }
  } catch (error) {
    return { ok: false, code: 'invalid-record', message: `Theme record ${index} contains an invalid document`, cause: error?.message };
  }
  return { ok: true };
}

function inspectStoredValue(stored) {
  const storeBytes = byteLength(stored);
  if (storeBytes > CUSTOM_THEME_MAX_STORE_BYTES) {
    return failure('corrupt', 'store-too-large', `Custom theme storage exceeds ${CUSTOM_THEME_MAX_STORE_BYTES} bytes`, { bytes: storeBytes });
  }
  if (!isPlainObject(stored)) return failure('corrupt', 'invalid-store', 'Custom theme storage must be a plain object');
  if (stored.version !== STORE_VERSION) return failure('corrupt', 'store-version', `Custom theme storage version must equal ${STORE_VERSION}`);
  if (!Array.isArray(stored.themes)) return failure('corrupt', 'invalid-store', 'Custom theme storage themes must be an array');
  if (Object.keys(stored).length !== 2 || !Object.hasOwn(stored, 'version') || !Object.hasOwn(stored, 'themes')) {
    return failure('corrupt', 'invalid-store', 'Custom theme storage contains unknown keys');
  }
  if (stored.themes.length > CUSTOM_THEME_MAX_COUNT) {
    return failure('corrupt', 'theme-limit-exceeded', `Custom theme storage exceeds ${CUSTOM_THEME_MAX_COUNT} records`);
  }
  const seen = new Set();
  for (let index = 0; index < stored.themes.length; index += 1) {
    const record = stored.themes[index];
    const inspection = inspectRecord(record, index);
    if (!inspection.ok) return failure('corrupt', inspection.code, inspection.message, inspection);
    if (seen.has(record.id)) return failure('corrupt', 'duplicate-id', `Duplicate custom theme ID at record ${index}`);
    seen.add(record.id);
  }
  return { ok: true, status: stored.themes.length ? 'ready' : 'empty', themes: structuredClone(stored.themes) };
}

function assertStorageAdapter(storageArea) {
  if (!storageArea || typeof storageArea.get !== 'function' || typeof storageArea.set !== 'function' || typeof storageArea.remove !== 'function') {
    throw new TypeError('storageArea must expose get, set, and remove');
  }
}

export async function readCustomThemeStore(storageArea) {
  try {
    assertStorageAdapter(storageArea);
  } catch (error) {
    return storageFailure('storage-adapter-invalid', error);
  }
  let result;
  try {
    result = await storageArea.get(CUSTOM_THEME_STORAGE_KEY);
  } catch (error) {
    return storageFailure('storage-read-failed', error);
  }
  if (!isPlainObject(result) || !Object.hasOwn(result, CUSTOM_THEME_STORAGE_KEY)) {
    return { ok: true, status: 'empty', themes: [] };
  }
  return inspectStoredValue(result[CUSTOM_THEME_STORAGE_KEY]);
}

function nowIso(options) {
  const value = typeof options?.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid installation timestamp');
  return date.toISOString();
}

function newCustomId(options) {
  const randomUUID = typeof options?.randomUUID === 'function'
    ? options.randomUUID
    : globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (typeof randomUUID !== 'function') throw new TypeError('crypto.randomUUID is unavailable');
  const uuid = String(randomUUID()).toLowerCase();
  const id = `custom:${uuid}`;
  if (!CUSTOM_THEME_ID_RE.test(id)) throw new TypeError('crypto.randomUUID returned an invalid UUID');
  return id;
}

export async function installCustomTheme(storageArea, document, options = {}) {
  if (Number.isFinite(options.inputBytes) && options.inputBytes > CUSTOM_THEME_MAX_INPUT_BYTES) {
    return failure('error', 'input-too-large', `Theme input exceeds ${CUSTOM_THEME_MAX_INPUT_BYTES} bytes`, { bytes: options.inputBytes });
  }

  let normalized;
  try {
    normalized = normalizedDocumentRecord(document);
  } catch (error) {
    return failure('error', 'invalid-document', error?.message || 'Theme document is invalid', { validationErrors: error?.validationErrors || [] });
  }

  const current = await readCustomThemeStore(storageArea);
  if (!current.ok) return current;
  if (current.themes.length >= CUSTOM_THEME_MAX_COUNT) {
    return failure('error', 'theme-limit-reached', `No more than ${CUSTOM_THEME_MAX_COUNT} custom themes may be installed`);
  }

  let record;
  try {
    const source = options.source === 'vscode-marketplace' ? 'vscode-marketplace' : 'import';
    const sourceId = source === 'vscode-marketplace' ? String(options.sourceId || '').trim() : null;
    const sourceVersion = source === 'vscode-marketplace' ? String(options.sourceVersion || '').trim() : null;
    if (source === 'vscode-marketplace' && (!/^[\w-]+\.[\w-]+$/.test(sourceId) || sourceId.length > 200 || !sourceVersion || sourceVersion.length > 100)) {
      throw new TypeError('Marketplace source metadata is invalid');
    }
    record = {
      id: newCustomId(options),
      source,
      sourceId,
      sourceVersion,
      installedAt: nowIso(options),
      document: normalized,
    };
  } catch (error) {
    return failure('error', 'record-generation-failed', error?.message || 'Could not create the theme record');
  }

  const recordBytes = byteLength(record);
  if (recordBytes > CUSTOM_THEME_MAX_RECORD_BYTES) {
    return failure('error', 'record-too-large', `Normalized theme record exceeds ${CUSTOM_THEME_MAX_RECORD_BYTES} bytes`, { bytes: recordBytes });
  }
  const store = { version: STORE_VERSION, themes: [...current.themes, record] };
  const storeBytes = byteLength(store);
  if (storeBytes > CUSTOM_THEME_MAX_STORE_BYTES) {
    return failure('error', 'store-too-large', `Custom theme storage would exceed ${CUSTOM_THEME_MAX_STORE_BYTES} bytes`, { bytes: storeBytes });
  }
  try {
    await storageArea.set({ [CUSTOM_THEME_STORAGE_KEY]: store });
  } catch (error) {
    return storageFailure('storage-write-failed', error);
  }
  return { ok: true, status: 'installed', record: structuredClone(record), store: structuredClone(store) };
}

export async function deleteCustomTheme(storageArea, id) {
  const current = await readCustomThemeStore(storageArea);
  if (!current.ok) return current;
  const index = current.themes.findIndex((record) => record.id === id);
  if (index < 0) return { ok: true, status: 'missing', store: { version: STORE_VERSION, themes: current.themes } };
  const themes = current.themes.filter((_, recordIndex) => recordIndex !== index);
  const store = { version: STORE_VERSION, themes };
  try {
    await storageArea.set({ [CUSTOM_THEME_STORAGE_KEY]: store });
  } catch (error) {
    return storageFailure('storage-write-failed', error);
  }
  return { ok: true, status: 'deleted', deletedId: id, store: structuredClone(store) };
}

export async function resetCustomThemeStore(storageArea) {
  try {
    assertStorageAdapter(storageArea);
    await storageArea.remove(CUSTOM_THEME_STORAGE_KEY);
  } catch (error) {
    return storageFailure('storage-reset-failed', error);
  }
  return { ok: true, status: 'reset' };
}
