// The live roster's vocabulary and its resilience: what counts as a live session, and what one failed
// poll may do to the badges already shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  readIdleRowSubagents, rosterAfterFailure, sessionIsLiveFromStatus, sessionLiveRoster,
} from '../extension/lib/live-session-attach.mjs';
import { rosterSuccessor } from '../extension/lib/session-lineage.mjs';
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
    liveSubagentCache: new Map(), discoverLiveSessions, liveDiscoveredSessions: [], safeActiveProfile: () => '',
    rosterSuccessor, adoptSessionSuccessor: async () => false, loadSessions: async () => {},
    normalizeHermesSessions: (payload) => payload.sessions.map((row) => ({ id: row.id, title: row.title || row.id, source: row.source })),
    availableSessions: [{ id: 'A' }], settings: { sessionId: 'A' }, renderSessionMenu: () => {}, liveAttach: null,
    reconcileAttachedLiveSession: async () => {}, sending: false, activeConversationTransport: 'dashboard-ws',
    attachLiveSessionIfRunning: async () => false, refreshActiveSessionHistoryQuietly: async () => {},
    liveSessionRosterFailures: 0, liveSessionPollTimer: null,
    setTimeout: () => 0, clearTimeout: () => {},
    composerRefreshes: 0, updateComposerBusyState: () => {},
    queuedTurn: null, flushQueuedTurnForSession: async () => false,
  });
  vm.runInContext("function viewedSessionIsRunning() { return liveSessionRows.get(settings.sessionId)?.live === true; }", context);
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

// ---------------------------------------------------------------------------------------------
// Discovery: a session running elsewhere (the CLI, Desktop, another window) that the panel's
// loaded list does not contain.
// ---------------------------------------------------------------------------------------------
import { discoverLiveSessions } from '../extension/lib/live-session-attach.mjs';

const discoveryPayload = { sessions: [
  { id: 'known', session_key: 'known', status: 'working', title: 'already listed', source: 'tui' },
  { id: 'cli-run', session_key: 'cli-run', status: 'working', title: 'Started in the CLI', source: 'cli', message_count: 4, last_active: 1790000000 },
  { id: 'starting-run', session_key: 'starting-run', status: 'starting', title: '', source: 'tui' },
  { id: 'waiting-run', session_key: 'waiting-run', status: 'waiting', source: 'tui' },
  { id: 'idle-run', session_key: 'idle-run', status: 'idle', source: 'tui' },
  { id: 'kanban-run', session_key: 'kanban-run', status: 'working', source: 'kanban' },
  { id: 'tool-run', session_key: 'tool-run', status: 'working', source: 'tool' },
  { id: 'oneshot-run', session_key: 'oneshot-run', status: 'working', source: 'oneshot' },
  { id: '', session_key: '', status: 'working' },
] };

test('discovery returns live, unlisted, non-internal sessions of a profile-scoped connection', () => {
  const found = discoverLiveSessions(discoveryPayload, { knownIds: ['known'], scoped: true });
  assert.deepEqual(found.map((row) => row.id).sort(), ['cli-run', 'starting-run', 'waiting-run']);
  const cli = found.find((row) => row.id === 'cli-run');
  assert.equal(cli.title, 'Started in the CLI');
  assert.equal(cli.source, 'cli');
  assert.equal(cli.message_count, 4);
  assert.equal(cli.last_active, 1790000000);
});

test('discovery returns nothing on a connection that is not scoped to the profile', () => {
  assert.deepEqual(discoverLiveSessions(discoveryPayload, { knownIds: ['known'], scoped: false }), []);
  assert.deepEqual(discoverLiveSessions(discoveryPayload, { knownIds: ['known'] }), []);
});

test('discovery tolerates an empty or malformed payload', () => {
  assert.deepEqual(discoverLiveSessions({}, { knownIds: [], scoped: true }), []);
  assert.deepEqual(discoverLiveSessions(null, { knownIds: [], scoped: true }), []);
  assert.deepEqual(discoverLiveSessions({ sessions: [null, 3, 'x'] }, { knownIds: [], scoped: true }), []);
});

function discoveryHarness({ authority = true, connectionProfile = '', activeProfile = '' } = {}) {
  const h = pollHarness([{ sessions: discoveryPayload.sessions }]);
  const client = h.context.activeDashboardWsConnection.client;
  client.readyPayload = authority ? { session_authority: true } : {};
  h.context.activeDashboardWsConnection.profile = connectionProfile;
  Object.assign(h.context, { safeActiveProfile: () => activeProfile, availableSessions: [{ id: 'known' }] });
  return h;
}

test('the poll surfaces discovered sessions on an authority connection for the active profile, and gives them a roster row', async () => {
  const h = discoveryHarness();
  await h.poll();
  assert.deepEqual(h.context.liveDiscoveredSessions.map((row) => row.id).sort(), ['cli-run', 'starting-run', 'waiting-run']);
  assert.ok(h.context.liveDiscoveredSessions.every((row) => row.liveElsewhere === true));
  assert.equal(h.context.liveSessionRows.get('cli-run')?.live, true, 'the drawer badge needs a roster row for it');
  assert.equal(h.context.liveSessionRows.has('idle-run'), false);
});

test('a legacy sidecar socket never discovers (its active_list lists every profile)', async () => {
  const h = discoveryHarness({ authority: false });
  await h.poll();
  assert.equal(h.context.liveDiscoveredSessions.length, 0);
  assert.equal(h.context.liveSessionRows.has('cli-run'), false);
});

test('a connection established under another profile never discovers', async () => {
  const h = discoveryHarness({ connectionProfile: 'work', activeProfile: 'personal' });
  await h.poll();
  assert.equal(h.context.liveDiscoveredSessions.length, 0);
});

test('discovered sessions follow the roster: kept through one failed poll, gone after two', async () => {
  const h = discoveryHarness();
  const client = h.context.activeDashboardWsConnection.client;
  const original = client.request;
  await h.poll();
  assert.equal(h.context.liveDiscoveredSessions.length, 3);
  client.request = async () => { throw new Error('active_list timed out'); };
  await h.poll();
  assert.equal(h.context.liveDiscoveredSessions.length, 3);
  await h.poll();
  assert.equal(h.context.liveDiscoveredSessions.length, 0);
  client.request = original;
});

const menuSource = source.slice(
  source.indexOf('function sessionMenuGroups(query = \'\')'),
  source.indexOf('function selectGroupThreadFromMenu('),
);

test('the drawer lists discovered sessions beside the loaded ones, once each', () => {
  const grouped = [];
  const context = vm.createContext({
    availableSessions: [{ id: 'known', title: 'Known', source: 'tui' }],
    liveDiscoveredSessions: [{ id: 'cli-run', title: 'CLI', source: 'cli', liveElsewhere: true }, { id: 'known', title: 'dup', source: 'tui', liveElsewhere: true }],
    settings: { sessionId: 'known' },
    groupSessionsForMenu: (sessions) => { grouped.push(...sessions); return [{ label: 'all', sessions }]; },
    groupThreadSessionsForMenu: () => [], isBotModeEngaged: () => false, t: (key) => key,
  });
  vm.runInContext(menuSource, context);
  vm.runInContext("sessionMenuGroups('')", context);
  assert.deepEqual(grouped.map((row) => row.id), ['known', 'cli-run']);
});

test('the composer follows the roster when the viewed session starts or stops running', async () => {
  const running = { sessions: [{ id: 'live-A', session_key: 'A', status: 'working' }] };
  const idle = { sessions: [{ id: 'live-A', session_key: 'A', status: 'idle' }] };
  const h = pollHarness([idle, running, running, idle]);
  h.context.updateComposerBusyState = () => { h.context.composerRefreshes += 1; };
  await h.poll();
  assert.equal(h.context.composerRefreshes, 0, 'nothing changed');
  await h.poll();
  assert.equal(h.context.composerRefreshes, 1, 'the session started running: busy state');
  await h.poll();
  assert.equal(h.context.composerRefreshes, 1, 'still running: no churn');
  await h.poll();
  assert.equal(h.context.composerRefreshes, 2, 'the session stopped: the composer is released');
});

// ---------------------------------------------------------------------------------------------
// Review finding 4: a draft queued behind a run the roster reports (a CLI or Desktop run viewed from a
// REST-transport panel, which never attaches) has no completion hook of its own; the poll sends it
// when the roster says the run ended.
// ---------------------------------------------------------------------------------------------
function queuedFlushHarness({ queued, transport = 'rest' } = {}) {
  const running = { sessions: [{ id: 'live-A', session_key: 'A', status: 'working' }] };
  const h = pollHarness([running, { sessions: [{ id: 'live-A', session_key: 'A', status: 'idle' }] }]);
  const flushed = [];
  Object.assign(h.context, {
    activeConversationTransport: transport,
    queuedTurn: queued,
    flushQueuedTurnForSession: async (sessionId, scopeRevisionId) => { flushed.push([sessionId, scopeRevisionId]); return true; },
  });
  return { ...h, flushed };
}

test('a REST-transport panel sends the draft queued behind a roster-live run when the run ends', async () => {
  const h = queuedFlushHarness({ queued: { text: 'next', autoSend: true, sessionId: 'A', scopeRevisionId: 7 } });
  await h.poll();
  assert.equal(h.context.liveSessionRows.get('A')?.live, true);
  assert.deepEqual(h.flushed, [], 'the run is still going');
  await h.poll();
  assert.deepEqual(h.flushed, [['A', 7]], 'the run ended: the queued draft is sent');
});

test('the draft is left alone when it belongs to another session or is not auto-send', async () => {
  for (const queued of [
    { text: 'x', autoSend: true, sessionId: 'B', scopeRevisionId: 1 },
    { text: 'x', autoSend: false, sessionId: 'A', scopeRevisionId: 1 },
    null,
  ]) {
    const h = queuedFlushHarness({ queued });
    await h.poll();
    await h.poll();
    assert.deepEqual(h.flushed, []);
  }
});
