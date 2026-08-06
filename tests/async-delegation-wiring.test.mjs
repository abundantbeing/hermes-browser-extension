import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [sidepanelSource, appSource, packageSource] = await Promise.all([
  fs.readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../extension/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

test('side panel and full-tab import the shared delegation watcher contract', () => {
  for (const source of [sidepanelSource, appSource]) {
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

test('both REST run.completed paths extract structured dispatch results', () => {
  assert.match(sidepanelSource, /delegationDispatchesFromMessages\(payload\?\.messages/);
  assert.match(appSource, /delegationDispatchesFromMessages\(runtime\?\.messages/);
});

test('both dashboard paths observe tool.complete result payloads', () => {
  for (const source of [sidepanelSource, appSource]) {
    assert.match(source, /client\.on\('tool\.complete'/);
    assert.match(source, /result:\s*event\.payload\?\.result/);
  }
});

test('dashboard history reconciliation uses live ids while watches remain durable scoped', () => {
  assert.match(sidepanelSource, /liveSessionId:\s*remoteWsConnection\?\.wsSessionId/);
  assert.match(sidepanelSource, /watch\.transport === 'dashboard-ws' \? watch\.liveSessionId : watch\.durableSessionId/);
  assert.match(sidepanelSource, /session_id:\s*sessionId/);
  assert.match(appSource, /liveSessionId:\s*dashboardLiveSessionId/);
  assert.match(appSource, /session_id:\s*watch\.liveSessionId/);
});

test('session identity is guarded before stale dashboard requests can mutate either surface', () => {
  assert.match(sidepanelSource, /if \(requestId !== sessionLoadRequestId\) return;\s*connection\.wsSessionId = liveId/);
  assert.match(appSource, /if \(!isCurrent\(\)\) \{[\s\S]*?newer session selection/);
  assert.match(appSource, /isCurrent: \(\) => requestId === webSessionLoadRequestId/);
});

test('both surfaces hydrate persisted watches and activate the current session', () => {
  for (const source of [sidepanelSource, appSource]) {
    assert.match(source, /delegationWatchManager\.hydrate/);
    assert.match(source, /delegationWatchManager\.activate/);
  }
});

test('new delegation module participates in the canonical JavaScript check', () => {
  assert.match(packageSource, /node --check extension\/lib\/async-delegation\.mjs/);
});
