// Projects client for the Hermes dashboard gateway (`projects.*` over the
// dashboard WebSocket).
//
// Pure module: every call goes through an injected `request(method, params)`
// (the createGatewayClient request), so nothing here opens a socket or touches
// the DOM. Contract source: tui_gateway/contracts/projects_pets.py and
// tui_gateway/methods_projects.py in the installed Hermes.
//
// Projects are backend workspaces, not client-side labels. A session belongs to
// a project only because its `cwd` resolves under one of the project's folders,
// so there is no project id on a session. Moving a session is a workspace
// change (see session-mutate.mjs), not a call in this file.
//
// Every method is profile-scoped, and the same project name can exist on two
// profiles or two hosts. Results and cache keys therefore carry the identity
// (endpoint + principal + profile) they were read under.

import { dashboardPrincipalFromMe } from './context-consent.mjs';
import { isLoopbackGatewayUrl } from './connection-modes.mjs';

export const PROJECTS_METHODS = Object.freeze({
  list: 'projects.list',
  tree: 'projects.tree',
  projectSessions: 'projects.project_sessions',
  create: 'projects.create',
  forCwd: 'projects.for_cwd',
});

// methods_projects.py: generic failure / id resolved to nothing / invalid
// argument (a duplicate primary path, an unusable name). 4064 is the legacy
// fallback's "profile unavailable" for a ticket or profile that no longer
// resolves.
export const PROJECTS_ERROR_CODES = Object.freeze({
  generic: 5061,
  noProject: 5062,
  invalidArgument: 5063,
  profileUnavailable: 4064,
});

export const PROJECTS_UNAVAILABLE = Object.freeze({
  notConnected: 'not-connected',
  restOnly: 'rest-only',
  noSessionAuthority: 'no-session-authority',
  methodNotFound: 'method-not-found',
  // The gateway's Webapp is serving this connection's dashboard routes and the panel does not hold
  // its sign-in: Projects cannot open a session-authority socket until it does.
  webappSignIn: 'webapp-sign-in',
});

const UNAVAILABLE_COPY = Object.freeze({
  [PROJECTS_UNAVAILABLE.notConnected]:
    'Projects are unavailable until the Hermes dashboard WebSocket is connected.',
  [PROJECTS_UNAVAILABLE.restOnly]:
    'Projects need the Hermes dashboard WebSocket. This connection only reaches the REST API, so Recents stays available and Projects does not.',
  [PROJECTS_UNAVAILABLE.noSessionAuthority]:
    'This Hermes gateway did not advertise session authority, so projects and moving sessions are unavailable. Update Hermes to a build with canonical session mutations.',
  [PROJECTS_UNAVAILABLE.webappSignIn]:
    "Projects needs Hermes Web's sign-in. Open Hermes Web once (run hermes webapp), then try again.",
});

function clean(value = '') {
  return String(value ?? '').trim();
}

/**
 * Whether the connection can serve a gateway method that needs the session
 * authority (projects.*, session.mutate). The reason is exact so the drawer can
 * say why instead of showing an empty list:
 *   rest-only            the connection has no dashboard WebSocket at all;
 *   not-connected        the WebSocket has not delivered gateway.ready yet;
 *   no-session-authority gateway.ready lacks `session_authority: true`;
 *   method-not-found     this connection already answered -32601 for `method`;
 *   webapp-sign-in       the caller says (`blockedReason`) that Hermes Web's sign-in is missing.
 */
export function gatewayAuthorityAvailability({
  dashboardWs = false,
  readyPayload = null,
  unsupportedMethods = [],
  method = '',
  blockedReason = '',
} = {}) {
  if (clean(blockedReason) === PROJECTS_UNAVAILABLE.webappSignIn) {
    return {
      available: false,
      reason: PROJECTS_UNAVAILABLE.webappSignIn,
      message: UNAVAILABLE_COPY[PROJECTS_UNAVAILABLE.webappSignIn],
    };
  }
  if (dashboardWs !== true) {
    return { available: false, reason: PROJECTS_UNAVAILABLE.restOnly, message: UNAVAILABLE_COPY[PROJECTS_UNAVAILABLE.restOnly] };
  }
  if (!readyPayload || typeof readyPayload !== 'object') {
    return { available: false, reason: PROJECTS_UNAVAILABLE.notConnected, message: UNAVAILABLE_COPY[PROJECTS_UNAVAILABLE.notConnected] };
  }
  if (readyPayload.session_authority !== true) {
    return {
      available: false,
      reason: PROJECTS_UNAVAILABLE.noSessionAuthority,
      message: UNAVAILABLE_COPY[PROJECTS_UNAVAILABLE.noSessionAuthority],
    };
  }
  const target = clean(method);
  const unsupported = unsupportedMethods instanceof Set ? unsupportedMethods : new Set(unsupportedMethods);
  if (target && unsupported.has(target)) {
    return {
      available: false,
      reason: PROJECTS_UNAVAILABLE.methodNotFound,
      method: target,
      message: `The connected Hermes gateway answered "method not found" (-32601) for ${target}.`,
    };
  }
  return { available: true };
}

// ---- Identity and cache --------------------------------------------------

function normalizeEndpoint(raw = '') {
  try {
    const url = new URL(clean(raw));
    if (url.username || url.password) return '';
    const protocol = { 'ws:': 'http:', 'wss:': 'https:' }[url.protocol] || url.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return `${protocol}//${url.host}`;
  } catch {
    return '';
  }
}

function normalizePrincipal(principal = '') {
  if (principal && typeof principal === 'object') return dashboardPrincipalFromMe(principal);
  return clean(principal);
}

/**
 * The scope a projects read belongs to. `key` is what caches use; two profiles
 * or two hosts with the same project name get different keys. `cacheable` is
 * false for a remote host whose signed-in principal is unknown, because a cache
 * shared across a user switch there could show someone else's projects.
 */
export function projectsIdentity({ endpoint = '', principal = '', profile = '' } = {}) {
  const origin = normalizeEndpoint(endpoint);
  if (!origin) return null;
  const normalizedPrincipal = normalizePrincipal(principal);
  const normalizedProfile = clean(profile) || 'default';
  return {
    endpoint: origin,
    principal: normalizedPrincipal,
    profile: normalizedProfile,
    key: JSON.stringify([1, origin, normalizedPrincipal, normalizedProfile]),
    cacheable: Boolean(normalizedPrincipal) || isLoopbackGatewayUrl(origin),
  };
}

export function projectsCacheKey(identity = null, resource = '', arg = '') {
  if (!identity?.key) return '';
  return JSON.stringify([identity.key, clean(resource), clean(arg)]);
}

/** "profile work on hermes.example.com": what the drawer shows beside the list. */
export function describeProjectsScope(identity = null) {
  if (!identity) return '';
  let host = identity.endpoint;
  try {
    host = new URL(identity.endpoint).host;
  } catch {
    // Keep the raw endpoint.
  }
  return `profile ${identity.profile} on ${host}`;
}

export function createProjectsCache({ ttlMs = 30_000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      if (!key) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    set(key, identityKey, value) {
      if (!key || !identityKey) return;
      const fetchedAt = now();
      entries.set(key, { identityKey, value, fetchedAt, expiresAt: fetchedAt + ttlMs });
    },
    invalidate(identityKey) {
      for (const [key, entry] of entries) {
        if (entry.identityKey === identityKey) entries.delete(key);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

// ---- Wire normalization --------------------------------------------------

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableText(value) {
  const text = clean(value);
  return text || null;
}

export function normalizeProjectFolder(raw = {}) {
  const folder = asObject(raw);
  const path = clean(folder.path);
  if (!path) return null;
  return {
    path,
    label: nullableText(folder.label),
    isPrimary: folder.is_primary === true,
    addedAt: Number.isFinite(Number(folder.added_at)) ? Number(folder.added_at) : null,
  };
}

/** ProjectInfo (hermes_cli/projects_db.py Project.to_dict). Null when it has no id. */
export function normalizeProject(raw = null) {
  const project = asObject(raw);
  const id = clean(project.id);
  if (!id) return null;
  return {
    id,
    slug: clean(project.slug),
    name: clean(project.name) || clean(project.slug) || id,
    description: nullableText(project.description),
    icon: nullableText(project.icon),
    color: nullableText(project.color),
    boardSlug: nullableText(project.board_slug),
    primaryPath: nullableText(project.primary_path),
    archived: project.archived === true,
    createdAt: numberOr(project.created_at, 0),
    folders: (Array.isArray(project.folders) ? project.folders : []).map(normalizeProjectFolder).filter(Boolean),
  };
}

export function normalizeProjectsPayload(raw = null) {
  const payload = asObject(raw);
  if (!Array.isArray(payload.projects)) return null;
  return {
    projects: payload.projects.map(normalizeProject).filter(Boolean),
    activeId: nullableText(payload.active_id),
  };
}

// A session row as the sidebar tree stamps it (methods_projects._project_tree_row).
export function normalizeTreeSession(raw = {}) {
  const row = asObject(raw);
  const id = clean(row.id);
  if (!id) return null;
  return {
    id,
    title: nullableText(row.title),
    preview: nullableText(row.preview),
    source: nullableText(row.source),
    model: nullableText(row.model),
    startedAt: Number.isFinite(Number(row.started_at)) ? Number(row.started_at) : null,
    lastActive: Number.isFinite(Number(row.last_active)) ? Number(row.last_active) : null,
    messageCount: numberOr(row.message_count, 0),
    isActive: row.is_active === true,
    cwd: nullableText(row.cwd),
    gitBranch: nullableText(row.git_branch),
    gitRepoRoot: nullableText(row.git_repo_root),
    archived: row.archived === true,
    pinned: row.pinned === true,
    profile: nullableText(row.profile),
  };
}

function normalizeTreeLane(raw = {}) {
  const lane = asObject(raw);
  return {
    id: clean(lane.id),
    label: clean(lane.label),
    path: nullableText(lane.path),
    isMain: lane.isMain === true,
    isKanban: lane.isKanban === true,
    isGit: lane.isGit !== false,
    sessions: (Array.isArray(lane.sessions) ? lane.sessions : []).map(normalizeTreeSession).filter(Boolean),
  };
}

function normalizeTreeRepo(raw = {}) {
  const repo = asObject(raw);
  return {
    id: clean(repo.id),
    label: clean(repo.label),
    path: nullableText(repo.path),
    sessionCount: numberOr(repo.sessionCount, 0),
    lanes: (Array.isArray(repo.groups) ? repo.groups : []).map(normalizeTreeLane),
  };
}

/** One ProjectTreeNode: explicit project, auto (git root) or the synthetic Home bucket. */
export function normalizeProjectTreeNode(raw = null) {
  const node = asObject(raw);
  const id = clean(node.id);
  if (!id) return null;
  return {
    id,
    label: clean(node.label) || id,
    path: nullableText(node.path),
    color: nullableText(node.color),
    icon: nullableText(node.icon),
    isAuto: node.isAuto === true,
    isNoProject: node.isNoProject === true,
    sessionCount: numberOr(node.sessionCount, 0),
    lastActive: numberOr(node.lastActive, 0),
    totalTokens: numberOr(node.totalTokens, 0),
    totalCostUsd: numberOr(node.totalCostUsd, 0),
    repos: (Array.isArray(node.repos) ? node.repos : []).map(normalizeTreeRepo),
    previewSessions: (Array.isArray(node.previewSessions) ? node.previewSessions : []).map(normalizeTreeSession).filter(Boolean),
    sessionIds: (Array.isArray(node.sessionIds) ? node.sessionIds : []).map(clean).filter(Boolean),
  };
}

export function normalizeProjectsTree(raw = null) {
  const payload = asObject(raw);
  if (!Array.isArray(payload.projects)) return null;
  return {
    projects: payload.projects.map(normalizeProjectTreeNode).filter(Boolean),
    activeId: nullableText(payload.active_id),
    scopedSessionIds: (Array.isArray(payload.scoped_session_ids) ? payload.scoped_session_ids : []).map(clean).filter(Boolean),
  };
}

export function normalizeProjectSessions(raw = null) {
  const payload = asObject(raw);
  if (!('project' in payload)) return null;
  return { project: normalizeProjectTreeNode(payload.project) };
}

export function normalizeForCwd(raw = null) {
  const payload = asObject(raw);
  const cwd = clean(payload.cwd);
  if (!cwd) return null;
  return { project: normalizeProject(payload.project), cwd, branch: clean(payload.branch) };
}

// ---- Request builders ----------------------------------------------------

function withProfile(params, profile) {
  const name = clean(profile);
  return name ? { ...params, profile: name } : params;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function buildProjectsTreeParams({ profile = '', previewLimit = null, sessionLimit = null } = {}) {
  return withProfile({
    ...(positiveInteger(previewLimit) ? { preview_limit: previewLimit } : {}),
    ...(positiveInteger(sessionLimit) ? { session_limit: sessionLimit } : {}),
  }, profile);
}

export function buildProjectSessionsParams({ profile = '', projectId = '', sessionLimit = null } = {}) {
  const id = clean(projectId);
  if (!id) throw new TypeError('A project id is required to list its sessions.');
  return withProfile({
    project_id: id,
    ...(positiveInteger(sessionLimit) ? { session_limit: sessionLimit } : {}),
  }, profile);
}

/**
 * projects.create params. Paths are gateway-host paths: the browser cannot open
 * a native picker on a remote machine, so they are typed and the gateway checks
 * them. `primaryPath` defaults to nothing; the gateway picks one when omitted.
 */
export function buildProjectCreateParams({
  profile = '',
  name = '',
  folders = [],
  primaryPath = '',
  slug = '',
  description = '',
  icon = '',
  color = '',
  boardSlug = '',
  use = false,
} = {}) {
  const title = clean(name);
  if (!title) throw new TypeError('A project name is required.');
  const paths = [];
  for (const folder of Array.isArray(folders) ? folders : []) {
    const path = clean(folder);
    if (path && !paths.includes(path)) paths.push(path);
  }
  const primary = clean(primaryPath);
  if (primary && !paths.includes(primary)) paths.push(primary);
  const optional = { slug, description, icon, color, board_slug: boardSlug };
  return withProfile({
    name: title,
    ...(paths.length ? { folders: paths } : {}),
    ...(primary ? { primary_path: primary } : {}),
    ...Object.fromEntries(Object.entries(optional).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value)),
    ...(use === true ? { use: true } : {}),
  }, profile);
}

// ---- Errors --------------------------------------------------------------

function rpcCodeOf(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  return Number.isFinite(code) ? code : null;
}

function isMethodNotFound(error) {
  return rpcCodeOf(error) === -32601 || clean(error?.data?.reason).toLowerCase() === 'unknown_method';
}

/**
 * Failure reasons the drawer can act on:
 *   method-not-found     -32601: this gateway does not serve the method;
 *   profile-unavailable  4064: the profile no longer resolves;
 *   not-found            5062: the project id resolves to nothing;
 *   invalid-argument     5063: the gateway refused the value (duplicate primary path);
 *   gateway-error        5061 or any other coded refusal;
 *   timeout / disconnected  no answer: the socket is gone or the call timed out.
 */
export function classifyProjectsError(error) {
  const message = clean(error?.message) || 'Hermes could not complete the projects request.';
  if (isMethodNotFound(error)) return { reason: PROJECTS_UNAVAILABLE.methodNotFound, message, code: rpcCodeOf(error) };
  const code = rpcCodeOf(error);
  if (code === PROJECTS_ERROR_CODES.profileUnavailable) return { reason: 'profile-unavailable', message, code };
  if (code === PROJECTS_ERROR_CODES.noProject) return { reason: 'not-found', message, code };
  if (code === PROJECTS_ERROR_CODES.invalidArgument) return { reason: 'invalid-argument', message, code };
  if (code !== null) return { reason: 'gateway-error', message, code };
  if (/timed out/i.test(message)) return { reason: 'timeout', message, code: null };
  return { reason: 'disconnected', message, code: null };
}

// ---- Client --------------------------------------------------------------

/**
 * A projects client bound to one connection identity. Build a new one when the
 * endpoint, signed-in principal or profile changes; its cache and its record of
 * unsupported methods never outlive that identity.
 *
 * Every call resolves to `{ ok: true, data, identity, cached }` or
 * `{ ok: false, reason, message, unavailable }`. A refusal never throws, so a
 * REST-only or older gateway keeps Recents usable. Bad arguments are the one
 * thing that throws (TypeError).
 */
export function createProjectsClient({
  request,
  dashboardWs = false,
  getReadyPayload = () => null,
  endpoint = '',
  principal = '',
  profile = '',
  cache = createProjectsCache(),
} = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  const identity = projectsIdentity({ endpoint, principal, profile });
  const unsupportedMethods = new Set();
  // Bumped by invalidate(): a read that started before it must not repopulate the cache.
  let epoch = 0;

  function availability(method = '') {
    if (!identity) {
      return { available: false, reason: PROJECTS_UNAVAILABLE.notConnected, message: 'A valid gateway address is required for Projects.' };
    }
    return gatewayAuthorityAvailability({ dashboardWs, readyPayload: getReadyPayload(), unsupportedMethods, method });
  }

  function unavailable(gate) {
    return { ok: false, unavailable: true, reason: gate.reason, message: gate.message, ...(gate.method ? { method: gate.method } : {}) };
  }

  function invalidate() {
    epoch += 1;
    if (identity) cache.invalidate(identity.key);
  }

  async function call(method, params, { normalize, resource = '', arg = '', force = false, useCache = true } = {}) {
    const gate = availability(method);
    if (!gate.available) return unavailable(gate);
    const cacheKey = useCache && identity.cacheable ? projectsCacheKey(identity, resource, arg) : '';
    if (cacheKey && !force) {
      const hit = cache.get(cacheKey);
      if (hit) return { ok: true, data: hit.value, identity, cached: true, fetchedAt: hit.fetchedAt };
    }
    const startedEpoch = epoch;
    let raw;
    try {
      raw = await request(method, params);
    } catch (error) {
      const failure = classifyProjectsError(error);
      if (failure.reason === PROJECTS_UNAVAILABLE.methodNotFound) {
        unsupportedMethods.add(method);
        return { ok: false, unavailable: true, method, ...failure };
      }
      return { ok: false, unavailable: false, method, ...failure };
    }
    const data = normalize(raw);
    if (!data) {
      return { ok: false, unavailable: false, method, reason: 'malformed-response', message: `Hermes answered ${method} with an unexpected shape.` };
    }
    if (cacheKey && startedEpoch === epoch) cache.set(cacheKey, identity.key, data);
    return { ok: true, data, identity, cached: false, fetchedAt: Date.now() };
  }

  return {
    identity,
    scopeLabel: describeProjectsScope(identity),
    availability,
    invalidate,

    list({ force = false } = {}) {
      return call(PROJECTS_METHODS.list, withProfile({}, profile), {
        normalize: normalizeProjectsPayload, resource: 'list', force,
      });
    },

    tree({ previewLimit = null, sessionLimit = null, force = false } = {}) {
      const params = buildProjectsTreeParams({ profile, previewLimit, sessionLimit });
      return call(PROJECTS_METHODS.tree, params, {
        normalize: normalizeProjectsTree, resource: 'tree', arg: JSON.stringify([previewLimit, sessionLimit]), force,
      });
    },

    projectSessions(projectId, { sessionLimit = null, force = false } = {}) {
      const params = buildProjectSessionsParams({ profile, projectId, sessionLimit });
      return call(PROJECTS_METHODS.projectSessions, params, {
        normalize: normalizeProjectSessions, resource: 'project_sessions', arg: JSON.stringify([params.project_id, sessionLimit]), force,
      });
    },

    // Never cached: the answer decides where a session goes next.
    forCwd(cwd = '') {
      const path = clean(cwd);
      return call(PROJECTS_METHODS.forCwd, withProfile(path ? { cwd: path } : {}, profile), {
        normalize: normalizeForCwd, useCache: false,
      });
    },

    async create(options = {}) {
      const params = buildProjectCreateParams({ ...options, profile });
      // The gateway may have committed the row even when the answer is lost, so
      // every cached listing is stale from the moment the call is sent.
      invalidate();
      const result = await call(PROJECTS_METHODS.create, params, {
        normalize: (raw) => {
          const project = normalizeProject(asObject(raw).project);
          return project ? { project } : null;
        },
        useCache: false,
      });
      if (result.ok) invalidate();
      if (!result.ok && result.reason === 'malformed-response') {
        return { ...result, reason: 'not-created', message: 'Hermes did not return the project it was asked to create.' };
      }
      return result;
    },
  };
}
