import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectsPayload,
  normalizeProjectsTree,
  normalizeProjectSessions,
} from '../extension/lib/projects-client.mjs';
import {
  buildProjectRows,
  describeMoveOutcome,
  describeProjectsFailure,
  filterProjectRows,
  flattenProjectSessions,
  formatLastActive,
  groupProjectRows,
  moveTargetsFor,
  normalizeSessionMenuTab,
  pathIsWithin,
  shortenPath,
  suggestUniqueName,
  validateMovePath,
  validateProjectDraft,
} from '../extension/lib/projects-view.mjs';

// Wire shapes follow tui_gateway/contracts/projects_pets.py (ProjectsPayload,
// ProjectsTreeResult, ProjectsProjectSessionsResult).
const folder = (path, primary = true) => ({ path, label: null, is_primary: primary, added_at: 1790000000 });
const project = (id, name, path, extra = {}) => ({
  id, slug: name.toLowerCase(), name, description: null, icon: null, color: null, board_slug: null,
  primary_path: path, archived: false, created_at: 1790000000, folders: [folder(path)], ...extra,
});
const session = (id, extra = {}) => ({
  id, title: `Session ${id}`, preview: 'preview', source: 'browser', model: 'm', started_at: 1790000000, last_active: 1790000500,
  message_count: 4, is_active: false, cwd: '/srv/atlas', git_branch: 'main', git_repo_root: '/srv/atlas', profile: 'work', ...extra,
});
const node = (id, label, path, extra = {}) => ({
  id, label, path, color: null, icon: null, isAuto: false, isNoProject: false, sessionCount: 0, lastActive: 0, totalTokens: 0,
  totalCostUsd: 0, repos: [], previewSessions: [], sessionIds: [], ...extra,
});

const LIST = normalizeProjectsPayload({
  projects: [
    project('p_a1', 'Atlas', '/srv/atlas'),
    project('p_a2', 'Atlas', '/srv/clients/atlas'),
    project('p_b', 'Beta', '/srv/beta'),
    project('p_old', 'Old', '/srv/old', { archived: true }),
  ],
  active_id: 'p_b',
});
const TREE = normalizeProjectsTree({
  projects: [
    node('p_a1', 'Atlas', '/srv/atlas', { sessionCount: 3, lastActive: 1790000900 }),
    node('p_a2', 'Atlas', '/srv/clients/atlas', { sessionCount: 1, lastActive: 1790000100 }),
    node('p_b', 'Beta', '/srv/beta', { sessionCount: 0 }),
    node('auto_tool', 'tooling', '/srv/tooling', { isAuto: true, sessionCount: 2, lastActive: 1790000300 }),
    node('home', 'Home', null, { isNoProject: true, sessionCount: 5, lastActive: 1790000800 }),
  ],
  active_id: 'p_b',
  scoped_session_ids: [],
});

test('rows merge names from the list with counts from the tree and key by id', () => {
  const rows = buildProjectRows({ list: LIST, tree: TREE });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [
    ['p_a1', 'project'], ['p_a2', 'project'], ['p_b', 'project'], ['auto_tool', 'auto'], ['home', 'home'],
  ]);
  const atlas = rows.find((row) => row.id === 'p_a1');
  assert.equal(atlas.sessionCount, 3);
  assert.equal(atlas.path, '/srv/atlas');
  assert.equal(rows.find((row) => row.id === 'p_b').active, true);
  assert.equal(rows.some((row) => row.id === 'p_old'), false, 'archived projects stay out of the list');
});

test('two projects with the same name stay two rows, told apart by folder', () => {
  const rows = buildProjectRows({ list: LIST, tree: TREE });
  const atlases = rows.filter((row) => row.name === 'Atlas');
  assert.equal(atlases.length, 2);
  assert.ok(atlases.every((row) => row.duplicateName));
  assert.notEqual(atlases[0].disambiguator, atlases[1].disambiguator);
  assert.match(atlases[1].disambiguator, /clients/);
  assert.equal(rows.find((row) => row.id === 'p_b').duplicateName, false);
});

test('rows survive either half of the read failing', () => {
  const noTree = buildProjectRows({ list: LIST, tree: null });
  assert.equal(noTree.find((row) => row.id === 'p_a1').sessionCount, null);
  const noList = buildProjectRows({ list: null, tree: TREE });
  assert.equal(noList.find((row) => row.id === 'p_a1').name, 'Atlas');
  assert.deepEqual(buildProjectRows({}), []);
});

test('filter matches name and folder, and rows group into projects, detected folders and Home', () => {
  const rows = buildProjectRows({ list: LIST, tree: TREE });
  assert.deepEqual(filterProjectRows(rows, 'clients').map((row) => row.id), ['p_a2']);
  assert.deepEqual(filterProjectRows(rows, 'BETA').map((row) => row.id), ['p_b']);
  assert.equal(filterProjectRows(rows, '  ').length, rows.length);
  const groups = groupProjectRows(rows);
  assert.equal(groups.projects.length, 3);
  assert.equal(groups.auto.length, 1);
  assert.equal(groups.home.length, 1);
});

test('project sessions are flattened once per id, newest first, archived left out, and searchable', () => {
  const lane = (sessions, extra = {}) => ({ id: 'l', label: 'main', path: '/srv/atlas', isMain: true, isKanban: false, isGit: true, sessions, ...extra });
  const wire = {
    project: node('p_a1', 'Atlas', '/srv/atlas', {
      repos: [{
        id: 'r', label: 'atlas', path: '/srv/atlas', sessionCount: 3,
        groups: [
          lane([session('s1', { last_active: 100 }), session('s2', { last_active: 300, title: 'Fix login' })]),
          lane([session('s3', { last_active: 200, archived: true }), session('s4', { last_active: 250, git_branch: 'feat/x' })], { isMain: false, label: 'feat-x' }),
        ],
      }],
      previewSessions: [session('s2', { last_active: 300 })],
    }),
  };
  const normalized = normalizeProjectSessions(wire);
  const rows = flattenProjectSessions(normalized.project);
  assert.deepEqual(rows.map((row) => row.id), ['s2', 's4', 's1']);
  assert.equal(rows[1].lane, 'feat-x');
  assert.deepEqual(flattenProjectSessions(normalized.project, { query: 'login' }).map((row) => row.id), ['s2']);
  assert.deepEqual(flattenProjectSessions(normalized.project, { query: 'feat/x' }).map((row) => row.id), ['s4']);
  assert.deepEqual(flattenProjectSessions(null), []);
});

test('paths: short form keeps the host separator, containment is by segment', () => {
  assert.deepEqual(shortenPath('/home/ana/code/atlas'), { text: '…/code/atlas', full: '/home/ana/code/atlas' });
  assert.equal(shortenPath('C:\\Users\\ana\\code\\atlas').text, '…\\code\\atlas');
  assert.equal(shortenPath('/srv/atlas').text, '/srv/atlas');
  assert.equal(shortenPath('').text, '');
  assert.equal(pathIsWithin('/srv/atlas/src', '/srv/atlas'), true);
  assert.equal(pathIsWithin('/srv/atlas2', '/srv/atlas'), false);
  assert.equal(pathIsWithin('c:/Work/Atlas/src', 'C:\\work\\atlas'), true);
});

test('relative time reads seconds and milliseconds and never throws', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(formatLastActive(now / 1000 - 3 * 3600, { now, locale: 'en' }), '3 hours ago');
  assert.equal(formatLastActive(now - 2 * 24 * 3600 * 1000, { now, locale: 'en' }), '2 days ago');
  assert.equal(formatLastActive(0, { now }), '');
  assert.equal(formatLastActive('x', { now }), '');
  assert.equal(typeof formatLastActive(now / 1000, { now, locale: 'not a locale' }), 'string');
});

test('failures map to the exact unavailable reason and keep the gateway detail otherwise', () => {
  const rest = describeProjectsFailure({ ok: false, unavailable: true, reason: 'rest-only', message: 'x' });
  assert.equal(rest.unavailable, true);
  assert.equal(rest.key, 'projects.unavailable.rest_only');
  assert.equal(rest.reason, 'rest-only');
  assert.equal(describeProjectsFailure({ unavailable: true, reason: 'no-session-authority' }).key, 'projects.unavailable.no_authority');
  assert.equal(describeProjectsFailure({ unavailable: true, reason: 'not-connected' }).key, 'projects.unavailable.not_connected');
  const missing = describeProjectsFailure({ unavailable: true, reason: 'method-not-found', method: 'projects.tree' });
  assert.equal(missing.key, 'projects.unavailable.method_not_found');
  assert.equal(missing.params.method, 'projects.tree');
  const refused = describeProjectsFailure({ reason: 'invalid-argument', message: 'folder already belongs to project x' });
  assert.equal(refused.unavailable, false);
  assert.equal(refused.key, 'projects.error.invalid_argument');
  assert.match(refused.detail, /already belongs/);
  assert.equal(describeProjectsFailure({ reason: 'timeout' }).key, 'projects.error.timeout');
  assert.equal(describeProjectsFailure({ reason: 'surprise' }).key, 'projects.error.gateway_error');
});

test('move targets are projects with a folder; the session is flagged where it already is', () => {
  const rows = buildProjectRows({ list: LIST, tree: TREE });
  const targets = moveTargetsFor(rows, { currentCwd: '/srv/atlas/src' });
  assert.deepEqual(targets.map((target) => target.id), ['p_a1', 'p_a2', 'p_b', 'auto_tool']);
  assert.deepEqual(targets.filter((target) => target.current).map((target) => target.id), ['p_a1']);
  assert.equal(targets.find((target) => target.id === 'p_b').cwd, '/srv/beta');
  assert.equal(targets.some((target) => target.kind === 'home'), false, 'Home has no folder to move into');
});

test('typed move folders must be gateway-host paths', () => {
  assert.equal(validateMovePath(''), 'projects.move.path_required');
  assert.equal(validateMovePath('relative/dir'), 'projects.move.path_invalid');
  assert.equal(validateMovePath('/srv/free'), '');
  assert.equal(validateMovePath('~/work'), '');
  assert.equal(validateMovePath('C:\\work'), '');
  assert.equal(validateMovePath('/a\0b'), 'projects.move.path_invalid');
});

test('each typed move result gets its own copy and the right controls', () => {
  assert.equal(describeMoveOutcome({ status: 'moved', cwd: '/srv/atlas' }).key, 'projects.move.done');
  assert.equal(describeMoveOutcome({ status: 'moved', cwd: '/srv/atlas', noop: true }).key, 'projects.move.already_there');
  const live = describeMoveOutcome({ status: 'live_turn', confirmationRequired: true });
  assert.equal(live.confirmable, true);
  assert.equal(live.tone, 'confirm');
  assert.equal(describeMoveOutcome({ status: 'busy', compressing: true }).key, 'projects.move.busy_compressing');
  assert.equal(describeMoveOutcome({ status: 'busy' }).key, 'projects.move.busy');
  assert.equal(describeMoveOutcome({ status: 'stale' }).key, 'projects.move.stale');
  assert.equal(describeMoveOutcome({ status: 'invalid', detail: 'nope' }).params.detail, 'nope');
  assert.equal(describeMoveOutcome({ status: 'denied' }).key, 'projects.move.denied');
  const lost = describeMoveOutcome({ status: 'indeterminate' });
  assert.equal(lost.reconcile, true);
  assert.equal(describeMoveOutcome({ status: 'not_committed' }).reconcile, true);
  assert.equal(describeMoveOutcome({ status: 'conflict' }).reconcile, false);
  assert.equal(describeMoveOutcome({ status: 'unconfirmed', snapshot: { cwd: '/x' } }).params.cwd, '/x');
  const gone = describeMoveOutcome({ status: 'unavailable', reason: 'rest-only' });
  assert.equal(gone.key, 'projects.unavailable.rest_only');
  assert.equal(gone.unavailableReason, 'rest-only');
  assert.equal(describeMoveOutcome({ status: 'failed', message: 'boom' }).params.detail, 'boom');
  assert.equal(describeMoveOutcome({ status: 'wat' }).key, 'projects.move.failed');
});

test('create drafts: a repeated name warns and suggests, a taken or relative folder blocks', () => {
  const rows = buildProjectRows({ list: LIST, tree: TREE });
  assert.equal(suggestUniqueName('Atlas', ['Atlas', 'atlas (2)']), 'Atlas (3)');
  assert.equal(suggestUniqueName('Gamma', ['Atlas']), 'Gamma');

  const ok = validateProjectDraft({ name: 'Gamma', path: '/srv/gamma' }, rows);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, {});

  const twin = validateProjectDraft({ name: ' atlas ', path: '/srv/new-atlas' }, rows);
  assert.equal(twin.ok, true, 'the gateway allows two projects with one name');
  assert.equal(twin.warnings.name, 'projects.create.warn.name_duplicate');
  assert.equal(twin.warnings.suggestion, 'atlas (2)');

  const taken = validateProjectDraft({ name: 'Other', path: '/srv/atlas/' }, rows);
  assert.equal(taken.ok, false);
  assert.equal(taken.errors.path, 'projects.create.error.path_in_use');
  assert.equal(taken.warnings.owner, 'Atlas');

  assert.equal(validateProjectDraft({ name: '', path: '' }, rows).errors.name, 'projects.create.error.name_required');
  assert.equal(validateProjectDraft({ name: 'x', path: '' }, rows).errors.path, 'projects.create.error.path_required');
  assert.equal(validateProjectDraft({ name: 'x', path: 'src/app' }, rows).errors.path, 'projects.create.error.path_invalid');
});

test('the remembered tab falls back to Recents for anything unknown', () => {
  assert.equal(normalizeSessionMenuTab('projects'), 'projects');
  assert.equal(normalizeSessionMenuTab('recents'), 'recents');
  assert.equal(normalizeSessionMenuTab(undefined), 'recents');
  assert.equal(normalizeSessionMenuTab('<script>'), 'recents');
});
