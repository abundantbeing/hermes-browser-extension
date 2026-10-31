// Review finding 5: a failed "New session in project" must leave the panel on the transport it was on.
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

function harness({ transport, createImpl }) {
  const previousConnection = { id: 'observer-socket' };
  const calls = [];
  const context = vm.createContext({
    activeConversationTransport: transport,
    activeDashboardWsConnection: previousConnection,
    settings: { sessionId: 'S-viewed' },
    sessionLoadRequestId: 1,
    persistBrowserIntroSeen: async () => {},
    detachLiveSession: () => calls.push('detach'),
    createHermesBrowserSession: async (options) => {
      calls.push(['create', options.transport, options.cwd]);
      // What the real function does before it talks to the gateway.
      context.activeConversationTransport = 'dashboard-ws';
      context.activeDashboardWsConnection = { id: 'new-socket' };
      return createImpl(context);
    },
    refreshLiveSessionRoster: async () => { calls.push('roster'); },
    t: (key) => key,
    els: { sessionMenu: { hidden: false }, sessionMenuButton: { setAttribute() {} } },
    showOperationToast() {},
    loadSessions: async () => {},
  });
  vm.runInContext(functionSource('createSessionInProjectFolder'), context);
  return { context, calls, previousConnection };
}

test('a refused create leaves a REST-transport panel on REST with its observer socket', async () => {
  const h = harness({ transport: 'rest', createImpl: () => { throw new Error('folder refused'); } });
  await assert.rejects(h.context.createSessionInProjectFolder({ cwd: '/srv/bad', projectName: 'Bad' }), /folder refused/);
  assert.equal(h.context.activeConversationTransport, 'rest');
  assert.equal(h.context.activeDashboardWsConnection, h.previousConnection);
});

test('a refused create on a dashboard-ws panel keeps it there and asks the roster to re-attach the live run', async () => {
  const h = harness({ transport: 'dashboard-ws', createImpl: () => { throw new Error('socket closed'); } });
  await assert.rejects(h.context.createSessionInProjectFolder({ cwd: '/srv/x', projectName: 'X' }), /socket closed/);
  assert.equal(h.context.activeConversationTransport, 'dashboard-ws');
  assert.equal(h.context.activeDashboardWsConnection, h.previousConnection);
  assert.ok(h.calls.includes('roster'), 'the next roster read re-attaches the run that detach dropped');
});

test('a create that answers "not started" is a failure too', async () => {
  const h = harness({ transport: 'rest', createImpl: () => false });
  await assert.rejects(h.context.createSessionInProjectFolder({ cwd: '/srv/x', projectName: 'X' }), /projects\.new_session\.not_started/);
  assert.equal(h.context.activeConversationTransport, 'rest');
});

test('a created session keeps the dashboard transport the create chose', async () => {
  const h = harness({ transport: 'rest', createImpl: (context) => { context.settings = { sessionId: 'S-new' }; return { id: 'S-new' }; } });
  await h.context.createSessionInProjectFolder({ cwd: '/srv/ok', projectName: 'Ok' });
  assert.equal(h.context.activeConversationTransport, 'dashboard-ws');
  assert.equal(h.context.activeDashboardWsConnection.id, 'new-socket');
});
