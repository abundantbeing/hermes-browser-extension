import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountSession, createAccountStore, createHermesAccount } from '../extension/lib/hermes-account.mjs';
import { findOpenWebappTab, resolveWebappTarget } from '../extension/lib/hermes-webapp.mjs';

const origin = 'https://gateway.example.com';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function sharedLocks() {
  let tail = Promise.resolve();
  return { request(_name, callback) { const run = tail.then(callback); tail = run.catch(() => {}); return run; } };
}
function area() {
  const data = {};
  return { get: async (key) => ({ [key]: structuredClone(data[key]) }), set: async (patch) => { Object.assign(data, structuredClone(patch)); }, remove: async (key) => { delete data[key]; } };
}
const response = (status, body) => ({ ok: status === 200, status, json: async () => body });
const session = (accessToken = 'old', refreshToken = 'old-refresh') => new AccountSession({ origin, connectionKey: 'old-connection', accessToken, refreshToken, expiresAt: 1 });

for (const action of ['signout', 'connection', 'new-session']) {
  test(`in-flight refresh cannot undo ${action}`, async () => {
    const locks = sharedLocks(); const storageArea = area();
    const first = createAccountStore({ storageArea, locks });
    const second = createAccountStore({ storageArea, locks });
    await first.save(session());
    const entered = deferred(); const release = deferred();
    const account = createHermesAccount({ store: first, now: () => 100000, fetchImpl: async () => { entered.resolve(); await release.promise; return response(200, { access_token: 'rotated', refresh_token: 'rotated-refresh', expires_at: 1000 }); } });
    const refreshing = account.accessToken(origin); await entered.promise;
    const mutation = action === 'signout' ? createHermesAccount({ store: second }).signOut(origin) : action === 'connection' ? second.clearUnlessConnection('new-connection') : second.save(session('new', 'new-refresh'));
    release.resolve(); await Promise.all([refreshing, mutation]);
    const saved = await second.get(origin);
    if (action === 'new-session') assert.equal(saved?.refreshToken, 'new-refresh');
    else assert.equal(saved, null);
  });
}

test('separate stores serialize refresh and reuse the rotated credential', async () => {
  const locks = sharedLocks(); const storageArea = area();
  const first = createAccountStore({ storageArea, locks }); const second = createAccountStore({ storageArea, locks });
  await first.save(session());
  const entered = deferred(); const release = deferred(); let calls = 0;
  const fetchImpl = async () => { calls += 1; entered.resolve(); await release.promise; return response(200, { access_token: 'rotated', refresh_token: 'rotated-refresh', expires_at: 1000 }); };
  const a = createHermesAccount({ store: first, fetchImpl, now: () => 100000 });
  const b = createHermesAccount({ store: second, fetchImpl, now: () => 100000 });
  const one = a.accessToken(origin); await entered.promise; const two = b.accessToken(origin);
  await Promise.resolve(); release.resolve();
  const results = await Promise.all([one, two]);
  assert.equal(calls, 1); assert.deepEqual(results.map((r) => r.token), ['rotated', 'rotated']);
  assert.equal((await second.get(origin)).refreshToken, 'rotated-refresh');
});

test('a different named or default webapp profile is never reused', async () => {
  for (const [selected, existing] of [['work', 'personal'], ['work', ''], ['', 'personal']]) {
    const target = resolveWebappTarget({ connectionMode: 'local', activeProfile: selected });
    const url = `http://127.0.0.1:9120/${existing ? `?profile=${existing}` : ''}`;
    assert.equal(await findOpenWebappTab({ query: async () => [{ id: 1, url }] }, target), null);
  }
});

test('a URL alone does not prove the currently selected Webapp profile', async () => {
  const target = resolveWebappTarget({ connectionMode: 'local', activeProfile: 'work' });
  assert.equal(await findOpenWebappTab({ query: async () => [{ id: 1, url: target.url }] }, target), null);
});

test('without cross-document locks, separate stores do not share persistent credentials', async () => {
  const storageArea = area();
  const first = createAccountStore({ storageArea, locks: null });
  const second = createAccountStore({ storageArea, locks: null });
  await first.save(session());
  assert.equal((await first.get(origin)).refreshToken, 'old-refresh');
  assert.equal(await second.get(origin), null);
});

test('a failed refresh clears only after acquiring the shared authority', async () => {
  const locks = sharedLocks(); const storageArea = area();
  const first = createAccountStore({ storageArea, locks }); const second = createAccountStore({ storageArea, locks });
  await first.save(session());
  const entered = deferred(); const release = deferred(); let calls = 0;
  const fetchImpl = async () => { calls += 1; entered.resolve(); await release.promise; return response(401, {}); };
  const a = createHermesAccount({ store: first, fetchImpl, now: () => 100000 });
  const b = createHermesAccount({ store: second, fetchImpl, now: () => 100000 });
  const one = a.accessToken(origin); await entered.promise; const two = b.accessToken(origin);
  release.resolve(); const results = await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal(results[0].reason, 'session-expired');
  assert.equal(results[1].reason, 'signed-out');
  assert.equal(await second.get(origin), null);
});
