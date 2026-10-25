import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [sidepanelSource, packageSource] = await Promise.all([
  fs.readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

test('side panel imports the shared delegation watcher contract', () => {
  for (const source of [sidepanelSource]) {
    assert.match(source, /createDelegationWatchManager/);
    assert.match(source, /delegationDispatchFromToolEvent/);
    assert.match(source, /delegationDispatchesFromMessages/);
    assert.match(source, /DELEGATION_WATCH_STORAGE_KEY/);
  }
});

test('legacy boolean and prose watcher is removed from the side panel', () => {
  assert.doesNotMatch(sidepanelSource, /sawDelegationToolThisTurn/);
  assert.doesNotMatch(sidepanelSource, /watchForDelegationResults/);
  assert.doesNotMatch(sidepanelSource, /turnMentionsDelegation/);
  assert.doesNotMatch(sidepanelSource, /delegationBatchSettled/);
});

test('side panel separates quiet history fetch from guarded UI commit', () => {
  assert.match(sidepanelSource, /async function fetchSessionMessagesQuietly\(/);
  assert.match(sidepanelSource, /async function commitFetchedSessionMessages\(/);
  assert.match(sidepanelSource, /delegationWatchManager/);
  assert.match(sidepanelSource, /requestId !== sessionLoadRequestId/);
});

test('the REST run.completed path extracts structured dispatch results', () => {
  assert.match(sidepanelSource, /delegationDispatchesFromMessages\(payload\?\.messages/);
});

test('the dashboard path observes tool.complete result payloads', () => {
  for (const source of [sidepanelSource]) {
    assert.match(source, /client\.on\('tool\.complete'/);
    assert.match(source, /result:\s*event\.payload\?\.result/);
  }
});

test('dashboard history reconciliation uses live ids while watches remain durable scoped', () => {
  assert.match(sidepanelSource, /liveSessionId:\s*String\(\s*remoteWsConnection\?\.wsSessionId/);
  assert.match(sidepanelSource, /fetchDashboardHistoryWithResume\(watch\.durableSessionId\)/);
  assert.doesNotMatch(sidepanelSource, /watch\.transport === 'dashboard-ws' \? watch\.liveSessionId/);
  assert.match(sidepanelSource, /session_id:\s*sessionId/);
});

test('completion replies reveal progressively instead of popping in', () => {
  assert.match(sidepanelSource, /commitFetchedSessionMessagesWithReveal/);
  assert.match(sidepanelSource, /revealCompletionReply/);
  for (const source of [sidepanelSource]) {
    assert.match(source, /from '\.\/lib\/completion-reveal\.mjs'/);
    assert.match(source, /trailingNewMessages/);
    assert.match(source, /revealSlice/);
  }
});

test('subagent steering resumes the durable session before the control RPC', () => {
  assert.match(sidepanelSource, /runSelectedSubagentControl[\s\S]*?establishGatewaySession\(\{[\s\S]*?storedSessionId: durableSessionId[\s\S]*?sessionId: liveId/);
});

test('background dashboard history resumes reaped runtimes before fetching', () => {
  assert.match(sidepanelSource, /async function fetchDashboardHistoryWithResume\(/);
  assert.match(sidepanelSource, /storedSessionId: sid/);
  assert.match(sidepanelSource, /refreshSessionAfterSubagentsSettle[\s\S]*?fetchDashboardHistoryWithResume\(durableSessionId\)/);
  assert.match(sidepanelSource, /refreshActiveSessionHistoryQuietly[\s\S]*?fetchDashboardHistoryWithResume\(sessionId\)/);
  assert.match(sidepanelSource, /delegationCompletionMarkerId/);
  assert.match(sidepanelSource, /delegationCompletionState\(rows, completionId\)/);
});

test('session identity is guarded before stale dashboard requests can mutate the side panel', () => {
  assert.match(sidepanelSource, /if \(requestId !== sessionLoadRequestId\) return;[\s\S]*?connection\.wsSessionId = liveId/);
});

test('the side panel hydrates persisted watches and activate the current session', () => {
  for (const source of [sidepanelSource]) {
    assert.match(source, /delegationWatchManager\.hydrate/);
    assert.match(source, /delegationWatchManager\.activate/);
  }
});

test('accepted-turn and degraded REST fallbacks rescan canonical history for dispatch ids', () => {
  assert.match(sidepanelSource, /async function captureDelegationDispatchesFromCurrentRestHistory\(/);
  assert.match(sidepanelSource, /async function recoverAcceptedTurn[\s\S]*?captureDelegationRuntimePayload\(\{ messages: rows \}\)/);
  assert.match(sidepanelSource, /async function streamChatCompletions[\s\S]*?captureDelegationDispatchesFromCurrentRestHistory\(\)/);
  assert.match(sidepanelSource, /async function fallbackSessionChat[\s\S]*?captureDelegationDispatchesFromCurrentRestHistory\(\)/);
});

test('new delegation module participates in the canonical JavaScript check', () => {
  assert.match(packageSource, /node --check extension\/lib\/async-delegation\.mjs/);
});
