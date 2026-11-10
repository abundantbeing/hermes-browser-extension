import assert from 'node:assert/strict';
import test from 'node:test';

// A small IndexedDB stand-in with the one property that matters here: read-write transactions on the
// same database run one after another, as they do between a side panel and the worker.
function fakeIndexedDb() {
  const rows = new Map();
  let queue = Promise.resolve();
  const later = (run) => setTimeout(run, 0);
  return {
    rows,
    open() {
      const request = { result: {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction(_name, mode) {
          const tx = {
            objectStore: () => ({
              get(id) {
                const req = {};
                tx.started.then(() => later(() => { req.result = rows.get(id); req.onsuccess?.(); }));
                return req;
              },
              put(row) {
                const req = {};
                tx.started.then(() => later(() => { rows.set(row.id, row); req.onsuccess?.(); }));
                return req;
              },
            }),
          };
          let begin;
          tx.started = new Promise((resolve) => { begin = resolve; });
          if (mode === 'readwrite') {
            const turn = queue.then(() => new Promise((release) => {
              begin();
              tx.release = release;
              later(() => later(() => later(() => release())));
            }));
            queue = turn;
          } else {
            begin();
          }
          return tx;
        },
      } };
      later(() => request.onsuccess?.());
      return request;
    },
  };
}

async function panel(label) {
  return import(`../extension/lib/saved-connection-secrets-crypto.mjs?panel=${label}`);
}

test('two panels creating the wrapping key at once end up with the same key', async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = fakeIndexedDb();
  try {
    const first = await panel('first');
    const second = await panel('second');
    const [keyA, keyB] = await Promise.all([first.ensureSavedSecretsWrappingKey(), second.ensureSavedSecretsWrappingKey()]);
    assert.ok(keyA && keyB);
    assert.equal(keyA, keyB, 'both panels hold the key that is stored');
    assert.equal(globalThis.indexedDB.rows.size, 1);
  } finally { globalThis.indexedDB = original; }
});

test('credentials one panel encrypts can still be read by the other after a first-run race', async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = fakeIndexedDb();
  try {
    const first = await panel('encrypt');
    const second = await panel('decrypt');
    const [record] = await Promise.all([
      first.encryptSavedConnectionSecretBag({ apiKey: 'race-test-key', tokenSource: 'manual' }),
      second.ensureSavedSecretsWrappingKey(),
    ]);
    const bag = await second.decryptSavedConnectionSecretBag(record);
    assert.deepEqual(bag, { apiKey: 'race-test-key', tokenSource: 'manual', headers: [] });
  } finally { globalThis.indexedDB = original; }
});
