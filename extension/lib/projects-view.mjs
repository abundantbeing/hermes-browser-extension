// Pure view helpers for the Projects tab of the sessions drawer.
//
// Everything here is DOM-free and takes plain data, so the drawer's behaviour
// (what a row says, which folder a move targets, which copy an unavailable
// reason maps to) is testable without a browser. The DOM renderer lives in
// projects-panel.mjs and the async state machine in projects-controller.mjs.
//
// Projects are backend workspaces. A session belongs to a project only because
// its `cwd` is inside one of the project's folders, so nothing here stores or
// invents a project label in the browser.

import { PROJECTS_UNAVAILABLE } from './projects-client.mjs';
import { comparablePath, isGatewayHostPath, samePath } from './session-mutate.mjs';

export const SESSION_MENU_TAB_KEY = 'hermesSessionMenuTab';
export const SESSION_MENU_TABS = Object.freeze({ recents: 'recents', projects: 'projects' });

export function normalizeSessionMenuTab(value) {
  return value === SESSION_MENU_TABS.projects ? SESSION_MENU_TABS.projects : SESSION_MENU_TABS.recents;
}

function clean(value = '') {
  return String(value ?? '').trim();
}

// ---- Paths ---------------------------------------------------------------

/** Whether `child` is `parent` or inside it. Both are gateway-host paths. */
export function pathIsWithin(child, parent) {
  const a = comparablePath(child);
  const b = comparablePath(parent);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(b === '/' ? '/' : `${b}/`);
}

/**
 * A short, readable form of a gateway path for a row: the last two segments,
 * with the full path kept for the tooltip. The separator the gateway used is
 * preserved so a Windows host does not show POSIX slashes.
 */
export function shortenPath(path = '', segments = 2) {
  const full = clean(path);
  if (!full) return { text: '', full: '' };
  const separator = full.includes('\\') && !full.includes('/') ? '\\' : '/';
  const parts = full.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return { text: full, full };
  return { text: `…${separator}${parts.slice(-segments).join(separator)}`, full };
}

// ---- Time ----------------------------------------------------------------

function toMilliseconds(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // The gateway reports epoch seconds; accept milliseconds too.
  return value < 1e11 ? value * 1000 : value;
}

const RELATIVE_UNITS = Object.freeze([
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]);

export function formatLastActive(timestamp, { now = Date.now(), locale = 'en' } = {}) {
  const at = toMilliseconds(timestamp);
  if (!at) return '';
  const seconds = Math.round((at - now) / 1000);
  try {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, size] of RELATIVE_UNITS) {
      if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
    }
    return formatter.format(0, 'second');
  } catch {
    return '';
  }
}

// ---- Project rows --------------------------------------------------------

function primaryFolderPath(project) {
  if (project.primaryPath) return project.primaryPath;
  const primary = project.folders.find((folder) => folder.isPrimary);
  return (primary || project.folders[0])?.path || '';
}

/**
 * Merge `projects.list` (names, folders, archived) with `projects.tree`
 * (session counts and recency, plus auto-detected git roots and the Home
 * bucket) into the rows the drawer shows. Rows are keyed by id, never by name,
 * so two projects called "Atlas" stay two rows; `disambiguator` tells them
 * apart by folder.
 *
 * `kind`: project (a project the user made), auto (a git root with sessions
 * but no project), home (sessions outside every project).
 */
export function buildProjectRows({ list = null, tree = null } = {}) {
  const nodes = new Map((tree?.projects || []).map((node) => [node.id, node]));
  const rows = [];
  const seen = new Set();

  for (const project of list?.projects || []) {
    if (project.archived) continue;
    const node = nodes.get(project.id) || null;
    const path = primaryFolderPath(project) || node?.path || '';
    seen.add(project.id);
    rows.push({
      id: project.id,
      kind: 'project',
      name: project.name,
      description: project.description,
      path,
      folders: project.folders,
      color: project.color || node?.color || null,
      icon: project.icon || node?.icon || null,
      sessionCount: node ? node.sessionCount : null,
      lastActive: node ? node.lastActive : 0,
      cwd: path,
      active: Boolean(list?.activeId && list.activeId === project.id),
    });
  }

  for (const node of tree?.projects || []) {
    if (seen.has(node.id)) continue;
    const kind = node.isNoProject ? 'home' : node.isAuto ? 'auto' : 'project';
    rows.push({
      id: node.id,
      kind,
      name: node.label,
      description: null,
      path: node.path || '',
      folders: node.path ? [{ path: node.path, label: null, isPrimary: true, addedAt: null }] : [],
      color: node.color,
      icon: node.icon,
      sessionCount: node.sessionCount,
      lastActive: node.lastActive,
      cwd: kind === 'home' ? '' : (node.path || ''),
      active: Boolean(tree?.activeId && tree.activeId === node.id),
    });
  }

  const rank = { project: 0, auto: 1, home: 2 };
  rows.sort((a, b) => (rank[a.kind] - rank[b.kind])
    || (b.lastActive - a.lastActive)
    || a.name.localeCompare(b.name));

  const byName = new Map();
  for (const row of rows) {
    const key = `${row.kind === 'home' ? 'home' : 'p'}:${row.name.toLowerCase()}`;
    byName.set(key, (byName.get(key) || 0) + 1);
  }
  for (const row of rows) {
    const key = `${row.kind === 'home' ? 'home' : 'p'}:${row.name.toLowerCase()}`;
    row.duplicateName = (byName.get(key) || 0) > 1;
    row.disambiguator = row.duplicateName
      ? (shortenPath(row.path).text || row.id)
      : '';
  }
  return rows;
}

export function filterProjectRows(rows = [], query = '') {
  const needle = clean(query).toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.name} ${row.path} ${row.description || ''}`.toLowerCase().includes(needle));
}

/** Split rows into the drawer's three groups, in display order. */
export function groupProjectRows(rows = []) {
  return {
    projects: rows.filter((row) => row.kind === 'project'),
    auto: rows.filter((row) => row.kind === 'auto'),
    home: rows.filter((row) => row.kind === 'home'),
  };
}

// ---- Sessions in a project ----------------------------------------------

/**
 * The sessions of one project node as flat rows, newest first, one row per
 * session id (a session can appear in a lane and in the preview list). Archived
 * sessions are left out, as the gateway's own sidebar leaves them out.
 */
export function flattenProjectSessions(node = null, { query = '' } = {}) {
  if (!node) return [];
  const byId = new Map();
  const add = (session, lane = null) => {
    if (!session?.id || session.archived || byId.has(session.id)) return;
    byId.set(session.id, {
      id: session.id,
      title: session.title || session.preview || session.id,
      preview: session.title ? session.preview : null,
      cwd: session.cwd,
      branch: session.gitBranch || '',
      lane: lane && !lane.isMain ? lane.label : '',
      lastActive: session.lastActive || session.startedAt || 0,
      messageCount: session.messageCount,
      isActive: session.isActive,
      pinned: session.pinned,
      source: session.source,
      model: session.model,
      profile: session.profile,
    });
  };
  for (const repo of node.repos || []) {
    for (const lane of repo.lanes || []) {
      for (const session of lane.sessions || []) add(session, lane);
    }
  }
  for (const session of node.previewSessions || []) add(session);

  const needle = clean(query).toLowerCase();
  return [...byId.values()]
    .filter((row) => !needle || `${row.title} ${row.preview || ''} ${row.cwd || ''} ${row.branch} ${row.id}`.toLowerCase().includes(needle))
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.lastActive - a.lastActive);
}

// ---- Unavailable and failure copy ---------------------------------------

const FAILURE_KEYS = Object.freeze({
  [PROJECTS_UNAVAILABLE.notConnected]: 'projects.unavailable.not_connected',
  [PROJECTS_UNAVAILABLE.restOnly]: 'projects.unavailable.rest_only',
  [PROJECTS_UNAVAILABLE.noSessionAuthority]: 'projects.unavailable.no_authority',
  [PROJECTS_UNAVAILABLE.methodNotFound]: 'projects.unavailable.method_not_found',
  [PROJECTS_UNAVAILABLE.webappSignIn]: 'projects.unavailable.webapp_sign_in',
  [PROJECTS_UNAVAILABLE.webappOff]: 'projects.unavailable.webapp_off',
  'profile-unavailable': 'projects.error.profile_unavailable',
  'not-found': 'projects.error.not_found',
  'invalid-argument': 'projects.error.invalid_argument',
  'gateway-error': 'projects.error.gateway_error',
  timeout: 'projects.error.timeout',
  disconnected: 'projects.error.disconnected',
  'malformed-response': 'projects.error.malformed',
  'not-created': 'projects.error.not_created',
});

/**
 * Turn a projects-client result (or an availability gate) into what the drawer
 * shows. `unavailable` failures are about the connection (Projects cannot be
 * used here at all) and keep their machine reason visible; the rest are about
 * one call and keep the gateway's own message as detail.
 */
export function describeProjectsFailure(result = {}) {
  const reason = clean(result.reason) || 'gateway-error';
  const unavailable = result.unavailable === true || Object.values(PROJECTS_UNAVAILABLE).includes(reason);
  return {
    unavailable,
    reason,
    key: FAILURE_KEYS[reason] || 'projects.error.gateway_error',
    params: { method: clean(result.method), detail: clean(result.message) },
    detail: unavailable ? '' : clean(result.message),
    fallback: clean(result.message),
  };
}

// ---- Move ----------------------------------------------------------------

/**
 * The folders a session can be moved to: every project that has a folder, plus
 * auto-detected git roots. `current` marks the one the session is already in,
 * so the picker can say so instead of offering a no-op.
 */
export function moveTargetsFor(rows = [], { currentCwd = '' } = {}) {
  const targets = [];
  for (const row of rows) {
    if (row.kind === 'home' || !clean(row.cwd)) continue;
    targets.push({
      id: row.id,
      kind: row.kind,
      label: row.name,
      cwd: row.cwd,
      disambiguator: row.disambiguator,
      current: Boolean(clean(currentCwd)) && (row.folders.some((folder) => pathIsWithin(currentCwd, folder.path))
        || pathIsWithin(currentCwd, row.cwd)),
    });
  }
  return targets;
}

/** Validate a typed gateway-host folder for a move; returns an i18n key or ''. */
export function validateMovePath(path = '') {
  const value = clean(path);
  if (!value) return 'projects.move.path_required';
  if (value.length > 4096 || value.includes('\0') || !isGatewayHostPath(value)) return 'projects.move.path_invalid';
  return '';
}

/**
 * Map a moveSessionToWorkspace result onto the copy and controls the drawer
 * shows. `tone`: ok / confirm / warn / error. `reconcile` means the answer was
 * lost and "Check again" is the right control (it reads, then resends only when
 * the write is proven absent); `confirmable` means a second explicit click
 * sends the move.
 */
export function describeMoveOutcome(result = {}) {
  const status = clean(result.status);
  const base = { status, tone: 'error', key: 'projects.move.failed', params: {}, reconcile: false, confirmable: false };
  switch (status) {
    case 'moved':
      return result.noop
        ? { ...base, tone: 'ok', key: 'projects.move.already_there', params: { cwd: result.cwd } }
        : { ...base, tone: 'ok', key: 'projects.move.done', params: { cwd: result.cwd } };
    case 'live_turn':
      return { ...base, tone: 'confirm', key: 'projects.move.live_turn', confirmable: true };
    case 'busy':
      return { ...base, tone: 'warn', key: result.compressing ? 'projects.move.busy_compressing' : 'projects.move.busy' };
    case 'stale':
      return { ...base, tone: 'warn', key: 'projects.move.stale' };
    case 'invalid':
      return { ...base, key: 'projects.move.invalid', params: { detail: clean(result.detail) } };
    case 'denied':
      return { ...base, key: 'projects.move.denied' };
    case 'unavailable': {
      const failure = describeProjectsFailure({ reason: result.reason, unavailable: true, message: result.message });
      return { ...base, key: failure.key, params: failure.params, unavailableReason: failure.reason };
    }
    case 'not_sent':
      return { ...base, tone: 'warn', key: 'projects.move.not_sent' };
    case 'indeterminate':
      return { ...base, tone: 'warn', key: 'projects.move.indeterminate', reconcile: true };
    case 'not_committed':
      return { ...base, tone: 'warn', key: 'projects.move.not_committed', reconcile: true };
    case 'conflict':
      return { ...base, tone: 'warn', key: 'projects.move.conflict' };
    case 'unconfirmed':
      return { ...base, tone: 'warn', key: 'projects.move.unconfirmed', params: { cwd: clean(result.snapshot?.cwd) } };
    default:
      return { ...base, params: { detail: clean(result.message) } };
  }
}

// ---- Create --------------------------------------------------------------

/** "Atlas" -> "Atlas (2)", skipping names already taken (case-insensitive). */
export function suggestUniqueName(name = '', existingNames = []) {
  const base = clean(name);
  const taken = new Set(existingNames.map((value) => clean(value).toLowerCase()));
  if (!base || !taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} (${index})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now().toString(36)})`;
}

/**
 * Check a create-project draft against what is already listed. Blocking
 * errors: no name, no folder, a folder that is not a gateway-host path, and a
 * folder that already is a project's primary folder (the gateway refuses it
 * with 5063). A repeated name is a warning, not an error: the gateway allows
 * it and tells the two apart by slug, so the drawer keeps them apart by folder.
 */
export function validateProjectDraft({ name = '', path = '' } = {}, rows = []) {
  const title = clean(name);
  const folder = clean(path);
  const errors = {};
  const warnings = {};
  const projects = rows.filter((row) => row.kind === 'project');
  if (!title) errors.name = 'projects.create.error.name_required';
  if (!folder) errors.path = 'projects.create.error.path_required';
  else if (folder.length > 4096 || folder.includes('\0') || !isGatewayHostPath(folder)) {
    errors.path = 'projects.create.error.path_invalid';
  } else {
    const owner = projects.find((row) => samePath(row.path, folder));
    if (owner) errors.path = 'projects.create.error.path_in_use';
    if (owner) warnings.owner = owner.name;
  }
  const twin = title ? projects.find((row) => row.name.toLowerCase() === title.toLowerCase()) : null;
  if (twin) {
    warnings.name = 'projects.create.warn.name_duplicate';
    warnings.twin = twin;
    warnings.suggestion = suggestUniqueName(title, projects.map((row) => row.name));
  }
  return { ok: Object.keys(errors).length === 0, errors, warnings };
}
