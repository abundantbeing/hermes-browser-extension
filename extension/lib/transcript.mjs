const YOUTUBE_HOST_RE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;

export function extractYouTubeVideoId(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOST_RE.test(host)) return '';
    if (host.endsWith('youtu.be')) return parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
    const shorts = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shorts) return shorts[1];
    const embed = parsed.pathname.match(/^\/embed\/([^/?#]+)/);
    if (embed) return embed[1];
    return '';
  } catch {
    return '';
  }
}

export function normalizeTranscriptPayload(payload = {}, source = 'provider') {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'empty_provider_response', source };
  }
  if (payload.ok === false) {
    return { ok: false, reason: payload.reason || payload.error || 'provider_unavailable', source: payload.source || source };
  }

  const rawSegments = Array.isArray(payload.segments)
    ? payload.segments
    : Array.isArray(payload.transcript)
      ? payload.transcript
      : Array.isArray(payload.data)
        ? payload.data
        : [];
  const segments = rawSegments
    .map((item, index) => {
      const start = item.start ?? item.offset ?? item.startTime ?? (item.tStartMs != null ? item.tStartMs / 1000 : index);
      const duration = item.duration ?? item.dur ?? (item.durationMs != null ? item.durationMs / 1000 : 0);
      return {
        start: Number(start),
        duration: Number(duration),
        text: String(item.text ?? item.content ?? item.caption ?? '').replace(/\s+/g, ' ').trim(),
      };
    })
    .filter((item) => item.text);

  const text = segments.length
    ? segments.map((item) => item.text).join('\n')
    : String(payload.text || payload.content || payload.transcript || '').trim();

  if (!text) return { ok: false, reason: 'empty_transcript', source: payload.source || source };
  return {
    ok: true,
    source: payload.source || source,
    language: payload.language || payload.lang || '',
    text,
    segments,
  };
}

export function providerUrlForVideo(provider = '', videoId = '') {
  const raw = String(provider || '').trim();
  if (!raw || raw === 'default' || raw === 'off') return '';
  const encoded = encodeURIComponent(videoId);
  if (raw.includes('{video_id}')) return raw.replaceAll('{video_id}', encoded);
  if (raw.includes('{videoId}')) return raw.replaceAll('{videoId}', encoded);
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('video_id') && !url.searchParams.has('videoId') && !url.searchParams.has('v')) {
      url.searchParams.set('video_id', videoId);
    }
    return url.toString();
  } catch {
    return '';
  }
}

// Settings shows the stored provider as one of three choices. The stored
// value stays what the background fetch reads: 'default' (YouTube's caption
// feed, then the page's own transcript panel), 'off', or an http(s) URL.
export const TRANSCRIPT_MODES = Object.freeze(['default', 'off', 'custom']);

function isTranscriptServiceUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The settings choice and URL field for a stored provider value. */
export function transcriptModeFromProvider(provider = 'default') {
  const raw = String(provider || '').trim();
  if (raw.toLowerCase() === 'off') return { mode: 'off', url: '' };
  if (isTranscriptServiceUrl(raw)) return { mode: 'custom', url: raw };
  return { mode: 'default', url: '' };
}

/**
 * The provider value to store for a settings choice. A custom choice needs an
 * http(s) address the background can fetch; without one it stays automatic.
 */
export function transcriptProviderFromMode(mode = 'default', url = '') {
  if (mode === 'off') return 'off';
  if (mode === 'custom' && isTranscriptServiceUrl(url)) return String(url).trim();
  return 'default';
}

function decodeXmlText(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function parseTimedTextXml(xml = '') {
  const segments = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = pattern.exec(String(xml || ''))) !== null) {
    const attrs = match[1] || '';
    const attr = (name) => {
      const found = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return found ? found[1] : '';
    };
    const text = decodeXmlText(match[2]).replace(/\s+/g, ' ').trim();
    if (text) {
      segments.push({
        start: Number(attr('start') || 0),
        duration: Number(attr('dur') || 0),
        text,
      });
    }
  }
  return segments;
}

export function parseYoutubeJson3(payload = {}) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  return events
    .map((event) => ({
      start: Number(event.tStartMs || 0) / 1000,
      duration: Number(event.dDurationMs || 0) / 1000,
      text: (event.segs || []).map((seg) => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
    }))
    .filter((item) => item.text);
}
