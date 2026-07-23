const RASTER_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/]+={0,2}$/i;

export const IMAGE_ASPECT_RATIOS = Object.freeze({
  landscape: 16 / 9,
  square: 1,
  portrait: 9 / 16,
});

export function normalizeImageAspectRatio(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.hasOwn(IMAGE_ASPECT_RATIOS, normalized) ? normalized : 'landscape';
}

function stripWrappingQuotes(value = '') {
  const text = String(value || '').trim();
  if (text.length >= 2 && ['"', "'", '`'].includes(text[0]) && text.at(-1) === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Return a browser-safe source for a generated raster image, or null.
 * Deliberately excludes file:, blob:, svg data URLs, and arbitrary schemes.
 */
export function resolveImageSource(value = '') {
  const source = stripWrappingQuotes(value);
  if (!source) return null;
  if (RASTER_DATA_URL_RE.test(source)) return source;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeUserImageAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  const previews = [];
  const seen = new Set();
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue;
    const kind = String(attachment.kind || '').trim().toLowerCase();
    const mime = String(attachment.mime || attachment.type || '').trim().toLowerCase();
    if (kind && kind !== 'image' && !mime.startsWith('image/')) continue;
    const source = resolveImageSource(attachment.dataUrl || attachment.source || attachment.url || '');
    if (!source || seen.has(source)) continue;
    seen.add(source);
    previews.push({
      name: String(attachment.name || 'Attached image').trim().slice(0, 180) || 'Attached image',
      source,
    });
    if (previews.length >= 8) break;
  }
  return previews;
}

function attachmentMessageKey(message = {}) {
  return String(message?.content || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function matchingUserMessageContent(remoteContent = '', localContent = '') {
  if (!remoteContent || !localContent) return false;
  if (remoteContent === localContent) return true;
  return remoteContent.startsWith(`${localContent}\n\n[ATTACHMENTS]`);
}

export function preserveUserImageAttachments(refreshedMessages = [], localMessages = []) {
  if (!Array.isArray(refreshedMessages) || !Array.isArray(localMessages)) return Array.isArray(refreshedMessages) ? refreshedMessages : [];
  const localCandidates = localMessages
    .map((message, index) => ({ message, index, key: attachmentMessageKey(message) }))
    .filter(({ message, key }) => String(message?.role || '').toLowerCase() === 'user'
      && key
      && normalizeUserImageAttachments(message.attachments).length);
  const claimed = new Set();

  const preserved = [...refreshedMessages];
  for (let index = preserved.length - 1; index >= 0; index -= 1) {
    const message = preserved[index];
    if (String(message?.role || '').toLowerCase() !== 'user' || normalizeUserImageAttachments(message?.attachments).length) continue;
    const key = attachmentMessageKey(message);
    const candidate = localCandidates.findLast(({ index, key: localKey }) => !claimed.has(index) && matchingUserMessageContent(key, localKey));
    if (!candidate) continue;
    claimed.add(candidate.index);
    preserved[index] = { ...message, attachments: candidate.message.attachments };
  }
  return preserved;
}

export function appendUserImageAttachments(container, attachments = [], { onOpen } = {}) {
  const previews = normalizeUserImageAttachments(attachments);
  const doc = container?.ownerDocument || globalThis.document;
  if (!container || !doc?.createElement || !previews.length) return null;
  const group = doc.createElement('div');
  group.className = `user-message-images${previews.length > 1 ? ' multiple' : ''}`;
  for (const preview of previews) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'user-message-image-open';
    button.setAttribute('aria-label', `Open attached image ${preview.name}`);
    const image = doc.createElement('img');
    image.src = preview.source;
    image.alt = preview.name;
    image.loading = 'lazy';
    const caption = doc.createElement('span');
    caption.className = 'user-message-image-name';
    caption.textContent = preview.name;
    button.append(image, caption);
    if (typeof onOpen === 'function') button.addEventListener('click', () => onOpen(image, preview));
    group.append(button);
  }
  container.append(group);
  return group;
}

/**
 * Extract full-line MEDIA tags without treating local paths as browser URLs.
 */
export function extractMediaTags(text = '') {
  const media = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const remaining = [];
  for (const line of lines) {
    const match = /^\s*["'`]?MEDIA:\s*(.+?)\s*["'`]?\s*$/i.exec(line);
    if (!match) {
      remaining.push(line);
      continue;
    }
    const source = stripWrappingQuotes(match[1]);
    if (source) media.push({ source, raw: line });
  }
  return {
    media,
    text: remaining.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Resolve the first browser-safe generated image from an assistant response.
 */
export function firstResolvedImageSource(text = '') {
  return resolvedGeneratedImageSources(text)[0] || '';
}

/**
 * Resolve every browser-safe generated raster image in an assistant response.
 * Hermes tool output can use either MEDIA tags or Markdown image syntax; keep
 * both in source order and de-duplicate repeated delivery receipts.
 */
export function resolvedGeneratedImageSources(text = '') {
  const raw = String(text || '');
  const { media } = extractMediaTags(raw);
  const candidates = media.map((item) => item.source);
  const markdownImage = /^\s*!\[[^\]]*\]\((?:<)?([^>\s)]+)(?:>)?(?:\s+['"][^'"]*['"])?\)\s*$/gim;
  let match;
  while ((match = markdownImage.exec(raw)) !== null) candidates.push(match[1]);

  const seen = new Set();
  return candidates
    .map((candidate) => resolveImageSource(candidate))
    .filter((source) => {
      if (!source || seen.has(source)) return false;
      seen.add(source);
      return true;
    });
}

/**
 * Remove repeated generated-image references once an image is rendered separately.
 *
 * Never interpolate image sources into a RegExp: persisted data URLs can be
 * several megabytes long and exceed the JavaScript engine's regex limit.
 */
export function stripGeneratedImageEchoes(text = '', imageSources = []) {
  const sources = new Set(
    imageSources
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  if (!sources.size) return String(text || '').replace(/\n{3,}/g, '\n\n').trim();

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const remaining = lines.filter((line) => {
    const trimmed = stripWrappingQuotes(line);
    if (sources.has(trimmed)) return false;

    if (trimmed.slice(0, 6).toLowerCase() === 'media:') {
      const mediaSource = stripWrappingQuotes(trimmed.slice(6));
      if (sources.has(mediaSource)) return false;
    }

    if (trimmed.startsWith('![') && trimmed.endsWith(')')) {
      const sourceStart = trimmed.indexOf('](');
      if (sourceStart > 1) {
        const markdownSource = trimmed.slice(sourceStart + 2, -1).trim();
        if (sources.has(markdownSource)) return false;
      }
    }

    return true;
  });

  return remaining.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
