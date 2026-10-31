// Create project like Desktop's New project dialog (name, folders, idea, Generate idea) and the host-folder
// picker for it and for a session's Move, over the same socket the Projects tab already uses.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectsController } from '../extension/lib/projects-controller.mjs';
import { buildIdeaParams, IDEA_INSTRUCTIONS } from '../extension/lib/projects-client.mjs';
import { validateProjectDraft } from '../extension/lib/projects-view.mjs';

const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const TOKEN = { id: 1 };
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

const wireProject = (id, name, path) => ({
  id, slug: name.toLowerCase(), name, description: null, icon: null, color: null, board_slug: null,
  primary_path: path, archived: false, created_at: 1790000000,
  folders: [{ path, label: null, is_primary: true, added_at: 1790000000 }],
});
const wireNode = (id, label, path) => ({
  id, label, path, color: null, icon: null, isAuto: false, isNoProject: false, sessionCount: 0, lastActive: 0,
  totalTokens: 0, totalCostUsd: 0, repos: [], previewSessions: [], sessionIds: [],
});

// The host's directory tree as complete.path serves it: folders under a directory whose name starts with the prefix.
const TREE = {
  '/': ['home', 'srv'],
  '/home': ['ana'],
  '/home/ana': ['code', 'docs', 'music'],
  '/home/ana/code': ['api', 'web'],
  '/srv': ['atlas', 'beta'],
};

function fakeGateway({ listFolders = true, idea = 'A weather bot.\n\n- Goal one', ideaFails = false } = {}) {
  const state = { projects: [wireProject('p_a', 'Atlas', '/srv/atlas')], calls: [] };
  const request = async (method, params) => {
    state.calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'projects.list':
        return { projects: state.projects, active_id: null };
      case 'projects.tree':
        return { projects: state.projects.map((p) => wireNode(p.id, p.name, p.primary_path)), active_id: null, scoped_session_ids: [] };
      case 'projects.project_sessions': {
        const project = state.projects.find((item) => item.id === params.project_id);
        return { project: wireNode(project.id, project.name, project.primary_path) };
      }
      case 'projects.create': {
        const created = wireProject(`p_${state.projects.length + 1}`, params.name, params.primary_path);
        created.folders = (params.folders || []).map((path, index) => ({ path, label: null, is_primary: index === 0, added_at: 1 }));
        state.projects.push(created);
        return { project: created };
      }
      case 'projects.for_cwd':
        if (params.cwd === '~') return { project: null, cwd: '/home/ana', branch: '' };
        return { project: null, cwd: params.cwd || '/home/ana/code', branch: '' };
      case 'projects.discover_repos':
        return { repos: [{ root: '/srv/atlas', label: 'Atlas', sessions: 2, last_active: 5 }] };
      case 'complete.path': {
        if (!listFolders) throw rpcError(-32601, 'unknown method', { reason: 'unknown_method' });
        const match = /^@folder:(.*)\/([^/]*)$/.exec(params.word);
        const dir = match[1] || '/';
        const names = (TREE[dir] || []).filter((name) => name.startsWith(match[2]));
        return { items: names.map((name) => ({ text: `@folder:${name}/`, display: `${name}/`, meta: 'dir' })) };
      }
      case 'llm.oneshot':
        if (ideaFails) throw new Error('Hermes could not generate that');
        return { text: idea };
      default:
        throw rpcError(-32601, 'method not found', { reason: 'unknown_method' });
    }
  };
  return { state, request };
}

function harness(options = {}) {
  const gateway = fakeGateway(options);
  const created = [];
  const controller = createProjectsController({
    getConnection: () => ({
      token: TOKEN,
      identityInput: { endpoint: 'https://hermes.example.com', principal: 'github:42:-', profile: 'work' },
      dashboardWs: true,
      request: (method, params) => gateway.request(method, params),
      getReadyPayload: () => READY,
      getSessionId: () => 'S1',
    }),
    openSession: () => {},
    createSessionInFolder: async (args) => { created.push(args); },
  });
  return { controller, gateway, created };
}

const calls = (gateway, method) => gateway.state.calls.filter((call) => call.method === method);

test('the idea request is Desktop\'s: one stateless llm.oneshot, steered by the name', () => {
  assert.deepEqual(buildIdeaParams({ profile: 'work', name: ' Weather ' }), {
    instructions: IDEA_INSTRUCTIONS, input: 'Project name: Weather', temperature: 1, profile: 'work',
  });
  assert.equal(buildIdeaParams({}).input, 'Surprise me with a fun project.');
  assert.match(IDEA_INSTRUCTIONS, /IDEA\.md body/);
});

test('a draft counts the added folders and the typed one, the first being primary', () => {
  const rows = [{ kind: 'project', name: 'Atlas', path: '/srv/atlas', id: 'p_a' }];
  assert.equal(validateProjectDraft({ name: 'x', folders: ['/a', '/b'], path: '' }, rows).ok, true);
  assert.equal(validateProjectDraft({ name: 'x', folders: [], path: '' }, rows).errors.path, 'projects.create.error.path_required');
  assert.equal(validateProjectDraft({ name: 'x', folders: ['/a', 'rel/b'] }, rows).errors.path, 'projects.create.error.path_invalid');
  assert.equal(validateProjectDraft({ name: 'x', folders: ['/srv/atlas', '/b'] }, rows).errors.path, 'projects.create.error.path_in_use');
  assert.equal(validateProjectDraft({ name: 'x', folders: ['/a', '/srv/atlas'] }, rows).ok, true, 'only the primary folder must be free');
});

test('create sends every folder, the first as primary, and names a nameless project after its first folder', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  controller.startCreate();
  controller.addCreateFolder('/home/ana/code/api');
  assert.equal(controller.state.create.name, 'api');
  controller.addCreateFolder('/home/ana/code/web');
  controller.addCreateFolder('/home/ana/code/web');
  assert.equal(controller.state.create.name, 'api', 'a second folder does not rename it');
  assert.deepEqual(controller.state.create.folders, ['/home/ana/code/api', '/home/ana/code/web']);
  controller.updateCreate('path', '/srv/extra');
  await controller.submitCreate();
  assert.deepEqual(calls(gateway, 'projects.create')[0].params, {
    name: 'api', folders: ['/home/ana/code/api', '/home/ana/code/web', '/srv/extra'], primary_path: '/home/ana/code/api', profile: 'work',
  });
  assert.equal(controller.state.view, 'project');
});

test('a typed name is kept when a folder is added, and folders can be removed', async () => {
  const { controller } = harness();
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Mine');
  controller.addCreateFolder('/srv/a');
  controller.addCreateFolder('/srv/b');
  assert.equal(controller.state.create.name, 'Mine');
  controller.removeCreateFolder('/srv/a/');
  assert.deepEqual(controller.state.create.folders, ['/srv/b']);
  controller.updateCreate('path', 'relative');
  controller.addTypedFolder();
  assert.deepEqual(controller.state.create.folders, ['/srv/b'], 'an invalid typed path is not added');
  assert.equal(controller.state.create.touched, true);
  controller.updateCreate('path', '/srv/c');
  controller.addTypedFolder();
  assert.deepEqual(controller.state.create.folders, ['/srv/b', '/srv/c']);
  assert.equal(controller.state.create.path, '');
});

test('Generate idea fills the idea from llm.oneshot and a failure leaves the text', async () => {
  const ok = harness();
  await ok.controller.activate();
  ok.controller.startCreate();
  ok.controller.updateCreate('name', 'Weather');
  const pending = ok.controller.generateIdea();
  assert.equal(ok.controller.state.create.ideaStatus, 'generating');
  await pending;
  assert.equal(ok.controller.state.create.idea, 'A weather bot.\n\n- Goal one');
  assert.equal(ok.controller.state.create.ideaStatus, 'idle');
  assert.deepEqual(calls(ok.gateway, 'llm.oneshot')[0].params, buildIdeaParams({ profile: 'work', name: 'Weather' }));

  const bad = harness({ ideaFails: true });
  await bad.controller.activate();
  bad.controller.startCreate();
  bad.controller.updateCreate('idea', 'my own words');
  await bad.controller.generateIdea();
  assert.equal(bad.controller.state.create.idea, 'my own words');
  assert.ok(bad.controller.state.create.ideaError);
  assert.equal(bad.controller.state.create.ideaStatus, 'idle');
});

test('a written idea waits on the new project until it is saved as IDEA.md in a session', async () => {
  const { controller, created } = harness();
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Weather');
  controller.addCreateFolder('/srv/weather');
  controller.updateCreate('idea', '  A weather bot.  ');
  await controller.submitCreate();
  assert.equal(controller.state.notice.key, 'projects.create.done_idea');
  assert.deepEqual(controller.state.pendingIdea, { projectId: 'p_2', name: 'Weather', cwd: '/srv/weather', idea: 'A weather bot.' });
  assert.equal(await controller.saveIdea(), true);
  assert.deepEqual(created, [{ cwd: '/srv/weather', projectName: 'Weather', idea: 'A weather bot.' }]);
  assert.equal(controller.state.pendingIdea, null);
});

test('no idea means no pending save, and a failed save keeps it for another try', async () => {
  const plain = harness();
  await plain.controller.activate();
  plain.controller.startCreate();
  plain.controller.updateCreate('name', 'Plain');
  plain.controller.addCreateFolder('/srv/plain');
  await plain.controller.submitCreate();
  assert.equal(plain.controller.state.pendingIdea, null);
  assert.equal(plain.controller.state.notice.key, 'projects.create.done');

  const gateway = fakeGateway();
  const controller = createProjectsController({
    getConnection: () => ({
      token: TOKEN,
      identityInput: { endpoint: 'https://hermes.example.com', principal: 'p', profile: 'work' },
      dashboardWs: true,
      request: (method, params) => gateway.request(method, params),
      getReadyPayload: () => READY,
    }),
    openSession: () => {},
    createSessionInFolder: async () => { throw new Error('folder refused'); },
  });
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'W');
  controller.addCreateFolder('/srv/w');
  controller.updateCreate('idea', 'x');
  await controller.submitCreate();
  assert.equal(await controller.saveIdea(), false);
  assert.ok(controller.state.pendingIdea, 'kept');
  assert.equal(controller.state.notice.key, 'projects.new_session.failed');
});

// ---- Picker -------------------------------------------------------------------

test('the picker opens at the host home, lists folders only, navigates, and chooses into the create form', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  const { picker } = controller.state;
  assert.equal(controller.state.view, 'picker');
  assert.equal(picker.path, '/home/ana');
  assert.deepEqual(picker.folders.map((f) => f.name), ['code', 'docs', 'music']);
  assert.deepEqual(picker.roots.map((r) => r.kind), ['home', 'default', 'repo']);
  const list = calls(gateway, 'complete.path')[0];
  assert.deepEqual(list.params, { word: '@folder:/home/ana/', session_id: 'S1', profile: 'work' });
  await controller.pickerNavigate('/home/ana/code');
  assert.deepEqual(controller.state.picker.folders.map((f) => f.path), ['/home/ana/code/api', '/home/ana/code/web']);
  controller.pickerChoose();
  assert.equal(controller.state.view, 'create');
  assert.equal(controller.state.picker, null);
  assert.deepEqual(controller.state.create.folders, ['/home/ana/code']);
  assert.equal(controller.state.create.name, 'code');
});

test('Back from the picker returns to the form, not the list', async () => {
  const { controller } = harness();
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Keep');
  await controller.openFolderPicker('create');
  controller.back();
  assert.equal(controller.state.view, 'create');
  assert.equal(controller.state.create.name, 'Keep');
});

test('the filter narrows at once and re-reads the host only when a full page might hide more', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  const before = calls(gateway, 'complete.path').length;
  await controller.pickerFilter('do');
  assert.equal(controller.state.picker.filter, 'do');
  assert.equal(calls(gateway, 'complete.path').length, before, 'a short page is complete, so no re-read');
});

test('a full page is re-read by prefix on the host', async () => {
  const gateway = fakeGateway();
  const big = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  TREE['/big'] = big;
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (method === 'complete.path' && params.word.startsWith('@folder:/big/')) {
      gateway.state.calls.push({ method, params: structuredClone(params) });
      const prefix = params.word.slice('@folder:/big/'.length);
      const names = big.filter((n) => n.startsWith(prefix)).slice(0, 30);
      return { items: names.map((name) => ({ text: name, display: `${name}/`, meta: 'dir' })) };
    }
    return original(method, params);
  };
  const controller = createProjectsController({
    getConnection: () => ({
      token: TOKEN, identityInput: { endpoint: 'https://h.example.com', principal: 'p', profile: 'work' }, dashboardWs: true,
      request: (m, p) => gateway.request(m, p), getReadyPayload: () => READY,
    }),
    openSession: () => {}, createSessionInFolder: async () => {},
  });
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  await controller.pickerNavigate('/big');
  assert.equal(controller.state.picker.truncated, true);
  await controller.pickerFilter('d1');
  assert.equal(calls(gateway, 'complete.path').at(-1).params.word, '@folder:/big/d1');
  assert.equal(controller.state.picker.folders.length, 10);
  delete TREE['/big'];
});

test('a typed path in the picker is validated, then browsed', async () => {
  const { controller } = harness();
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  controller.pickerSetTyped('relative/path');
  await controller.pickerGo();
  assert.equal(controller.state.picker.pathError, 'projects.move.path_invalid');
  controller.pickerSetTyped('/srv');
  await controller.pickerGo();
  assert.equal(controller.state.picker.path, '/srv');
  assert.deepEqual(controller.state.picker.folders.map((f) => f.name), ['atlas', 'beta']);
});

test('a gateway that cannot list folders says so and still offers the typed path', async () => {
  const { controller } = harness({ listFolders: false });
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  const { picker } = controller.state;
  assert.equal(picker.status, 'error');
  assert.equal(picker.failure.key, 'projects.picker.unsupported');
  assert.equal(picker.roots.length, 3, 'the host still resolves its home, default and repos');
  controller.pickerSetTyped('/srv/atlas');
  controller.pickerChoose();
  assert.equal(controller.state.view, 'create', 'the typed path is the choice when the host cannot be browsed');
  assert.deepEqual(controller.state.create.folders, ['/srv/atlas']);
});

test('Move: Another folder opens the picker beside the session folder and a choice fills the path and checks it', async () => {
  const { controller, gateway } = harness();
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix login', cwd: '/srv/atlas' });
  controller.chooseMoveTarget('custom');
  await controller.openFolderPicker('move');
  assert.equal(controller.state.picker.path, '/srv/atlas');
  await controller.pickerNavigate('/srv');
  await controller.pickerNavigate('/srv/beta');
  controller.pickerChoose();
  assert.equal(controller.state.view, 'move');
  assert.equal(controller.state.move.targetId, 'custom');
  assert.equal(controller.state.move.customPath, '/srv/beta');
  await wait();
  assert.equal(calls(gateway, 'projects.for_cwd').at(-1).params.cwd, '/srv/beta');
});

test('an answer for a picker the person already left is dropped', async () => {
  const gateway = fakeGateway();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = gateway.request;
  gateway.request = async (method, params) => {
    if (method === 'complete.path') await gate;
    return original(method, params);
  };
  const controller = createProjectsController({
    getConnection: () => ({
      token: TOKEN, identityInput: { endpoint: 'https://h.example.com', principal: 'p', profile: 'work' }, dashboardWs: true,
      request: (m, p) => gateway.request(m, p), getReadyPayload: () => READY,
    }),
    openSession: () => {}, createSessionInFolder: async () => {},
  });
  await controller.activate();
  controller.startCreate();
  const opening = controller.openFolderPicker('create');
  await wait();
  await wait();
  controller.back();
  release();
  await opening;
  assert.equal(controller.state.picker, null);
  assert.equal(controller.state.view, 'create');
});
