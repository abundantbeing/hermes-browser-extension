// The turn queue a session-authority gateway owns is mirrored read-only: queued
// turns are shown, and a turn lost in a restart offers Discard. Shapes follow
// tui_gateway/contracts/canonical*.py (pending rows, prompt.resolve_unknown).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createGatewayQueueStore,
  discardLostTurnRequest,
  gatewayQueueView,
  isLostTurnAlreadyResolved,
  normalizePendingRows,
  observeSessionResume,
} from '../extension/lib/gateway-queue.mjs';

const SID = '20260415_093000_ab12cd';

function row(overrides = {}) {
  return {
    admission_id: 'adm-1',
    ref: { profile_id: 'default', session_id: SID },
    sequence: 1,
    status: 'queued',
    outcome: null,
    authority_epoch: 3,
    execution_generation: null,
    input_id: 'in-1',
    text: 'hello',
    ...overrides,
  };
}

test('only queued, steering and lost rows are shown; the running turn and settled ones are not', () => {
  const rows = normalizePendingRows([
    row({ admission_id: 'run', status: 'started', sequence: 1 }),
    row({ admission_id: 'steer', status: 'started', steering: true, sequence: 2 }),
    row({ admission_id: 'q', status: 'queued', sequence: 4 }),
    row({ admission_id: 'lost', status: 'unknown', execution_generation: 4, sequence: 3 }),
    row({ admission_id: 'done', status: 'terminal', outcome: 'completed', sequence: 5 }),
    { nope: true },
    null,
  ]);
  assert.deepEqual(rows.map((item) => [item.admissionId, item.status]), [
    ['steer', 'queued'], ['lost', 'unknown'], ['q', 'queued'],
  ]);
  const view = gatewayQueueView(rows);
  assert.equal(view.lost.length, 1);
  assert.equal(view.queued.length, 2);
  assert.equal(normalizePendingRows('x').length, 0);
});

test('Discard is prompt.resolve_unknown with the generation stamped on the lost row', () => {
  const [lost] = normalizePendingRows([row({ admission_id: 'lost', status: 'unknown', execution_generation: 4 })]);
  assert.deepEqual(discardLostTurnRequest(lost), {
    method: 'prompt.resolve_unknown',
    params: { session_id: SID, admission_id: 'lost', execution_generation: 4 },
  });
});

test('only a lost row with a known generation can be discarded', () => {
  const [queued] = normalizePendingRows([row({ status: 'queued' })]);
  assert.equal(discardLostTurnRequest(queued), null);
  const [noGeneration] = normalizePendingRows([row({ status: 'unknown', execution_generation: null })]);
  assert.equal(discardLostTurnRequest(noGeneration), null);
  assert.equal(discardLostTurnRequest(undefined), null);
});

test('a stale or already-settled refusal retires the row quietly; other refusals do not', () => {
  assert.equal(isLostTurnAlreadyResolved({ data: { reason: 'stale_generation' } }), true);
  assert.equal(isLostTurnAlreadyResolved({ data: { reason: 'not_found' } }), true);
  assert.equal(isLostTurnAlreadyResolved({ data: { reason: 'permission_denied' } }), false);
  assert.equal(isLostTurnAlreadyResolved(new Error('socket closed')), false);
});

test('a resume snapshot and later session.info events keep the store current, per session', () => {
  const changes = [];
  const store = createGatewayQueueStore({ onChange: (id) => changes.push(id) });
  assert.equal(store.ingestResume({ session_id: SID, stored_session_id: SID, pending: [row({ status: 'unknown', execution_generation: 2 })] }), true);
  assert.equal(store.forSession(SID).length, 1);
  assert.equal(store.ingestResume({ session_id: SID, stored_session_id: SID, pending: [row({ status: 'unknown', execution_generation: 2 })] }), false, 'an unchanged list is not a change');

  store.ingestEvent({ type: 'session.info', sessionId: SID, payload: { stored_session_id: SID, pending: [row({ admission_id: 'adm-2', sequence: 2 })] } });
  assert.deepEqual(store.forSession(SID).map((item) => item.admissionId), ['adm-2']);

  store.ingestEvent({ type: 'session.info', sessionId: SID, payload: { stored_session_id: SID, pending: [] } });
  assert.equal(store.forSession(SID).length, 0);
  assert.deepEqual(changes, [SID, SID, SID]);

  assert.equal(store.ingestEvent({ type: 'session.info', sessionId: SID, payload: { title: 'x' } }), false, 'an event with no pending list changes nothing');
  assert.equal(store.ingestResume({ session_id: SID }), false, 'a resume from a gateway with no queue changes nothing');
});

test('drop removes one confirmed row and clear forgets a closed connection', () => {
  const store = createGatewayQueueStore();
  store.ingestResume({ stored_session_id: SID, pending: [
    row({ admission_id: 'lost', status: 'unknown', execution_generation: 4, sequence: 1 }),
    row({ admission_id: 'q', sequence: 2 }),
  ] });
  store.drop(SID, 'lost');
  assert.deepEqual(store.forSession(SID).map((item) => item.admissionId), ['q']);
  assert.equal(store.forSession(SID)[0].status, 'queued');
  store.clear();
  assert.equal(store.forSession(SID).length, 0);
});

test('observeSessionResume feeds the store from every resume and leaves other calls alone', async () => {
  const seen = [];
  const client = { request: async (method) => (method === 'session.resume' ? { stored_session_id: SID, pending: [row()] } : { ok: method }) };
  observeSessionResume(client, (result) => seen.push(result));
  assert.deepEqual(await client.request('prompt.submit', {}), { ok: 'prompt.submit' });
  assert.equal(seen.length, 0);
  const resumed = await client.request('session.resume', { session_id: SID });
  assert.equal(resumed.stored_session_id, SID);
  assert.equal(seen.length, 1);
  observeSessionResume(client, () => seen.push('again'));
  await client.request('session.resume', {});
  assert.equal(seen.length, 2, 'a client is only wrapped once');
});

test('a failing observer never breaks the resume', async () => {
  const client = { request: async () => ({ pending: [] }) };
  observeSessionResume(client, () => { throw new Error('render failed'); });
  assert.deepEqual(await client.request('session.resume', {}), { pending: [] });
});

test('the panel wires the mirror into every chat connection and never resends from it', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /gatewayClient\.on\('session\.replay\.truncated', onReplayTruncated\);\s*mirrorGatewayQueue\(gatewayClient\);/);
  const mirror = source.slice(source.indexOf('function mirrorGatewayQueue'), source.indexOf('function renderGatewayQueue'));
  assert.match(mirror, /observeSessionResume\(client/);
  assert.match(mirror, /client\.on\('session\.info'/);
  assert.match(mirror, /client\.on\('close'/);
  const discard = source.slice(source.indexOf('async function discardLostGatewayTurn'), source.indexOf('// Reads GET /v1/runs/{id} while a REST run is quiet'));
  assert.match(discard, /discardLostTurnRequest\(row, sessionId\)/);
  assert.doesNotMatch(discard, /prompt\.submit|askHermes|sendPrompt|streamSessionChat/);
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /id="gatewayQueueNotice"/);
});
