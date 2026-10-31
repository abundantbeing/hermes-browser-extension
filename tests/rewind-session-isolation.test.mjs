import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';
import * as rewind from '../extension/lib/message-rewind.mjs';
import * as recovery from '../extension/lib/rewind-recovery.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
function functionSource(name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness({ rowId = 41 } = {}) {
  const record = { role: 'user', content: 'original A', ...(rowId ? { rowId } : {}) };
  const calls = [];
  const recoveryStorage = new Map();
  const storage = {
    getItem: (key) => recoveryStorage.get(key) ?? null,
    setItem: (key, value) => recoveryStorage.set(key, String(value)),
    removeItem: (key) => recoveryStorage.delete(key),
  };
  const context = vm.createContext({
    ...rewind, settings: { sessionId: 'A' }, sessionLoadRequestId: 1,
    scopeRevision: { current: () => 1, isCurrent: (id) => id === 1 },
    messages: [record, { role: 'assistant', content: 'reply A' }],
    messageDisplayText: (_role, text) => text,
    lastUserRecordIndex: () => 0,
    translateUiText: (text) => text, t: (key) => key,
    addMessage: (...args) => calls.push(['notice', ...args]),
    renderMessagesFromStorage: () => calls.push(['render']),
    askHermes: async (text, attachments, options) => {
      calls.push(['send', context.settings.sessionId, text]);
      options.onSubmitResponse?.({ user_row_id: 42 });
    },
    trimAndSaveMessages: async () => { calls.push(['save', context.settings.sessionId]); },
    fetchDashboardHistoryWithResume: async () => ({ messages: [] }),
    rewindOnSessionAuthority: async () => null,
    resyncAfterAuthorityRewind: async () => { calls.push(['resync', context.settings.sessionId]); },
    safeActiveProfile: () => 'work',
    composerDraftStorage: () => storage,
    saveRewindRecovery: recovery.saveRewindRecovery,
    clearRewindRecovery: recovery.clearRewindRecovery,
    recoveryStorage,
  });
  vm.runInContext(functionSource('submitRewind'), context);
  const switchToB = () => {
    context.settings = { sessionId: 'B' };
    context.sessionLoadRequestId += 1;
    context.messages = [{ role: 'user', content: 'B must survive', rowId: 9 }];
  };
  return { context, record, calls, switchToB };
}

for (const mode of ['edit', 'restore']) {
  test(`${mode}: switching chats during the authority rewind never changes or sends to B`, async () => {
    const { context, record, calls, switchToB } = harness();
    const pending = deferred();
    context.rewindOnSessionAuthority = () => pending.promise;
    const running = context.submitRewind({ record, text: 'edited A', mode });
    switchToB();
    pending.resolve({ status: 'rewound' });
    assert.equal(await running, false);
    assert.equal(context.messages[0].content, 'B must survive');
    assert.deepEqual(calls, []);
  });
}

test('switching chats during row lookup never rewinds or falls back to sending in B', async () => {
  const { context, record, calls, switchToB } = harness({ rowId: null });
  const pending = deferred();
  context.fetchDashboardHistoryWithResume = () => pending.promise;
  context.rewindOnSessionAuthority = async () => { calls.push(['rewind', context.settings.sessionId]); return null; };
  const running = context.submitRewind({ record, text: 'edited A' });
  switchToB();
  pending.resolve({ messages: [] });
  assert.equal(await running, false);
  assert.deepEqual(calls, []);
  assert.equal(context.messages[0].content, 'B must survive');
});

test('leaving and reopening the same chat invalidates an awaited edit', async () => {
  const { context, record, calls } = harness();
  const pending = deferred();
  context.rewindOnSessionAuthority = () => pending.promise;
  const running = context.submitRewind({ record, text: 'edited A' });
  context.sessionLoadRequestId += 2;
  pending.resolve({ status: 'rewound' });
  assert.equal(await running, false);
  assert.deepEqual(calls, []);
});

test('a failed submit finishing after chat switch never restores A into B', async () => {
  const { context, record, switchToB } = harness();
  context.askHermes = async () => { switchToB(); throw new Error('disconnected'); };
  assert.equal(await context.submitRewind({ record, text: 'edited A' }), false);
  assert.equal(context.messages[0].content, 'B must survive');
});

test('an edit that stays in its chat still submits and saves the new row id', async () => {
  const { context, record, calls } = harness();
  assert.equal(await context.submitRewind({ record, text: 'edited A' }), true);
  assert.deepEqual(calls.filter(([kind]) => kind === 'send'), [['send', 'A', 'edited A']]);
  assert.equal(context.messages[0].rowId, 42);
});

test('a profile or gateway change invalidates a rewind even when the session id stays the same', async () => {
  const { context, record, calls } = harness();
  const pending = deferred();
  context.rewindOnSessionAuthority = () => pending.promise;
  const running = context.submitRewind({ record, text: 'edited A' });
  context.scopeRevision.isCurrent = () => false;
  pending.resolve({ status: 'rewound' });
  assert.equal(await running, false);
  assert.deepEqual(calls, []);
});

test('late history after a successful rewind cannot bind row ids into the newly opened chat', async () => {
  const { context, record, calls, switchToB } = harness();
  const pending = deferred();
  context.rewindOnSessionAuthority = async () => ({ status: 'rewound' });
  context.fetchDashboardHistoryWithResume = () => pending.promise;
  const running = context.submitRewind({ record, text: 'edited A' });
  await new Promise((resolve) => setImmediate(resolve));
  const writesBeforeSwitch = calls.length;
  switchToB();
  pending.resolve({ messages: [{ role: 'user', content: 'edited A', row_id: 999 }] });
  assert.equal(await running, false);
  assert.equal(context.messages[0].content, 'B must survive');
  assert.equal(context.messages[0].rowId, 9);
  assert.equal(calls.length, writesBeforeSwitch);
});

test('the authority helper keeps the captured chat instead of the connection mutable binding', async () => {
  const captured = [];
  const context = vm.createContext({
    usesDashboardWsChatTransport: () => true,
    ensureActiveDashboardWsConnection: async () => ({ client: {}, wsStoredSessionId: 'B' }),
    usesAuthorityRewind: () => true,
    capabilityRuntime: { unsupportedMethods: new Set() },
    rewindSessionToMessage: async (options) => { captured.push(options.sessionId); return { status: 'rewound' }; },
  });
  vm.runInContext(functionSource('rewindOnSessionAuthority'), context);
  const result = await context.rewindOnSessionAuthority(41, { sessionId: 'A', isCurrent: () => true });
  assert.equal(result.status, 'rewound');
  assert.deepEqual(captured, ['A']);
});

test('a view changed while obtaining the socket sends no authority rewind', async () => {
  const pending = deferred();
  let current = true;
  let mutations = 0;
  const context = vm.createContext({
    usesDashboardWsChatTransport: () => true,
    ensureActiveDashboardWsConnection: () => pending.promise,
    usesAuthorityRewind: () => true,
    capabilityRuntime: { unsupportedMethods: new Set() },
    rewindSessionToMessage: async () => { mutations += 1; return { status: 'rewound' }; },
  });
  vm.runInContext(functionSource('rewindOnSessionAuthority'), context);
  const running = context.rewindOnSessionAuthority(41, { sessionId: 'A', isCurrent: () => current });
  current = false;
  pending.resolve({ client: {} });
  assert.equal((await running).status, 'not_sent');
  assert.equal(mutations, 0);
});

test('a view changed after canonical resume cannot submit the destructive rewind request', async () => {
  let current = true;
  const sent = [];
  const context = vm.createContext({
    usesDashboardWsChatTransport: () => true,
    ensureActiveDashboardWsConnection: async () => ({ client: { request: async (method) => { sent.push(method); current = false; } } }),
    usesAuthorityRewind: () => true,
    capabilityRuntime: { unsupportedMethods: new Set() },
    rewindSessionToMessage: async ({ request }) => {
      await request('session.resume', { session_id: 'A' });
      return request('session.mutate', { session_id: 'A' });
    },
  });
  vm.runInContext(functionSource('rewindOnSessionAuthority'), context);
  assert.equal((await context.rewindOnSessionAuthority(41, { sessionId: 'A', isCurrent: () => current })).status, 'not_sent');
  assert.deepEqual(sent, ['session.resume']);
});

for (const waitAt of ['history', 'commit']) {
  test(`failure recovery switching during ${waitAt} cannot restore messages or composer into B`, async () => {
    const { context, calls, switchToB } = harness();
    const pending = deferred();
    let current = true;
    context.els = { input: { value: '' } };
    context.persistCurrentComposerDraft = () => calls.push(['draft']);
    context.fetchDashboardHistoryWithResume = () => waitAt === 'history' ? pending.promise : Promise.resolve({ messages: [] });
    context.commitFetchedSessionMessages = () => pending.promise;
    vm.runInContext(functionSource('resyncAfterAuthorityRewind'), context);
    const running = context.resyncAfterAuthorityRewind([{ role: 'user', content: 'A' }], 0, 'edited A', {
      sessionId: 'A', requestId: 1, scopeRevisionId: 1, isCurrent: () => current,
    });
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    switchToB();
    pending.resolve(false);
    await running;
    assert.equal(context.messages[0].content, 'B must survive');
    assert.equal(context.els.input.value, '');
    assert.deepEqual(calls, []);
  });
}
