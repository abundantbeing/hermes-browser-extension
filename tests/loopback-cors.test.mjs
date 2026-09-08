import test from 'node:test';
import assert from 'node:assert/strict';

import { LOOPBACK_CORS_RULE_ID, installLoopbackCorsRules, loopbackCorsRules } from '../extension/lib/loopback-cors.mjs';

test('loopback CORS rules are disabled instead of rewriting every loopback response', () => {
  assert.deepEqual(loopbackCorsRules(), []);
});

test('installLoopbackCorsRules removes the stale broad session rule', async () => {
  const calls = [];
  const dnr = {
    updateSessionRules: async (options) => {
      calls.push(options);
    },
  };
  assert.equal(await installLoopbackCorsRules(dnr), true);
  assert.deepEqual(calls[0].removeRuleIds, [LOOPBACK_CORS_RULE_ID]);
  assert.deepEqual(calls[0].addRules, []);
});

test('loopback fetch proxy rejects non-loopback URLs', async () => {
  const { handleLoopbackFetchMessage, LOOPBACK_FETCH_MESSAGE } = await import('../extension/lib/loopback-cors.mjs');
  const result = await handleLoopbackFetchMessage({
    type: LOOPBACK_FETCH_MESSAGE,
    url: 'https://example.com/api/profiles',
  });
  assert.equal(result.error, 'loopback-url-rejected');
});

test('loopback fetch proxy returns the worker response body', async () => {
  const { handleLoopbackFetchMessage, LOOPBACK_FETCH_MESSAGE } = await import('../extension/lib/loopback-cors.mjs');
  const fetchFn = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:17445/api/status');
    assert.equal(options.credentials, 'omit');
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"profiles":["default"]}',
    };
  };
  const result = await handleLoopbackFetchMessage({
    type: LOOPBACK_FETCH_MESSAGE,
    url: 'http://127.0.0.1:17445/api/status',
  }, fetchFn);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.match(result.body, /default/);
});

test('background loopback fetch uses the worker when the URL is local', async () => {
  const { createBackgroundLoopbackFetch, LOOPBACK_FETCH_MESSAGE } = await import('../extension/lib/loopback-cors.mjs');
  const sendMessage = async (message) => {
    assert.equal(message.type, LOOPBACK_FETCH_MESSAGE);
    return { ok: true, status: 200, body: '{"version":"0.21.0"}', contentType: 'application/json' };
  };
  const fetchFn = createBackgroundLoopbackFetch({ sendMessage, fetchFn: async () => { throw new Error('page fetch should not run'); } });
  const response = await fetchFn('http://127.0.0.1:17445/api/status');
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { version: '0.21.0' });
});

test('background loopback fetch rejects unsupported methods before any fallback fetch', async () => {
  const { createBackgroundLoopbackFetch } = await import('../extension/lib/loopback-cors.mjs');
  let fallbackCalled = false;
  const fetchFn = createBackgroundLoopbackFetch({
    sendMessage: async () => { throw new Error('worker unavailable'); },
    fetchFn: async () => {
      fallbackCalled = true;
      return { ok: true, status: 200 };
    },
  });
  await assert.rejects(
    fetchFn('http://127.0.0.1:17445/api/status', { method: 'POST' }),
    /loopback-method-rejected/,
  );
  assert.equal(fallbackCalled, false);
});

test('background loopback fallback forces credential-free error-on-redirect fetches', async () => {
  const { createBackgroundLoopbackFetch } = await import('../extension/lib/loopback-cors.mjs');
  const fetchFn = createBackgroundLoopbackFetch({
    sendMessage: async () => { throw new Error('worker unavailable'); },
    fetchFn: async (_url, options) => {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      return { ok: true, status: 200 };
    },
  });
  const response = await fetchFn('http://127.0.0.1:17445/api/status', {
    credentials: 'include',
    redirect: 'follow',
    cache: 'default',
  });
  assert.equal(response.ok, true);
});
