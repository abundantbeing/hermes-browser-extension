(() => {
  const CONTENT_SCRIPT_VERSION = '2026-06-23-dom-context-fix';
  const previousListener = globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
  if (previousListener) {
    try {
      chrome.runtime.onMessage.removeListener(previousListener);
    } catch (_error) {
      // The previous listener can belong to an invalidated extension context after reload.
    }
  }
  globalThis.__HERMES_BROWSER_CONTENT_LOADED__ = CONTENT_SCRIPT_VERSION;

  const TEXT_LIMITS = {
    minimal: 4_000,
    normal: 12_000,
    full: 30_000,
  };

  function normalizeReadableWhitespace(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textOf(node) {
    return normalizeReadableWhitespace(node?.innerText || node?.textContent || '');
  }

  function textContentWithoutJunk(root) {
    if (!root) return '';
    const clone = root.cloneNode?.(true);
    if (!clone) return normalizeReadableWhitespace(root.textContent || '');
    clone.querySelectorAll?.('script, style, noscript, svg, canvas, template, iframe').forEach((node) => node.remove());
    return normalizeReadableWhitespace(clone.textContent || '');
  }

  function uniqueReadableLines(values = []) {
    const seen = new Set();
    const lines = [];
    for (const value of values) {
      for (const rawLine of normalizeReadableWhitespace(value).split('\n')) {
        const line = rawLine.trim();
        if (line.length < 2) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(line);
      }
    }
    return lines.join('\n');
  }

  function collectReadablePageText(doc = document, { minSemanticChars = 80 } = {}) {
    const root = doc?.body || doc?.documentElement;
    if (!root) return '';
    const innerText = normalizeReadableWhitespace(root.innerText || doc?.documentElement?.innerText || '');
    const semanticText = uniqueReadableLines(Array.from(doc.querySelectorAll?.('main, article, [role="main"], h1, h2, h3, h4, p, li, blockquote, figcaption, td, th, a[href], button, summary, [aria-label]') || []).map(textOf));
    const fallbackText = textContentWithoutJunk(root);
    if (semanticText.length >= Math.max(minSemanticChars, innerText.length * 1.2)) return semanticText;
    if (innerText) return innerText;
    if (semanticText) return semanticText;
    return fallbackText;
  }

  function clamp(value, limit) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
  }

  function redact(value) {
    // Mirror of redactSensitiveText in lib/common.mjs. Kept inline because the
    // content script cannot import the module; the canonical version (and its
    // tests) live in lib/common.mjs and re-redacts the same text at prompt-build.
    return String(value || '')
      .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/\bBearer\s+[^\s'"`;&]+/gi, 'Bearer [REDACTED_BEARER]')
      .replace(new RegExp('\\bsk-[A-Za-z0-9_\\-]{12,}\\b', 'g'), '[REDACTED_SECRET]')
      .replace(/\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, '[REDACTED_SECRET]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, '[REDACTED_SECRET]')
      .replace(/\bAIza[0-9A-Za-z_\-]{35}\b/g, '[REDACTED_SECRET]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SECRET]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
      .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|private[_-]?key)\b["'`]?\s*[:=]\s*["'`]?([^\s'"`;&]+)/gi, (_match, key) => `${key}=[REDACTED_SECRET]`);
  }

  function pageMeta() {
    const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '';
    const language = document.documentElement?.lang || document.querySelector('meta[http-equiv="content-language"]')?.content || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 25)
      .map((node) => ({ level: node.tagName.toLowerCase(), text: textOf(node).slice(0, 240) }))
      .filter((item) => item.text);
    const interactive = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]'))
      .slice(0, 80)
      .map((node) => {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        const kind = role || tag;
        const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('name') || node.getAttribute('placeholder') || '';
        const href = tag === 'a' ? node.href : '';
        const text = textOf(node) || label || href;
        return { kind, text: text.slice(0, 220), href };
      })
      .filter((item) => item.text || item.href)
      .slice(0, 40);
    const forms = Array.from(document.forms || [])
      .slice(0, 10)
      .map((form) => ({
        name: form.getAttribute('name') || form.getAttribute('aria-label') || '',
        action: form.action || '',
        method: form.method || 'get',
        fields: Array.from(form.elements || [])
          .slice(0, 30)
          .map((el) => ({
            tag: el.tagName?.toLowerCase?.() || '',
            type: el.getAttribute?.('type') || '',
            name: el.getAttribute?.('name') || '',
            label: el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '',
          })),
      }));
    return { description, language, canonical, headings, interactive, forms };
  }

  function collectContext(options = {}) {
    const depth = options.depth || 'normal';
    const limit = TEXT_LIMITS[depth] || TEXT_LIMITS.normal;
    const selection = globalThis.getSelection?.().toString() || '';
    const text = collectReadablePageText(document);
    return {
      ok: true,
      title: document.title || '',
      url: location.href,
      selectedText: clamp(redact(selection), Math.min(limit, 8_000)),
      text: clamp(redact(text), limit),
      meta: pageMeta(),
      capturedAt: new Date().toISOString(),
    };
  }

  function findBalancedJson(source, token) {
    const tokenIndex = source.indexOf(token);
    if (tokenIndex < 0) return null;
    const start = source.indexOf('{', tokenIndex + token.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return null;
  }

  function youtubePlayerResponse() {
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse')) continue;
      const json = findBalancedJson(text, 'ytInitialPlayerResponse');
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch (_error) {
        // Try next script.
      }
    }
    return null;
  }

  function captionTracks() {
    const response = youtubePlayerResponse();
    return response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  function pickCaptionTrack(tracks = []) {
    if (!tracks.length) return null;
    return tracks.find((track) => track.languageCode === 'en' && track.kind !== 'asr')
      || tracks.find((track) => track.languageCode === 'en')
      || tracks.find((track) => track.kind !== 'asr')
      || tracks[0];
  }

  function parseTimedTextXml(xml = '') {
    const doc = new DOMParser().parseFromString(String(xml || ''), 'text/xml');
    return Array.from(doc.querySelectorAll('text'))
      .map((node) => ({
        start: Number(node.getAttribute('start') || 0),
        duration: Number(node.getAttribute('dur') || 0),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((segment) => segment.text);
  }

  async function collectYoutubeTranscript() {
    const tracks = captionTracks();
    const track = pickCaptionTrack(tracks);
    if (!track?.baseUrl) return { ok: false, reason: 'no_caption_tracks', source: 'page-dom' };
    const url = new URL(track.baseUrl);
    if (!url.searchParams.has('fmt')) url.searchParams.set('fmt', 'srv3');
    const response = await fetch(url.toString(), { credentials: 'omit' });
    if (!response.ok) return { ok: false, reason: `caption_fetch_${response.status}`, source: 'page-dom' };
    const segments = parseTimedTextXml(await response.text());
    if (!segments.length) return { ok: false, reason: 'empty_caption_track', source: 'page-dom' };
    return {
      ok: true,
      source: 'page-dom',
      language: track.languageCode || '',
      text: segments.map((segment) => segment.text).join('\n'),
      segments,
    };
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (message?.type === 'HERMES_GET_PAGE_CONTEXT') {
      try {
        sendResponse(collectContext(message.options || {}));
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (message?.type === 'HERMES_GET_YOUTUBE_TRANSCRIPT_DOM') {
      collectYoutubeTranscript()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, reason: error?.message || String(error), source: 'page-dom' }));
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(messageListener);
  globalThis.__HERMES_BROWSER_CONTENT_LISTENER__ = messageListener;
})();
