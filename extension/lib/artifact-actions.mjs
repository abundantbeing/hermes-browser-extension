// File-artifact classification for returned files.
//
// Hermes frequently finishes a turn with a file it produced — a PDF report, an
// HTML page, a spreadsheet, a CSV export — and the transcript used to answer
// with nothing but the path it sits at. This module turns such a path (or a
// MEDIA: tag value, or a URL) into a description the surfaces can act on: the
// basename, the extension, a coarse kind, whether a browser can render that
// kind inline, a sensible MIME type for the blob/stream, and the list of
// actions a card should offer. Pure and dependency-free: no DOM, no browser
// APIs, no network. Everything that needs those lives in the surfaces.

const MEDIA_TAG_PREFIX_RE = /^MEDIA:/i;
const REMOTE_URL_RE = /^https?:\/\//i;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^\\\\[^\\/\s]+[\\/]/;
const HOME_PATH_RE = /^~[\\/]/;
const POSIX_PATH_RE = /^\//;

// Extension -> kind + MIME. The kind names are the coarse buckets the card
// badge and the action list key off; `viewable` kinds get an in-browser Open.
const EXTENSION_SPECS = Object.freeze({
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  html: { kind: 'html', mime: 'text/html' },
  htm: { kind: 'html', mime: 'text/html' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  avif: { kind: 'image', mime: 'image/avif' },
  tif: { kind: 'image', mime: 'image/tiff' },
  tiff: { kind: 'image', mime: 'image/tiff' },
  txt: { kind: 'text', mime: 'text/plain' },
  log: { kind: 'text', mime: 'text/plain' },
  text: { kind: 'text', mime: 'text/plain' },
  xml: { kind: 'text', mime: 'text/xml' },
  yml: { kind: 'text', mime: 'text/yaml' },
  yaml: { kind: 'text', mime: 'text/yaml' },
  csv: { kind: 'csv', mime: 'text/csv' },
  tsv: { kind: 'csv', mime: 'text/tab-separated-values' },
  json: { kind: 'json', mime: 'application/json' },
  jsonl: { kind: 'json', mime: 'application/x-ndjson' },
  md: { kind: 'markdown', mime: 'text/markdown' },
  markdown: { kind: 'markdown', mime: 'text/markdown' },
  xlsx: { kind: 'sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xlsm: { kind: 'sheet', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' },
  xls: { kind: 'sheet', mime: 'application/vnd.ms-excel' },
  ods: { kind: 'sheet', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { kind: 'document', mime: 'application/msword' },
  odt: { kind: 'document', mime: 'application/vnd.oasis.opendocument.text' },
  rtf: { kind: 'document', mime: 'application/rtf' },
  pptx: { kind: 'presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  ppt: { kind: 'presentation', mime: 'application/vnd.ms-powerpoint' },
  odp: { kind: 'presentation', mime: 'application/vnd.oasis.opendocument.presentation' },
  zip: { kind: 'archive', mime: 'application/zip' },
  tar: { kind: 'archive', mime: 'application/x-tar' },
  gz: { kind: 'archive', mime: 'application/gzip' },
  tgz: { kind: 'archive', mime: 'application/gzip' },
  xz: { kind: 'archive', mime: 'application/x-xz' },
  bz2: { kind: 'archive', mime: 'application/x-bzip2' },
  sevenz: { kind: 'archive', mime: 'application/x-7z-compressed' },
  '7z': { kind: 'archive', mime: 'application/x-7z-compressed' },
  rar: { kind: 'archive', mime: 'application/vnd.rar' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  m4v: { kind: 'video', mime: 'video/x-m4v' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  exe: { kind: 'binary', mime: 'application/octet-stream' },
  msi: { kind: 'binary', mime: 'application/octet-stream' },
  dll: { kind: 'binary', mime: 'application/octet-stream' },
  bin: { kind: 'binary', mime: 'application/octet-stream' },
  iso: { kind: 'binary', mime: 'application/octet-stream' },
  dmg: { kind: 'binary', mime: 'application/octet-stream' },
});

const VIEWABLE_KINDS = Object.freeze(new Set(['pdf', 'html', 'image', 'text', 'csv', 'json', 'markdown', 'video', 'audio']));

const KIND_BADGES = Object.freeze({
  pdf: 'PDF',
  html: 'HTML',
  image: 'IMG',
  text: 'TXT',
  csv: 'CSV',
  json: 'JSON',
  markdown: 'MD',
  sheet: 'SHEET',
  document: 'DOC',
  presentation: 'SLIDES',
  archive: 'ARCHIVE',
  video: 'VIDEO',
  audio: 'AUDIO',
  binary: 'FILE',
});

export const ARTIFACT_KINDS = Object.freeze(Object.keys(KIND_BADGES));

// Kind -> family: the coarse visual bucket the card's type token is tinted by.
// Five families, five distinct token treatments (see sidepanel.css /
// app-parity.css): nothing here is a colour, so every theme keeps its own
// palette and the surface only has to map the family name to a tint.
const KIND_FAMILIES = Object.freeze({
  pdf: 'document',
  html: 'document',
  text: 'document',
  markdown: 'document',
  json: 'document',
  document: 'document',
  presentation: 'document',
  sheet: 'sheet',
  csv: 'sheet',
  image: 'media',
  video: 'media',
  audio: 'media',
  archive: 'archive',
  binary: 'unknown',
});

export const ARTIFACT_FAMILIES = Object.freeze(['document', 'sheet', 'media', 'archive', 'unknown']);

/** Family an unknown kind falls back to. */
export const UNKNOWN_ARTIFACT_FAMILY = 'unknown';

/**
 * Visual family for a kind: document | sheet | media | archive | unknown.
 * @param {string} kind
 * @returns {string}
 */
export function artifactKindFamily(kind = '') {
  return KIND_FAMILIES[String(kind || '')] || UNKNOWN_ARTIFACT_FAMILY;
}

/** Kind used for anything without a mapped extension. */
export const UNKNOWN_ARTIFACT_KIND = 'binary';

export const ARTIFACT_ACTION_IDS = Object.freeze(['open', 'open-on-computer', 'save']);

const ARTIFACT_ACTION_LABELS = Object.freeze({
  open: 'Open',
  'open-on-computer': 'Open on computer',
  save: 'Save',
});

const FAILURE_NOTICES = Object.freeze({
  'http-401': 'Hermes refused to read this file (HTTP 401 — the dashboard session token was rejected).',
  'http-403': 'Hermes refused to read this file (HTTP 403 — outside the files the dashboard may serve).',
  'http-404': 'This file is no longer at that path (HTTP 404).',
  'http-413': 'This file is too large for the dashboard to serve.',
  'http-415': 'The dashboard will not serve this file type.',
  'fetch-failed': 'The Hermes dashboard could not be reached to read this file.',
  'fetch-unavailable': 'This browser surface cannot fetch files right now.',
  'aborted': 'Reading this file was interrupted.',
  'empty-file': 'The file is empty.',
  'object-url-unavailable': 'This browser could not prepare the file for opening.',
});

function cleanSource(value = '') {
  const text = String(value ?? '').trim().replace(MEDIA_TAG_PREFIX_RE, '').trim();
  if (text.length >= 2 && ['"', "'", '`'].includes(text[0]) && text.at(-1) === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function withoutQueryOrFragment(value = '') {
  return String(value || '').split(/[?#]/)[0];
}

/**
 * Basename of a path or URL, keeping spaces and Windows separators intact.
 * @param {unknown} pathRef
 * @returns {string}
 */
export function artifactFileName(pathRef) {
  const source = cleanSource(pathRef);
  if (!source) return '';
  const trimmed = withoutQueryOrFragment(source).replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() || '';
  if (!base || base === '.' || base === '..') return '';
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/**
 * Lower-case extension (no dot) of a path or URL, '' when there is none.
 * @param {unknown} pathRef
 * @returns {string}
 */
export function artifactExtension(pathRef) {
  const name = artifactFileName(pathRef);
  const match = /\.([a-z0-9]{1,12})$/i.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Coarse artifact kind for an extension; unknown extensions are 'binary'.
 * @param {string} extension
 * @returns {string}
 */
export function artifactKindForExtension(extension = '') {
  const key = String(extension || '').toLowerCase().replace(/^\./, '');
  return EXTENSION_SPECS[key]?.kind || UNKNOWN_ARTIFACT_KIND;
}

/**
 * MIME type to serve a file of this extension as.
 * @param {string} extension
 * @returns {string}
 */
export function artifactMimeForExtension(extension = '') {
  const key = String(extension || '').toLowerCase().replace(/^\./, '');
  return EXTENSION_SPECS[key]?.mime || 'application/octet-stream';
}

/**
 * Whether a browser can render this kind inline (the Open action).
 * @param {string} kind
 * @returns {boolean}
 */
export function isInlineViewableKind(kind = '') {
  return VIEWABLE_KINDS.has(String(kind || ''));
}

/**
 * True for an absolute path on this machine: drive letter, UNC share, ~/, or a
 * POSIX root. Relative paths and bare filenames are not local artifacts.
 * @param {unknown} pathRef
 * @returns {boolean}
 */
export function isLocalArtifactPath(pathRef) {
  const source = cleanSource(pathRef);
  if (!source || REMOTE_URL_RE.test(source) || source.startsWith('data:') || source.startsWith('blob:')) return false;
  return WINDOWS_PATH_RE.test(source)
    || UNC_PATH_RE.test(source)
    || HOME_PATH_RE.test(source)
    || POSIX_PATH_RE.test(source);
}

/**
 * Describe a returned file: name, extension, kind, badge, MIME, viewability.
 * @param {unknown} pathRef Local path, MEDIA: tag value, or URL.
 * @returns {{ source: string, name: string, extension: string, kind: string, badge: string, mime: string, viewable: boolean, local: boolean }}
 */
export function describeArtifactFile(pathRef) {
  const source = cleanSource(pathRef);
  const name = artifactFileName(source) || 'Generated file';
  const extension = artifactExtension(source);
  const kind = artifactKindForExtension(extension);
  return {
    source,
    name,
    extension,
    kind,
    badge: KIND_BADGES[kind] || KIND_BADGES[UNKNOWN_ARTIFACT_KIND],
    family: artifactKindFamily(kind),
    mime: artifactMimeForExtension(extension),
    viewable: isInlineViewableKind(kind),
    local: isLocalArtifactPath(source),
  };
}

/**
 * Dashboard URL that streams a file's bytes as a download. `/api/files/download`
 * is the one route that also accepts the dashboard session token as `?token=`,
 * which is what lets the browser's own download machinery read a file without
 * the extension fetching it first.
 *
 * This is the fallback route for the OS-open / Save actions, not the default:
 * a token in a URL lands in the browser's download history and in any log that
 * records the request line. The surfaces prefer `resolveArtifactDownloadSource`
 * (media-source.mjs), which hands `downloads.download` a blob object URL built
 * from bytes fetched over the header-authenticated transport, and only come
 * back here when the page cannot hold the bytes at all.
 *
 * @param {{ baseUrl?: string, filePath?: string, token?: string }} options
 * @returns {string}
 */
export function artifactFileDownloadUrl({ baseUrl = '', filePath = '', token = '' } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const pathRef = String(filePath || '').trim();
  if (!base || !pathRef) return '';
  const params = new URLSearchParams({ path: pathRef });
  if (token) params.set('token', String(token));
  return `${base}/api/files/download?${params.toString()}`;
}

/**
 * URL for the extension's own read of a file's bytes. The request carries the
 * session token in the `X-Hermes-Session-Token` header (the transport the media
 * routes use), and `/api/files/download` accepts either that header or the
 * query parameter — so the URL stays free of the token, which is where it would
 * otherwise be copied into access logs.
 *
 * @param {{ baseUrl?: string, filePath?: string }} options
 * @returns {string}
 */
export function artifactFileFetchUrl({ baseUrl = '', filePath = '' } = {}) {
  return artifactFileDownloadUrl({ baseUrl, filePath });
}

/**
 * Human sentence for a failed read. Unknown reasons stay visible verbatim
 * instead of being flattened into a generic apology.
 * @param {string} reason
 * @returns {string}
 */
export function artifactFailureNotice(reason = '') {
  const key = String(reason || '').trim();
  if (!key) return 'Hermes could not read this file, so its actions are disabled.';
  const known = FAILURE_NOTICES[key];
  if (known) return `${known} Its actions are disabled until it can be read.`;
  return `Hermes could not read this file (${key}). Its actions are disabled until it can be read.`;
}

function actionEntry(id, enabled, reason = '') {
  return { id, label: ARTIFACT_ACTION_LABELS[id], enabled, reason };
}

/**
 * Actions a returned file should offer. `open` (render in the browser) only
 * exists for inline-viewable kinds; `open-on-computer` and `save` exist for
 * every kind. Pass `readable: false` once a read has failed and every action
 * comes back disabled with the reason, so the card never shows a dead button.
 *
 * Order is meaningful: the first action is the primary one the card emphasises
 * (`open` when the file can be shown inline, otherwise `open-on-computer`).
 *
 * @param {unknown} pathRef
 * @param {{ readable?: boolean|null, reason?: string }} [options]
 * @returns {{
 *   source: string, name: string, extension: string, kind: string, badge: string, mime: string,
 *   viewable: boolean, local: boolean, readable: boolean|null, notice: string,
 *   actions: Array<{ id: string, label: string, enabled: boolean, reason: string }>,
 * }}
 */
export function artifactActionPlan(pathRef, { readable = null, reason = '' } = {}) {
  const descriptor = describeArtifactFile(pathRef);
  const readableState = readable === true ? true : readable === false ? false : null;
  const blocked = readableState === false;
  const notice = blocked ? artifactFailureNotice(reason) : '';
  const actions = [];
  if (descriptor.viewable) {
    actions.push(actionEntry('open', !blocked, blocked ? notice : ''));
  }
  actions.push(actionEntry('open-on-computer', !blocked, blocked ? notice : ''));
  actions.push(actionEntry('save', !blocked, blocked ? notice : ''));
  return { ...descriptor, readable: readableState, notice, actions };
}

// ---------------------------------------------------------------------------
// Paths inside free text
// ---------------------------------------------------------------------------

// A path root: drive letter, UNC share, home shortcut, or POSIX root.
const PATH_ROOT_RE = /[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|~[\\/]|\//g;

const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}>"'`*]+$/;
const KNOWN_EXTENSION_RE = /\.([a-z0-9]{1,12})$/i;

// How many trailing words may be dropped while hunting for the extension that
// ends a real path — "…report.pdf is ready" / "…sheet.xlsx was saved for you".
const MAX_TRAILING_WORDS = 4;

function hasKnownArtifactExtension(value = '') {
  const match = KNOWN_EXTENSION_RE.exec(String(value || ''));
  return Boolean(match && EXTENSION_SPECS[match[1].toLowerCase()]);
}

function stripTrailingPunctuation(value = '') {
  return String(value || '').replace(TRAILING_PUNCTUATION_RE, '').trim();
}

// "C:\a\x.txt and C:\b\y.pdf" is two paths, not one path with a space. A second
// root token (optionally quoted) ends the candidate so each path is seen alone.
const PATH_ROOT_START_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|~[\\/]|\/)/;
const LEADING_QUOTES_RE = /^[`"'([{<]+/;

function secondPathRootTokenIndex(value = '') {
  const tokens = String(value || '').split(/[ \t]+/);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index].replace(LEADING_QUOTES_RE, '');
    if (token && PATH_ROOT_START_RE.test(token)) return index;
  }
  return -1;
}

// Walk back from the end of the region until the text ends with a recognised
// artifact extension, dropping a few trailing prose words on the way.
function extensionSuffixCandidate(value = '') {
  let text = stripTrailingPunctuation(value);
  if (!text) return '';
  const cut = secondPathRootTokenIndex(text);
  if (cut > 0) text = stripTrailingPunctuation(text.split(/[ \t]+/).slice(0, cut).join(' '));
  if (!text) return '';
  if (hasKnownArtifactExtension(text)) return text;
  const tokens = text.split(/[ \t]+/);
  for (let drop = 1; drop <= MAX_TRAILING_WORDS && drop < tokens.length; drop += 1) {
    const candidate = stripTrailingPunctuation(tokens.slice(0, tokens.length - drop).join(' '));
    if (!candidate) return '';
    if (hasKnownArtifactExtension(candidate)) return candidate;
  }
  return '';
}

function candidateStartIsPathRoot(text = '', index = 0) {
  if (index === 0) return true;
  const previous = text[index - 1];
  // `https://host/a.pdf`, `data:…`, `file://`, `blob:` must not read as a
  // POSIX path starting at a slash.
  if (previous === '/' || previous === ':' || previous === '.') return false;
  if (/[A-Za-z0-9_]/.test(previous)) return false;
  return true;
}

/**
 * Every local file path with a recognised artifact extension inside free text,
 * in order, de-duplicated, capped. Unknown extensions and URLs are skipped, so
 * a card is only offered for something Hermes could plausibly have produced.
 *
 * @param {unknown} text
 * @param {{ limit?: number }} [options]
 * @returns {Array<ReturnType<typeof describeArtifactFile>>}
 */
export function extractArtifactPaths(text, { limit = 6 } = {}) {
  const raw = String(text ?? '');
  const cap = Math.max(1, Number(limit) || 1);
  const found = [];
  const seen = new Set();
  let index = 0;
  while (index < raw.length && found.length < cap) {
    const rest = raw.slice(index);
    PATH_ROOT_RE.lastIndex = 0;
    let match = null;
    let absoluteStart = -1;
    while ((match = PATH_ROOT_RE.exec(rest)) !== null) {
      if (candidateStartIsPathRoot(raw, index + match.index)) {
        match = { index: match.index, length: match[0].length };
        absoluteStart = index + match.index;
        break;
      }
    }
    if (absoluteStart < 0) break;

    // One candidate lives on one line: the dashboard returns one path per line
    // and prose after the file name is what the suffix walk trims.
    const lineEnd = raw.indexOf('\n', absoluteStart);
    const region = raw.slice(absoluteStart, lineEnd === -1 ? raw.length : lineEnd);
    const candidate = extensionSuffixCandidate(region);
    if (!candidate) {
      index = absoluteStart + Math.max(1, match.length);
      continue;
    }
    const descriptor = describeArtifactFile(candidate);
    if (descriptor.local && !seen.has(descriptor.source)) {
      seen.add(descriptor.source);
      found.push(descriptor);
    }
    const offsetInRegion = region.indexOf(candidate);
    index = absoluteStart + (offsetInRegion >= 0 ? offsetInRegion + candidate.length : Math.max(1, match.length));
  }
  return found.slice(0, cap);
}
