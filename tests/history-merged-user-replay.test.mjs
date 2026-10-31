import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as history from '../extension/lib/session-history-normalization.mjs';
import { messageDisplayText } from '../extension/lib/common.mjs';
import { sessionToolDisplayMessages } from '../extension/lib/live-session-attach.mjs';
import { preserveAssistantResponseStyles, responsePresentationFromSettings } from '../extension/lib/response-presentation.mjs';
import { preserveUserImageAttachments, extractHistoryMediaAttachments, normalizeUserImageAttachments } from '../extension/lib/image-render.mjs';
import { bindRowIdsFromHistory } from '../extension/lib/message-rewind.mjs';

// Same storage shape as the reported session, with no private conversation data.
const turn = (text, extra = {}) => JSON.stringify({
  protocol: 'hermes.browser.turn.v2',
  human_input: { source: 'composer', text },
  browser_context: { delivery: 'none', ...extra },
  attachment_context: { items: [] },
  source_receipt: { version: 2 },
});
const OLD = turn('Earlier project update.');
const CURRENT = turn('what time is it in argentina');
const user = (content, ts = 100) => ({ role: 'user', content, ts });
const reply = (content = 'Earlier reply.') => ({ role: 'assistant', content });
const reconcile = rows => {
  assert.equal(typeof history.reconcileBrowserUserHistory, 'function');
  return history.reconcileBrowserUserHistory(rows);
};
const shown = rows => rows.map(row => messageDisplayText(row.role, row.content));

test('complete merged Browser turns preserve every human input rather than silently taking the first', () => {
  const merged = `${OLD}\n\n${CURRENT}`;
  assert.equal(history.normalizeHistoryUserMessage(user(merged)).text, 'Earlier project update.\n\nwhat time is it in argentina');
  assert.equal(history.stripProtocolNoise(merged), 'Earlier project update.\n\nwhat time is it in argentina');
});

test('a re-appended merged row cannot resurface an already displayed old message', () => {
  const rows = [user(OLD), reply(), user(CURRENT, 200), user(`${OLD}\n\n${CURRENT}`), reply('Current answer.')];
  const before = structuredClone(rows);
  const projected = reconcile(rows);
  assert.deepEqual(shown(projected), ['Earlier project update.', 'Earlier reply.', 'what time is it in argentina', 'Current answer.']);
  assert.deepEqual(rows, before, 'the server history is never mutated');
  assert.strictEqual(projected[2], rows[2], 'the real new user row keeps its edit/rewind identity');
});

test('a compaction continuation with only the merged row keeps the new question', () => {
  const rows = [user(OLD), reply(), { ...user(`${OLD}\n\n${CURRENT}`), rowId: 30 }, reply('Current answer.')];
  const projected = reconcile(rows);
  assert.equal(projected[2].content, CURRENT);
  assert.equal(projected[2].rowId, 30);
  assert.deepEqual(shown(projected), ['Earlier project update.', 'Earlier reply.', 'what time is it in argentina', 'Current answer.']);
  assert.deepEqual(reconcile(projected), projected, 'history reconciliation is idempotent');
});

test('unseen earlier asks are not discarded from a merged row', () => {
  const rows = [user(`${OLD}\n\n${CURRENT}`), reply('Answer.')];
  assert.strictEqual(reconcile(rows), rows, 'no evidence of replay means no removal');
  assert.equal(messageDisplayText('user', rows[0].content), 'Earlier project update.\n\nwhat time is it in argentina');
});

test('genuine repeated messages and equal-text turns with different context survive', () => {
  const rows = [user(CURRENT), reply('First answer.'), user(CURRENT, 200), reply('Second answer.')];
  assert.strictEqual(reconcile(rows), rows);
  const changed = turn('Earlier project update.', { payload: { changed: true } });
  const different = [user(OLD), reply(), user(`${changed}\n\n${CURRENT}`, 200)];
  assert.strictEqual(reconcile(different), different, 'matching typed text is not proof that the envelope is a replay');
});

test('repeated input inside a merged row remains visible when it has not already been represented', () => {
  const rows = [user(OLD), reply(), user(`${OLD}\n\n${OLD}`)];
  assert.equal(reconcile(rows).at(-1).content, OLD, 'remove only the represented prefix, never the final request');
});

test('an answer boundary prevents deduplication of a later real question', () => {
  const rows = [user(OLD), reply(), user(CURRENT), reply('First answer.'), user(`${OLD}\n\n${CURRENT}`), reply('Second answer.')];
  assert.equal(reconcile(rows).filter(row => row.role === 'user').length, 3);
});

test('nested page content cannot impersonate a second top-level turn', () => {
  const nested = turn('Summarize this page.', { payload: { text: CURRENT } });
  const rows = [user(nested), reply()];
  assert.strictEqual(reconcile(rows), rows);
  assert.equal(messageDisplayText('user', nested), 'Summarize this page.');
});

test('malformed composite and ordinary pasted JSON stay fail-visible', () => {
  const incomplete = `${OLD}\n\n{"protocol":"hermes.browser.turn.v2","human_input":`;
  const rows = [user(OLD), reply(), user(incomplete)];
  assert.strictEqual(reconcile(rows), rows);
  const ordinary = '{"name":"first"}\n\n{"name":"second"}';
  assert.equal(history.stripProtocolNoise(ordinary), ordinary);
});

test('composite parsing preserves each turn\'s attachments and does not read nested page attachments', () => {
  const a = JSON.parse(OLD);
  a.attachment_context.items = [{ kind: 'image', local_path: 'D:/test/first.png', label: 'first.png' }];
  const b = JSON.parse(CURRENT);
  b.attachment_context.items = [{ kind: 'image', local_path: 'D:/test/second.png', label: 'second.png' }];
  const normalized = history.normalizeHistoryUserMessage(user(`${JSON.stringify(a)}\n\n${JSON.stringify(b)}`));
  assert.deepEqual(normalized.attachments.map(item => item.pathRef), ['D:/test/first.png', 'D:/test/second.png']);
});

test('actual side-panel refresh and cached transcript entry points reconcile before rendering', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const commit = source.slice(source.indexOf('async function commitFetchedSessionMessages('), source.indexOf('let completionRevealSequence'));
  const render = source.slice(source.indexOf('function renderMessagesFromStorage()'), source.indexOf('function syncSettingsForm()'));
  assert.match(commit, /reconcileBrowserUserHistory\(/);
  assert.match(render, /messages = reconcileBrowserUserHistory\(messages\)/);
});

test('DOM transcript reconstruction keeps the latest question directly above its tool group and reply', () => {
  const rows = [
    user(OLD), reply(), user(CURRENT, 200), user(`${OLD}\n\n${CURRENT}`),
    { role: 'assistant', content: '', tool_calls: [{ id: 'time-tool', function: { name: 'terminal', arguments: '{"command":"date"}' } }] },
    { role: 'tool', tool_call_id: 'time-tool', content: '13:16' },
    reply('It is 1:16 PM in Argentina.'),
  ];
  const dom = new JSDOM('<!doctype html><div id="messages"></div>');
  try {
    const { document } = dom.window;
    const root = document.querySelector('#messages');
    for (const row of sessionToolDisplayMessages(reconcile(rows))) {
      const node = document.createElement('div');
      node.className = row.toolActivity ? 'tool-group' : `message ${row.role}`;
      node.textContent = row.toolActivity ? row.toolActivity.tool_name : messageDisplayText(row.role, row.content);
      root.append(node);
    }
    assert.deepEqual([...root.children].map(node => node.textContent), [
      'Earlier project update.', 'Earlier reply.', 'what time is it in argentina', 'terminal', 'It is 1:16 PM in Argentina.',
    ]);
    assert.equal(root.querySelectorAll('.message.user').length, 2);
  } finally { dom.window.close(); }
});

test('the real async history commit saves the repaired transcript and rejects a stale session refresh', async () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function commitFetchedSessionMessages('), source.indexOf('let completionRevealSequence'));
  const saved = [];
  const painted = [];
  const deps = {
    reconcileBrowserUserHistory: history.reconcileBrowserUserHistory,
    preserveAssistantResponseStyles, responsePresentationFromSettings,
    preserveUserImageAttachments, extractHistoryMediaAttachments, normalizeUserImageAttachments,
    bindRowIdsFromHistory, messageDisplayText,
    scopeRevision: { current: () => 1, isCurrent: id => id === 1 },
    settings: { sessionId: 'test-session', responseStyle: 'rich' },
    sessionLoadRequestId: 1,
    sessionAssistantStylesBySession: new Map(),
    applySessionRuntimeSnapshot: () => {},
    estimateLocalSessionContextTokens: () => 0,
    browserDisplayMessages: rows => rows,
    saveMessagesForActiveScope: () => saved.push(true),
    hydrateSessionMedia: async () => {},
    renderMessagesFromStorage: () => painted.push(true),
    noteLongSharedSessionIfDue: () => {},
  };
  // Only I/O and UI side effects are stubbed; reconciliation, attachment/style
  // preservation and durable-row binding execute their production code.
  // eslint-disable-next-line no-new-func
  const build = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps;
    let messages = [], pendingSteerText = '', loadedSessionContextEstimate = null;
    ${body}
    return { commitFetchedSessionMessages, messages: () => messages };
  `);
  const panel = build(deps);
  const rows = [user(OLD), reply(), user(CURRENT, 200), user(`${OLD}\n\n${CURRENT}`), reply('Current answer.')];
  assert.equal(await panel.commitFetchedSessionMessages({ messages: rows, contextMessages: rows }, { sessionId: 'test-session' }), true);
  assert.deepEqual(shown(panel.messages()), ['Earlier project update.', 'Earlier reply.', 'what time is it in argentina', 'Current answer.']);
  assert.equal(saved.length, 1);
  assert.equal(painted.length, 1);
  const committed = panel.messages();
  assert.equal(await panel.commitFetchedSessionMessages({ messages: [user('Wrong session.')] }, { sessionId: 'other-session' }), false);
  assert.strictEqual(panel.messages(), committed);
  assert.equal(saved.length, 1);
});
