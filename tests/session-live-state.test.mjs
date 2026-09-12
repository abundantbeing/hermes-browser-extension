// Tests for the session live-state model. Fixtures are real payloads (with
// secrets/large strings elided) observed from the local Hermes gateway:
//   - GET http://127.0.0.1:8642/api/sessions?limit=5  (persisted session rows)
//   - WS /api/ws session.info / session.resume payloads (running boolean)
//   - WS /api/ws subagent.list roster rows
//   - REST /v1/runs/{run_id} status payloads
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_STATES,
  liveStateBadge,
  liveStateFromSessionRow,
  mergeLiveSignals,
} from '../extension/lib/session-live-state.mjs';

// Observed: GET /api/sessions -> data[1]. Exactly the client-safe key set —
// note there is NO state/status/busy/running/active/updated_at/running_turns.
const browserSessionRow = {
  id: '20260911_214357_8adf51',
  source: 'hermes_browser',
  user_id: null,
  model: 'gemini-3.8-flash-high(medium)',
  title: 'Hermes Browser Extension · Sep 11, 9:43:57 PM',
  started_at: 1789137883.3282714,
  ended_at: null,
  end_reason: null,
  message_count: 187,
  tool_call_count: 57,
  input_tokens: 2094862,
  output_tokens: 19115,
  cache_read_tokens: 8507279,
  cache_write_tokens: 0,
  reasoning_tokens: 25762,
  estimated_cost_usd: 0,
  actual_cost_usd: null,
  api_call_count: 93,
  parent_session_id: null,
  last_active: 1789153520.9138334,
  preview: '{"protocol":"hermes.browser.turn.v2","human_input":{"source"...',
  pinned: false,
  archived: false,
  hidden: false,
  has_system_prompt: true,
  has_model_config: true,
};

// Observed: GET /api/sessions -> a session that ENDED (end_reason stamped).
const endedSessionRow = {
  id: '20260909_143828_15f1ea',
  source: 'telegram',
  user_id: '6590719035',
  model: 'grok-4.6',
  title: 'Friendly greeting #4',
  started_at: 1788929527.5772626,
  ended_at: 1789150973.524066,
  end_reason: 'agent_close',
  message_count: 238,
  tool_call_count: 99,
  last_active: 1789137800.3665798,
  pinned: false,
  archived: false,
  hidden: false,
};

// Observed shape: WS `subagent.list` -> { subagents: [...] }, rows carry
// subagent_id/parent_id/depth/goal/delegation_id/model/started_at/status/
// tool_count/last_tool/accepting_steer.
const liveRosterRow = {
  subagent_id: 'sub_01H9ZY',
  parent_id: null,
  depth: 1,
  goal: 'Research competitor pricing pages',
  delegation_id: 'deleg_a1b2c3d4',
  model: 'deepseek/deepseek-v4.1-flash',
  started_at: 1789153400.0,
  status: 'running',
  tool_count: 7,
  last_tool: 'web_search',
  accepting_steer: true,
};

const finishedRoster = [
  { ...liveRosterRow, subagent_id: 'sub_done', status: 'completed' },
  { ...liveRosterRow, subagent_id: 'sub_failed', status: 'failed', summary: 'child errored' },
  { ...liveRosterRow, subagent_id: 'sub_stopped', status: 'interrupted' },
];

// Observed shape: WS session.info payload fragment (tui_gateway _session_info)
// — the `running` boolean + turn_started_at are the live facts.
const sessionInfoFragment = {
  running: true,
  turn_started_at: 1789153499.5,
  stored_session_id: '20260911_214357_8adf51',
  model: 'gemini-3.8-flash-high(medium)',
  provider: 'google',
  cwd: 'D:/Documents/HERMES_BROWSER',
};

// Observed shape: GET /v1/runs/{run_id} run status (api_server_runs).
const restRunStatus = {
  object: 'hermes.run',
  run_id: 'run_9f2c41',
  status: 'running',
  created_at: 1789153500.1,
  updated_at: 1789153522.5,
  session_id: '20260911_214357_8adf51',
};

test('a persisted row with no live fields is unknown, never live', () => {
  assert.deepEqual(liveStateFromSessionRow(browserSessionRow), {
    live: false,
    busy: false,
    state: 'unknown',
    label: 'No live signal',
    hasSubagents: false,
    updatedAt: 1789153520914,
  });
});

test('a row that ended reads idle, not unknown', () => {
  assert.deepEqual(liveStateFromSessionRow(endedSessionRow), {
    live: false,
    busy: false,
    state: 'idle',
    label: 'Idle',
    hasSubagents: false,
    updatedAt: 1789137800367,
  });
});

test('an ended_at already in milliseconds still reads idle', () => {
  const msRow = { ...browserSessionRow, ended_at: 1789150973524 };
  assert.equal(liveStateFromSessionRow(msRow).state, 'idle');
});

test('a busy/running row reads running', () => {
  const byStatus = liveStateFromSessionRow({ ...browserSessionRow, status: 'streaming' });
  assert.deepEqual(byStatus, {
    live: true,
    busy: true,
    state: 'running',
    label: 'Running',
    hasSubagents: false,
    updatedAt: 1789153520914,
  });
  assert.deepEqual(liveStateFromSessionRow({ ...browserSessionRow, running: true }), byStatus);
});

test('a row enriched with a session.info fragment (running boolean) reads live', () => {
  const enriched = { ...browserSessionRow, ...sessionInfoFragment };
  const state = liveStateFromSessionRow(enriched);
  assert.equal(state.live, true);
  assert.equal(state.busy, true);
  assert.equal(state.state, 'running');
});

test('explicit idle booleans read idle (not unknown)', () => {
  assert.equal(liveStateFromSessionRow({ ...browserSessionRow, busy: false }).state, 'idle');
  assert.equal(liveStateFromSessionRow({ ...browserSessionRow, running: false }).state, 'idle');
});

test('needs-input outranks a running claim and is live but not busy', () => {
  const state = liveStateFromSessionRow({ ...browserSessionRow, running: true, needs_input: true });
  assert.deepEqual(state, {
    live: true,
    busy: false,
    state: 'waiting',
    label: 'Waiting for input',
    hasSubagents: false,
    updatedAt: 1789153520914,
  });
});

test('waiting_for_approval and stopping map to their families', () => {
  const approval = liveStateFromSessionRow({ ...browserSessionRow, status: 'waiting_for_approval' });
  assert.equal(approval.state, 'waiting');
  assert.equal(approval.label, 'Waiting for approval');
  assert.equal(approval.live, true);
  assert.equal(approval.busy, false);

  const stopping = liveStateFromSessionRow({ ...browserSessionRow, status: 'stopping' });
  assert.equal(stopping.state, 'running');
  assert.equal(stopping.label, 'Stopping');
  assert.equal(stopping.live, true);
});

test('a failed row reads error', () => {
  assert.deepEqual(liveStateFromSessionRow({ ...browserSessionRow, status: 'failed' }), {
    live: false,
    busy: false,
    state: 'error',
    label: 'Failed',
    hasSubagents: false,
    updatedAt: 1789153520914,
  });
});

test('running_turns > 0 reads running; 0 reads idle', () => {
  assert.equal(liveStateFromSessionRow({ ...browserSessionRow, running_turns: 2 }).state, 'running');
  assert.equal(liveStateFromSessionRow({ ...browserSessionRow, running_turns: 0 }).state, 'idle');
});

test('an unrecognized status string does not fabricate a state', () => {
  assert.equal(liveStateFromSessionRow({ ...browserSessionRow, status: 'banana' }).state, 'unknown');
});

test('a normalized extension row (camelCase) is understood', () => {
  const normalized = {
    id: '20260911_214357_8adf51',
    title: 'Hermes Browser Extension · Sep 11, 9:43:57 PM',
    source: 'hermes_browser',
    messageCount: 187,
    lastActive: 1789153520914,
  };
  const state = liveStateFromSessionRow(normalized);
  assert.equal(state.state, 'unknown');
  assert.equal(state.updatedAt, 1789153520914);
  assert.equal(liveStateFromSessionRow({ ...normalized, running: true }).state, 'running');
});

test('garbage rows are unknown with zero timestamps', () => {
  for (const row of [null, undefined, [], 42, 'row']) {
    assert.deepEqual(liveStateFromSessionRow(row), {
      live: false,
      busy: false,
      state: 'unknown',
      label: 'No live signal',
      hasSubagents: false,
      updatedAt: 0,
    });
  }
});

test('merge: a locally-connected running run reads live over a silent row', () => {
  const merged = mergeLiveSignals({ row: browserSessionRow, liveRun: { phase: 'running', runId: 'run_1' } });
  assert.deepEqual(merged, {
    live: true,
    busy: true,
    state: 'running',
    label: 'Running',
    hasSubagents: false,
    updatedAt: 1789153520914,
  });
});

test('merge PRECEDENCE: local run running while the row says idle', () => {
  const rowSaysIdle = { ...browserSessionRow, running: false };
  assert.equal(liveStateFromSessionRow(rowSaysIdle).state, 'idle');
  const merged = mergeLiveSignals({ row: rowSaysIdle, liveRun: { phase: 'running', runId: 'run_1' } });
  assert.equal(merged.live, true);
  assert.equal(merged.busy, true);
  assert.equal(merged.state, 'running');
});

test('merge PRECEDENCE: a terminal local run settles even a running-status row', () => {
  const merged = mergeLiveSignals({
    row: { ...browserSessionRow, status: 'streaming' },
    liveRun: { phase: 'terminal', terminalStatus: 'completed' },
  });
  assert.equal(merged.live, false);
  assert.equal(merged.state, 'idle');
});

test('merge: a REST /v1/runs status payload maps through and freshens updatedAt', () => {
  const merged = mergeLiveSignals({ row: browserSessionRow, liveRun: restRunStatus });
  assert.deepEqual(merged, {
    live: true,
    busy: true,
    state: 'running',
    label: 'Running',
    hasSubagents: false,
    updatedAt: 1789153522500,
  });
});

test('merge: waiting_for_approval run reads waiting/live', () => {
  const merged = mergeLiveSignals({
    row: browserSessionRow,
    liveRun: { ...restRunStatus, status: 'waiting_for_approval', updated_at: 1789153600.5 },
  });
  assert.equal(merged.state, 'waiting');
  assert.equal(merged.label, 'Waiting for approval');
  assert.equal(merged.live, true);
  assert.equal(merged.busy, false);
  assert.equal(merged.updatedAt, 1789153600500);
});

test('merge: terminal failed reads error, terminal cancelled settles idle', () => {
  const failed = mergeLiveSignals({
    row: browserSessionRow,
    liveRun: { phase: 'terminal', terminalStatus: 'failed' },
  });
  assert.equal(failed.state, 'error');
  assert.equal(failed.live, false);

  const cancelled = mergeLiveSignals({
    row: browserSessionRow,
    liveRun: { phase: 'terminal', terminalStatus: 'cancelled' },
  });
  assert.equal(cancelled.state, 'idle');
});

test('merge: an unrecognizable liveRun falls back to the row', () => {
  const merged = mergeLiveSignals({ row: browserSessionRow, liveRun: { foo: 1 } });
  assert.equal(merged.state, 'unknown');
  const idleRun = mergeLiveSignals({ row: browserSessionRow, liveRun: { running: false } });
  assert.equal(idleRun.state, 'idle');
});

test('merge: a running subagent keeps an unknown row live', () => {
  const merged = mergeLiveSignals({ row: browserSessionRow, roster: [liveRosterRow] });
  assert.deepEqual(merged, {
    live: true,
    busy: true,
    state: 'running',
    label: 'Subagents running',
    hasSubagents: true,
    updatedAt: 1789153520914,
  });
});

test('merge: subagent.list payload wrapper and extension items both count', () => {
  const wrapped = mergeLiveSignals({ row: browserSessionRow, roster: { subagents: [liveRosterRow] } });
  assert.equal(wrapped.hasSubagents, true);
  assert.equal(wrapped.live, true);

  const extensionItems = mergeLiveSignals({
    row: browserSessionRow,
    roster: [{ id: 'sub_01H9ZY', status: 'running' }, { id: 'sub_old', status: 'completed' }],
  });
  assert.equal(extensionItems.hasSubagents, true);
  assert.equal(extensionItems.live, true);
});

test('merge: a finished roster does not fabricate liveness', () => {
  const merged = mergeLiveSignals({ row: browserSessionRow, roster: finishedRoster });
  assert.equal(merged.hasSubagents, false);
  assert.equal(merged.live, false);
  assert.equal(merged.state, 'unknown');
});

test('merge ASYNC DELEGATION: terminal local run + active roster stays live', () => {
  const merged = mergeLiveSignals({
    row: browserSessionRow,
    liveRun: { phase: 'terminal', terminalStatus: 'completed' },
    roster: [liveRosterRow],
  });
  assert.deepEqual(merged, {
    live: true,
    busy: true,
    state: 'running',
    label: 'Subagents running',
    hasSubagents: true,
    updatedAt: 1789153520914,
  });
});

test('merge: an active roster never masks a waiting claim', () => {
  const merged = mergeLiveSignals({
    row: { ...browserSessionRow, status: 'waiting_for_approval' },
    roster: [liveRosterRow],
  });
  assert.equal(merged.state, 'waiting');
  assert.equal(merged.label, 'Waiting for approval');
  assert.equal(merged.hasSubagents, true);
});

test('merge: default and empty inputs are unknown at updatedAt 0', () => {
  const expected = {
    live: false,
    busy: false,
    state: 'unknown',
    label: 'No live signal',
    hasSubagents: false,
    updatedAt: 0,
  };
  assert.deepEqual(mergeLiveSignals(), expected);
  assert.deepEqual(mergeLiveSignals({}), expected);
  assert.deepEqual(mergeLiveSignals({ row: null, liveRun: null, roster: null }), expected);
});

test('badges: every live state has a stable text/tone pair', () => {
  assert.deepEqual(liveStateBadge('running'), { text: 'Live', tone: 'live' });
  assert.deepEqual(liveStateBadge('waiting'), { text: 'Waiting', tone: 'warn' });
  assert.deepEqual(liveStateBadge('idle'), { text: 'Idle', tone: 'idle' });
  assert.deepEqual(liveStateBadge('error'), { text: 'Error', tone: 'error' });
  assert.deepEqual(liveStateBadge('unknown'), { text: 'Unknown', tone: 'idle' });
  for (const state of LIVE_STATES) {
    const badge = liveStateBadge(state);
    assert.ok(['live', 'idle', 'warn', 'error'].includes(badge.tone));
    assert.ok(badge.text.length > 0);
  }
});

test('badges: invalid input is Unknown, never Idle', () => {
  assert.deepEqual(liveStateBadge('banana'), { text: 'Unknown', tone: 'idle' });
  assert.deepEqual(liveStateBadge(undefined), { text: 'Unknown', tone: 'idle' });
  assert.deepEqual(liveStateBadge(null), { text: 'Unknown', tone: 'idle' });
});
