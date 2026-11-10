import test from 'node:test';
import assert from 'node:assert/strict';

// IndexedDB holds the wrapping key. With it unreachable the key cannot be made, so nothing can be encrypted.
globalThis.indexedDB = { open() { throw new Error('IndexedDB is unavailable'); } };

const {
  packSavedConnectionStorage,
  rememberSavedConnection,
  SAVED_CONNECTION_SECRETS_STORAGE_KEY,
} = await import('../extension/lib/saved-connections.mjs');

const SECRET = 'plain-key-must-not-be-stored';
const HEADER_SECRET = 'plain-header-must-not-be-stored';

const local = {
  gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', apiKey: SECRET, tokenSource: 'pairing',
  connectionHeaders: [{ name: 'X-Proxy-Token', value: HEADER_SECRET }],
};

test('a save that cannot encrypt is refused instead of storing the key and headers in plaintext', async () => {
  await assert.rejects(
    packSavedConnectionStorage(rememberSavedConnection(local), {}),
    /cannot be encrypted/,
  );
});

test('a refused save leaves records that are already encrypted as they were', async () => {
  const kept = { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'BBBBBBBBBBBBBBBB' };
  const { connectionHeaders: _unread, ...unread } = { ...local, apiKey: '', tokenSource: '' };
  const settings = rememberSavedConnection(unread);
  const packed = await packSavedConnectionStorage(settings, { [settings.activeSavedConnectionId]: kept });
  assert.deepEqual(packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY][settings.activeSavedConnectionId], kept);
  await assert.rejects(
    packSavedConnectionStorage(rememberSavedConnection(local), { other: kept }),
    /cannot be encrypted/,
  );
});

test('settings without any secret still save when encryption is unavailable', async () => {
  const packed = await packSavedConnectionStorage(rememberSavedConnection({ ...local, apiKey: '', tokenSource: '', connectionHeaders: [] }), {});
  assert.deepEqual(packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY], {});
  assert.equal(JSON.stringify(packed).includes(SECRET), false);
});
