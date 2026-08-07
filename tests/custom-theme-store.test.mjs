import assert from 'node:assert/strict';
import test from 'node:test';

const THEMES_MODULE_PATH = '../extension/lib/custom-themes.mjs';
const themeFallback = {
  CUSTOM_THEME_MAX_COUNT: 32,
  CUSTOM_THEME_MAX_INPUT_BYTES: 32 * 1024,
  CUSTOM_THEME_MAX_RECORD_BYTES: 16 * 1024,
  CUSTOM_THEME_MAX_STORE_BYTES: 512 * 1024,
  CUSTOM_THEME_STORAGE_KEY: 'hermesBrowserCustomThemesV1',
  normalizeThemeDocument(candidate) {
    return structuredClone(candidate);
  },
};

async function loadThemesContract() {
  try {
    return await import(THEMES_MODULE_PATH);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.url || '').endsWith('/extension/lib/custom-themes.mjs')) {
      return themeFallback;
    }
    throw error;
  }
}

const {
  CUSTOM_THEME_MAX_COUNT,
  CUSTOM_THEME_MAX_INPUT_BYTES,
  CUSTOM_THEME_MAX_RECORD_BYTES,
  CUSTOM_THEME_MAX_STORE_BYTES,
  CUSTOM_THEME_STORAGE_KEY,
  normalizeThemeDocument,
} = await loadThemesContract();

const MODULE_PATH = '../extension/lib/custom-theme-store.mjs';
const missingContract = {
  readCustomThemeStore: async () => ({ ok: false, status: 'module-missing', themes: [] }),
  installCustomTheme: async () => ({ ok: false, status: 'module-missing' }),
  deleteCustomTheme: async () => ({ ok: false, status: 'module-missing' }),
  resetCustomThemeStore: async () => ({ ok: false, status: 'module-missing' }),
};

async function loadContract() {
  try {
    return await import(MODULE_PATH);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.url || '').endsWith('/extension/lib/custom-theme-store.mjs')) {
      return missingContract;
    }
    throw error;
  }
}

const {
  readCustomThemeStore,
  installCustomTheme,
  deleteCustomTheme,
  resetCustomThemeStore,
} = await loadContract();

const COLORS = Object.freeze({
  canvas: '#ffffff', paper: '#f5f5f5', ink: '#111111', muted: '#595959',
  primary: '#0505e8', primaryDeep: '#03039b', onPrimary: '#ffffff', accent: '#ffd400',
  onAccent: '#111111', line: '#767676', input: '#ffffff', danger: '#b00020',
  onDanger: '#ffffff', shellForeground: '#ffffff',
});

function validDocument(name = 'Focus Forge') {
  return normalizeThemeDocument({
    schemaVersion: 1,
    name,
    description: 'A strict high-contrast theme.',
    colors: { ...COLORS },
  });
}

function validRecord(index = 0) {
  return {
    id: `custom:${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    source: 'import',
    sourceId: null,
    sourceVersion: null,
    installedAt: '2026-08-08T00:00:00.000Z',
    document: validDocument(`Theme ${index}`),
  };
}

function createStorage(initial = {}, failures = {}) {
  const values = structuredClone(initial);
  const calls = { get: [], set: [], remove: [] };
  return {
    calls,
    values,
    async get(key) {
      calls.get.push(key);
      if (failures.get) throw new Error(failures.get);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(patch) {
      calls.set.push(structuredClone(patch));
      if (failures.set) throw new Error(failures.set);
      Object.assign(values, structuredClone(patch));
    },
    async remove(key) {
      calls.remove.push(key);
      if (failures.remove) throw new Error(failures.remove);
      delete values[key];
    },
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)]));
}

test('reads missing storage as an empty healthy store without writing', async () => {
  const storage = createStorage();
  const result = await readCustomThemeStore(storage);
  assert.deepEqual(result, { ok: true, status: 'empty', themes: [] });
  assert.equal(storage.calls.set.length, 0);
  assert.equal(storage.calls.remove.length, 0);
});

test('installs and reads back a normalized record while ignoring caller IDs', async () => {
  const storage = createStorage();
  const document = validDocument();
  const result = await installCustomTheme(storage, document, {
    id: 'custom:caller-controlled',
    now: () => new Date('2026-08-08T00:00:00.000Z'),
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    inputBytes: 1024,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'installed');
  assert.equal(result.record.id, 'custom:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.notEqual(result.record.id, 'custom:caller-controlled');
  assert.equal(result.record.source, 'import');
  assert.equal(result.record.sourceId, null);
  assert.equal(result.record.sourceVersion, null);
  assert.equal(result.record.installedAt, '2026-08-08T00:00:00.000Z');
  assert.deepEqual(result.record.document, document);

  const reread = await readCustomThemeStore(storage);
  assert.equal(reread.ok, true);
  assert.equal(reread.status, 'ready');
  assert.deepEqual(reread.themes, [result.record]);
});

test('installs normalized preview output but rejects unknown direct-install keys', async () => {
  const storage = createStorage();
  const result = await installCustomTheme(storage, validDocument(), {
    inputBytes: 2048,
    randomUUID: () => 'abababab-abab-4bab-8bab-abababababab',
    now: () => '2026-08-08T04:10:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'installed');
  assert.equal(result.record.id, 'custom:abababab-abab-4bab-8bab-abababababab');

  const unsafeStorage = createStorage();
  const unsafe = await installCustomTheme(unsafeStorage, { ...validDocument(), css: 'body{}' }, { inputBytes: 128 });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error?.code, 'invalid-document');
  assert.equal(unsafeStorage.calls.set.length, 0);
});

test('reads a valid normalized record after browser storage reorders object keys', async () => {
  const record = reverseObjectKeys(validRecord(7));
  const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: { themes: [record], version: 1 } });
  const result = await readCustomThemeStore(storage);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.themes[0].id, record.id);
  assert.equal(storage.calls.set.length, 0);
});

test('discloses wrong store versions and malformed records without any repair write', async () => {
  for (const stored of [
    { version: 2, themes: [] },
    { version: 1, themes: [{ id: 'built-in:nous' }] },
    { version: 1, themes: 'not-an-array' },
  ]) {
    const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: stored });
    const result = await readCustomThemeStore(storage);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.status, 'corrupt');
    assert.deepEqual(result.themes, []);
    assert.equal(storage.calls.set.length, 0);
    assert.equal(storage.calls.remove.length, 0);
  }
});

test('rejects oversized source input before storage access', async () => {
  const storage = createStorage();
  const result = await installCustomTheme(storage, validDocument(), { inputBytes: CUSTOM_THEME_MAX_INPUT_BYTES + 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'input-too-large');
  assert.equal(storage.calls.get.length, 0);
  assert.equal(storage.calls.set.length, 0);
});

test('rejects records and stores beyond normalized byte limits', async () => {
  const oversizedRecord = { ...validRecord(1), sourceId: 'x'.repeat(CUSTOM_THEME_MAX_RECORD_BYTES) };
  const recordStorage = createStorage({
    [CUSTOM_THEME_STORAGE_KEY]: { version: 1, themes: [oversizedRecord] },
  });
  const recordResult = await readCustomThemeStore(recordStorage);
  assert.equal(recordResult.ok, false);
  assert.equal(recordResult.status, 'corrupt');
  assert.ok(['record-too-large', 'invalid-record'].includes(recordResult.error.code));
  assert.equal(recordStorage.calls.set.length, 0);

  const oversizedStore = { version: 1, themes: [], padding: 'x'.repeat(CUSTOM_THEME_MAX_STORE_BYTES) };
  const storeStorage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: oversizedStore });
  const storeResult = await readCustomThemeStore(storeStorage);
  assert.equal(storeResult.ok, false);
  assert.equal(storeResult.status, 'corrupt');
  assert.equal(storeResult.error.code, 'store-too-large');
  assert.equal(storeStorage.calls.set.length, 0);
});

test('enforces the installed theme count limit without writing', async () => {
  const records = Array.from({ length: CUSTOM_THEME_MAX_COUNT }, (_, index) => validRecord(index));
  const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: { version: 1, themes: records } });
  const result = await installCustomTheme(storage, validDocument('One Too Many'), { inputBytes: 1024 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'theme-limit-reached');
  assert.equal(storage.calls.set.length, 0);
});

test('supports duplicate names because generated IDs are authoritative', async () => {
  const existing = validRecord(1);
  const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: { version: 1, themes: [existing] } });
  const result = await installCustomTheme(storage, validDocument(existing.document.name), {
    inputBytes: 1024,
    randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  assert.equal(result.ok, true);
  assert.equal(result.store.themes.length, 2);
  assert.equal(result.store.themes[0].document.name, result.store.themes[1].document.name);
  assert.notEqual(result.store.themes[0].id, result.store.themes[1].id);
});

test('previewing through schema normalization performs no storage write', async () => {
  const storage = createStorage();
  const document = validDocument();
  assert.equal(document.name, 'Focus Forge');
  assert.equal(storage.calls.get.length, 0);
  assert.equal(storage.calls.set.length, 0);
  assert.equal(storage.calls.remove.length, 0);
});

test('deletes an existing record, preserves order, and reports a missing ID without writing', async () => {
  const first = validRecord(1);
  const second = validRecord(2);
  const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: { version: 1, themes: [first, second] } });
  const deleted = await deleteCustomTheme(storage, first.id);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(deleted.store.themes.map((record) => record.id), [second.id]);
  assert.equal(storage.calls.set.length, 1);

  const beforeMissing = storage.calls.set.length;
  const missing = await deleteCustomTheme(storage, 'custom:ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.equal(missing.ok, true);
  assert.equal(missing.status, 'missing');
  assert.equal(storage.calls.set.length, beforeMissing);
});

test('refuses deletion from corrupt storage and leaves the bytes untouched', async () => {
  const original = { version: 99, themes: [] };
  const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: original });
  const result = await deleteCustomTheme(storage, 'custom:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'corrupt');
  assert.deepEqual(storage.values[CUSTOM_THEME_STORAGE_KEY], original);
  assert.equal(storage.calls.set.length, 0);
  assert.equal(storage.calls.remove.length, 0);
});

test('only explicit reset removes corrupt custom theme storage', async () => {
  const storage = createStorage({ [CUSTOM_THEME_STORAGE_KEY]: { version: 99, themes: [] } });
  await readCustomThemeStore(storage);
  assert.equal(storage.calls.remove.length, 0);
  const result = await resetCustomThemeStore(storage);
  assert.deepEqual(result, { ok: true, status: 'reset' });
  assert.deepEqual(storage.calls.remove, [CUSTOM_THEME_STORAGE_KEY]);
  assert.equal(Object.hasOwn(storage.values, CUSTOM_THEME_STORAGE_KEY), false);
});

test('converts storage adapter exceptions into structured failures without throwing', async () => {
  const readFailure = await readCustomThemeStore(createStorage({}, { get: 'read exploded' }));
  assert.equal(readFailure.ok, false);
  assert.equal(readFailure.status, 'error');
  assert.equal(readFailure.error?.code, 'storage-read-failed');
  assert.match(readFailure.error?.message || '', /read exploded/);

  const writeFailure = await installCustomTheme(createStorage({}, { set: 'write exploded' }), validDocument(), { inputBytes: 1024 });
  assert.equal(writeFailure.ok, false);
  assert.equal(writeFailure.status, 'error');
  assert.equal(writeFailure.error?.code, 'storage-write-failed');
  assert.match(writeFailure.error?.message || '', /write exploded/);

  const resetFailure = await resetCustomThemeStore(createStorage({}, { remove: 'remove exploded' }));
  assert.equal(resetFailure.ok, false);
  assert.equal(resetFailure.status, 'error');
  assert.equal(resetFailure.error?.code, 'storage-reset-failed');
  assert.match(resetFailure.error?.message || '', /remove exploded/);
});
