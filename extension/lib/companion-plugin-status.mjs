// Is the Hermes Browser companion plugin ready on the gateway this connection uses?
//
// Hermes does not advertise plugins in /v1/capabilities, so the plugin answers
// for itself: with `plugins.isolation: in_process` (the default) it wires one
// read-only route into the API server (companion-plugin/status_route.py):
//
//   GET /api/plugins/hermes-browser-companion/status
//   -> { object, plugin, version, profile, tools, hooks, routes, live: false }
//
// The API server authenticates it with the same paired loopback token or API key
// as every other route, so the extension can reach it. (The dashboard listener's
// /api/plugins/<name>/ routes need the Webapp credential and a plugin dashboard
// manifest; this module does not use them.)
//
// A gateway without that route cannot tell "plugin missing" from "plugin too old
// to have the route", so a missing route is cross-checked against the existing
// GET /v1/toolsets, which lists every plugin toolset with its tools and whether
// it is switched on for the API server.
//
// States, each with one exact reason:
//   ready          loaded, current, toolset on
//   outdated       loaded, but an older copy (version, missing tools, or no status route)
//   disabled       loaded, but its toolset is switched off for the API server
//   not-installed  not loaded on this gateway: not installed, not enabled for the
//                  profile, or the gateway has not been restarted since
//   unreachable    the probe could not get a trustworthy answer (network, auth, 5xx)
//
// Pure module: no DOM, no storage. The caller supplies fetch.

export const COMPANION_PLUGIN_NAME = 'hermes-browser-companion';
export const COMPANION_STATUS_PATH = `/api/plugins/${COMPANION_PLUGIN_NAME}/status`;
export const COMPANION_TOOLSETS_PATH = '/v1/toolsets';
export const COMPANION_STATUS_OBJECT = 'hermes.browser_companion.status';
// The browser-context side channel the plugin lists in its status `routes`
// (companion-plugin/context_routes.py); companion-context-client.mjs calls them.
export const COMPANION_CONTEXT_STATUS_PATH = `/api/plugins/${COMPANION_PLUGIN_NAME}/context/status`;
export const COMPANION_CONTEXT_UPLOAD_PATH = `/api/plugins/${COMPANION_PLUGIN_NAME}/context`;
export const COMPANION_ACTIONS_PATH = `/api/plugins/${COMPANION_PLUGIN_NAME}/actions`;

// The plugin version this extension build expects. companion-plugin/plugin.yaml
// carries the same value and a test keeps the two equal: bump them together.
export const COMPANION_EXPECTED_VERSION = '0.4.0';
export const COMPANION_EXPECTED_TOOLS = Object.freeze([
  'browser_clear_context',
  'browser_context_journal',
  'browser_context_status',
  'browser_control_status',
  'browser_event_log',
  'browser_get_context',
  'browser_text_utility',
]);

export const COMPANION_STATES = Object.freeze({
  ready: 'ready',
  notInstalled: 'not-installed',
  disabled: 'disabled',
  outdated: 'outdated',
  unreachable: 'unreachable',
});

const STATE_SET = new Set(Object.values(COMPANION_STATES));
const DEFAULT_TIMEOUT_MS = 4000;

function clean(value = '') {
  return String(value ?? '').trim();
}

function list(values) {
  return values.length ? values.join(', ') : 'none';
}

// English wording for every reason code. The record carries this text, so
// diagnostics print it and the panel can show it without a locale string.
export const COMPANION_REASONS = Object.freeze({
  'companion-ready': ({ version, profile, toolCount } = {}) => `Loaded: version ${clean(version) || 'unknown'}${profile ? `, profile ${clean(profile)}` : ''}, ${toolCount ?? COMPANION_EXPECTED_TOOLS.length} tools.`,
  'companion-ready-route-only': ({ version, profile, toolCount } = {}) => `Loaded: version ${clean(version) || 'unknown'}${profile ? `, profile ${clean(profile)}` : ''}, ${toolCount ?? COMPANION_EXPECTED_TOOLS.length} tools. This gateway could not confirm whether its toolset is on for the API server.`,
  'companion-version-old': ({ version, expected } = {}) => `Loaded, but it is version ${clean(version) || 'unknown'} and this extension expects ${clean(expected) || COMPANION_EXPECTED_VERSION}. Reinstall it for this profile and restart the gateway.`,
  'companion-tools-missing': ({ version, missing = [] } = {}) => `Loaded (version ${clean(version) || 'unknown'}) but missing tools: ${list(missing)}. Reinstall it for this profile and restart the gateway.`,
  'companion-no-route': ({ present = [] } = {}) => `A companion plugin is loaded with ${present.length} of ${COMPANION_EXPECTED_TOOLS.length} tools, but it does not serve the status route, so it is an older copy. Reinstall it for this profile and restart the gateway.`,
  'companion-toolset-off': () => 'Loaded, but its toolset is switched off for the API server. Turn it on with `hermes tools`, or remove it from agent.disabled_toolsets.',
  'companion-not-loaded': () => 'Not loaded on this gateway: the status route is absent and no companion toolset is listed. It is not installed, not enabled for this profile, or the gateway has not been restarted since. Run `hermes plugins list` for the profile.',
  'companion-cannot-tell': () => 'This gateway serves no status route and no readable toolset list, so the extension cannot tell whether the companion plugin is loaded. This does not mean it is missing.',
  'companion-auth-refused': ({ status } = {}) => `The gateway refused the paired token (HTTP ${status ?? 401}), so the plugin could not be checked.`,
  'companion-gateway-error': ({ status } = {}) => `The gateway answered HTTP ${status ?? 500}, so the plugin could not be checked.`,
  'companion-network': ({ detail } = {}) => `The gateway could not be reached${clean(detail) ? ` (${clean(detail)})` : ''}, so the plugin could not be checked.`,
  'companion-no-token': () => 'No gateway token is available, so the plugin was not checked.',
  'companion-route': ({ version } = {}) => `Available through the companion plugin (version ${clean(version) || 'unknown'}), which serves this route on this gateway. Hermes itself has no such route.`,
});

export function companionReasonText(code, params = {}) {
  const make = COMPANION_REASONS[clean(code)];
  return make ? make(params || {}) : '';
}

/** Compare dotted numeric versions: -1, 0 or 1; null when either is not a plain version. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(clean(value));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function result(state, reasonCode, params = {}, extra = {}) {
  if (!STATE_SET.has(state)) throw new TypeError(`Unknown companion plugin state: ${state}`);
  return Object.freeze({
    state,
    reasonCode,
    params: Object.freeze({ ...params }),
    reason: companionReasonText(reasonCode, params),
    version: extra.version ?? '',
    profile: extra.profile ?? '',
    tools: Object.freeze([...(extra.tools || [])]),
    routes: Object.freeze([...(extra.routes || [])]),
    toolsetEnabled: extra.toolsetEnabled ?? null,
    via: extra.via || 'none',
    checkedAt: extra.checkedAt ?? null,
  });
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map(clean).filter(Boolean) : [];
}

/**
 * Read the status route's body. `ok: false` means "not the companion plugin's
 * answer" (wrong shape); otherwise `version`, `profile`, `tools` are the
 * plugin's own words and `missing` is what this extension expects and the
 * plugin did not list.
 */
export function parseCompanionStatusPayload(payload, { expectedTools = COMPANION_EXPECTED_TOOLS } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  if (payload.object !== COMPANION_STATUS_OBJECT || payload.plugin !== COMPANION_PLUGIN_NAME) return { ok: false };
  const tools = stringList(payload.tools);
  const have = new Set(tools);
  return {
    ok: true,
    version: clean(payload.version),
    profile: clean(payload.profile),
    tools,
    routes: stringList(payload.routes),
    missing: expectedTools.filter((name) => !have.has(name)),
  };
}

/**
 * Find the companion toolset in a GET /v1/toolsets body: `{ present, enabled,
 * tools }`, or `{ present: false }`. `valid: false` when the body is not a
 * toolset list at all.
 */
export function parseCompanionToolsets(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (!rows) return { valid: false, present: false };
  const row = rows.find((item) => item && typeof item === 'object' && item.name === COMPANION_PLUGIN_NAME);
  if (!row) return { valid: true, present: false };
  return {
    valid: true,
    present: true,
    enabled: row.enabled === true ? true : (row.enabled === false ? false : null),
    tools: stringList(row.tools),
  };
}

/**
 * Turn what the two reads found into one state. `route` is `{ kind: 'ok',
 * parsed }`, `{ kind: 'absent' }` (404/405 or an unreadable answer from a
 * reachable gateway), or `{ kind: 'error', reasonCode, params }`; `toolsets` is
 * parseCompanionToolsets()'s output or null when it could not be read.
 */
export function classifyCompanionPlugin({ route, toolsets = null, expectedVersion = COMPANION_EXPECTED_VERSION, expectedTools = COMPANION_EXPECTED_TOOLS, checkedAt = null } = {}) {
  const stamp = { checkedAt };
  if (route?.kind === 'ok') {
    const parsed = route.parsed;
    const info = { version: parsed.version, profile: parsed.profile, tools: parsed.tools, routes: parsed.routes || [], via: 'route', ...stamp };
    if (parsed.missing.length) {
      return result(COMPANION_STATES.outdated, 'companion-tools-missing', { version: parsed.version, missing: parsed.missing }, info);
    }
    const order = compareVersions(parsed.version, expectedVersion);
    if (order !== null && order < 0) {
      return result(COMPANION_STATES.outdated, 'companion-version-old', { version: parsed.version, expected: expectedVersion }, info);
    }
    if (toolsets?.present && toolsets.enabled === false) {
      return result(COMPANION_STATES.disabled, 'companion-toolset-off', {}, { ...info, toolsetEnabled: false });
    }
    const params = { version: parsed.version, profile: parsed.profile, toolCount: parsed.tools.length };
    if (toolsets?.present) return result(COMPANION_STATES.ready, 'companion-ready', params, { ...info, toolsetEnabled: toolsets.enabled });
    return result(COMPANION_STATES.ready, 'companion-ready-route-only', params, info);
  }
  if (route?.kind === 'error') {
    return result(COMPANION_STATES.unreachable, route.reasonCode, route.params || {}, { via: 'route', ...stamp });
  }
  // The route is absent on a gateway that answered. Ask the toolset list.
  if (!toolsets || !toolsets.valid) {
    return result(COMPANION_STATES.unreachable, 'companion-cannot-tell', {}, { via: 'toolsets', ...stamp });
  }
  if (!toolsets.present) {
    return result(COMPANION_STATES.notInstalled, 'companion-not-loaded', {}, { via: 'toolsets', ...stamp });
  }
  const present = expectedTools.filter((name) => toolsets.tools.includes(name));
  return result(COMPANION_STATES.outdated, 'companion-no-route', { present }, {
    via: 'toolsets', tools: toolsets.tools, toolsetEnabled: toolsets.enabled, ...stamp,
  });
}

function joinUrl(baseUrl, path) {
  return `${clean(baseUrl).replace(/\/+$/, '')}${path}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getJson(fetchImpl, url, { token, timeoutMs }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'omit',
      ...(controller ? { signal: controller.signal } : {}),
    });
    return { status: Number(response.status), body: response.ok ? await readJson(response) : null };
  } catch (error) {
    return { status: 0, error: clean(error?.name === 'AbortError' ? 'timed out' : (error?.message || 'network error')).slice(0, 80) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe the gateway at `baseUrl` (the API server, e.g. http://127.0.0.1:8642)
 * with the paired token. Bounded (two GETs, each with a timeout) and read-only.
 * Never throws: every failure is an `unreachable` result with its reason.
 */
export async function probeCompanionPlugin({
  baseUrl = '',
  token = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  expectedVersion = COMPANION_EXPECTED_VERSION,
  expectedTools = COMPANION_EXPECTED_TOOLS,
} = {}) {
  const checkedAt = Number(typeof now === 'function' ? now() : now);
  const bearer = clean(token);
  if (!bearer) return result(COMPANION_STATES.unreachable, 'companion-no-token', {}, { checkedAt });
  if (!clean(baseUrl) || typeof fetchImpl !== 'function') {
    return result(COMPANION_STATES.unreachable, 'companion-network', { detail: 'no gateway address' }, { checkedAt });
  }
  const options = { token: bearer, timeoutMs };
  const toolsetsRead = () => getJson(fetchImpl, joinUrl(baseUrl, COMPANION_TOOLSETS_PATH), options);
  const asToolsets = (read) => (read.status >= 200 && read.status < 300 ? parseCompanionToolsets(read.body) : null);

  const status = await getJson(fetchImpl, joinUrl(baseUrl, COMPANION_STATUS_PATH), options);
  const classify = (route, toolsets = null) => classifyCompanionPlugin({ route, toolsets, expectedVersion, expectedTools, checkedAt });

  if (status.status === 401 || status.status === 403) {
    return classify({ kind: 'error', reasonCode: 'companion-auth-refused', params: { status: status.status } });
  }
  if (status.status >= 500) {
    return classify({ kind: 'error', reasonCode: 'companion-gateway-error', params: { status: status.status } });
  }
  if (status.status >= 200 && status.status < 300) {
    const parsed = parseCompanionStatusPayload(status.body, { expectedTools });
    if (parsed.ok) {
      const toolsets = asToolsets(await toolsetsRead());
      return classify({ kind: 'ok', parsed }, toolsets);
    }
    // A 200 that is not the plugin's body (a proxy, a different server): treat as no route.
  }
  // 404/405, an unrecognised 200, or a network failure (a browser reports a
  // cross-origin 404 without CORS headers as a network error). The toolset list
  // decides between "not loaded" and "an older copy"; if it fails too, the
  // gateway is the problem.
  const toolsetsResponse = await toolsetsRead();
  if (toolsetsResponse.status === 401 || toolsetsResponse.status === 403) {
    return classify({ kind: 'error', reasonCode: 'companion-auth-refused', params: { status: toolsetsResponse.status } });
  }
  if (toolsetsResponse.status === 0) {
    return classify({ kind: 'error', reasonCode: 'companion-network', params: { detail: toolsetsResponse.error || status.error || '' } });
  }
  if (toolsetsResponse.status >= 500) {
    return classify({ kind: 'error', reasonCode: 'companion-gateway-error', params: { status: toolsetsResponse.status } });
  }
  return classify({ kind: 'absent' }, asToolsets(toolsetsResponse));
}

// ---- Capability record bridge ------------------------------------------------

// The capability record vocabulary (capability-status.mjs) for each state. The
// plugin is optional, so "not loaded" is `unsupported` (the gateway answered and
// has no such plugin) rather than an error, and an older copy is `degraded`.
const RECORD_STATE = Object.freeze({
  [COMPANION_STATES.ready]: 'available',
  [COMPANION_STATES.outdated]: 'degraded',
  [COMPANION_STATES.disabled]: 'blocked',
  [COMPANION_STATES.notInstalled]: 'unsupported',
  [COMPANION_STATES.unreachable]: 'unknown',
});

/**
 * The fields a capability record is built from for one probe result:
 * `{ state, reasonCode, params, reason, checkedAt }`, or null when `probe` is
 * not a result of probeCompanionPlugin().
 */
export function companionRecordFields(probe) {
  if (!probe || !STATE_SET.has(probe.state) || !probe.reasonCode) return null;
  return {
    state: RECORD_STATE[probe.state],
    reasonCode: probe.reasonCode,
    params: { ...(probe.params || {}), companionState: probe.state },
    reason: probe.reason || companionReasonText(probe.reasonCode, probe.params),
    checkedAt: Number.isFinite(probe.checkedAt) ? probe.checkedAt : null,
  };
}

// The three capability rows the plugin can serve when Hermes cannot, and the path
// of the route each one means. A row reads "available via the companion plugin"
// only when the plugin's own status route lists that path and the plugin is
// ready; otherwise it keeps its honest "no such route" reason.
export const COMPANION_ROUTE_CAPABILITIES = Object.freeze({
  browserContextUpload: COMPANION_CONTEXT_UPLOAD_PATH,
  browserContextStatus: COMPANION_CONTEXT_STATUS_PATH,
  pluginActions: COMPANION_ACTIONS_PATH,
});

/**
 * The record fields for one of those rows from a probe result, or null when the
 * probe does not prove the route (not ready, an older copy without the route, or
 * not a probe result). Same shape as companionRecordFields().
 */
export function companionRouteRecordFields(probe, id) {
  const path = COMPANION_ROUTE_CAPABILITIES[clean(id)];
  if (!path || !probe || probe.state !== COMPANION_STATES.ready || probe.via !== 'route') return null;
  if (!Array.isArray(probe.routes) || !probe.routes.includes(path)) return null;
  const params = { version: probe.version || '', route: path, companionState: probe.state };
  return {
    state: 'available',
    reasonCode: 'companion-route',
    params,
    reason: companionReasonText('companion-route', params),
    checkedAt: Number.isFinite(probe.checkedAt) ? probe.checkedAt : null,
  };
}

/** True for a reason code this module owns (the panel's locale tables do not have it). */
export function isCompanionReasonCode(code) {
  return Object.hasOwn(COMPANION_REASONS, clean(code));
}
