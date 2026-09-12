// Media source resolution for extension pages.
//
// Turns a local media path (a MEDIA: tag value, a vision cache path, or a
// dashboard-managed file) into something an extension page can actually
// display — a data URL, a blob object URL, or a validated https URL — and
// fails honestly with a reason when it cannot. Dependency-free; the async
// resolver takes injectable fetchImpl / signal / createObjectUrl so tests
// never touch the network or the platform.

import { resolveImageSource } from './image-render.mjs';
import { classifyMediaKind, isHermesManagedMediaPath } from './media-persistence.mjs';

const DASHBOARD_MEDIA_ROUTE = '/api/media';
const DASHBOARD_STREAM_ROUTE = '/api/files/stream';
const DASHBOARD_IMAGE_DATA_URL_PREFIX = 'data:image/';
const OBJECT_URL_PREFIX = 'blob:';

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
