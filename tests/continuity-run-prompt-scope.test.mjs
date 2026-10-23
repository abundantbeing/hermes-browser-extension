// D11: a finished local run withdraws the prompt cards of ITS OWN session, not those of the session
// that happens to be selected when it settles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  RUN_CONTROL_PHASES, beginRunControl, liveIdForRunSettle, markRunTerminal, withRunLiveSession,
} from '../extension/lib/run-control-lifecycle.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

function terminalRun({ sessionId = 'A', liveSessionId = '' } = {}) {
  let run = { ...beginRunControl({ transport: 'dashboard-ws' }), sessionId, scopeRevisionId: 1 };
  if (liveSessionId) run = withRunLiveSession(run, liveSessionId);
  return { ...markRunTerminal(run, 'completed'), sessionId, scopeRevisionId: 1, liveSessionId: run.liveSessionId };
}

// ---------- pure ----------

test('the connection is believed only while it is still bound to the run\'s own session', () => {
  const run = terminalRun({ sessionId: 'A', liveSessionId: 'live-A-old' });
  assert.equal(liveIdForRunSettle(run, { wsStoredSessionId: 'A', wsSessionId: 'live-A' }), 'live-A', 'the freshest id for the run\'s session');
  assert.equal(liveIdForRunSettle(run, { wsStoredSessionId: 'B', wsSessionId: 'live-B' }), 'live-A-old', 'the view moved on: the id recorded when the run started');
  assert.equal(liveIdForRunSettle(terminalRun({ sessionId: 'A' }), { wsStoredSessionId: 'B', wsSessionId: 'live-B' }), '', 'unknown means nothing is withdrawn, never the selected session\'s id');
  assert.equal(liveIdForRunSettle(terminalRun({ sessionId: '' }), { wsStoredSessionId: '', wsSessionId: 'live-B' }), '');
});

test('the live id is recorded once per value and ignores blanks', () => {
  const run = beginRunControl({});
  assert.equal(withRunLiveSession(run, ''), run);
  const recorded = withRunLiveSession(run, ' live-A ');
  assert.equal(recorded.liveSessionId, 'live-A');
  assert.equal(withRunLiveSession(recorded, 'live-A'), recorded);
});

// ---------- the panel ----------

function settle({ run, connection }) {
  const settled = [];
  const context = vm.createContext({
    RUN_CONTROL_PHASES, liveIdForRunSettle,
    activeRunControl: run,
    activeDashboardWsConnection: connection,
    promptController: { settleScope: (transport, scope) => settled.push([transport, scope]) },
    activeAbortController: null, activeRunId: 'r1', pendingSteerText: '', sending: true, queuedTurn: null,
    updateComposerBusyState() {}, renderContextWindow() {}, recheckBuildIdentityAfterUpdateTurn() {},
    shouldAutoFlushQueuedTurn: () => false, flushQueuedTurnForSession: async () => {},
  });
  vm.runInContext(functionSource('settleActiveRunTerminal'), context);
  return vm.runInContext('settleActiveRunTerminal()', context).then(() => settled);
}

test('run A settles while B is selected: B\'s prompt cards stay, A\'s are withdrawn', async () => {
  const settled = await settle({
    run: terminalRun({ sessionId: 'A', liveSessionId: 'live-A' }),
    connection: { wsStoredSessionId: 'B', wsSessionId: 'live-B' },
  });
  assert.deepEqual(settled, [['ws-authority', 'live-A']]);
});

test('run A settles while B is selected and A\'s live id is unknown: nothing is withdrawn', async () => {
  const settled = await settle({
    run: terminalRun({ sessionId: 'A' }),
    connection: { wsStoredSessionId: 'B', wsSessionId: 'live-B' },
  });
  assert.deepEqual(settled, []);
});

test('a run that settles in the session still on screen withdraws that session\'s prompts', async () => {
  const settled = await settle({
    run: terminalRun({ sessionId: 'A' }),
    connection: { wsStoredSessionId: 'A', wsSessionId: 'live-A' },
  });
  assert.deepEqual(settled, [['ws-authority', 'live-A']]);
});

test('the run records its live session id when the gateway admits the turn', () => {
  const wrapper = source.slice(source.indexOf('onSubmitResponse: (response) => {\n            // The generation the gateway admitted'), source.indexOf('turnOptions.onSubmitResponse?.(response);'));
  assert.match(wrapper, /withRunLiveSession\(activeRunControl,/);
});
