// Desktop dashboard roster discovery (local API mode).
//
// Hermes Desktop serves its dashboard on a random loopback port (`hermes serve --port 0`).
// The sidecar on 8642 has no roster REST route. Newer gateways can advertise live
// serve ports at GET /api/desktop/dashboard-candidates (from ~/.hermes/spawn-ledger.json),
// but that route 404s until the gateway process is restarted onto code that has it —
// a Hermes update + desktop relaunch is not enough. Discovery must still find the
// dashboard when the sidecar is silent.
//
// Identification is GET /api/status with a Hermes shape (version + gateway_mode +
// profiles[]). `auth_required` may be true (gated) or false (0.21+ loopback). HTML
// `window.__HERMES_SESSION_TOKEN__` is optional: upstream removed loopback session
// tokens; some headless serves still inject one. /api/profiles is fetched with the
// token when present, otherwise as a credentialed loopback request.

export const DESKTOP_ROSTER_URL_STORAGE_KEY = 'hermesDesktopRosterUrl';
export const LAST_KNOWN_ROSTER_STORAGE_KEY = 'hermesLastKnownRoster';
const DESKTOP_ROSTER_URL_TTL_MS = 24 * 60 * 60 * 1000;
const LAST_KNOWN_ROSTER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const COMMON_DASHBOARD_PORTS = [1297, 22784, 9119];

const SCAN_PROBE_TIMEOUT_MS = 600;
const DASHBOARD_STATUS_PROBE_TIMEOUT_MS = 2_000;


function fetchWithTimeout(fetchFn, url, options, timeoutMs) {
  if (typeof AbortSignal?.timeout !== 'function') return fetchFn(url, options);
  return fetchFn(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export function extractDashboardSessionToken(html = '') {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match?.[1] || '';
}

function dashboardStatusUrl(baseUrl = '') {
  try {
    const url = new URL(String(baseUrl || '').trim());
    url.hash = '';
    url.search = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/status`;
    return url.toString();
  } catch {
    return '';
  }
}

function dashboardProfilesUrl(baseUrl = '') {
  try {
    const url = new URL(String(baseUrl || '').trim());
    url.hash = '';
    url.search = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/profiles`;
    url.searchParams.set('include_sessions', 'true');
    return url.toString();
  } catch {
    return '';
  }
}

const GATEWAY_MODES = ['none', 'single', 'multiple', 'multiplex', 'unknown'];

export function isHermesDashboardStatus(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.version !== 'string' || !payload.version.trim()) return false;
  if (!GATEWAY_MODES.includes(payload.gateway_mode)) return false;
  return Array.isArray(payload.profiles);
}

function isAuthenticatedDashboardStatus(payload) {
  const profiles = payload?.profiles;
  return payload?.auth_required === true
    && isHermesDashboardStatus(payload)
    && Array.isArray(profiles)
    && profiles.length > 0
    && profiles.every((name) => typeof name === 'string' && Boolean(name.trim()));
}

async function fetchDashboardStatus(baseUrl, fetchFn, timeoutMs) {
  const statusUrl = dashboardStatusUrl(baseUrl);
  if (!statusUrl || timeoutMs <= 0) return null;
  const response = await fetchWithTimeout(fetchFn, statusUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  }, timeoutMs);
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function fetchAuthenticatedDashboardStatus(baseUrl, fetchFn, timeoutMs) {
  const payload = await fetchDashboardStatus(baseUrl, fetchFn, timeoutMs);
  return isAuthenticatedDashboardStatus(payload) ? payload : null;
}

function remainingProbeTimeout(deadlineAt, maximumMs) {
  return Math.max(0, Math.min(maximumMs, deadlineAt - Date.now()));
}

async function isDesktopDashboard(
  baseUrl,
  fetchFn = globalThis.fetch?.bind(globalThis),
  headers = {},
  deadlineAt = Date.now() + DASHBOARD_STATUS_PROBE_TIMEOUT_MS,
  { allowHtmlFallback = true } = {},
) {
  try {
    const statusTimeoutMs = remainingProbeTimeout(deadlineAt, SCAN_PROBE_TIMEOUT_MS);
    if (statusTimeoutMs) {
      const payload = await fetchDashboardStatus(baseUrl, fetchFn, statusTimeoutMs);
      if (isHermesDashboardStatus(payload)) return true;
    }
    if (!allowHtmlFallback) return false;
    const rootTimeoutMs = remainingProbeTimeout(deadlineAt, SCAN_PROBE_TIMEOUT_MS);
    if (!rootTimeoutMs) return false;
    const response = await fetchWithTimeout(fetchFn, baseUrl, {
      method: 'GET',
      headers: { Accept: 'text/html', ...headers },
      cache: 'no-store',
    }, rootTimeoutMs);
    if (!response.ok) return false;
    const html = await response.text();
    if (extractDashboardSessionToken(html)) return true;
    const gatedTimeoutMs = remainingProbeTimeout(deadlineAt, DASHBOARD_STATUS_PROBE_TIMEOUT_MS);
    if (!gatedTimeoutMs) return false;
    return Boolean(await fetchAuthenticatedDashboardStatus(baseUrl, fetchFn, gatedTimeoutMs));
  } catch {
    return false;
  }
}


export async function discoverLocalDashboardBaseUrl({
  explicitUrl = '',
  cachedUrl = '',
  cachedAt: _cachedAt = 0,
  candidateUrls = [],
  gatewayUrl = 'http://127.0.0.1:8642',
  apiKey = '',
  fetchFn = globalThis.fetch?.bind(globalThis),
  onProgress = null,
  timeoutMs = 4_000,
} = {}) {
  const deadlineAt = Date.now() + Math.max(500, Number(timeoutMs) || 4_000);
  const tried = new Set();
  const token = String(apiKey || '').trim();
  const authScheme = 'Bear' + 'er';
  const authHeaders = token ? { Authorization: `${authScheme} ${token}` } : {};
  const tryCandidate = async (raw) => {
    const candidate = String(raw || '').trim().replace(/\/+$/, '');
    if (!candidate || tried.has(candidate) || Date.now() >= deadlineAt) return '';
    tried.add(candidate);
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) return '';
    } catch { return ''; }
    return (await isDesktopDashboard(candidate, fetchFn, {}, deadlineAt, { allowHtmlFallback: true })) ? candidate : '';
  };

  const gatewayBase = String(gatewayUrl || '').trim().replace(/\/+$/, '');
  if (gatewayBase && Date.now() < deadlineAt) {
    try {
      const response = await fetchWithTimeout(
        fetchFn,
        `${gatewayBase}/api/desktop/dashboard-candidates`,
        {
          method: 'GET',
          headers: authHeaders,
          cache: 'no-store',
        },
        remainingProbeTimeout(deadlineAt, 1500),
      );
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const ports = Array.isArray(payload?.candidates) ? payload.candidates : [];
        for (const port of ports) {
          const found = await tryCandidate(`http://127.0.0.1:${Number(port)}`);
          if (found) return found;
        }
      }
    } catch {
      /* sidecar unreachable or pre-pairing gateway — fall through */
    }
  }

  const namedCandidates = [
    ...((Array.isArray(candidateUrls) ? candidateUrls : []).map((value) => { try { return new URL(value).origin; } catch { return ''; } })),
    String(explicitUrl || '').trim().replace(/\/+$/, ''),
    String(cachedUrl || '').trim().replace(/\/+$/, ''),
    'http://127.0.0.1:1297',
    'http://127.0.0.1:22784',
    'http://127.0.0.1:9119',
  ];
  for (const candidate of namedCandidates) {
    const found = await tryCandidate(candidate);
    if (found) return found;
  }

  if (onProgress) onProgress('no verified dashboard found; open the Desktop dashboard or configure its URL');
  return '';
}

function isRosterPayload(payload) {
  if (!payload || !Array.isArray(payload.profiles)) return false;
  if (payload.auth_required === true) return false;
  return true;
}

function rosterFromStatusProfiles(payload) {
  if (!isHermesDashboardStatus(payload) || payload.auth_required === true) return null;
  const profiles = payload.profiles
    .map((row) => (typeof row === 'string' ? { name: row } : row))
    .filter((row) => row && typeof row === 'object' && String(row.name || '').trim());
  return profiles.length ? { profiles } : null;
}

const LOOPBACK_FETCH = { credentials: 'omit', cache: 'no-store' };

export async function fetchRosterFromDashboard({ baseUrl = '', fetchFn = globalThis.fetch?.bind(globalThis) } = {}) {
  const dashboardUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!dashboardUrl) throw new Error('no-dashboard-url');
  const rootResponse = await fetchWithTimeout(fetchFn, dashboardUrl, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    ...LOOPBACK_FETCH,
  }, 2500);
  if (!rootResponse.ok) throw new Error(`dashboard-root-${rootResponse.status}`);
  const html = await rootResponse.text();
  const token = extractDashboardSessionToken(html);
  if (!token) {
    const authenticatedStatus = await fetchAuthenticatedDashboardStatus(dashboardUrl, fetchFn, 2500);
    if (authenticatedStatus) throw new Error('dashboard-authentication-required');
  }

  const rosterUrl = dashboardProfilesUrl(dashboardUrl);
  if (!rosterUrl) throw new Error('bad-dashboard-url');
  const headers = { Accept: 'application/json' };
  if (token) headers['X-Hermes-Session-Token'] = token;
  try {
    const rosterResponse = await fetchWithTimeout(fetchFn, rosterUrl, {
      method: 'GET',
      headers,
      ...LOOPBACK_FETCH,
    }, 8000);
    if (rosterResponse.ok) {
      const payload = await rosterResponse.json().catch(() => null);
      if (isRosterPayload(payload)) return payload;
    }
  } catch {
    /* chrome-extension CORS or a blocked private-network probe */
  }
  const status = await fetchDashboardStatus(dashboardUrl, fetchFn, 2500).catch(() => null);
  throw Object.assign(new Error('no-profiles-in-response'), {
    code: 'no-rich-roster', degraded: true,
    metadata: { source: 'dashboard-status', profileNames: (rosterFromStatusProfiles(status)?.profiles || []).map((row) => row.name) },
  });
}

export async function fetchRosterFromGateway({
  gatewayUrl = '',
  apiKey = '',
  knownProfileNames = [],
  fetchFn = globalThis.fetch?.bind(globalThis),
} = {}) {
  const base = String(gatewayUrl || '').trim().replace(/\/+$/, '');
  const token = String(apiKey || '').trim();
  if (!base) throw new Error('no-gateway-url');
  const authScheme = 'Bear' + 'er';
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `${authScheme} ${token}`;
  const names = new Set();

  const addName = (value) => {
    const name = String(value || '').trim();
    if (name) names.add(name);
  };

  try {
    const detailed = await fetchWithTimeout(fetchFn, `${base}/health/detailed`, {
      method: 'GET',
      headers,
      ...LOOPBACK_FETCH,
    }, 4000);
    if (detailed.ok) {
      const payload = await detailed.json().catch(() => null);
      const list = payload?.profiles || payload?.served_profiles || payload?.readiness?.profiles;
      if (Array.isArray(list)) {
        for (const row of list) addName(typeof row === 'string' ? row : row?.name);
      }
    }
  } catch {
    /* 401/404 on older gateways */
  }

  const candidates = ['default', ...((Array.isArray(knownProfileNames) ? knownProfileNames : []).map((name) => String(name || '').trim()))];
  for (const name of candidates) {
    if (!name || names.has(name)) continue;
    try {
      const probe = await fetchWithTimeout(fetchFn, `${base}/p/${encodeURIComponent(name)}/health`, {
        method: 'GET',
        headers,
        ...LOOPBACK_FETCH,
      }, 2000);
      if (probe.ok) addName(name);
    } catch {
      /* profile missing or unscoped gateway */
    }
  }

  if (!names.size) throw new Error('no-gateway-profiles');
  throw Object.assign(new Error('gateway-profiles-degraded: rich roster requires dashboard WebSocket'), {
    code: 'no-rich-roster', degraded: true,
    metadata: { source: 'gateway-health', profileNames: [...names] },
  });
}

export function retainRosterAfterFailedDiscovery({
  incomingAgents = [],
  incomingGroups = [],
  previous = {},
} = {}) {
  const incomingA = Array.isArray(incomingAgents) ? incomingAgents : [];
  const incomingG = Array.isArray(incomingGroups) ? incomingGroups : [];
  const previousAgents = Array.isArray(previous?.agents) ? previous.agents : [];
  const previousGroups = Array.isArray(previous?.groupChats) ? previous.groupChats : [];
  if (incomingA.length || incomingG.length) {
    return { keep: false, agents: incomingA, groupChats: incomingG };
  }
  if (previousAgents.length || previousGroups.length) {
    return { keep: true, agents: previousAgents, groupChats: previousGroups };
  }
  return { keep: false, agents: [], groupChats: [] };
}

export async function readCachedRosterUrl(storageApi = globalThis.chrome?.storage?.local) {
  if (!storageApi?.get) return { url: '', cachedAt: 0 };
  const stored = await storageApi.get(DESKTOP_ROSTER_URL_STORAGE_KEY);
  const entry = stored?.[DESKTOP_ROSTER_URL_STORAGE_KEY];
  if (!entry || typeof entry.url !== 'string') return { url: '', cachedAt: 0 };
  if (Date.now() - Number(entry.cachedAt || 0) > DESKTOP_ROSTER_URL_TTL_MS) return { url: '', cachedAt: 0 };
  return { url: entry.url, cachedAt: Number(entry.cachedAt || 0) };
}

export async function writeCachedRosterUrl(url, storageApi = globalThis.chrome?.storage?.local) {
  if (!storageApi?.set || !url) return;
  await storageApi.set({ [DESKTOP_ROSTER_URL_STORAGE_KEY]: { url, cachedAt: Date.now() } });
}

export async function clearCachedRosterUrl(storageApi = globalThis.chrome?.storage?.local) {
  if (storageApi?.remove) {
    await storageApi.remove(DESKTOP_ROSTER_URL_STORAGE_KEY);
    return;
  }
  if (storageApi?.set) {
    await storageApi.set({ [DESKTOP_ROSTER_URL_STORAGE_KEY]: { url: '', cachedAt: 0 } });
  }
}

export async function readLastKnownRoster(storageApi = globalThis.chrome?.storage?.local) {
  if (!storageApi?.get) return { agents: [], groupChats: [], sourceId: '', savedAt: 0 };
  const stored = await storageApi.get(LAST_KNOWN_ROSTER_STORAGE_KEY);
  const entry = stored?.[LAST_KNOWN_ROSTER_STORAGE_KEY];
  if (!entry || Date.now() - Number(entry.savedAt || 0) > LAST_KNOWN_ROSTER_TTL_MS) {
    return { agents: [], groupChats: [], sourceId: '', savedAt: 0 };
  }
  return {
    agents: Array.isArray(entry.agents) ? entry.agents : [],
    groupChats: Array.isArray(entry.groupChats) ? entry.groupChats : [],
    sourceId: typeof entry.sourceId === 'string' ? entry.sourceId : '',
    savedAt: Number(entry.savedAt || 0),
  };
}

export async function writeLastKnownRoster(roster, storageApi = globalThis.chrome?.storage?.local) {
  if (!storageApi?.set) return;
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const groupChats = Array.isArray(roster?.groupChats) ? roster.groupChats : [];
  if (!agents.length && !groupChats.length) return;
  await storageApi.set({
    [LAST_KNOWN_ROSTER_STORAGE_KEY]: {
      agents,
      groupChats,
      sourceId: typeof roster?.sourceId === 'string' ? roster.sourceId : '',
      savedAt: Date.now(),
    },
  });
}
