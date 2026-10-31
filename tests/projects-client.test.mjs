import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECTS_ERROR_CODES,
  PROJECTS_METHODS,
  PROJECTS_UNAVAILABLE,
  buildProjectCreateParams,
  buildProjectSessionsParams,
  buildProjectsTreeParams,
  classifyProjectsError,
  createProjectsCache,
  createProjectsClient,
  describeProjectsScope,
  gatewayAuthorityAvailability,
  normalizeProject,
  projectsCacheKey,
  projectsIdentity,
} from '../extension/lib/projects-client.mjs';

// Fixtures below were validated against the installed pydantic contracts in
// tui_gateway/contracts/projects_pets.py (ProjectsPayload, ProjectsTreeResult,
// ProjectsProjectSessionsResult, ProjectsForCwdResult, OptionalProjectResult).
const FOLDER = { path: '/home/ana/code/atlas', label: 'atlas', is_primary: true, added_at: 1790000000 };
const PROJECT = {
  id: 'prj_01',
  slug: 'atlas',
  name: 'Atlas',
  description: null,
  icon: null,
  color: '#6aa84f',
  board_slug: null,
  primary_path: '/home/ana/code/atlas',
  archived: false,
  created_at: 1790000000,
  folders: [FOLDER],
};
const LISTING = { projects: [PROJECT], active_id: 'prj_01' };
const TREE_SESSION = {
  id: '20261022_093000_ab12cd',
  title: 'Fix login',
  preview: 'login redirects',
  source: 'browser',
  model: 'm',
  started_at: 1790000100.0,
  last_active: 1790000900.0,
  message_count: 6,
  is_active: false,
  cwd: '/home/ana/code/atlas',
  git_branch: 'main',
  git_repo_root: '/home/ana/code/atlas',
  profile: 'work',
};
const TREE_NODE = {
  id: 'prj_01',
  label: 'Atlas',
  path: '/home/ana/code/atlas',
  color: '#6aa84f',
  icon: null,
  isAuto: false,
  isNoProject: false,
  sessionCount: 1,
  lastActive: 1790000900.0,
  totalTokens: 1200,
  totalCostUsd: 0.04,
  repos: [{
    id: 'repo_atlas',
    label: 'atlas',
    path: '/home/ana/code/atlas',
    sessionCount: 1,
    groups: [{
      id: 'lane_main', label: 'main', path: '/home/ana/code/atlas', isMain: true, isKanban: false, isGit: true, sessions: [TREE_SESSION],
    }],
  }],
  previewSessions: [TREE_SESSION],
  sessionIds: [TREE_SESSION.id],
};
const TREE = { projects: [TREE_NODE], active_id: 'prj_01', scoped_session_ids: [TREE_SESSION.id] };
const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.rpcCode = code;
  if (data !== undefined) error.data = data;
  return error;
}

function recorder(handlers = {}) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw rpcError(-32601, 'method not found', { reason: 'unknown_method' });
    return handler(params, calls.length);
  };
  return { request, calls };
}

function clientFor(handlers, options = {}) {
  const { request, calls } = recorder(handlers);
  const client = createProjectsClient({
    request,
    dashboardWs: true,
    getReadyPayload: () => READY,
    endpoint: 'https://hermes.example.com/dashboard',
    principal: 'github:42:-',
    profile: 'work',
    ...options,
  });
  return { client, calls };
}

// ---- Capability gate ------------------------------------------------------

test('gate names the exact reason Projects is unavailable', () => {
  assert.deepEqual(gatewayAuthorityAvailability({ dashboardWs: true, readyPayload: READY }), { available: true });

  const rest = gatewayAuthorityAvailability({ dashboardWs: false, readyPayload: READY });
  assert.equal(rest.available, false);
  assert.equal(rest.reason, PROJECTS_UNAVAILABLE.restOnly);
  assert.match(rest.message, /REST API/);

  const waiting = gatewayAuthorityAvailability({ dashboardWs: true, readyPayload: null });
  assert.equal(waiting.reason, PROJECTS_UNAVAILABLE.notConnected);

  const legacy = gatewayAuthorityAvailability({ dashboardWs: true, readyPayload: { replay_epoch: 'ep1', change_events: true } });
  assert.equal(legacy.reason, PROJECTS_UNAVAILABLE.noSessionAuthority);
  const falsy = gatewayAuthorityAvailability({ dashboardWs: true, readyPayload: { ...READY, session_authority: false } });
  assert.equal(falsy.reason, PROJECTS_UNAVAILABLE.noSessionAuthority);

  const missing = gatewayAuthorityAvailability({
    dashboardWs: true, readyPayload: READY, unsupportedMethods: ['projects.tree'], method: 'projects.tree',
  });
  assert.equal(missing.reason, PROJECTS_UNAVAILABLE.methodNotFound);
  assert.equal(missing.method, 'projects.tree');
  assert.match(missing.message, /-32601/);
  // Another method on the same connection is still available.
  assert.equal(gatewayAuthorityAvailability({
    dashboardWs: true, readyPayload: READY, unsupportedMethods: ['projects.tree'], method: 'projects.list',
  }).available, true);
});

test('REST-only and non-authority connections send nothing and say why', async () => {
  const rest = clientFor({ 'projects.list': () => LISTING }, { dashboardWs: false });
  const restResult = await rest.client.list();
  assert.equal(restResult.ok, false);
  assert.equal(restResult.unavailable, true);
  assert.equal(restResult.reason, 'rest-only');
  assert.equal(rest.calls.length, 0);

  const legacy = clientFor({ 'projects.list': () => LISTING }, { getReadyPayload: () => ({ replay_epoch: 'ep1' }) });
  const legacyResult = await legacy.client.tree();
  assert.equal(legacyResult.reason, 'no-session-authority');
  assert.equal(legacy.calls.length, 0);

  const early = clientFor({ 'projects.list': () => LISTING }, { getReadyPayload: () => null });
  assert.equal((await early.client.forCwd('/x')).reason, 'not-connected');
  assert.equal(early.calls.length, 0);
});

test('a -32601 answer disables only that method and is remembered without re-asking', async () => {
  const { client, calls } = clientFor({ 'projects.list': () => LISTING });
  const first = await client.tree();
  assert.equal(first.ok, false);
  assert.equal(first.unavailable, true);
  assert.equal(first.reason, PROJECTS_UNAVAILABLE.methodNotFound);
  assert.equal(first.method, 'projects.tree');
  assert.equal(calls.length, 1);

  const second = await client.tree();
  assert.equal(second.reason, PROJECTS_UNAVAILABLE.methodNotFound);
  assert.equal(calls.length, 1, 'the second call is answered from the recorded refusal');
  assert.equal(client.availability('projects.tree').available, false);

  const list = await client.list();
  assert.equal(list.ok, true);
  assert.equal(client.availability('projects.list').available, true);
});

// ---- Calls and fixtures ---------------------------------------------------

test('projects.list sends the profile and normalizes the stored rows', async () => {
  const { client, calls } = clientFor({ 'projects.list': () => LISTING });
  const result = await client.list();
  assert.deepEqual(calls, [{ method: PROJECTS_METHODS.list, params: { profile: 'work' } }]);
  assert.equal(result.ok, true);
  assert.equal(result.data.activeId, 'prj_01');
  assert.deepEqual(result.data.projects, [{
    id: 'prj_01',
    slug: 'atlas',
    name: 'Atlas',
    description: null,
    icon: null,
    color: '#6aa84f',
    boardSlug: null,
    primaryPath: '/home/ana/code/atlas',
    archived: false,
    createdAt: 1790000000,
    folders: [{ path: '/home/ana/code/atlas', label: 'atlas', isPrimary: true, addedAt: 1790000000 }],
  }]);
  assert.equal(result.identity.profile, 'work');
  assert.equal(result.identity.endpoint, 'https://hermes.example.com');
});

test('projects.tree and project_sessions build the contract params and normalize lanes', async () => {
  const { client, calls } = clientFor({
    'projects.tree': () => TREE,
    'projects.project_sessions': () => ({ project: TREE_NODE }),
  });
  const tree = await client.tree({ previewLimit: 3, sessionLimit: 50 });
  assert.deepEqual(calls[0], { method: 'projects.tree', params: { preview_limit: 3, session_limit: 50, profile: 'work' } });
  assert.equal(tree.data.scopedSessionIds[0], TREE_SESSION.id);
  const node = tree.data.projects[0];
  assert.equal(node.sessionCount, 1);
  assert.equal(node.repos[0].lanes[0].isMain, true);
  assert.equal(node.previewSessions[0].cwd, '/home/ana/code/atlas');
  assert.equal(node.previewSessions[0].profile, 'work');

  const sessions = await client.projectSessions('prj_01', { sessionLimit: 20 });
  assert.deepEqual(calls[1], { method: 'projects.project_sessions', params: { project_id: 'prj_01', session_limit: 20, profile: 'work' } });
  assert.equal(sessions.data.project.repos[0].lanes[0].sessions[0].title, 'Fix login');

  const gone = await clientFor({ 'projects.project_sessions': () => ({ project: null }) }).client.projectSessions('prj_missing');
  assert.equal(gone.ok, true);
  assert.equal(gone.data.project, null);
  assert.throws(() => buildProjectSessionsParams({ projectId: '  ' }), TypeError);
});

test('unset limits and an unset profile are left off the wire', () => {
  assert.deepEqual(buildProjectsTreeParams({}), {});
  assert.deepEqual(buildProjectsTreeParams({ previewLimit: 0, sessionLimit: -1, profile: '' }), {});
  assert.deepEqual(buildProjectsTreeParams({ profile: 'work' }), { profile: 'work' });
});

test('projects.for_cwd resolves the owning project, or none, and is never cached', async () => {
  let answer = { project: PROJECT, cwd: '/home/ana/code/atlas', branch: 'main' };
  const { client, calls } = clientFor({ 'projects.for_cwd': () => answer });
  const owned = await client.forCwd('/home/ana/code/atlas');
  assert.deepEqual(calls[0], { method: 'projects.for_cwd', params: { cwd: '/home/ana/code/atlas', profile: 'work' } });
  assert.equal(owned.data.project.name, 'Atlas');
  assert.equal(owned.data.branch, 'main');

  answer = { project: null, cwd: '/tmp', branch: '' };
  const loose = await client.forCwd('/tmp');
  assert.equal(loose.data.project, null);
  assert.equal(loose.data.cwd, '/tmp');
  assert.equal(calls.length, 2);

  await client.forCwd();
  assert.deepEqual(calls[2].params, { profile: 'work' }, 'an absent cwd lets the gateway resolve its default');
});

test('projects.create sends gateway-host paths, returns the stored row and drops cached listings', async () => {
  let listCalls = 0;
  const { client, calls } = clientFor({
    'projects.list': () => { listCalls += 1; return LISTING; },
    'projects.create': () => ({ project: PROJECT }),
  });
  await client.list();
  await client.list();
  assert.equal(listCalls, 1, 'the second list is a cache hit');

  const created = await client.create({
    name: '  Atlas ',
    folders: ['/home/ana/code/atlas', '/home/ana/code/atlas', ' '],
    primaryPath: '/home/ana/code/atlas',
    description: 'Main app',
    use: true,
  });
  const createCall = calls.find((call) => call.method === 'projects.create');
  assert.deepEqual(createCall.params, {
    name: 'Atlas',
    folders: ['/home/ana/code/atlas'],
    primary_path: '/home/ana/code/atlas',
    description: 'Main app',
    use: true,
    profile: 'work',
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.project.id, 'prj_01');

  await client.list();
  assert.equal(listCalls, 2, 'create invalidated the cached listing');
  assert.throws(() => buildProjectCreateParams({ name: '   ' }), TypeError);
  assert.deepEqual(buildProjectCreateParams({ name: 'No folders' }), { name: 'No folders' });
});

test('projects.create reports gateway refusals and an empty answer distinctly', async () => {
  const duplicate = clientFor({
    'projects.create': () => { throw rpcError(PROJECTS_ERROR_CODES.invalidArgument, 'primary path already belongs to atlas'); },
  });
  const refused = await duplicate.client.create({ name: 'Atlas 2', folders: ['/home/ana/code/atlas'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid-argument');
  assert.equal(refused.code, 5063);
  assert.match(refused.message, /already belongs/);
  assert.equal(refused.unavailable, false);

  const empty = await clientFor({ 'projects.create': () => ({ project: null }) }).client.create({ name: 'X' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'not-created');
});

test('error classification maps the gateway codes and transport failures', () => {
  assert.equal(classifyProjectsError(rpcError(5062, 'no such project')).reason, 'not-found');
  assert.equal(classifyProjectsError(rpcError(5063, 'bad')).reason, 'invalid-argument');
  assert.equal(classifyProjectsError(rpcError(5061, 'boom')).reason, 'gateway-error');
  assert.equal(classifyProjectsError(rpcError(4064, 'profile unavailable')).reason, 'profile-unavailable');
  assert.equal(classifyProjectsError(rpcError(-32601, 'nope')).reason, 'method-not-found');
  assert.equal(classifyProjectsError({ data: { reason: 'unknown_method' }, message: 'x' }).reason, 'method-not-found');
  assert.equal(classifyProjectsError(new Error('Gateway RPC projects.list timed out')).reason, 'timeout');
  assert.equal(classifyProjectsError(new Error('WebSocket is not open')).reason, 'disconnected');
});

test('a malformed answer is reported, not cached or thrown', async () => {
  const { client } = clientFor({ 'projects.list': () => ({ nope: true }), 'projects.for_cwd': () => ({}) });
  assert.equal((await client.list()).reason, 'malformed-response');
  assert.equal((await client.forCwd('/x')).reason, 'malformed-response');
  assert.equal(normalizeProject({ name: 'no id' }), null);
});

// ---- Scoping --------------------------------------------------------------

test('identity keys separate host, principal and profile and ignore the URL path', () => {
  const base = { endpoint: 'https://hermes.example.com/a/b?x=1', principal: 'github:42:-', profile: 'work' };
  const key = (overrides) => projectsIdentity({ ...base, ...overrides }).key;
  assert.equal(key({}), key({ endpoint: 'https://hermes.example.com/other' }));
  assert.equal(key({}), key({ endpoint: 'wss://hermes.example.com/api/ws' }), 'ws and http endpoints of one host share an identity');
  assert.notEqual(key({}), key({ endpoint: 'https://other.example.com' }));
  assert.notEqual(key({}), key({ principal: 'github:43:-' }));
  assert.notEqual(key({}), key({ profile: 'personal' }));
  assert.notEqual(key({}), key({ endpoint: 'https://hermes.example.com:8443' }));
  assert.equal(key({ profile: '' }), key({ profile: 'default' }));
  assert.equal(projectsIdentity({ ...base, principal: { user_id: '42', provider: 'github', org_id: '' } }).principal, 'github:42:-');
  assert.equal(projectsIdentity({ endpoint: 'not a url' }), null);
  assert.equal(projectsIdentity({ endpoint: 'https://user:pw@hermes.example.com' }), null);
  assert.equal(projectsIdentity({ endpoint: 'ftp://hermes.example.com' }), null);
  assert.equal(projectsCacheKey(null, 'list'), '');
  assert.match(describeProjectsScope(projectsIdentity(base)), /profile work on hermes\.example\.com/);
});

test('two profiles or hosts with the same project name never share a cache entry', async () => {
  const shared = createProjectsCache();
  const named = (id, name) => ({ projects: [{ ...PROJECT, id, name }], active_id: id });
  const make = (options, answer) => {
    const { request, calls } = recorder({ 'projects.list': () => answer });
    const client = createProjectsClient({
      request, dashboardWs: true, getReadyPayload: () => READY, cache: shared, ...options,
    });
    return { client, calls };
  };
  const base = { endpoint: 'https://a.example.com', principal: 'github:42:-' };
  const workA = make({ ...base, profile: 'work' }, named('prj_work', 'Atlas'));
  const personalA = make({ ...base, profile: 'personal' }, named('prj_personal', 'Atlas'));
  const workB = make({ ...base, endpoint: 'https://b.example.com', profile: 'work' }, named('prj_b', 'Atlas'));
  const otherUser = make({ ...base, principal: 'github:99:-', profile: 'work' }, named('prj_user99', 'Atlas'));

  assert.equal((await workA.client.list()).data.projects[0].id, 'prj_work');
  assert.equal((await personalA.client.list()).data.projects[0].id, 'prj_personal');
  assert.equal((await workB.client.list()).data.projects[0].id, 'prj_b');
  assert.equal((await otherUser.client.list()).data.projects[0].id, 'prj_user99');
  assert.equal(shared.size, 4);

  const again = await workA.client.list();
  assert.equal(again.cached, true);
  assert.equal(again.data.projects[0].id, 'prj_work');
  assert.equal(workA.calls.length, 1);

  // Invalidating one identity leaves the others cached.
  workA.client.invalidate();
  assert.equal(shared.size, 3);
  assert.equal((await personalA.client.list()).cached, true);
});

test('a remote host with an unknown principal is not cached, a loopback one is', async () => {
  let remoteCalls = 0;
  const remote = clientFor({ 'projects.list': () => { remoteCalls += 1; return LISTING; } }, { principal: '' });
  await remote.client.list();
  await remote.client.list();
  assert.equal(remoteCalls, 2);

  let localCalls = 0;
  const local = clientFor({ 'projects.list': () => { localCalls += 1; return LISTING; } }, { endpoint: 'http://127.0.0.1:9119', principal: '' });
  await local.client.list();
  const hit = await local.client.list();
  assert.equal(localCalls, 1);
  assert.equal(hit.cached, true);
});

test('cache entries expire and force bypasses them', async () => {
  let clock = 1_000;
  const cache = createProjectsCache({ ttlMs: 100, now: () => clock });
  let listCalls = 0;
  const { client } = clientFor({ 'projects.list': () => { listCalls += 1; return LISTING; } }, { cache });
  await client.list();
  assert.equal((await client.list()).cached, true);
  clock += 101;
  assert.equal((await client.list()).cached, false);
  assert.equal(listCalls, 2);
  await client.list({ force: true });
  assert.equal(listCalls, 3);
});

test('a read that was in flight when the data changed does not repopulate the cache', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listCalls = 0;
  const { client } = clientFor({
    'projects.list': async () => { listCalls += 1; await gate; return LISTING; },
    'projects.create': () => ({ project: PROJECT }),
  });
  const slowRead = client.list();
  await Promise.resolve();
  await client.create({ name: 'Atlas' });
  release();
  await slowRead;
  const next = await client.list();
  assert.equal(next.cached, false, 'the pre-create read was not stored');
  assert.equal(listCalls, 2);
});

test('failures are not cached and a disconnect surfaces as a typed reason', async () => {
  let fail = true;
  const { client } = clientFor({
    'projects.list': () => {
      if (fail) throw new Error('WebSocket is not open');
      return LISTING;
    },
  });
  const down = await client.list();
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'disconnected');
  assert.equal(down.unavailable, false);
  fail = false;
  assert.equal((await client.list()).ok, true);
});

test('createProjectsClient requires a request function', () => {
  assert.throws(() => createProjectsClient({}), TypeError);
});
