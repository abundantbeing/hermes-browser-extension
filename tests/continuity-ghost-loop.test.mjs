// Issue #69, "ghost loop": a run keeps going on the gateway while this panel shows idle, and the
// person types "stop" into the composer. The panel must never answer that by starting a second turn on
// the same session (the second writer that forked the conversation in the report): a session the
// roster lists as running takes the text as a steer or a queued message, and only a session that is
// not running takes a new turn. The rest of the symptoms are pinned by the continuity and stop tests
// named in the report (stop-safety, stop-confirmation, stop-generation-fence, attach-authority, ...).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { sessionLiveRoster } from '../extension/lib/live-session-attach.mjs';
import { busyComposerSubmitAction, composerControlState } from '../extension/lib/common.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from > 0 && to > from, start);
  return source.slice(from, to);
}

const viewedRunning = between('function viewedSessionIsRunning()', 'function currentComposerDraftState()');
// The composer's submit handler: the arrow function's body, as the panel runs it.
const submitBody = between("els.composer.addEventListener('submit', async (event) => {", "  els.input.addEventListener('keydown'")
  .replace("els.composer.addEventListener('submit', async (event) => {", '')
  .replace(/\n {2}\}\);\n$/, '\n');

async function composer({ rosterStatus = 'working', sending = false, canSteer = true, draft = 'bro stop', children = null, attach = null } = {}) {
  const roster = sessionLiveRoster({ sessions: [{ id: 'live-A', session_key: 'A', status: rosterStatus }] }, ['A'],
    children ? { subagentRosters: new Map([['A', children]]) } : {});
  const calls = [];
  const code = `export default function make(env) {
    const { settings, els, attachments, busyComposerSubmitAction } = env;
    const sending = env.sending;
    const liveAttach = env.attach;
    const liveSessionRows = env.roster;
    const liveSessionRosterScope = 'scope-1';
    const liveSessionScopeKey = () => 'scope-1';
    const localRunIsViewed = () => false;
    const activeGroupProjection = null;
    const parseBrowserCommand = () => null;
    const canSteerActiveRun = () => env.canSteer;
    const executeNativeBrowserCommand = async () => env.calls.push('native');
    const steerCurrentDraft = async () => env.calls.push('steer');
    const queueCurrentDraft = () => env.calls.push('queue');
    const askHermes = async (text) => env.calls.push('ask:' + text);
    const sendActiveGroupMessage = async () => env.calls.push('group');
    ${viewedRunning}
    return async function submit(event) {${submitBody}};
  }`;
  const { default: make } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const submit = make({
    settings: { sessionId: 'A' },
    els: { input: { value: draft } },
    attachments: [],
    busyComposerSubmitAction,
    sending,
    attach,
    roster,
    canSteer,
    calls,
  });
  await submit({ preventDefault() {} });
  return calls;
}

test('typing into a session the roster lists as running steers it instead of starting a second turn', async () => {
  assert.deepEqual(await composer({ rosterStatus: 'working', canSteer: true }), ['steer']);
  assert.deepEqual(await composer({ rosterStatus: 'running', canSteer: true }), ['steer']);
});

test('without steering the text is queued behind the run, never sent beside it', async () => {
  assert.deepEqual(await composer({ rosterStatus: 'working', canSteer: false }), ['queue']);
  assert.deepEqual(await composer({ rosterStatus: 'waiting', canSteer: false }), ['queue']);
});

test('a session that is running for another reason than its own turn never gets a concurrent send either', async () => {
  // The panel's own attach (another window's run it follows) counts as running.
  assert.deepEqual(await composer({ rosterStatus: 'idle', attach: { sessionId: 'A' } }), ['steer']);
  // An empty draft with a running session does nothing at all.
  assert.deepEqual(await composer({ rosterStatus: 'working', draft: '   ' }), []);
});

test('an idle session, or one live only through its subagents, takes the turn normally', async () => {
  assert.deepEqual(await composer({ rosterStatus: 'idle' }), ['ask:bro stop']);
  assert.deepEqual(await composer({ rosterStatus: 'idle', children: [{ id: 's', status: 'running' }] }), ['ask:bro stop']);
});

test('the Stop control and the busy label follow the same running verdict', () => {
  const running = composerControlState({ connected: true, sending: true, draftText: '', canSteer: true });
  assert.equal(running.controls.stop.hidden, false, 'Stop is reachable while the gateway still runs the session');
  assert.equal(running.controls.inlineSend.hidden, true, 'and the plain Send is not');
  assert.equal(busyComposerSubmitAction({ sending: true, draftText: 'stop', canSteer: true }), 'steer');
  const idle = composerControlState({ connected: true, sending: false, draftText: 'stop', canSteer: true });
  assert.equal(idle.controls.stop.hidden, true);
});

test('the keyboard path asks the same running verdict, so Enter cannot start the second turn either', () => {
  const keydown = between("els.input.addEventListener('keydown'", "els.input.addEventListener('paste'");
  assert.match(keydown, /sending: viewedSessionIsRunning\(\)/);
  assert.match(source, /if \(viewedSessionIsRunning\(\)\) \{\s*const action = busyComposerSubmitAction\(\{\s*sending: true,/);
});
