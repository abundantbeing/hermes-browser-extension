// Pure helpers for session media persistence. No browser APIs here:
// unit-testable in node and importable by both surfaces.

export const IMAGE_EXTS = Object.freeze(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
export const VIDEO_EXTS = Object.freeze(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);

const IMAGE_EXT_SET = new Set(IMAGE_EXTS);
const VIDEO_EXT_SET = new Set(VIDEO_EXTS);

function fileExt(filePath = '') {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

function unwrapQuotedPath(value = '') {
  const text = String(value || '').trim();
  if (text.length >= 2 && ['"', "'", '`'].includes(text[0]) && text.at(-1) === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function isRemoteOrDataUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:', 'data:', 'blob:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function classifyMediaKind(filePath = '') {
  const ext = fileExt(filePath);
  if (IMAGE_EXT_SET.has(ext)) return 'image';
  if (VIDEO_EXT_SET.has(ext)) return 'video';
  return 'other';
}

export function isHermesManagedMediaPath(filePath = '') {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return /\/\.hermes\/(cache|images|screenshots)(\/|$)/.test(normalized);
}

export function extractTaggedPaths(text = '', tag = '@image:') {
  const raw = String(text || '');
  if (!raw.includes(tag)) return [];
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?:"([^"]+)"|'([^']+)'|([^\\s\\]]+))`, 'g');
  const found = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const filePath = unwrapQuotedPath(match[1] || match[2] || match[3] || '');
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    found.push({ path: filePath, ext: fileExt(filePath), kind: classifyMediaKind(filePath) });
  }
  return found;
}

export function extractImageRefs(text = '') {
  return extractTaggedPaths(text, '@image:').filter((item) => item.kind === 'image' || item.ext);
}

export function extractVideoRefs(text = '') {
  return extractTaggedPaths(text, '@video:').filter((item) => item.kind === 'video' || fileExt(item.path) === '.mp4');
}

export function extractMediaTagPaths(text = '') {
  const found = [];
  const seen = new Set();
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const match = /^\s*["'`]?MEDIA:\s*(.+?)\s*["'`]?\s*$/i.exec(line);
    if (!match) continue;
    const filePath = unwrapQuotedPath(match[1]);
    if (!filePath || isRemoteOrDataUrl(filePath) || seen.has(filePath)) continue;
    const kind = classifyMediaKind(filePath);
    if (kind === 'other') continue;
    seen.add(filePath);
    found.push({ path: filePath, kind, ext: fileExt(filePath) });
  }
  return found;
}

export function extractVisionCachePaths(text = '') {
  const found = [];
  const seen = new Set();
  const pattern = /image_url:\s*([A-Za-z]:\\[^\s\]]+|\/[^\s\]]+)/g;
  const raw = String(text || '');
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const filePath = unwrapQuotedPath(match[1] || '');
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    found.push(filePath);
  }
  return found;
}

export function splitInboundVisionMessage(text = '') {
  const raw = String(text || '');
  const paths = extractVisionCachePaths(raw);
  const hadVisionBlock = /\[The user sent an image/i.test(raw)
    || /vision_analyze with image_url:/i.test(raw);
  const visibleText = raw
    .replace(/\[The user sent an image~[\s\S]*?\]\s*/gi, '')
    .replace(/\[If you need a closer look, use vision_analyze with image_url:\s*[^\]]+~\]\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { paths, visibleText, hadVisionBlock };
}

export function resolveMediaFetchPlan({ pathRef = '' } = {}) {
  const filePath = String(pathRef || '').trim();
  const kind = classifyMediaKind(filePath);
  if (!filePath || kind === 'other') return { transport: 'none', reason: 'path-not-media' };
  if (kind === 'image' && isHermesManagedMediaPath(filePath)) {
    return {
      transport: 'dashboard-media',
      endpoint: '/api/media',
      params: { path: filePath },
    };
  }
  if (kind === 'video') {
    return {
      transport: 'dashboard-stream',
      endpoint: '/api/files/stream',
      params: { path: filePath },
    };
  }
  return { transport: 'none', reason: 'path-not-media-managed' };
}
