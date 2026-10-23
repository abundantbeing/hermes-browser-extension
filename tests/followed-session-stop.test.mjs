import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { rosterStopTarget } from '../extension/lib/live-session-attach.mjs';
const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const stop = source.match(/async function stopCurrentTurn\(\) \{[\s\S]*?\n\}/)[0];
function localStop(sending) {
  // Stop also looks the viewed session up in the live roster (nothing listed here).
  const context = vm.createContext({ liveAttach: null, settings: {sessionId:'local-1'}, sending,
    liveSessionRows: new Map(), liveSessionRosterScope: '', liveSessionScopeKey: () => '', activeDashboardWsConnection: null, rosterStopTarget,
    localRunIsViewed: () => true, usesDashboardWsChatTransport: () => false, activeRunControl: {phase:'streaming'},
    requestRunStop: () => { throw new Error('Reached the existing local Stop controller'); } });
  return vm.runInContext(`${stop};stopCurrentTurn()`,context);
}
test('the followed-session branch leaves the existing local active Stop reachable', async () => {
  await assert.rejects(localStop(true), /Reached the existing local Stop controller/);
});
test('local Stop is a no-op only while idle', async () => {
  assert.equal(await localStop(false), false);
});
