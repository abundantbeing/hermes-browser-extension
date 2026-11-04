// Dashboard routes the gateway API does not advertise.
//
// Hermes 0.22.5's API server (8642) lists audio transcription and stored-image reads in
// /v1/capabilities, but has no image-upload route at all. The dashboard listener (the
// Desktop dashboard on 9119, or the Webapp on 9120) serves all three, behind its session
// token (a legacy dashboard's page token, or the Webapp sign-in the panel holds):
//
//   POST /api/audio/transcribe    speech to text
//   GET  /api/media               stored images
//   POST /api/chat/image-upload   { data_url, filename } -> { ok, path, name, bytes, mime_type }
//
// This module probes that the dashboard accepts the token (one bounded read-only GET) and
// does the image upload. Pure: the caller supplies fetch and the token. Never throws.

export const DASHBOARD_PROBE_PATH = '/api/audio/voice-config';
export const DASHBOARD_IMAGE_UPLOAD_PATH = '/api/chat/image-upload';
export const DASHBOARD_SESSION_HEADER = 'X-Hermes-Session-Token';
// The capability rows this dashboard stands in for.
export const DASHBOARD_ROUTE_CAPABILITIES = Object.freeze(['audioTranscription', 'imageUpload', 'mediaRead']);

const TIMEOUT_MS = 4000;

function base(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function withProfile(url, profile = '') {
  const name = String(profile || '').trim();
  return name && name.toLowerCase() !== 'default' ? `${url}?profile=${encodeURIComponent(name)}` : url;
}

async function send(fetchFn, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchFn(url, { ...init, cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Does the dashboard at baseUrl accept `token`? { reachable, status, reason, checkedAt } */
export async function probeDashboardRoutes({ baseUrl = '', token = '', fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const checkedAt = Number(typeof now === 'function' ? now() : now);
  if (!base(baseUrl) || !String(token || '').trim() || typeof fetchFn !== 'function') {
    return { reachable: false, reason: 'no-token', checkedAt };
  }
  try {
    const response = await send(fetchFn, `${base(baseUrl)}${DASHBOARD_PROBE_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json', [DASHBOARD_SESSION_HEADER]: String(token).trim() },
      credentials: 'omit',
    }, timeoutMs);
    const status = Number(response?.status) || 0;
    if (response?.ok) return { reachable: true, status, checkedAt };
    return { reachable: false, status, reason: status === 401 || status === 403 ? 'rejected' : 'unsupported', checkedAt };
  } catch {
    return { reachable: false, reason: 'unreachable', checkedAt };
  }
}

/** The ledger fields (see ledger.observeProbe) for one capability this dashboard serves, or null. */
export function dashboardRouteRecordFields(probe) {
  if (!probe?.reachable) return null;
  return {
    state: 'available',
    reasonCode: 'dashboard-route',
    params: {},
    checkedAt: Number.isFinite(probe.checkedAt) ? probe.checkedAt : null,
  };
}

/** Save one pasted image where Hermes vision can read it, through the dashboard. */
export async function uploadImageViaDashboard({
  baseUrl = '',
  token = '',
  profile = '',
  dataUrl = '',
  filename = '',
  fetchFn = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!base(baseUrl) || !String(token || '').trim() || !String(dataUrl || '').startsWith('data:image/') || typeof fetchFn !== 'function') {
    return { ok: false, error: 'dashboard-image-upload-unavailable' };
  }
  try {
    const response = await send(fetchFn, withProfile(`${base(baseUrl)}${DASHBOARD_IMAGE_UPLOAD_PATH}`, profile), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', [DASHBOARD_SESSION_HEADER]: String(token).trim() },
      credentials: 'omit',
      body: JSON.stringify({ data_url: dataUrl, filename: String(filename || '').slice(0, 200) }),
    }, timeoutMs);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !payload?.path) {
      const detail = payload?.detail || payload?.error?.message || payload?.error;
      return { ok: false, status: Number(response.status) || 0, error: typeof detail === 'string' && detail ? detail : `Image upload failed (${response.status})` };
    }
    return {
      ok: true,
      path: String(payload.path),
      filename: String(payload.name || ''),
      mimeType: String(payload.mime_type || ''),
      size: Number(payload.bytes) || 0,
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'Image upload timed out.' : (error?.message || 'Image upload failed.') };
  }
}

export const DASHBOARD_MODEL_INFO_PATH = '/api/model/info';

/**
 * The context window the gateway itself resolves for the profile's configured model
 * (agent.model_metadata.get_model_context_length: config pin, provider catalogs, models.dev, then its
 * built-in table). GET /api/model/info answers { model, provider, auto_context_length,
 * config_context_length, effective_context_length }; `effective` is the window the agent really uses.
 * One bounded read-only GET. Never throws.
 * @returns {{ok: true, model: string, provider: string, tokens: number} | {ok: false, reason: string}}
 */
export async function readDashboardModelInfo({ baseUrl = '', token = '', profile = '', fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!base(baseUrl) || !String(token || '').trim() || typeof fetchFn !== 'function') return { ok: false, reason: 'no-token' };
  try {
    const response = await send(fetchFn, withProfile(`${base(baseUrl)}${DASHBOARD_MODEL_INFO_PATH}`, profile), {
      method: 'GET',
      headers: { Accept: 'application/json', [DASHBOARD_SESSION_HEADER]: String(token).trim() },
      credentials: 'omit',
    }, timeoutMs);
    if (!response?.ok) return { ok: false, reason: Number(response?.status) === 401 || Number(response?.status) === 403 ? 'rejected' : 'unsupported' };
    const payload = await response.json();
    const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
    const tokens = Number(payload?.effective_context_length) > 0 ? Number(payload.effective_context_length) : Number(payload?.auto_context_length);
    // 0 is the gateway's "could not resolve it in time", not a window.
    if (!model || !(tokens > 0)) return { ok: false, reason: 'unresolved' };
    return { ok: true, model, provider: typeof payload.provider === 'string' ? payload.provider.trim() : '', tokens: Math.round(tokens) };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
