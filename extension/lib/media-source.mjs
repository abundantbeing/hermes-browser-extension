// Media source resolution for extension pages.
//
// Turns a local media path (a MEDIA: tag value, a vision cache path, or a
// dashboard-managed file) into something an extension page can actually
// display — a data URL, a blob object URL, or a validated https URL — and
// fails honestly with a reason when it cannot. Dependency-free; the async
// resolver takes injectable fetchImpl / signal / createObjectUrl so tests
// never touch the network or the platform.

import { resolveImageSource } from './image-render.mjs';
import { artifactFileDownloadUrl, artifactFileFetchUrl } from './artifact-actions.mjs';
import { classifyMediaKind, isHermesManagedMediaPath } from './media-persistence.mjs';

const DASHBOARD_MEDIA_ROUTE = '/api/media';
const DASHBOARD_STREAM_ROUTE = '/api/files/stream';
const DASHBOARD_IMAGE_DATA_URL_PREFIX = 'data:image/';
const OBJECT_URL_PREFIX = 'blob:';

// Reasons the blob download route may hand the job back to the query-token URL:
// each one means "this page cannot hold the bytes", never "the dashboard
// refused the file". A server-side refusal (http-401/403/404/413/415), an empty
// file, or an abort stays a failure — the download route would answer the same
// way, and a second request would only blur the honest reason.
const BLOB_DOWNLOAD_FALLBACK_REASONS = Object.freeze(new Set([
  'fetch-unavailable',
  'object-url-unavailable',
  'fetch-failed',
  'file-read-failed',
]));

function normalizePathRef(pathRef) {
  if (typeof pathRef !== 'string') return '';
  const text = pathRef.trim();
  if (text.length >= 2 && ['"', "'", '`'].includes(text[0]) && text.at(-1) === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function dashboardRouteUrl(baseUrl = '', route = '', filePath = '') {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  return `${base}${route}?path=${encodeURIComponent(filePath)}`;
}

/**
 * Plan how a path reference should reach the page without ever trusting it as
 * a URL. Only two direct sources are browser-safe: a raster image data URL and
 * an https URL. Anything else must go through the dashboard's policy-scoped
 * media endpoints, and only Hermes-managed paths (inside the Hermes home's
 * images/, screenshots/ or cache/ dirs) qualify — everything else is refused
 * rather than guessed at.
 *
 * @param {unknown} pathRef Local path or already-safe URL from a MEDIA tag / tool result.
 * @param {{ baseUrl?: string }} [options] Dashboard base URL; '' yields root-relative URLs.
 * @returns {{ transport: 'dashboard-media'|'dashboard-stream'|'direct'|'none', url: string, kind: 'image'|'video'|'other', reason: string }}
 */
export function mediaSourcePlan(pathRef, { baseUrl = '' } = {}) {
  const filePath = normalizePathRef(pathRef);
  const kind = classifyMediaKind(filePath);

  const directSource = resolveImageSource(filePath);
  if (directSource) {
    const directKind = directSource.startsWith('data:') ? 'image' : classifyMediaKind(directSource);
    return { transport: 'direct', url: directSource, kind: directKind, reason: 'direct-url' };
  }

  if (filePath && kind === 'image' && isHermesManagedMediaPath(filePath)) {
    return {
      transport: 'dashboard-media',
      url: dashboardRouteUrl(baseUrl, DASHBOARD_MEDIA_ROUTE, filePath),
      kind,
      reason: 'hermes-managed-image',
    };
  }

  if (filePath && kind === 'video' && isHermesManagedMediaPath(filePath)) {
    return {
      transport: 'dashboard-stream',
      url: dashboardRouteUrl(baseUrl, DASHBOARD_STREAM_ROUTE, filePath),
      kind,
      reason: 'hermes-managed-video',
    };
  }

  return { transport: 'none', url: '', kind, reason: 'path-not-media-managed' };
}

function objectUrlForBlob(blob, createObjectUrl) {
  try {
    if (typeof createObjectUrl === 'function') {
      const url = createObjectUrl(blob);
      return typeof url === 'string' && url.startsWith(OBJECT_URL_PREFIX) ? url : '';
    }
    const urlApi = globalThis.URL;
    if (typeof urlApi?.createObjectURL !== 'function') return '';
    const url = urlApi.createObjectURL(blob);
    return typeof url === 'string' && url.startsWith(OBJECT_URL_PREFIX) ? url : '';
  } catch {
    return '';
  }
}

function failureReason(error, fallback) {
  return error?.name === 'AbortError' ? 'aborted' : fallback;
}

/**
 * Resolve a displayable source for a path reference.
 *
 * Direct https URLs and raster data URLs are returned untouched. Managed
 * images are fetched from /api/media and must carry a `data:image/` `data_url`
 * payload; managed videos are fetched from /api/files/stream and become blob
 * object URLs (callers should revoke them when done). Every failure — bad
 * status, malformed payload, empty path, unsupported kind, thrown error —
 * resolves to `{ ok: false, reason }`; this function never throws and never
 * returns an unvalidated string.
 *
 * @param {unknown} pathRef Local path or already-safe URL.
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, signal?: AbortSignal, createObjectUrl?: (blob: Blob) => string }} [options]
 * @returns {Promise<{ ok: true, url: string, transport: 'dashboard-media'|'dashboard-stream'|'direct' } | { ok: false, reason: string }>}
 */
export async function resolveDisplayableMediaSource(pathRef, {
  baseUrl = '',
  fetchImpl,
  signal,
  createObjectUrl,
} = {}) {
  const plan = mediaSourcePlan(pathRef, { baseUrl });
  if (plan.transport === 'none') return { ok: false, reason: plan.reason };
  if (plan.transport === 'direct') return { ok: true, url: plan.url, transport: plan.transport };

  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch?.bind(globalThis);
  if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch-unavailable' };

  let response;
  try {
    response = await fetchFn(plan.url, { signal });
  } catch (error) {
    return { ok: false, reason: failureReason(error, 'fetch-failed') };
  }

  if (!response || typeof response !== 'object') return { ok: false, reason: 'fetch-failed' };
  if (!response.ok) {
    const status = Number(response.status);
    return { ok: false, reason: Number.isInteger(status) && status > 0 ? `http-${status}` : 'http-error' };
  }

  try {
    if (plan.transport === 'dashboard-media') {
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        return { ok: false, reason: failureReason(error, 'invalid-json') };
      }
      if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid-json' };
      const dataUrl = typeof payload.data_url === 'string' ? payload.data_url.trim() : '';
      if (!dataUrl) return { ok: false, reason: 'missing-media-data-url' };
      if (!dataUrl.startsWith(DASHBOARD_IMAGE_DATA_URL_PREFIX)) {
        return { ok: false, reason: 'invalid-media-data-url' };
      }
      return { ok: true, url: dataUrl, transport: 'dashboard-media' };
    }

    const blob = await response.blob();
    if (!blob || typeof blob.size !== 'number' || !(blob.size > 0)) {
      return { ok: false, reason: 'empty-media-stream' };
    }
    const objectUrl = objectUrlForBlob(blob, createObjectUrl);
    if (!objectUrl) return { ok: false, reason: 'object-url-unavailable' };
    return { ok: true, url: objectUrl, transport: 'dashboard-stream' };
  } catch (error) {
    return { ok: false, reason: failureReason(error, 'media-read-failed') };
  }
}

/**
 * Fetch a returned file's bytes through the dashboard's authenticated download
 * route (`/api/files/download`, the same session token the media routes use)
 * and hand back a blob URL the surface can open in a tab. Failure is always an
 * honest reason — never an unvalidated URL.
 *
 * The blob document inherits the creating extension page's CSP (`script-src
 * 'self'` with no inline allowance), so a previewed HTML file renders its
 * markup and styling while inline and remote scripts stay blocked.
 *
 * @param {unknown} pathRef Local path of the returned file.
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch, createObjectUrl?: (blob: Blob) => string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, url: string, transport: 'dashboard-file-download', size: number } | { ok: false, reason: string }>}
 */
export async function resolveArtifactFileSource(pathRef, {
  baseUrl = '',
  token = '',
  fetchImpl,
  createObjectUrl,
  signal,
} = {}) {
  const filePath = normalizePathRef(pathRef);
  if (!filePath) return { ok: false, reason: 'missing-file-path' };
  // The token rides in the header, never in the URL: this request is the
  // extension's own read, and the blob it produces is what the browser's
  // download machinery sees later on.
  const url = artifactFileFetchUrl({ baseUrl, filePath });
  if (!url) return { ok: false, reason: 'missing-base-url' };

  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch?.bind(globalThis);
  if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch-unavailable' };

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        ...(token ? { 'X-Hermes-Session-Token': String(token) } : {}),
      },
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    return { ok: false, reason: failureReason(error, 'fetch-failed') };
  }

  if (!response || typeof response !== 'object') return { ok: false, reason: 'fetch-failed' };
  if (!response.ok) {
    const status = Number(response.status);
    return { ok: false, reason: Number.isInteger(status) && status > 0 ? `http-${status}` : 'http-error' };
  }

  try {
    const blob = await response.blob();
    if (!blob || typeof blob.size !== 'number') return { ok: false, reason: 'file-read-failed' };
    if (!(blob.size > 0)) return { ok: false, reason: 'empty-file' };
    const objectUrl = objectUrlForBlob(blob, createObjectUrl);
    if (!objectUrl) return { ok: false, reason: 'object-url-unavailable' };
    return { ok: true, url: objectUrl, transport: 'dashboard-file-download', size: blob.size };
  } catch (error) {
    return { ok: false, reason: failureReason(error, 'file-read-failed') };
  }
}

/**
 * Ask the dashboard whether a returned file can be read before a card offers
 * any button. A HEAD request is enough: the download route answers it with the
 * same auth, existence and size checks as the GET. Routes that refuse HEAD
 * (405/501) fall back to a one-byte ranged GET.
 *
 * @param {unknown} pathRef Local path of the returned file.
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, size: number|null } | { ok: false, reason: string }>}
 */
export async function probeArtifactFileSource(pathRef, {
  baseUrl = '',
  token = '',
  fetchImpl,
  signal,
} = {}) {
  const filePath = normalizePathRef(pathRef);
  if (!filePath) return { ok: false, reason: 'missing-file-path' };
  const url = artifactFileFetchUrl({ baseUrl, filePath });
  if (!url) return { ok: false, reason: 'missing-base-url' };

  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch?.bind(globalThis);
  if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch-unavailable' };

  const headers = {
    Accept: '*/*',
    ...(token ? { 'X-Hermes-Session-Token': String(token) } : {}),
  };

  let response;
  try {
    response = await fetchFn(url, { method: 'HEAD', headers, credentials: 'include', cache: 'no-store', signal });
    if (response && [405, 501].includes(Number(response.status))) {
      response = await fetchFn(url, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-0' },
        credentials: 'include',
        cache: 'no-store',
        signal,
      });
      try {
        await response?.body?.cancel?.();
      } catch {
        /* draining the probe response is best-effort */
      }
    }
  } catch (error) {
    return { ok: false, reason: failureReason(error, 'fetch-failed') };
  }

  if (!response || typeof response !== 'object') return { ok: false, reason: 'fetch-failed' };
  if (!response.ok) {
    const status = Number(response.status);
    return { ok: false, reason: Number.isInteger(status) && status > 0 ? `http-${status}` : 'http-error' };
  }

  const rawLength = response.headers?.get?.('content-length');
  const length = rawLength === null || rawLength === undefined || rawLength === '' ? NaN : Number(rawLength);
  return { ok: true, size: Number.isFinite(length) && length >= 0 ? length : null };
}

/**
 * URL for a `downloads.download` call that must not carry the session token.
 *
 * Primary route: the file's bytes are fetched over the same header-authenticated
 * transport `resolveArtifactFileSource` uses and handed to the browser's
 * download machinery as a blob object URL, so the token never lands in a URL —
 * not in the download history, not in a logged request line. `downloads.download`
 * cannot set request headers, which is the whole reason this fallback exists,
 * so the blob stays the only way to keep the token out of the URL.
 *
 * Fallback: `/api/files/download?path=…&token=…`. It stays for the cases where
 * this page simply cannot hold the bytes (no fetch in this surface, no object
 * URL), which is a property of the surface rather than of the file — and it is
 * reachable only for those reasons, deliberately: when the dashboard itself
 * refused the file (HTTP 401/403/404/413/415) or the file is empty, the query
 * URL would be refused exactly the same way, so the honest reason is returned
 * instead of firing a second doomed request.
 *
 * @param {unknown} pathRef Local path of the returned file.
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch, createObjectUrl?: (blob: Blob) => string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, url: string, route: 'blob', size: number }
 *   | { ok: true, url: string, route: 'query-token', reason: string }
 *   | { ok: false, reason: string }>}
 */
export async function resolveArtifactDownloadSource(pathRef, {
  baseUrl = '',
  token = '',
  fetchImpl,
  createObjectUrl,
  signal,
} = {}) {
  const blobRoute = await resolveArtifactFileSource(pathRef, { baseUrl, token, fetchImpl, createObjectUrl, signal });
  if (blobRoute.ok) return { ok: true, url: blobRoute.url, route: 'blob', size: blobRoute.size };
  if (!BLOB_DOWNLOAD_FALLBACK_REASONS.has(blobRoute.reason)) return { ok: false, reason: blobRoute.reason };
  const filePath = normalizePathRef(pathRef);
  const url = artifactFileDownloadUrl({ baseUrl, filePath, token });
  if (!url) return { ok: false, reason: blobRoute.reason };
  return { ok: true, url, route: 'query-token', reason: blobRoute.reason };
}

/**
 * Caption for a media path reference: the file's basename, falling back to
 * 'Video'/'Image' from the classified kind when there is none.
 *
 * @param {unknown} pathRef Local path or URL.
 * @returns {string}
 */
export function mediaDisplayName(pathRef) {
  const value = normalizePathRef(pathRef);
  const kind = classifyMediaKind(value);
  const fallback = kind === 'video' ? 'Video' : 'Image';
  if (!value || value.startsWith('data:')) return fallback;
  const withoutQuery = /^https?:/i.test(value) ? value.split(/[?#]/)[0] : value;
  const base = String(withoutQuery.split(/[\\/]/).pop() || '').trim();
  if (!base || base === '.' || base === '..' || base.includes(':')) return fallback;
  return base.slice(0, 180) || fallback;
}
