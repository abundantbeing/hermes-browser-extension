import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sessionLiveRoster } from '../extension/lib/live-session-attach.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const fnSource = source.slice(
  source.indexOf('function viewedSessionIsRunning()'),
  source.indexOf('function currentComposerDraftState()'),
);

// viewedSessionIsRunning as the panel runs it, fed with a roster built by the real
// sessionLiveRoster from a session.active_list payload.
function viewed(status, { sessionId = 'A', scopeMatches = true, attach = null, sending = false, children = null } = {}) {
  const roster = sessionLiveRoster({ sessions: [{ id: 'live-A', session_key: 'A', status }] }, ['A'],
    children ? { subagentRosters: new Map([['A', children]]) } : {});
  const context = vm.createContext({
    settings: { sessionId },
    sending, liveAttach: attach,
    liveSessionRows: roster,
    liveSessionRosterScope: 'scope-1',
    liveSessionScopeKey: () => (scopeMatches ? 'scope-1' : 'scope-2'),
    localRunIsViewed: () => false,
  });
  vm.runInContext(fnSource, context);
  return vm.runInContext('viewedSessionIsRunning()', context);
}

test('a roster row that says running puts the composer into busy state without an attach', () => {
  assert.equal(viewed('working'), true);
  assert.equal(viewed('running'), true);
});

test('a roster row that waits on the user is live too', () => {
  assert.equal(viewed('waiting'), true);
});

test('an idle roster row is not running, and another session is not affected', () => {
  assert.equal(viewed('idle'), false);
  assert.equal(viewed('working', { sessionId: 'B' }), false);
});

test('a roster read for another connection scope is ignored', () => {
  assert.equal(viewed('working', { scopeMatches: false }), false);
});

test('the panel\'s own attach still counts', () => {
  assert.equal(viewed('idle', { attach: { sessionId: 'A' } }), true);
});

test('a session that is live only because its subagents run leaves the composer open', () => {
  assert.equal(viewed('idle', { children: [{ id: 's', status: 'running' }] }), false);
  assert.equal(viewed('working', { children: [{ id: 's', status: 'running' }] }), true, 'its own running turn still counts');
});
