// Desktop dashboard roster discovery (local API mode).
//
// Hermes Desktop serves its dashboard (and the /api/profiles roster endpoint)
// on a random loopback port announced only on its own stdout. The sidecar API
// server (8642) has no roster REST route, so in local-api mode the verified
// roster is sourced from the desktop dashboard: GET / bootstraps
// window.__HERMES_SESSION_TOKEN__, then GET /api/profiles?include_sessions=true
// returns the roster. Extension host_permissions (http://127.0.0.1/*) exempt
// these fetches from CORS.
//
// Port discovery is intentionally bounded: the last verified URL (cached in
// chrome.storage.local), an explicit user-supplied URL, a sidecar candidate
// route, and a small well-known port list. A full 16k/64k loopback scan is
// never run from the extension — it saturates the browser socket pool and makes
// Bot Mode appear frozen after a Hermes restart. The sidecar route is the
// authoritative fast path for dynamic desktop ports; bounded probing is only a
// compatibility fallback for older Hermes runtimes.

export const DESKTOP_ROSTER_URL_STORAGE_KEY = 'hermesDesktopRosterUrl';
const DESKTOP_ROSTER_URL_TTL_MS = 24 * 60 * 60 * 1000;

// Scan bounds: test known high-probability candidate ports first,
// followed by bounded ephemeral windows in small batches so Chrome socket pools
// are never saturated.
const COMMON_DASHBOARD_PORTS = [
  1297, 22784, 9119, 9120, 8642, 8414, 8317, 3000, 5173, 8080, 8000, 8888,
  1042, 1043, 1200, 1300, 1400, 1500, 2000, 2500, 3100, 4000, 5000,
  62431, 59515, 46855, 57710, 57711, 43362, 50740, 50100, 50923, 51100,
];
const SCAN_PROBE_TIMEOUT_MS = 200; // per-probe; loopback connection refused returns in <5ms

function fetchWithTimeout(fetchFn, url, options, timeoutMs) {
  if (typeof AbortSignal?.timeout !== 'function') return fetchFn(url, options);
  return fetchFn(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export function extractDashboardSessionToken(html = '') {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  return match?.[1] || '';
}

async function isDesktopDashboard(baseUrl, fetchFn = globalThis.fetch?.bind(globalThis), headers = {}) {
  try {
    const response = await fetchWithTimeout(fetchFn, baseUrl, {
      method: 'GET',
      headers: { Accept: 'text/html', ...headers },
      cache: 'no-store',
    }, SCAN_PROBE_TIMEOUT_MS);
    if (!response.ok) return false;
    const html = await response.text();
    return Boolean(extractDashboardSessionToken(html));
  } catch {
    return false;
  }
}

async function scanLoopbackForDashboard(fetchFn, onProgress, headers = {}, deadlineAt = Date.now() + 4000) {
  const probePorts = async (ports) => {
    const results = await Promise.all(ports.map(async (port) => {
      const candidate = `http://127.0.0.1:${port}`;
      return (await isDesktopDashboard(candidate, fetchFn, headers)) ? candidate : null;
    }));
    return results.find(Boolean) || '';
  };

  // Probe known ports concurrently. A sequential refusal on Windows can take
  // hundreds of milliseconds even with an AbortSignal, turning a simple panel
  // open into a multi-second serial wait.
  for (let i = 0; i < COMMON_DASHBOARD_PORTS.length && Date.now() < deadlineAt; i += 16) {
    const found = await probePorts(COMMON_DASHBOARD_PORTS.slice(i, i + 16));
    if (found) return found;
  }

  // Probe a few bounded ephemeral windows for older Hermes runtimes that do not
  // publish their --port 0 handoff through the sidecar.
  const ephemeralBases = [1200, 1300, 22700, 62400, 59500, 57700, 46800, 50700, 43300, 50900, 51100];
  for (const base of ephemeralBases) {
    if (Date.now() >= deadlineAt) break;
    const ports = Array.from({ length: 40 }, (_, i) => base + i)
      .filter((port) => !COMMON_DASHBOARD_PORTS.includes(port));
    for (let i = 0; i < ports.length && Date.now() < deadlineAt; i += 16) {
      const found = await probePorts(ports.slice(i, i + 16));
      if (found) return found;
    }
  }

  if (onProgress) onProgress('no verified dashboard found');
  return '';
}

export async function discoverLocalDashboardBaseUrl({
  explicitUrl = '',
  cachedUrl = '',
  cachedAt = 0,
  gatewayUrl = 'http://127.0.0.1:8642',
  apiKey = '',
  fetchFn = globalThis.fetch?.bind(globalThis),
  onProgress = null,
  timeoutMs = 4_000,
} = {}) {
  const deadlineAt = Date.now() + Math.max(500, Number(timeoutMs) || 4_000);
  const tried = new Set();
  const candidates = [];
  const authHeaders = String(apiKey || '').trim() ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {};
  for (const candidate of [
    String(explicitUrl || '').trim().replace(/\/+$/, ''),
    String(cachedUrl || '').trim().replace(/\/+$/, ''),
    'http://127.0.0.1:1297',
    'http://127.0.0.1:22784',
    'http://127.0.0.1:9119',
  ]) {
    if (candidate && !tried.has(candidate)) {
      tried.add(candidate);
      candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    if (Date.now() >= deadlineAt) break;
    if (await isDesktopDashboard(candidate, fetchFn, authHeaders)) return candidate;
  }

  // Ask the sidecar gateway (fixed port, same machine) for live loopback
  // listeners — Chrome JS cannot enumerate sockets reliably, and a 64k-port
  // scan drops the dashboard under socket-pool queuing.
  if (Date.now() < deadlineAt) {
    try {
      const response = await fetchWithTimeout(
        fetchFn,
        `${String(gatewayUrl || '').trim().replace(/\/+$/, '')}/api/desktop/dashboard-candidates`,
        {
          method: 'GET',
          headers: authHeaders,
          cache: 'no-store',
        },
        1500,
      );
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const ports = Array.isArray(payload?.candidates) ? payload.candidates : [];
        for (const port of ports) {
          const candidate = `http://127.0.0.1:${Number(port)}`;
          if (tried.has(candidate)) continue;
          tried.add(candidate);
          if (await isDesktopDashboard(candidate, fetchFn, authHeaders)) return candidate;
        }
      }
    } catch {
      /* sidecar unreachable — fall through to the bounded scan */
    }
  }

  return scanLoopbackForDashboard(fetchFn, onProgress, authHeaders, deadlineAt);
}

// Fetch the roster from a known dashboard base URL. Returns the raw payload
// ({ profiles: [...] }) or throws with a short machine-parseable reason.
export async function fetchRosterFromDashboard({ baseUrl = '', fetchFn = globalThis.fetch?.bind(globalThis) } = {}) {
  const dashboardUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!dashboardUrl) throw new Error('no-dashboard-url');
  const rootResponse = await fetchWithTimeout(fetchFn, dashboardUrl, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    cache: 'no-store',
  }, 2500);
  if (!rootResponse.ok) throw new Error(`dashboard-root-${rootResponse.status}`);
  const html = await rootResponse.text();
  const token = extractDashboardSessionToken(html);
  if (!token) throw new Error('no-dashboard-session-token');

  let rosterUrl;
  try {
    const url = new URL(dashboardUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/profiles`;
    url.searchParams.set('include_sessions', 'true');
    rosterUrl = url.toString();
  } catch {
    throw new Error('bad-dashboard-url');
  }
  const rosterResponse = await fetchWithTimeout(fetchFn, rosterUrl, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Hermes-Session-Token': token },
    credentials: 'include',
  }, 8000);
  if (!rosterResponse.ok) throw new Error(`profiles-http-${rosterResponse.status}`);
  const payload = await rosterResponse.json().catch(() => null);
  if (!payload || !Array.isArray(payload.profiles)) throw new Error('no-profiles-in-response');
  return payload;
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

