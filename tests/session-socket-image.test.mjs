import test from 'node:test';
import assert from 'node:assert/strict';
import { stageImageViaSessionSocket } from '../extension/lib/session-socket-image.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function socket(handlers, { authority = true, readyState = 1 } = {}) {
  const calls = [];
  return {
    readyState, readyPayload: { session_authority: authority }, calls,
    request: async (method, params) => {
      calls.push([method, params]);
      const handler = handlers[method];
      if (handler instanceof Error) throw handler;
      return typeof handler === 'function' ? handler(params) : handler;
    },
  };
}

test('resumes read-only, stages the bytes, returns the gateway path and leaves again', async () => {
  const client = socket({
    'session.resume': { session_id: 'api-1', subscription_id: 'sub-9' },
    'image.attach_bytes': { attached: true, path: '/home/u/.hermes/cache/images/upload_1.png', name: 'upload_1.png', mime: 'image/png', bytes: 8 },
    'session.detach': { detached: true },
  });
  const result = await stageImageViaSessionSocket({ client, sessionId: 'api-1', dataUrl: PNG, filename: 'shot.png' });
  assert.deepEqual(result, { ok: true, path: '/home/u/.hermes/cache/images/upload_1.png', name: 'upload_1.png', mime: 'image/png', bytes: 8 });
  assert.deepEqual(client.calls.map(([method]) => method), ['session.resume', 'image.attach_bytes', 'session.detach']);
  assert.deepEqual(client.calls[0][1], { session_id: 'api-1', omit_messages: true });
  assert.deepEqual(client.calls[1][1], { session_id: 'api-1', content_base64: PNG, filename: 'shot.png' });
  assert.deepEqual(client.calls[2][1], { session_id: 'api-1', subscription_id: 'sub-9' });
});

test('uses the id the gateway names when it resolves the session to its owner', async () => {
  const client = socket({
    'session.resume': { session_id: 'root-1', subscription_id: 's' },
    'image.attach_bytes': { attached: true, path: '/p.png' },
    'session.detach': {},
  });
  await stageImageViaSessionSocket({ client, sessionId: 'child-1', dataUrl: PNG });
  assert.equal(client.calls[1][1].session_id, 'root-1');
  assert.equal(client.calls[2][1].session_id, 'root-1');
});

test('says why it could not, and always detaches what it attached', async () => {
  const notHeld = socket({ 'session.resume': Object.assign(new Error('not_found'), { data: { reason: 'not_found' } }) });
  assert.deepEqual(await stageImageViaSessionSocket({ client: notHeld, sessionId: 'x', dataUrl: PNG }), { ok: false, reason: 'session-not-held' });
  const missing = socket({ 'session.resume': { session_id: 'x', subscription_id: 'sub' }, 'image.attach_bytes': Object.assign(new Error('Unknown method'), { code: -32601 }), 'session.detach': {} });
  assert.equal((await stageImageViaSessionSocket({ client: missing, sessionId: 'x', dataUrl: PNG })).reason, 'method-not-found');
  assert.equal(missing.calls.at(-1)[0], 'session.detach');
  const refused = socket({ 'session.resume': { session_id: 'x', subscription_id: 'sub' }, 'image.attach_bytes': { attached: false, message: 'too big' }, 'session.detach': {} });
  assert.deepEqual(await stageImageViaSessionSocket({ client: refused, sessionId: 'x', dataUrl: PNG }), { ok: false, reason: 'refused', detail: 'too big' });
  assert.equal(refused.calls.at(-1)[0], 'session.detach');
});

test('never touches a socket that is not session authority, a closed one, or a non-image', async () => {
  for (const client of [socket({}, { authority: false }), socket({}, { readyState: 3 }), null]) {
    assert.equal((await stageImageViaSessionSocket({ client, sessionId: 'x', dataUrl: PNG })).reason, 'no-authority-socket');
    if (client) assert.equal(client.calls.length, 0);
  }
  const client = socket({});
  assert.equal((await stageImageViaSessionSocket({ client, sessionId: '', dataUrl: PNG })).reason, 'no-session');
  assert.equal((await stageImageViaSessionSocket({ client, sessionId: 'x', dataUrl: 'data:text/plain;base64,AA==' })).reason, 'not-an-image');
  assert.equal(client.calls.length, 0);
});
