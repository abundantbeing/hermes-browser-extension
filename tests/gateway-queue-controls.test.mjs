// Cancel and Edit for the turns a session-authority gateway holds in its queue: prompt.cancel and
// prompt.replace_queued on the row the gateway listed, with Discard's refusal handling. Shapes follow
// gateway/session_controls.py (cancel) and gateway/session_queued_controls.py (replace_queued).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import english from '../extension/lib/locales/en.mjs';
import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';
import {
  MAX_EDITABLE_TEXT,
  cancelQueuedTurnRequest,
  classifyQueuedRefusal,
  createGatewayQueueStore,
  normalizePendingRows,
  queuedTurnEditable,
  replaceQueuedTurnRequest,
} from '../extension/lib/gateway-queue.mjs';

const SID = '20260415_093000_ab12cd';
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function wire(overrides = {}) {
  return {
    admission_id: 'adm-1',
    ref: { profile_id: 'default', session_id: SID },
    sequence: 1,
    status: 'queued',
    execution_generation: null,
    text: 'first  line\nsecond line',
    controls: ['steer', 'replace'],
    ...overrides,
  };
}

const [queued] = normalizePendingRows([wire()]);

test('a row keeps the gateway\'s controls and its exact text, and a transfer is marked', () => {
  assert.deepEqual([...queued.controls], ['steer', 'replace']);
  assert.equal(queued.fullText, 'first  line\nsecond line', 'the exact text, not the collapsed one');
  assert.equal(queued.text, 'first line second line');
  assert.equal(queued.inTransfer, false);
  const [moving] = normalizePendingRows([wire({ admission_id: 'moving', status: 'started', steering: true })]);
  assert.equal(moving.status, 'queued');
  assert.equal(moving.inTransfer, true);
  // An older owner lists no controls; a long text is shown but never held for editing.
  const [older] = normalizePendingRows([wire({ controls: undefined })]);
  assert.deepEqual([...older.controls], []);
  const [long] = normalizePendingRows([wire({ text: 'x'.repeat(MAX_EDITABLE_TEXT + 1) })]);
  assert.equal(long.fullText, '');
  assert.ok(long.text.length <= 600);
});

test('Cancel is offered for a plain waiting turn only, and never for one in transfer to the running turn', () => {
  assert.deepEqual(cancelQueuedTurnRequest(queued, SID), {
    method: 'prompt.cancel',
    params: { session_id: SID, admission_id: 'adm-1' },
  });
  const [moving] = normalizePendingRows([wire({ status: 'started', steering: true })]);
  assert.equal(cancelQueuedTurnRequest(moving, SID), null, 'the gateway would stop the running turn');
  const [lost] = normalizePendingRows([wire({ status: 'unknown', execution_generation: 4 })]);
  assert.equal(cancelQueuedTurnRequest(lost, SID), null, 'a lost turn is discarded, not cancelled');
  assert.equal(cancelQueuedTurnRequest(null, SID), null);
  assert.equal(cancelQueuedTurnRequest({ ...queued, sessionId: '' }, ''), null, 'no session, no request');
});

test('Edit needs the gateway to offer replace for that row and the whole text, and sends exactly the verb\'s params', () => {
  assert.equal(queuedTurnEditable(queued), true);
  assert.equal(queuedTurnEditable(normalizePendingRows([wire({ controls: ['steer'] })])[0]), false);
  assert.equal(queuedTurnEditable(normalizePendingRows([wire({ controls: undefined })])[0]), false);
  assert.equal(queuedTurnEditable(normalizePendingRows([wire({ text: 'x'.repeat(MAX_EDITABLE_TEXT + 1) })])[0]), false);
  assert.equal(queuedTurnEditable(normalizePendingRows([wire({ status: 'started', steering: true })])[0]), false);
  assert.deepEqual(replaceQueuedTurnRequest(queued, 'new text', { sessionId: SID, submissionId: 'abc123' }), {
    method: 'prompt.replace_queued',
    params: { session_id: SID, admission_id: 'adm-1', submission_id: 'abc123', text: 'new text' },
  });
  // Nothing is sent for an empty, unchanged or oversized edit, or without a submission id.
  const options = { sessionId: SID, submissionId: 'abc123' };
  assert.equal(replaceQueuedTurnRequest(queued, '   ', options), null);
  assert.equal(replaceQueuedTurnRequest(queued, queued.fullText, options), null);
  assert.equal(replaceQueuedTurnRequest(queued, 'x'.repeat(MAX_EDITABLE_TEXT + 1), options), null);
  assert.equal(replaceQueuedTurnRequest(queued, 'new', { sessionId: SID }), null);
  assert.equal(replaceQueuedTurnRequest(queued, 'new', { submissionId: 'abc123' }) !== null, true, 'the row names its own session');
});

test('refusals read as settled, unsupported or failed, the way Discard\'s do', () => {
  for (const reason of ['stale_generation', 'not_found', 'admission_conflict', 'admission_started']) {
    assert.equal(classifyQueuedRefusal({ data: { reason } }), 'settled', reason);
  }
  assert.equal(classifyQueuedRefusal({ reason: 'stale_generation' }), 'settled');
  assert.equal(classifyQueuedRefusal({ data: { reason: 'unsupported_control' } }), 'unsupported');
  assert.equal(classifyQueuedRefusal({ code: -32601 }), 'unsupported');
  assert.equal(classifyQueuedRefusal(new Error('socket closed')), 'failed');
  assert.equal(classifyQueuedRefusal(null), 'failed');
});

test('dropping a row keeps every other row exactly as held, including edit text and controls', () => {
  const changes = [];
  const store = createGatewayQueueStore({ onChange: (id) => changes.push(id) });
  store.ingestResume({ stored_session_id: SID, pending: [wire({ admission_id: 'a', sequence: 1 }), wire({ admission_id: 'b', sequence: 2, text: 'keep   me\nexact' })] });
  changes.length = 0;
  assert.equal(store.drop(SID, 'a'), true);
  assert.equal(store.drop(SID, 'a'), false, 'a row that is gone is not dropped twice');
  const [kept] = store.forSession(SID);
  assert.equal(kept.admissionId, 'b');
  assert.equal(kept.fullText, 'keep   me\nexact');
  assert.deepEqual([...kept.controls], ['steer', 'replace']);
  assert.deepEqual(changes, [SID]);
  assert.equal(store.drop(SID, 'b'), true);
  assert.equal(store.forSession(SID).length, 0);
});

// ---- The panel's controls, run from the real source with stubbed externals --------------------

function sliceBetween(start, end) {
  const from = panel.indexOf(start);
  const to = panel.indexOf(end, from);
  assert.ok(from > 0 && to > from, `${start}`);
  return panel.slice(from, to);
}

async function loadControls(env) {
  const source = sliceBetween('function appendQueuedRowControls(', 'async function discardLostGatewayTurn(')
    .replace(/\bactiveDashboardWsConnection\b/g, 'env.connection');
  const code = `export default function make(env) {
    const { settings, document, lib } = env;
    const { cancelQueuedTurnRequest, classifyQueuedRefusal, queuedTurnEditable, replaceQueuedTurnRequest } = lib;
    const gatewayQueueStores = env.stores;
    let gatewayQueueEdit = env.edit;
    const t = (key, params) => key + (params ? JSON.stringify(params) : '');
    const els = env.els;
    const setStatus = (...args) => env.statuses.push(args);
    const renderGatewayQueue = () => { env.renders += 1; };
    ${source}
    return {
      appendQueuedRowControls, cancelQueuedGatewayTurn, startQueuedTurnEdit, saveQueuedTurnEdit, endQueuedTurnEdit,
      edit: () => gatewayQueueEdit,
      setDraft: (text) => { gatewayQueueEdit.draft = text; },
    };
  }`;
  const { default: make } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return make(env);
}

function harness({ rows = [wire()], failWith = null } = {}) {
  const { document } = parseHTML('<body><section id="gatewayQueueNotice"></section></body>');
  const requests = [];
  const client = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (failWith) throw failWith;
      return { status: 'ok' };
    },
  };
  const stores = new WeakMap();
  const store = createGatewayQueueStore();
  store.ingestResume({ stored_session_id: SID, pending: rows });
  stores.set(client, store);
  const env = {
    settings: { sessionId: SID },
    connection: { client, wsStoredSessionId: SID },
    document,
    stores,
    edit: null,
    renders: 0,
    statuses: [],
    els: { gatewayQueueNotice: document.getElementById('gatewayQueueNotice') },
    lib: { cancelQueuedTurnRequest, classifyQueuedRefusal, queuedTurnEditable, replaceQueuedTurnRequest },
  };
  globalThis.document = document;
  return { env, requests, store };
}

test('the row controls draw Edit and Cancel for an editable turn, Cancel alone otherwise, and nothing for a transfer', async () => {
  const draw = async (row) => {
    const { env } = harness();
    const controls = await loadControls(env);
    const [normalized] = normalizePendingRows([row]);
    const box = env.document.createElement('div');
    controls.appendQueuedRowControls(box, normalized, SID);
    return [...box.querySelectorAll('button')].map((button) => button.textContent);
  };
  assert.deepEqual(await draw(wire()), ['gateway_queue.edit', 'gateway_queue.cancel']);
  assert.deepEqual(await draw(wire({ controls: ['steer'] })), ['gateway_queue.cancel']);
  assert.deepEqual(await draw(wire({ controls: undefined })), ['gateway_queue.cancel']);
  assert.deepEqual(await draw(wire({ status: 'started', steering: true })), []);
});

test('Cancel sends prompt.cancel for the viewed session\'s row and drops it only once the gateway accepted', async () => {
  const { env, requests, store } = harness();
  const controls = await loadControls(env);
  await controls.cancelQueuedGatewayTurn('adm-1');
  assert.deepEqual(requests, [{ method: 'prompt.cancel', params: { session_id: SID, admission_id: 'adm-1' } }]);
  assert.equal(store.forSession(SID).length, 0);
  // A row that is not in this session's store is never sent.
  const other = harness({ rows: [] });
  const otherControls = await loadControls(other.env);
  await otherControls.cancelQueuedGatewayTurn('adm-1');
  assert.equal(other.requests.length, 0);
});

test('a refused Cancel keeps the row and says why; one the gateway already settled leaves quietly', async () => {
  const failed = harness({ failWith: new Error('owner busy') });
  const failedControls = await loadControls(failed.env);
  await failedControls.cancelQueuedGatewayTurn('adm-1');
  assert.equal(failed.store.forSession(SID).length, 1);
  assert.equal(failed.env.statuses.length, 1);
  assert.match(String(failed.env.statuses[0][2]), /gateway_queue\.cancel_failed.*owner busy/);

  const settled = harness({ failWith: Object.assign(new Error('gone'), { data: { reason: 'admission_started' } }) });
  const settledControls = await loadControls(settled.env);
  await settledControls.cancelQueuedGatewayTurn('adm-1');
  assert.equal(settled.store.forSession(SID).length, 0);
  assert.equal(settled.env.statuses.length, 0, 'no warning for a turn that already ran');

  const missing = harness({ failWith: Object.assign(new Error('Method not found'), { code: -32601 }) });
  const missingControls = await loadControls(missing.env);
  await missingControls.cancelQueuedGatewayTurn('adm-1');
  assert.equal(missing.store.forSession(SID).length, 1);
  assert.match(String(missing.env.statuses[0][2]), /gateway_queue\.unsupported/);
});

test('Edit starts from the exact text, sends one replace with one submission id, and retires the old row', async () => {
  const { env, requests, store } = harness();
  const controls = await loadControls(env);
  controls.startQueuedTurnEdit('adm-1');
  assert.equal(controls.edit().draft, 'first  line\nsecond line');
  assert.equal(env.renders, 1);
  controls.setDraft('rewritten message');
  await controls.saveQueuedTurnEdit('adm-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'prompt.replace_queued');
  assert.deepEqual(Object.keys(requests[0].params).sort(), ['admission_id', 'session_id', 'submission_id', 'text']);
  assert.equal(requests[0].params.text, 'rewritten message');
  assert.match(requests[0].params.submission_id, /^[0-9a-f]{32}$/);
  assert.equal(store.forSession(SID).length, 0);
  assert.equal(controls.edit(), null);
});

test('a failed Edit keeps the typed text and retries the same submission id; an unchanged or empty edit sends nothing', async () => {
  const failing = harness({ failWith: new Error('timeout') });
  const controls = await loadControls(failing.env);
  controls.startQueuedTurnEdit('adm-1');
  controls.setDraft('rewritten');
  await controls.saveQueuedTurnEdit('adm-1');
  assert.equal(controls.edit().draft, 'rewritten', 'the draft survives a failure');
  assert.equal(controls.edit().busy, false);
  await controls.saveQueuedTurnEdit('adm-1');
  assert.equal(failing.requests.length, 2);
  assert.equal(failing.requests[0].params.submission_id, failing.requests[1].params.submission_id, 'an exact retry of the same edit');
  assert.match(String(failing.env.statuses[0][2]), /gateway_queue\.edit_failed.*timeout/);

  const quiet = harness();
  const quietControls = await loadControls(quiet.env);
  quietControls.startQueuedTurnEdit('adm-1');
  await quietControls.saveQueuedTurnEdit('adm-1');
  assert.equal(quiet.requests.length, 0, 'unchanged');
  assert.equal(quietControls.edit(), null);
  quietControls.startQueuedTurnEdit('adm-1');
  quietControls.setDraft('   ');
  await quietControls.saveQueuedTurnEdit('adm-1');
  assert.equal(quiet.requests.length, 0, 'empty');
});

test('a row that cannot be edited never starts an edit', async () => {
  const { env } = harness({ rows: [wire({ controls: ['steer'] })] });
  const controls = await loadControls(env);
  controls.startQueuedTurnEdit('adm-1');
  assert.equal(controls.edit(), null);
});

test('the panel wires the controls through one delegated listener and keeps an edit across queue updates', () => {
  const render = sliceBetween('function renderGatewayQueue(', 'function appendQueuedRowControls(');
  for (const attribute of ['gatewayDiscard', 'gatewayCancel', 'gatewayEdit', 'gatewaySave', 'gatewayEditDiscard']) {
    assert.match(render, new RegExp(`target\\.dataset\\.${attribute}`));
  }
  assert.match(render, /textarea\[data-gateway-edit-text\]/);
  assert.match(render, /gatewayQueueEdit = null;\s*node\.hidden = true;/, 'an edit ends with its queue');
  // Cancel and Edit never resend, and the mirror still wires first.
  const controls = sliceBetween('function appendQueuedRowControls(', 'async function discardLostGatewayTurn(');
  assert.doesNotMatch(controls, /prompt\.submit|askHermes|sendPrompt|streamSessionChat/);
  assert.match(panel, /gatewayClient\.on\('session\.replay\.truncated', onReplayTruncated\);\s*mirrorGatewayQueue\(gatewayClient\);/);
});

test('every queue-control string exists in every locale with its placeholders', async () => {
  const keys = ['gateway_queue.cancel', 'gateway_queue.edit', 'gateway_queue.save', 'gateway_queue.edit_discard', 'gateway_queue.edit_label', 'gateway_queue.unsupported', 'gateway_queue.cancel_failed', 'gateway_queue.edit_failed'];
  for (const locale of SUPPORTED_LOCALES) {
    const messages = await loadLocaleMessages(locale.id);
    for (const key of keys) {
      assert.ok(String(messages[key] ?? '').trim(), `${locale.id} has ${key}`);
      const wanted = [...english[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const have = [...String(messages[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(have, wanted, `${locale.id} ${key}`);
    }
  }
});
