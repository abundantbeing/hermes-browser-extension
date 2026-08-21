/**
 * Phase 8 one-shot artifact transport for browser control.
 *
 * Artifacts (PDFs, uploaded files, bounded response bodies) never cross a
 * controller WebSocket frame as base64. Instead the extension exchanges a
 * short-lived, authenticated, one-shot HTTPS artifact with the gateway. This
 * module owns the extension-side contract for that exchange:
 *
 * - normalized artifact names (no traversal, no control characters)
 * - exact MIME and size caps (fail closed on unknown types)
 * - SHA-256 checksums computed locally and verified on download
 * - provenance-bearing artifact receipts that never contain content bytes
 *
 * The raw HTTPS transport is injected so the gateway implementation can be
 * swapped (and unit-tested with a fake) without touching this module.
 */

const NAME_MAX = 255;
const DEFAULT_TTL_MS = 300_000;

export const BROWSER_CONTROL_ARTIFACT_LIMITS = Object.freeze({
  /** Hard cap for any artifact that has no tighter MIME-specific cap. */
  maxBytes: 25_000_000,
  mimeTypes: Object.freeze({
    'application/pdf': Object.freeze({ maxBytes: 25_000_000, kind: 'document' }),
    'application/zip': Object.freeze({ maxBytes: 25_000_000, kind: 'archive' }),
    'application/octet-stream': Object.freeze({ maxBytes: 25_000_000, kind: 'binary' }),
    'application/json': Object.freeze({ maxBytes: 2_000_000, kind: 'text' }),
    'image/gif': Object.freeze({ maxBytes: 10_000_000, kind: 'image' }),
    'image/jpeg': Object.freeze({ maxBytes: 10_000_000, kind: 'image' }),
    'image/png': Object.freeze({ maxBytes: 10_000_000, kind: 'image' }),
    'image/webp': Object.freeze({ maxBytes: 10_000_000, kind: 'image' }),
    'text/csv': Object.freeze({ maxBytes: 5_000_000, kind: 'text' }),
    'text/html': Object.freeze({ maxBytes: 2_000_000, kind: 'text' }),
    'text/markdown': Object.freeze({ maxBytes: 2_000_000, kind: 'text' }),
    'text/plain': Object.freeze({ maxBytes: 1_000_000, kind: 'text' }),
  }),
});

function compact(value, limit = 2_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** Accepts Uint8Array, ArrayBuffer, or a UTF-8 string; returns Uint8Array or null. */
function toBytes(value = null) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value);
    return null;
  }
  return null;
}

/** SHA-256 over bytes, hex-encoded. Uses WebCrypto (service worker + Node 20+). */
export async function sha256Hex(value = '') {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) throw new Error('SHA-256 is unavailable in this environment.');
  const bytes = toBytes(value);
  if (!bytes) throw new Error('SHA-256 requires bytes, an ArrayBuffer, or a string.');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Decode a base64 string into bytes; returns null for empty or invalid input. */
export function base64ToBytes(value = '') {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) return null;
  if (typeof atob !== 'function') return null;
  return Uint8Array.from(atob(clean), (char) => char.charCodeAt(0));
}

/**
 * Normalize a user- or agent-supplied artifact name to a safe basename.
 * Rejects traversal, dot-paths, control characters, and over-long names.
 */
export function normalizeArtifactName(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, error: 'empty_name' };
  const name = raw.split(/[\\/]/).pop() || '';
  if (!name || name === '.' || name === '..') return { ok: false, error: 'invalid_name' };
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return { ok: false, error: 'invalid_name' };
  }
  if (name.length > NAME_MAX) return { ok: false, error: 'name_too_long' };
  return { ok: true, name };
}

/**
 * Enforce the exact MIME and size contract. Unknown MIME types fail closed;
 * only the allowlisted types (or an explicit octet-stream opt-in) pass.
 */
export function classifyArtifact({
  mimeType = '',
  sizeBytes = 0,
  limits = BROWSER_CONTROL_ARTIFACT_LIMITS,
} = {}) {
  const mime = compact(mimeType).toLowerCase();
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size < 0) return { ok: false, error: 'invalid_size' };
  let entry = null;
  for (const [type, candidate] of Object.entries(limits.mimeTypes || {})) {
    if (type === mime) {
      entry = candidate;
      break;
    }
  }
  if (!entry) return { ok: false, error: 'unsupported_mime', mimeType: mime };
  if (size > entry.maxBytes) {
    return {
      ok: false,
      error: 'artifact_too_large',
      mimeType: mime,
      size,
      maxBytes: entry.maxBytes,
    };
  }
  return { ok: true, mimeType: mime, kind: entry.kind, maxBytes: entry.maxBytes, size };
}

/**
 * Build a provenance-bearing artifact receipt. Receipts never contain content
 * bytes or base64 payloads — only identity, metadata, checksum, and scope.
 */
export function buildArtifactReceipt({
  artifactId = '',
  name = '',
  mimeType = '',
  size = 0,
  checksum = '',
  url = '',
  expiresAt = 0,
  scope = {},
  action = '',
} = {}) {
  return {
    artifact: {
      artifactId: compact(artifactId, 200),
      name: compact(name, NAME_MAX),
      mimeType: compact(mimeType, 120),
      size: Math.max(0, Math.floor(Number(size) || 0)),
      checksum: compact(checksum, 64).toLowerCase(),
      url: compact(url, 2_000),
      expiresAt: Math.max(0, Math.floor(Number(expiresAt) || 0)),
    },
    provenance: {
      controllerId: compact(scope.controllerId, 160),
      tabId: Math.max(0, Math.floor(Number(scope.tabId) || 0)),
      action: compact(action, 120),
      createdAt: Math.max(0, Math.floor(Number(scope.createdAt) || 0)),
    },
  };
}

/**
 * Create the extension-side one-shot artifact client.
 *
 * transport contract:
 *   upload({ name, mimeType, bytes, checksum }) -> { artifactId, url?, expiresAt? }
 *   download({ artifactId })                  -> { bytes, name, mimeType, checksum? }
 *
 * Every upload computes and attests a local SHA-256; every download verifies
 * the checksum, MIME allowlist, and size cap before bytes are released.
 */
export function createBrowserControlArtifactClient({
  transport = null,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  limits = BROWSER_CONTROL_ARTIFACT_LIMITS,
} = {}) {
  if (!transport || typeof transport.upload !== 'function' || typeof transport.download !== 'function') {
    throw new TypeError('A one-shot artifact transport with upload and download is required.');
  }
  const boundedTtl = Math.max(1_000, Math.floor(Number(ttlMs) || DEFAULT_TTL_MS));

  async function upload({ name = '', mimeType = '', bytes = null, scope = {}, action = '' } = {}) {
    const normalizedName = normalizeArtifactName(name);
    if (!normalizedName.ok) return { ok: false, error: normalizedName.error };
    const payload = toBytes(bytes);
    if (!payload) return { ok: false, error: 'invalid_bytes' };
    const classified = classifyArtifact({ mimeType, sizeBytes: payload.length, limits });
    if (!classified.ok) return { ok: false, error: classified.error };
    const checksum = await sha256Hex(payload);
    let uploaded;
    try {
      uploaded = await transport.upload({
        name: normalizedName.name,
        mimeType: classified.mimeType,
        bytes: payload,
        checksum,
      });
    } catch (error) {
      return { ok: false, error: 'artifact_upload_failed', message: error?.message || 'Artifact upload failed.' };
    }
    const artifactId = compact(uploaded?.artifactId, 200);
    if (!artifactId) return { ok: false, error: 'artifact_id_missing' };
    const createdAt = Math.max(0, Math.floor(Number(now())));
    const expiresAt = Math.max(0, Math.floor(Number(uploaded?.expiresAt) || (createdAt + boundedTtl)));
    return {
      ok: true,
      receipt: buildArtifactReceipt({
        artifactId,
        name: normalizedName.name,
        mimeType: classified.mimeType,
        size: payload.length,
        checksum,
        url: uploaded?.url,
        expiresAt,
        scope: { ...scope, createdAt },
        action,
      }),
    };
  }

  async function download({ artifactId = '' } = {}) {
    const id = compact(artifactId, 200);
    if (!id) return { ok: false, error: 'artifact_id_missing' };
    let downloaded;
    try {
      downloaded = await transport.download({ artifactId: id });
    } catch (error) {
      return { ok: false, error: 'artifact_download_failed', message: error?.message || 'Artifact download failed.' };
    }
    const normalizedName = normalizeArtifactName(downloaded?.name);
    if (!normalizedName.ok) return { ok: false, error: normalizedName.error };
    const payload = toBytes(downloaded?.bytes);
    if (!payload) return { ok: false, error: 'invalid_bytes' };
    const classified = classifyArtifact({ mimeType: downloaded?.mimeType, sizeBytes: payload.length, limits });
    if (!classified.ok) return { ok: false, error: classified.error };
    const checksum = await sha256Hex(payload);
    const claimed = compact(downloaded?.checksum, 64).toLowerCase();
    if (claimed && claimed !== checksum) return { ok: false, error: 'checksum_mismatch' };
    return {
      ok: true,
      artifact: {
        artifactId: id,
        name: normalizedName.name,
        mimeType: classified.mimeType,
        kind: classified.kind,
        size: payload.length,
        checksum,
        bytes: payload,
      },
    };
  }

  return {
    upload,
    download,
    buildReceipt: buildArtifactReceipt,
    sha256Hex,
    classifyArtifact,
    normalizeArtifactName,
  };
}

function artifactEndpoint(baseUrl, path) {
  const normalized = String(baseUrl || '').trim();
  if (!normalized) throw new TypeError('Artifact transport base URL is required.');
  const parsed = new URL(normalized.endsWith('/') ? normalized : `${normalized}/`);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError('Artifact transport requires a credential-free HTTP(S) base URL.');
  }
  return new URL(String(path || '').replace(/^\/+/, ''), parsed).toString();
}

async function artifactError(response, fallback) {
  try {
    const payload = await response.json();
    return String(payload?.error?.message || payload?.detail || fallback);
  } catch {
    return fallback;
  }
}

function dispositionFilename(value = '') {
  const match = String(value || '').match(/filename="([^"]+)"/i);
  return match?.[1] || 'artifact.bin';
}

/** Authenticated HTTP transport for the Gateway one-shot artifact routes. */
export function createBrowserControlArtifactHttpTransport({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  baseUrl = '',
  apiKey = '',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Artifact transport fetch implementation is required.');
  const token = String(apiKey || '').trim();
  if (!token) throw new TypeError('Artifact transport API key is required.');
  const authorization = `Bearer ${token}`;

  async function upload({ name, mimeType, bytes }) {
    const response = await fetchImpl(artifactEndpoint(baseUrl, 'v1/artifacts/upload'), {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Authorization: authorization,
        'Content-Type': String(mimeType || 'application/octet-stream'),
        'X-Artifact-Filename': String(name || 'artifact.bin'),
      },
      body: bytes,
    });
    if (!response.ok) throw new Error(await artifactError(response, `Artifact upload failed (${response.status}).`));
    const payload = await response.json();
    const expiresAt = Number(payload?.expires_at || 0);
    return {
      artifactId: payload?.artifact_id,
      url: payload?.download_path,
      expiresAt: expiresAt > 0 && expiresAt < 10_000_000_000 ? Math.floor(expiresAt * 1_000) : expiresAt,
    };
  }

  async function download({ artifactId }) {
    const id = String(artifactId || '').trim();
    const response = await fetchImpl(artifactEndpoint(baseUrl, `v1/artifacts/download/${encodeURIComponent(id)}`), {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: authorization },
    });
    if (!response.ok) throw new Error(await artifactError(response, `Artifact download failed (${response.status}).`));
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name: dispositionFilename(response.headers.get('Content-Disposition')),
      mimeType: response.headers.get('Content-Type') || 'application/octet-stream',
      checksum: response.headers.get('X-Artifact-Sha256') || '',
    };
  }

  return { upload, download };
}
