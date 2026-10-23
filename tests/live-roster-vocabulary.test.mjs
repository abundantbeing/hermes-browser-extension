// The live roster's vocabulary and its resilience: what counts as a live session, and what one failed
// poll may do to the badges already shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  readIdleRowSubagents, rosterAfterFailure, sessionIsLiveFromStatus, sessionLiveRoster,
} from '../extension/lib/live-session-attach.mjs';
import { liveStateFromSessionRow } from '../extension/lib/session-live-state.mjs';

test('"starting" (admitted, agent not started: both gateways emit it) is a live session', () => {
  const state = liveStateFromSessionRow({ status: 'starting' });
  assert.equal(state.live, true);
  assert.equal(state.state, 'running');
  assert.equal(state.label, 'Starting');
  const rows = sessionLiveRoster({ sessions: [{ id: 'live-1', session_key: 'A', status: 'starting' }] }, ['A']);
  assert.equal(rows.get('A').live, true);
  assert.equal(sessionIsLiveFromStatus({ status: 'starting' }), true);
});

test('an idle row whose subagents still run is live, and says so', () => {
  const payload = { sessions: [
    { id: 'live-A', session_key: 'A', status: 'idle' },
    { id: 'live-B', session_key: 'B', status: 'idle' },
    { id: 'live-C', session_key: 'C', status: 'working' },
  ] };
  const rows = sessionLiveRoster(payload, ['A', 'B', 'C'], {
    subagentRosters: new Map([
      ['A', [{ id: 's1', status: 'running' }]],
      ['B', [{ id: 's2', status: 'completed' }]],
      ['C', [{ id: 's3', status: 'running' }]],
    ]),
  });
  assert.equal(rows.get('A').live, true);
  assert.equal(rows.get('A').state, 'running');
  assert.equal(rows.get('A').label, 'Subagents running');
  assert.equal(rows.get('A').hasSubagents, true);
  assert.equal(rows.get('A').liveId, 'live-A');
  assert.equal(rows.get('B').live, false, 'a finished roster does not keep a session lit');
  assert.equal(rows.get('C').label, 'Running', 'a turn that is running keeps its own label');
  assert.equal(rows.get('A').childrenOnly, true, 'live only for its children: no turn of its own to follow or Stop');
  assert.equal(rows.get('C').childrenOnly, false);
});

test('only rows that read idle are asked for their subagents, by live id, and a failure is not fatal', async () => {
  const calls = [];
  const client = {
    request: async (method, params) => {
      calls.push([method, params.session_id]);
      if (params.session_id === 'live-bad') throw new Error('not owned by this transport');
      return { subagents: [{ subagent_id: 'x', status: 'running' }] };
    },
  };
  const rows = new Map([
    ['A', { live: false, liveId: 'live-A' }],
    ['B', { live: true, liveId: 'live-B' }],
    ['C', { live: false, liveId: 'live-bad' }],
  ]);
  const found = await readIdleRowSubagents(client, rows, { cache: new Map(), now: () => 1000 });
  assert.deepEqual(calls.map((call) => call[1]).sort(), ['live-A', 'live-bad']);
  assert.equal(found.has('A'), true);
  assert.equal(found.has('B'), false);
  assert.equal(found.has('C'), false);
});

test('subagent reads are cached per live id and bounded per poll', async () => {
  let n = 0;
  const client = { request: async () => { n += 1; return { subagents: [] }; } };
  const rows = new Map(Array.from({ length: 20 }, (_, i) => [`S${i}`, { live: false, liveId: `live-${i}` }]));
  const cache = new Map();
  await readIdleRowSubagents(client, rows, { cache, now: () => 1000, limit: 5 });
  assert.equal(n, 5);
  await readIdleRowSubagents(client, rows, { cache, now: () => 2000, limit: 5 });
  assert.equal(n, 10, 'the first five were answered recently; the next five are read');
  await readIdleRowSubagents(client, rows, { cache, now: () => 2500, limit: 5 });
  assert.equal(n, 15);
});

test('one failed poll keeps the last good roster; a second, or an unsupported method, clears it', () => {
  const rows = new Map([['A', { live: true }]]);
  assert.equal(rosterAfterFailure({ rows, failures: 1, error: new Error('timeout') }), rows);
  assert.equal(rosterAfterFailure({ rows, failures: 2, error: new Error('timeout') }).size, 0);
  assert.equal(rosterAfterFailure({ rows, failures: 1, error: Object.assign(new Error('x'), { rpcCode: -32601 }) }).size, 0);
});

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const refreshSource = source.slice(
  source.indexOf('async function refreshLiveSessionRoster()'),
  source.indexOf('async function completeAttachedRun('),
);

function pollHarness(requests) {
  let call = 0;
  const client = { readyState: 1, request: async (method) => {
    if (method === 'session.active_list') { const next = requests[Math.min(call, requests.length - 1)]; call += 1; return typeof next === 'function' ? next() : next; }
    return { subagents: [] };
  } };
  const context = vm.createContext({
    liveSessionPollInFlight: false, document: { hidden: false }, followRestSessionTick: async () => {},
    liveSessionScopeKey: () => 'scope', liveSessionRows: new Map(), liveSessionRosterScope: '',
    activeDashboardWsConnection: { client, wsStoredSessionId: 'A', wsSessionId: 'live-A' }, desktopDashboardUrl: 'http://127.0.0.1:9119',
    isRemoteWsMode: () => false, scheduleLiveSessionPoll: () => {}, ensureActiveDashboardWsConnection: async () => ({ client }),
    unsupportedLiveRosterClients: new WeakSet(), sessionLiveRoster, readIdleRowSubagents, rosterAfterFailure,
    liveSubagentCache: new Map(),
    availableSessions: [{ id: 'A' }], settings: { sessionId: 'A' }, renderSessionMenu: () => {}, liveAttach: null,
    reconcileAttachedLiveSession: async () => {}, sending: false, activeConversationTransport: 'dashboard-ws',
    attachLiveSessionIfRunning: async () => false, refreshActiveSessionHistoryQuietly: async () => {},
    liveSessionRosterFailures: 0, liveSessionPollTimer: null,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  vm.runInContext(refreshSource, context);
  return { context, poll: () => vm.runInContext('refreshLiveSessionRoster()', context) };
}

test('a roster poll that fails once does not blank the Running badges until the next poll also fails', async () => {
  const h = pollHarness([
    { sessions: [{ id: 'live-A', session_key: 'A', status: 'working' }] },
    () => { throw new Error('active_list timed out'); },
    () => { throw new Error('active_list timed out'); },
  ]);
  await h.poll();
  assert.equal(h.context.liveSessionRows.get('A')?.live, true);
  await h.poll();
  assert.equal(h.context.liveSessionRows.get('A')?.live, true, 'one failure: the last good roster stays');
  await h.poll();
  assert.equal(h.context.liveSessionRows.size, 0, 'two in a row: it is no longer evidence');
});

test('a poll that succeeds again resets the failure count', async () => {
  const ok = { sessions: [{ id: 'live-A', session_key: 'A', status: 'working' }] };
  const h = pollHarness([ok, () => { throw new Error('x'); }, ok, () => { throw new Error('x'); }]);
  await h.poll(); await h.poll(); await h.poll(); await h.poll();
  assert.equal(h.context.liveSessionRows.get('A')?.live, true);
});
