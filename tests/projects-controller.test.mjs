import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectsController } from '../extension/lib/projects-controller.mjs';

const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

const folder = (path) => ({ path, label: null, is_primary: true, added_at: 1790000000 });
const wireProject = (id, name, path) => ({
  id, slug: name.toLowerCase(), name, description: null, icon: null, color: null, board_slug: null,
  primary_path: path, archived: false, created_at: 1790000000, folders: [folder(path)],
});
const wireNode = (id, label, path, extra = {}) => ({
  id, label, path, color: null, icon: null, isAuto: false, isNoProject: false, sessionCount: 1, lastActive: 1790000500,
  totalTokens: 0, totalCostUsd: 0, repos: [], previewSessions: [], sessionIds: [], ...extra,
});
const wireSession = (id, cwd) => ({
  id, title: `Title ${id}`, preview: null, source: 'browser', model: 'm', started_at: 1790000000, last_active: 1790000400,
  message_count: 3, is_active: false, cwd, git_branch: 'main', git_repo_root: cwd, profile: 'work',
});

// A gateway holding profile-scoped projects and sessions, with the contract
// behaviour the controller depends on: projects.create refuses a duplicate
// primary folder (5063) but allows a repeated name, and session.mutate needs
// both fences and refuses a running session.
function fakeGateway({ profile = 'work', executionState = 'idle', cwd = '/srv/scratch' } = {}) {
  const state = {
    projects: [wireProject('p_a', 'Atlas', '/srv/atlas'), wireProject('p_b', 'Beta', '/srv/beta')],
    session: { cwd, revision: 4, generation: 1, executionState },
    calls: [],
    dropCreateAnswer: false,
    receipts: new Map(),
  };
  const sessionRows = () => state.projects.map((project) => ({ project, rows: state.session.cwd.startsWith(project.primary_path) ? [wireSession('S1', state.session.cwd)] : [] }));
  const request = async (method, params) => {
    state.calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'projects.list':
        return { projects: state.projects, active_id: null };
      case 'projects.tree':
        return {
          projects: state.projects.map((project) => wireNode(project.id, project.name, project.primary_path, {
            sessionCount: state.session.cwd.startsWith(project.primary_path) ? 1 : 0,
          })),
          active_id: null,
          scoped_session_ids: [],
        };
      case 'projects.project_sessions': {
        const project = state.projects.find((item) => item.id === params.project_id);
        if (!project) throw rpcError(5062, 'no such project', { reason: 'no_project' });
        const rows = sessionRows().find((entry) => entry.project.id === project.id).rows;
        return { project: wireNode(project.id, project.name, project.primary_path, { sessionCount: rows.length, previewSessions: rows }) };
      }
      case 'projects.create': {
        if (state.projects.some((project) => project.primary_path === params.primary_path)) {
          throw rpcError(5063, "folder already belongs to project 'atlas' (p_a); switch to it instead of creating a duplicate");
        }
        const created = wireProject(`p_${state.projects.length + 1}`, params.name, params.primary_path);
        state.projects.push(created);
        if (state.dropCreateAnswer) {
          state.dropCreateAnswer = false;
          throw new Error('WebSocket is not open');
        }
        return { project: created };
      }
      case 'projects.for_cwd': {
        const project = state.projects.find((item) => params.cwd.startsWith(item.primary_path));
        return { project: project || null, cwd: params.cwd, branch: '' };
      }
      case 'session.resume':
        return {
          session_id: 'S1', stored_session_id: 'S1', messages: [], message_count: 3, running: state.session.executionState === 'running',
          revision: state.session.revision, execution_generation: state.session.generation, execution_state: state.session.executionState,
          info: { cwd: state.session.cwd, profile_name: profile, title: 'Fix login' },
        };
      case 'session.mutate': {
        const replay = state.receipts.get(params.request_id);
        if (replay) return replay;
        if (state.session.executionState === 'running') throw rpcError(4090, 'session_busy', { reason: 'session_busy' });
        if (!['/srv/atlas', '/srv/beta', '/srv/free'].includes(params.payload.cwd)) throw rpcError(4001, 'invalid_params', { reason: 'invalid_params' });
        state.session.revision += 1;
        state.session.cwd = params.payload.cwd;
        const receipt = { session_id: 'S1', operation: 'workspace', revision: state.session.revision, execution_generation: state.session.generation };
        state.receipts.set(params.request_id, receipt);
        return receipt;
      }
      default:
        throw rpcError(-32601, 'method not found', { reason: 'unknown_method' });
    }
  };
  return { state, request };
}

function harness(overrides = {}) {
  const gateway = overrides.gateway || fakeGateway(overrides.gatewayOptions);
  const context = {
    endpoint: 'https://hermes.example.com',
    principal: 'github:42:-',
    profile: 'work',
    dashboardWs: true,
    ready: READY,
    token: { id: 1 },
    ...overrides.context,
  };
  const events = { changes: 0, opened: [], created: [], moved: [] };
  const controller = createProjectsController({
    getConnection: () => ({
      token: context.token,
      identityInput: { endpoint: context.endpoint, principal: context.principal, profile: context.profile },
      dashboardWs: context.dashboardWs,
      request: (method, params) => gateway.request(method, params),
      getReadyPayload: () => context.ready,
    }),
    openSession: (session) => events.opened.push(session),
    createSessionInFolder: async (args) => { events.created.push(args); },
    onSessionMoved: (move) => events.moved.push(move),
    onChange: () => { events.changes += 1; },
  });
  return { controller, gateway, context, events };
}

const methods = (gateway) => gateway.state.calls.map((call) => call.method);

test('activate loads the list and the tree under the connection identity', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  const { state } = controller;
  assert.equal(state.list.status, 'ready');
  assert.deepEqual(state.list.rows.map((row) => row.name), ['Atlas', 'Beta']);
  assert.deepEqual(state.scope, { profile: 'work', endpoint: 'https://hermes.example.com' });
  assert.deepEqual(gateway.state.calls.map((call) => call.params.profile), ['work', 'work']);
});

test('a REST-only connection shows the exact reason and sends nothing', async () => {
  const { controller, gateway } = harness({ context: { dashboardWs: false, ready: null } });
  await controller.activate();
  assert.equal(controller.state.list.status, 'unavailable');
  assert.equal(controller.state.list.failure.reason, 'rest-only');
  assert.equal(gateway.state.calls.length, 0);
  assert.equal(controller.availability().reason, 'rest-only');
});

test('a gateway without session authority and a socket still connecting are different reasons', async () => {
  const legacy = harness({ context: { ready: { replay_epoch: 'ep1' } } });
  await legacy.controller.activate();
  assert.equal(legacy.controller.state.list.failure.reason, 'no-session-authority');
  const waiting = harness({ context: { ready: null } });
  await waiting.controller.activate();
  assert.equal(waiting.controller.state.list.failure.reason, 'not-connected');
});

test('switching profile or host drops the previous identity and never mixes the lists', async () => {
  const { controller, context } = harness();
  await controller.activate();
  await controller.openProject('p_a');
  assert.equal(controller.state.view, 'project');
  context.profile = 'personal';
  context.endpoint = 'https://other.example.com';
  controller.resolve();
  assert.equal(controller.state.view, 'list');
  assert.deepEqual(controller.state.list.rows, []);
  assert.equal(controller.state.list.status, 'idle');
  assert.deepEqual(controller.state.scope, { profile: 'personal', endpoint: 'https://other.example.com' });
});

test('an answer that arrives after the identity changed is discarded', async () => {
  const gateway = fakeGateway();
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (method === 'projects.list') await slow;
    return original(method, params);
  };
  const { controller, context } = harness({ gateway });
  const pending = controller.activate();
  await wait();
  context.profile = 'personal';
  controller.resolve();
  release();
  await pending;
  assert.equal(controller.state.list.status, 'idle', 'the stale read did not populate the new identity');
  assert.deepEqual(controller.state.list.rows, []);
});

test('opening a project loads its sessions; an unknown project reports not-found', async () => {
  const { controller } = harness({ gatewayOptions: { cwd: '/srv/atlas/src' } });
  await controller.activate();
  await controller.openProject('p_a');
  assert.equal(controller.state.project.status, 'ready');
  assert.equal(controller.state.project.name, 'Atlas');
  await controller.openProject('p_missing');
  assert.equal(controller.state.project.status, 'error');
  assert.equal(controller.state.project.failure.reason, 'not-found');
  controller.back();
  assert.equal(controller.state.view, 'list');
});

test('late project creation preserves newer draft and records the committed result', async () => {
  const gateway = fakeGateway();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (method === 'projects.create') { entered(); await gate; }
    return original(method, params);
  };
  const { controller } = harness({ gateway });
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Gamma');
  controller.updateCreate('path', '/srv/gamma');
  const pending = controller.submitCreate();
  await started;
  controller.back();
  controller.startCreate();
  controller.updateCreate('name', 'New draft');
  release();
  await pending;
  assert.equal(controller.state.view, 'create');
  assert.equal(controller.state.create.name, 'New draft');
  assert.equal(controller.state.notice.key, 'projects.create.done');
  assert.ok(controller.state.list.rows.some((row) => row.name === 'Gamma'));
});

for (const outcome of ['refused', 'lost']) {
  test(`late ${outcome} create retains the newer draft and reports its outcome`, async () => {
    const gateway = fakeGateway();
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const original = gateway.request;
    gateway.request = async (method, params) => {
      if (method === 'projects.create') {
        entered();
        await gate;
        if (outcome === 'refused') throw rpcError(5063, 'duplicate');
        gateway.state.dropCreateAnswer = true;
      }
      return original(method, params);
    };
    const { controller } = harness({ gateway });
    await controller.activate();
    controller.startCreate();
    controller.updateCreate('name', 'Gamma');
    controller.updateCreate('path', '/srv/gamma');
    const pending = controller.submitCreate();
    await started;
    controller.resetView();
    controller.startCreate();
    controller.updateCreate('name', 'New draft');
    release();
    await pending;
    assert.equal(controller.state.view, 'create');
    assert.equal(controller.state.create.name, 'New draft');
    assert.equal(controller.state.notice.tone, outcome === 'lost' ? 'ok' : 'error');
    if (outcome === 'lost') assert.ok(controller.state.list.rows.some((row) => row.name === 'Gamma'));
  });
}

test('Back during the post-create list refresh prevents automatic project navigation', async () => {
  const gateway = fakeGateway();
  let entered;
  let release;
  let block = false;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (block && method === 'projects.list') { entered(); await gate; }
    return original(method, params);
  };
  const { controller } = harness({ gateway });
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Gamma');
  controller.updateCreate('path', '/srv/gamma');
  block = true;
  const pending = controller.submitCreate();
  await started;
  controller.back();
  release();
  await pending;
  assert.equal(controller.state.view, 'list');
  assert.equal(controller.state.notice.key, 'projects.create.done');
});

test('create sends the folder as primary, refreshes, and opens the new project', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Gamma');
  controller.updateCreate('path', '/srv/gamma');
  await controller.submitCreate();
  const create = gateway.state.calls.find((call) => call.method === 'projects.create');
  assert.deepEqual(create.params, { name: 'Gamma', folders: ['/srv/gamma'], primary_path: '/srv/gamma', profile: 'work' });
  assert.equal(controller.state.view, 'project');
  assert.equal(controller.state.project.name, 'Gamma');
  assert.equal(controller.state.notice.key, 'projects.create.done');
  assert.ok(controller.state.list.rows.some((row) => row.name === 'Gamma'));
});

test('create validates before sending and does not double-submit', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  controller.startCreate();
  await controller.submitCreate();
  assert.equal(methods(gateway).includes('projects.create'), false);
  assert.equal(controller.state.create.touched, true);

  controller.updateCreate('name', 'Atlas copy');
  controller.updateCreate('path', '/srv/atlas');
  assert.equal(controller.draftCheck().errors.path, 'projects.create.error.path_in_use');
  await controller.submitCreate();
  assert.equal(methods(gateway).includes('projects.create'), false, 'a folder that is already a project is caught before the gateway');

  controller.updateCreate('path', '/srv/gamma');
  const first = controller.submitCreate();
  const second = controller.submitCreate();
  await Promise.all([first, second]);
  assert.equal(methods(gateway).filter((name) => name === 'projects.create').length, 1);
});

test('a duplicate name is created as a second project and both stay distinct', async () => {
  const { controller } = harness();
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Atlas');
  controller.updateCreate('path', '/srv/clients/atlas');
  assert.equal(controller.draftCheck().warnings.name, 'projects.create.warn.name_duplicate');
  await controller.submitCreate();
  const atlases = controller.state.list.rows.filter((row) => row.name === 'Atlas');
  assert.equal(atlases.length, 2);
  assert.notEqual(atlases[0].id, atlases[1].id);
  assert.ok(atlases.every((row) => row.disambiguator));
});

test('a create whose answer was lost is recognised on re-read instead of failing as a duplicate', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  gateway.state.dropCreateAnswer = true;
  controller.startCreate();
  controller.updateCreate('name', 'Gamma');
  controller.updateCreate('path', '/srv/gamma');
  await controller.submitCreate();
  assert.equal(controller.state.create, null);
  assert.equal(controller.state.notice.key, 'projects.create.done');
  assert.equal(gateway.state.calls.filter((call) => call.method === 'projects.create').length, 1);
});

test('a gateway refusal of the create is shown as an error and keeps the form', async () => {
  const gateway = fakeGateway();
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (method === 'projects.create') throw rpcError(5063, 'folder is a home directory');
    return original(method, params);
  };
  const { controller } = harness({ gateway });
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Home');
  controller.updateCreate('path', '/home/ana');
  await controller.submitCreate();
  assert.equal(controller.state.view, 'create');
  assert.equal(controller.state.create.status, 'editing');
  assert.equal(controller.state.create.error.reason, 'invalid-argument');
  assert.match(controller.state.create.error.detail, /home directory/);
});

test('move: the receipt is read back before the UI says it moved, then the lists refresh', async () => {
  const { controller, gateway, events } = harness();
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p_a');
  await controller.confirmMove();
  const order = methods(gateway);
  assert.ok(order.indexOf('session.resume') < order.indexOf('session.mutate'), 'fences are read first');
  assert.ok(order.lastIndexOf('session.resume') > order.indexOf('session.mutate'), 'and the result is read back');
  assert.equal(order.includes('session.workspace.move'), false);
  const mutate = gateway.state.calls.find((call) => call.method === 'session.mutate');
  assert.equal(mutate.params.operation, 'workspace');
  assert.deepEqual(mutate.params.payload, { cwd: '/srv/atlas' });
  assert.equal(controller.state.move.step, 'result');
  assert.equal(controller.state.move.outcome.status, 'moved');
  assert.equal(controller.state.move.session.cwd, '/srv/atlas');
  assert.deepEqual(events.moved, [{ sessionId: 'S1', cwd: '/srv/atlas', previousCwd: '/srv/scratch' }]);
  const atlas = controller.state.list.rows.find((row) => row.id === 'p_a');
  assert.equal(atlas.sessionCount, 1, 'the list was re-read after the move');
});

test('move: a running turn asks first, sends nothing, and a confirmed attempt is still decided by the gateway', async () => {
  const { controller, gateway, events } = harness({ gatewayOptions: { executionState: 'running' } });
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Busy', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p_b');
  await controller.confirmMove();
  assert.equal(controller.state.move.step, 'confirm-live');
  assert.equal(methods(gateway).includes('session.mutate'), false, 'nothing is sent before the confirmation');

  controller.cancelLiveConfirm();
  assert.equal(controller.state.move.step, 'choose');
  assert.equal(methods(gateway).includes('session.mutate'), false);

  await controller.confirmMove();
  assert.equal(controller.state.move.step, 'confirm-live');
  await controller.confirmMove();
  assert.equal(methods(gateway).filter((name) => name === 'session.mutate').length, 1);
  assert.equal(controller.state.move.step, 'result');
  assert.equal(controller.state.move.outcome.status, 'busy');
  assert.equal(events.moved.length, 0);
  assert.equal(gateway.state.session.cwd, '/srv/scratch', 'the busy session did not move');
});

test('move to a typed folder: path rules, the for_cwd check, and the unavailable gate', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/atlas/src' });
  controller.setMoveCustomPath('relative');
  await controller.confirmMove();
  assert.equal(controller.state.move.pathError, 'projects.move.path_invalid');
  assert.equal(methods(gateway).includes('session.mutate'), false);

  controller.setMoveCustomPath('/srv/free');
  await controller.checkCustomFolder();
  assert.deepEqual(controller.state.move.folderCheck, { status: 'ok', projectName: '', cwd: '/srv/free' });
  controller.setMoveCustomPath('/srv/beta/x');
  await controller.checkCustomFolder();
  assert.equal(controller.state.move.folderCheck.projectName, 'Beta');

  controller.setMoveCustomPath('/srv/free');
  await controller.confirmMove();
  assert.equal(controller.state.move.outcome.status, 'moved');
  assert.equal(controller.state.move.session.cwd, '/srv/free');
});

test('move on a connection without authority is refused with its reason and sends nothing', async () => {
  const { controller, gateway } = harness({ context: { dashboardWs: false, ready: null } });
  await controller.startMove({ id: 'S1', title: 'x', cwd: '' });
  controller.setMoveCustomPath('/srv/free');
  await controller.confirmMove();
  assert.equal(controller.state.move.outcome.status, 'unavailable');
  assert.equal(controller.state.move.outcome.unavailableReason, 'rest-only');
  assert.equal(gateway.state.calls.length, 0);
});

test('new session in a project hands its folder to the panel, and reports a failure', async () => {
  const { controller, events } = harness();
  await controller.activate();
  await controller.openProject('p_b');
  assert.equal(await controller.newSessionInProject(), true);
  assert.deepEqual(events.created, [{ cwd: '/srv/beta', projectName: 'Beta' }]);

  const failing = createProjectsController({
    getConnection: () => null,
    openSession() {},
    createSessionInFolder: async () => { throw new Error('boom'); },
  });
  assert.equal(await failing.newSessionInProject({ cwd: '/x', name: 'X' }), false);
  assert.equal(failing.state.notice.key, 'projects.new_session.failed');
  assert.equal(failing.state.notice.params.detail, 'boom');
});

test('opening a project session goes through the panel callback', async () => {
  const { controller, events } = harness();
  await controller.openProjectSession({ id: 'S1', title: 'Fix login' });
  assert.deepEqual(events.opened, [{ id: 'S1', title: 'Fix login' }]);
});

test('a move started inside a project keeps its result on screen while the project re-reads', async () => {
  const { controller } = harness({ gatewayOptions: { cwd: '/srv/atlas/src' } });
  await controller.activate();
  await controller.openProject('p_a');
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/atlas/src' }, { returnTo: 'project' });
  controller.chooseMoveTarget('p_b');
  await controller.confirmMove();
  assert.equal(controller.state.view, 'move', 'the confirmation is not replaced by the refreshed project');
  assert.equal(controller.state.move.outcome.status, 'moved');
  assert.equal(controller.state.project.status, 'ready');
  assert.equal(controller.state.project.node.sessionCount, 0, 'the project it left no longer holds the session');
  controller.back();
  assert.equal(controller.state.view, 'project');
});

test('Back from a move started in Recents hands control back to Recents', async () => {
  const calls = [];
  const gateway = fakeGateway();
  const controller = createProjectsController({
    getConnection: () => ({
      token: 1,
      identityInput: { endpoint: 'https://hermes.example.com', principal: 'u', profile: 'work' },
      dashboardWs: true,
      request: gateway.request,
      getReadyPayload: () => READY,
    }),
    openSession() {},
    createSessionInFolder: async () => {},
    onReturnToRecents: () => calls.push('recents'),
  });
  await controller.startMove({ id: 'S1', title: 'x', cwd: '' }, { returnTo: 'recents' });
  controller.back();
  assert.deepEqual(calls, ['recents']);
  assert.equal(controller.state.view, 'list');
});

test('resetView returns to the project list but keeps the loaded rows', async () => {
  const { controller } = harness();
  await controller.activate();
  await controller.openProject('p_a');
  controller.setQuery('x');
  controller.resetView();
  assert.equal(controller.state.view, 'list');
  assert.equal(controller.state.project, null);
  assert.equal(controller.state.query, '');
  assert.equal(controller.state.list.rows.length, 2);
});

test('a lost move answer is reconciled by reading, never by a blind second write', async () => {
  const gateway = fakeGateway();
  const original = gateway.request;
  let mutates = 0;
  let dropNext = true;
  gateway.request = async (method, params) => {
    if (method === 'session.mutate') {
      mutates += 1;
      const receipt = await original(method, params);
      if (dropNext) {
        dropNext = false;
        throw new Error('WebSocket is not open');
      }
      return receipt;
    }
    return original(method, params);
  };
  const { controller, events } = harness({ gateway });
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p_a');
  await controller.confirmMove();
  assert.equal(mutates, 1);
  assert.equal(controller.state.move.outcome.status, 'moved', 'the write landed and was found by reading');
  assert.equal(events.moved.length, 1);
});

// A move that is in flight can outlive the view that started it: Back, a reopened drawer, another
// session's Move pill. The gateway still commits it, so the panel must still learn about it.
function gatedGateway(options) {
  const gateway = fakeGateway(options);
  const original = gateway.request;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let started = () => {};
  const mutateStarted = new Promise((resolve) => { started = resolve; });
  let holdMutate = true;
  gateway.request = async (method, params) => {
    if (method === 'session.mutate' && holdMutate) {
      holdMutate = false;
      const receipt = await original(method, params);
      started();
      await gate;
      return receipt;
    }
    return original(method, params);
  };
  return { gateway, release: () => release(), mutateStarted };
}

test('move: Back and a drawer reopen do nothing while a move is working', async () => {
  const { gateway, release, mutateStarted } = gatedGateway();
  const { controller, events } = harness({ gateway });
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p_a');
  const done = controller.confirmMove();
  await mutateStarted;
  assert.equal(controller.state.move.step, 'working');
  controller.back();
  controller.resetView();
  assert.equal(controller.state.view, 'move', 'the move view stays until the gateway answers');
  assert.equal(controller.state.move.step, 'working');
  release();
  await done;
  assert.equal(controller.state.move.outcome.status, 'moved');
  assert.equal(events.moved.length, 1);
});

test('move: a committed result still reaches Recents and the caches when the view moved on', async () => {
  const { gateway, release, mutateStarted } = gatedGateway();
  const { controller, events } = harness({ gateway });
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p_a');
  const done = controller.confirmMove();
  await mutateStarted;
  // Another session's Move pill (Recents) replaces the move view while the first is still committing.
  await controller.startMove({ id: 'S2', title: 'Other', cwd: '/srv/scratch' });
  const listCallsBefore = methods(gateway).filter((method) => method === 'projects.list').length;
  release();
  await done;
  assert.deepEqual(events.moved, [{ sessionId: 'S1', cwd: '/srv/atlas', previousCwd: '/srv/scratch' }], 'Recents learns the new folder');
  assert.ok(methods(gateway).filter((method) => method === 'projects.list').length > listCallsBefore, 'the project list is re-read');
  assert.equal(controller.state.move.session.id, 'S2', 'the other session\'s move view is untouched');
  assert.equal(controller.state.notice.key, 'projects.move.done');
});

test('move: an uncertain result is shown as a notice when the view moved on', async () => {
  const gateway = fakeGateway();
  const original = gateway.request;
  let afterMutate = false;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let started = () => {};
  const mutateStarted = new Promise((resolve) => { started = resolve; });
  gateway.request = async (method, params) => {
    if (afterMutate) throw new Error('WebSocket is not open');
    if (method === 'session.mutate') {
      afterMutate = true;
      await original(method, params);
      started();
      await gate;
      throw new Error('WebSocket is not open');
    }
    return original(method, params);
  };
  const { controller, events } = harness({ gateway });
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p_a');
  const done = controller.confirmMove();
  await mutateStarted;
  await controller.startMove({ id: 'S2', title: 'Other', cwd: '/srv/scratch' });
  release();
  await done;
  assert.equal(events.moved.length, 0, 'nothing was confirmed');
  assert.equal(controller.state.notice?.tone, 'error');
  assert.equal(controller.state.notice?.key, 'projects.move.indeterminate');
});
