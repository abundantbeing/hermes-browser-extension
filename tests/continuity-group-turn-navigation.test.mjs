// D9: opening or creating a regular session must not cancel a foreground group turn. The group runtime
// sends session.interrupt to every member when its signal aborts, so an abort is a cancellation. The
// view detaches (the turn keeps running, reachable again from its room); only an explicit Stop cancels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

// The part of a navigation function that runs before anything is awaited.
function prologue(name, until) {
  const body = functionSource(name);
  const open = body.indexOf('{\n') + 2;
  const stop = body.indexOf(until);
  assert.ok(stop > open, `${name}: ${until} found`);
  return body.slice(open, stop);
}

function world({ liveGroupTurn = true } = {}) {
  const events = [];
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => events.push('aborted'));
  const projection = { roomId: 'room-1', id: 'room-1' };
  const runtime = { name: 'runtime' };
  const context = vm.createContext({
    events,
    scopeRevision: { isCurrent: () => true, current: () => 1 },
    detachLiveSession: () => events.push('detachLiveSession'),
    activeGroupGeneration: 4,
    activeGroupAbortController: liveGroupTurn ? controller : null,
    backgroundGroupTurn: null,
    activeGroupProjection: projection,
    activeGroupRuntime: runtime,
    activeGroupMessages: [{ role: 'user' }],
    activeComposerLease: { id: 'lease' },
    sending: liveGroupTurn,
    updateComposerBusyState: () => {},
    resetActiveGroupTypingIndicator: () => {},
    els: { sessionMenu: { hidden: false }, sessionMenuButton: { setAttribute() {} } },
    sessionLoadRequestId: 0,
  });
  vm.runInContext([
    functionSource('abortAttachedGroupTurn'),
    functionSource('detachActiveGroupTurnForBackground'),
    functionSource('releaseGroupComposer'),
    functionSource('detachGroupTurnForNavigation'),
  ].join('\n'), context);
  return { context, controller, events, projection, runtime };
}

async function run(context, name, until, args = [{ id: 'S2' }]) {
  const text = prologue(name, until);
  // createHermesBrowserSession receives it as a parameter; openHermesSession reads it itself.
  const parameter = text.includes('{ scopeRevisionId =') ? '' : 'const scopeRevisionId = 1;';
  const fn = vm.runInContext(`(async function (...args) { const [selectedSession] = args; ${parameter} ${text} return 'done'; })`, context);
  return fn.apply(null, args);
}

test('opening a session while a group turn is in flight detaches it and does not abort it', async () => {
  const { context, controller, events, projection } = world();
  await run(context, 'openHermesSession', 'const requestId = ++sessionLoadRequestId;');
  assert.equal(controller.signal.aborted, false, 'no abort, so no session.interrupt to the members');
  assert.ok(!events.includes('aborted'));
  const background = vm.runInContext('backgroundGroupTurn', context);
  assert.equal(background?.abortController, controller, 'the turn stays reachable from its room');
  assert.equal(background.roomId, 'room-1');
  assert.equal(background.projection, projection);
  assert.equal(background.generation, 4, 'detached under the generation its callbacks were bound with');
  assert.equal(vm.runInContext('activeGroupAbortController', context), null);
  assert.equal(vm.runInContext('sending', context), false, 'the regular composer is free');
  assert.equal(vm.runInContext('activeGroupProjection', context), null, 'the regular session takes the view');
});

test('creating a session while a group turn is in flight detaches it and does not abort it', async () => {
  const { context, controller } = world();
  await run(context, 'createHermesBrowserSession', 'const preferredBinding', [{ title: 'x' }]);
  assert.equal(controller.signal.aborted, false);
  assert.equal(vm.runInContext('backgroundGroupTurn?.abortController', context), controller);
});

test('with no group turn in flight, navigation just leaves the room', async () => {
  const { context, controller } = world({ liveGroupTurn: false });
  await run(context, 'openHermesSession', 'const requestId = ++sessionLoadRequestId;');
  assert.equal(controller.signal.aborted, false);
  assert.equal(vm.runInContext('backgroundGroupTurn', context), null);
  assert.equal(vm.runInContext('activeGroupProjection', context), null);
});

test('the explicit Stop is what cancels a group turn, and it still does', () => {
  const stop = source.slice(source.indexOf('els.stopButton?.addEventListener'), source.indexOf('els.retryRunStatusButton?.addEventListener'));
  assert.match(stop, /activeGroupAbortController\.abort\(\)/);
});

test('neither navigation function aborts the group controller itself any more', () => {
  for (const name of ['openHermesSession', 'createHermesBrowserSession']) {
    const head = functionSource(name).split('\n').slice(0, 40).join('\n');
    assert.match(head, /detachGroupTurnForNavigation\(\)/, `${name} detaches`);
    assert.ok(head.indexOf('detachGroupTurnForNavigation()') < head.indexOf('activeGroupGeneration += 1'), `${name} detaches under the room's own generation`);
    assert.doesNotMatch(head.replace(/detachGroupTurnForNavigation\(\)/g, ''), /\.abort\(\)/);
  }
});
