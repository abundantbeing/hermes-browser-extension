import assert from 'node:assert/strict';
import test from 'node:test';

import { createBotGroupRuntime } from '../extension/lib/bot-group-runtime.mjs';
import { prepareTabScreenshotAttachment, resolveBotBrowserContext } from '../extension/lib/bot-browser-bridge.mjs';

const NOW = 1_800_000_000_000;
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const BCP_PROTOCOL = 'hermes.browser.turn.v2';

async function waitUntil(predicate, { tries = 200, delayMs = 2 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function makeClient(options = {}) {
  const listeners = new Map();
  const calls = [];
  const prompts = [];
  const promptGone = new Set(options.promptGoneOnce || []);
  let gate = null;
  let release = () => {};
  if (options.holdPrompt) gate = new Promise((resolve) => { release = resolve; });
  const emit = (type, event) => { for (const handler of listeners.get(type) || []) handler(event); };
  const client = {
    calls,
    prompts,
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.list') return { sessions: [{ id: `stored-${params.profile}`, title: params.title }] };
      if (method === 'session.resume') {
        return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
      }
      if (method === 'session.create') {
        return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
      }
      if (method === 'image.attach_bytes') {
        if (options.attachThrows) throw new Error(options.attachThrows);
        if (typeof options.attachFor === 'function') return options.attachFor(params);
        return { attached: true, path: `staged-${params.session_id}-${params.filename}`, count: 1 };
      }
      if (method === 'image.detach') {
        if (options.detachThrows) throw new Error('detach failed');
        return { detached: true, count: 0 };
      }
      if (method === 'session.interrupt') return { ok: true };
      if (method === 'prompt.submit') {
        prompts.push(params.text);
        if (gate) await gate;
        if (promptGone.has(params.session_id)) {
          promptGone.delete(params.session_id);
          const error = new Error('session not found');
          error.code = 4001;
          error.rpcCode = 4001;
          throw error;
        }
        if (options.failFor && options.failFor(params)) throw new Error('member exploded');
        const reply = options.replyFor ? options.replyFor(params) : `${params.session_id} reply`;
        queueMicrotask(() => emit('message.complete', { sessionId: params.session_id, payload: { text: reply } }));
        return { accepted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return { client, calls, prompts, release };
}

function browserContext(overrides = {}) {
  return resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 101, url: 'https://example.com/offer', title: 'Current Offer' },
    pageContext: { text: 'The spring offer is 20 percent off.' },
    ...overrides,
  });
}

function methods(calls) {
  return calls.map(({ method }) => method);
}

function isEnvelope(text) {
  try {
    return JSON.parse(text)?.protocol === BCP_PROTOCOL;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Append context to every addressed member prompt, never persist it
// ---------------------------------------------------------------------------

test('send appends the same turn browser context to ALL addressed member prompts', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });

  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: '@everyone check this',
    browserContext: browserContext(),
  });

  assert.equal(prompts.length, 2);
  assert.equal(prompts.every(isEnvelope), true, 'every member prompt is a BCP v2 envelope');
  const urls = prompts.map((text) => JSON.parse(text).browser_context.payload.activeTab.url);
  assert.deepEqual(urls, ['https://example.com/offer', 'https://example.com/offer']);
});

test('send never persists browser context into the shared messages or the synced projection', async () => {
  const { client } = makeClient();
  const persisted = [];
  const visible = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    onMessage: (message, meta) => visible.push({ message, meta }),
    persist: async (messages, meta) => { persisted.push({ messages, meta }); },
  });

  const result = await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: 'check this',
    browserContext: browserContext(),
  });

  const serialized = JSON.stringify({ visible, persisted, result });
  assert.equal(serialized.includes(BCP_PROTOCOL), false, 'the envelope never enters the room record');
  assert.equal(result.messages.some((message) => String(message.content).includes(BCP_PROTOCOL)), false);
});

test('send with a disabled context submits the plain group prompt', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: 'plain turn',
    browserContext: browserContext({ scopeMode: 'chat-only' }),
  });
  assert.equal(prompts.every((text) => text.includes('[Group chat: "Room"]')), true);
  assert.equal(prompts.every((text) => text.includes(BCP_PROTOCOL)), false);
});

test('send with no browserContext never captures a page', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  assert.equal(methods(client.calls).includes('image.attach_bytes'), false);
  assert.equal(prompts.every((text) => text.includes(BCP_PROTOCOL)), false);
});

// ---------------------------------------------------------------------------
// Screenshots: explicit per-turn intent, attach before submit, detach on error
// ---------------------------------------------------------------------------

test('send attaches a screenshot on each member session before prompt.submit', async () => {
  const { client, calls } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const shot = prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101 });

  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: 'hi',
    screenshotAttachments: [shot],
  });

  const attaches = calls.filter(({ method }) => method === 'image.attach_bytes');
  assert.deepEqual(attaches.map(({ params }) => params.session_id), ['live-alpha', 'live-beta']);
  for (const sessionId of ['live-alpha', 'live-beta']) {
    const attachIndex = calls.findIndex(({ method, params }) => method === 'image.attach_bytes' && params.session_id === sessionId);
    const submitIndex = calls.findIndex(({ method, params }) => method === 'prompt.submit' && params.session_id === sessionId);
    assert.ok(attachIndex > -1 && attachIndex < submitIndex, `${sessionId} attaches before submit`);
  }
});

test('screenshots are attached on EVERY attempt, after the model hook and before submit', async () => {
  const { client, calls, prompts } = makeClient({ promptGoneOnce: ['live-alpha'] });
  const order = [];
  const runtime = createBotGroupRuntime({
    client,
    timeoutMs: 1000,
    beforeMemberTurn: async (member, session) => { order.push(`hook:${session.liveId}`); },
  });
  const original = client.request;
  client.request = async (method, params) => {
    if (method === 'image.attach_bytes') order.push(`attach:${params.session_id}`);
    if (method === 'prompt.submit') order.push(`submit:${params.session_id}`);
    return original(method, params);
  };

  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: '@alpha hi',
    screenshotAttachments: [prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101 })],
  });

  assert.deepEqual(order, [
    'hook:live-alpha',
    'attach:live-alpha',
    'submit:live-alpha',
    'hook:live-alpha',
    'attach:live-alpha',
    'submit:live-alpha',
  ]);
  assert.equal(prompts.length, 2, 'the rebound attempt submits as well');
  assert.equal(methods(calls).includes('image.attach_bytes'), true);
});

test('an attach rejection fails the member without a text-only downgrade', async () => {
  const { client, prompts, calls } = makeClient({
    attachFor: (params) => (params.filename === 'browser-tab-1.png'
      ? { attached: true, path: 'staged-partial' }
      : { attached: false }),
  });
  const activity = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onActivity: (event) => activity.push(event) });
  const good = prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 1, filename: 'browser-tab-1.png' });
  const bad = prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 2, filename: 'browser-tab-2.png' });

  const result = await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: '@alpha hi',
    screenshotAttachments: [good, bad],
  });

  assert.equal(prompts.length, 0, 'no prompt.submit on a failed attach');
  const failed = activity.find((event) => event.kind === 'failed');
  assert.equal(failed.member, 'alpha');
  assert.equal(result.failures.length, 1);
  const detaches = calls.filter(({ method }) => method === 'image.detach');
  assert.deepEqual(detaches.map(({ params }) => params.path), ['staged-partial'], 'the partial attach is rolled back');
});

test('a prompt.submit rejection after staging detaches the staged image', async () => {
  const { client, calls } = makeClient({ failFor: (params) => params.session_id === 'live-alpha' });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: '@alpha hi',
    screenshotAttachments: [prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101 })],
  });
  const detaches = calls.filter(({ method }) => method === 'image.detach');
  assert.equal(detaches.length, 1);
  assert.equal(detaches[0].params.path, 'staged-live-alpha-browser-tab-101.png');
  assert.equal(detaches[0].params.session_id, 'live-alpha');
});

test('an aborted turn detaches the staged screenshot', async () => {
  const { client, calls, release } = makeClient({ holdPrompt: true });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 5000 });
  const controller = new AbortController();
  const pending = runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: 'hi',
    signal: controller.signal,
    screenshotAttachments: [prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101 })],
  });
  assert.equal(await waitUntil(() => client.calls.some(({ method }) => method === 'prompt.submit')), true);
  controller.abort();
  release();
  await pending;
  const detaches = calls.filter(({ method }) => method === 'image.detach');
  assert.ok(detaches.length >= 1, 'the staged image is detached on cancel');
  assert.equal(detaches[0].params.path, 'staged-live-alpha-browser-tab-101.png');
});

// ---------------------------------------------------------------------------
// Retry reuses the exact cached turn context (runtime-only)
// ---------------------------------------------------------------------------

test('retryMember reuses the cached turn browser context without re-capturing a page', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    text: 'hi',
    browserContext: browserContext(),
  });
  prompts.length = 0;

  await runtime.retryMember({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    messages: [{ role: 'user', content: 'hi', ts: NOW }],
    member: 'alpha',
  });

  assert.equal(prompts.length, 1);
  assert.equal(isEnvelope(prompts[0]), true, 'the retry re-uses the exact cached envelope');
  assert.equal(JSON.parse(prompts[0]).browser_context.payload.activeTab.url, 'https://example.com/offer');
});

test('retryMember reuses the cached screenshots', async () => {
  const { client, calls } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const shot = prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101 });
  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi', screenshotAttachments: [shot] });
  calls.length = 0;

  await runtime.retryMember({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    messages: [{ role: 'user', content: 'hi', ts: NOW }],
    member: 'beta',
  });

  const attaches = calls.filter(({ method }) => method === 'image.attach_bytes');
  assert.deepEqual(attaches.map(({ params }) => params.session_id), ['live-beta']);
  assert.equal(attaches[0].params.content_base64, PNG_DATA_URL);
});

test('retryMember with no cached context never invents one', async () => {
  const { client, prompts } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  await runtime.send({ roomId: 'room', groupName: 'Room', members: ['alpha', 'beta'], text: 'hi' });
  prompts.length = 0;
  await runtime.retryMember({
    roomId: 'room',
    groupName: 'Room',
    members: ['alpha', 'beta'],
    messages: [{ role: 'user', content: 'hi', ts: NOW }],
    member: 'alpha',
  });
  assert.equal(isEnvelope(prompts[0]), false);
  assert.equal(methods(client.calls).includes('image.attach_bytes'), false);
});

test('abort while image attach is pending cannot submit a late prompt', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { client, calls } = makeClient({ attachFor: async () => { await held; return { attached: true, path: 'late-staged.png' }; } });
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = runtime.send({ roomId: 'room', members: ['alpha', 'beta'], text: '@alpha inspect', signal: controller.signal,
    screenshotAttachments: [prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101 })] });
  assert.equal(await waitUntil(() => calls.some((call) => call.method === 'image.attach_bytes')), true);
  controller.abort();
  await pending;
  release();
  await waitUntil(() => calls.some((call) => call.method === 'image.detach'));
  assert.equal(calls.some((call) => call.method === 'prompt.submit'), false);
  assert.ok(calls.some((call) => call.method === 'image.detach' && call.params.path === 'late-staged.png'));
});