const CONTENT_SCRIPT_VERSION = '2026-07-16-extraction-site-adapters-v1';
const previousListener = globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
if (previousListener) {
  try {
    chrome.runtime.onMessage.removeListener(previousListener);
  } catch (_error) {
    // The previous listener can belong to an invalidated extension context after reload.
  }
}
globalThis.__HERMES_BROWSER_CONTENT_LOADED__ = CONTENT_SCRIPT_VERSION;

const HermesContentExtractor = globalThis.HermesContentExtractor;
const HermesSiteAdapters = globalThis.HermesSiteAdapters;

const TEXT_LIMITS = {
  minimal: 4_000,
  normal: 12_000,
  full: 30_000,
};

const PICK_STYLE_ID = 'hermes-element-pick-style';
const OUTER_HTML_LIMIT = 4_000;
const PICK_TEXT_LIMIT = 2_000;
const ELEMENT_PICK_MESSAGES = Object.freeze({
  START: 'HERMES_START_ELEMENT_PICK',
  CANCEL: 'HERMES_CANCEL_ELEMENT_PICK',
  RESULT: 'HERMES_ELEMENT_PICK_RESULT',
  PICKING: 'HERMES_ELEMENT_PICKING',
  CANCELLED: 'HERMES_ELEMENT_PICK_CANCELLED',
});
let pickModeActive = false;
let highlightedElement = null;

function clamp(value, limit) {
  return HermesContentExtractor?.clampExtractedText?.(value, limit)?.text
    || String(value || '').slice(0, limit);
}

function clampPickerText(value = '', max = PICK_TEXT_LIMIT) {
  return clamp(value, max);
}

function escapeCssIdent(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (typeof globalThis.CSS !== 'undefined' && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(raw);
  }
  return raw.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function buildCssSelector(element) {
  if (!element || element.nodeType !== 1) return '';
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    if (node.id) {
      part = `${tag}#${escapeCssIdent(node.id)}`;
      parts.unshift(part);
      break;
    }
    const testId = node.getAttribute?.('data-testid') || node.getAttribute?.('data-test-id');
    if (testId) {
      part = `${tag}[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
      parts.unshift(part);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(node) + 1;
        part = `${tag}:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function captureElementSnapshot(element) {
  if (!element || element.nodeType !== 1) {
    return { ok: false, reason: 'not_an_element' };
  }
  const tag = element.tagName.toLowerCase();
  const rect = element.getBoundingClientRect?.();
  const attrs = {};
  for (const name of ['id', 'class', 'name', 'type', 'href', 'src', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test-id']) {
    const value = element.getAttribute?.(name);
    if (value) attrs[name] = value.slice(0, 500);
  }
  const className = typeof element.className === 'string' ? element.className.trim().slice(0, 300) : '';
  const text = clampPickerText((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim());
  let outerHtml = '';
  try {
    outerHtml = clampPickerText(element.outerHTML || '', OUTER_HTML_LIMIT);
  } catch {
    outerHtml = '';
  }
  return {
    ok: true,
    tag,
    selector: buildCssSelector(element),
    text,
    outerHtml,
    className,
    attributes: attrs,
    boundingBox: rect
      ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      : null,
    capturedAt: new Date().toISOString(),
  };
}

function collectContext(options = {}) {
  if (!HermesContentExtractor?.collectPageContext) {
    throw new Error('Hermes content extractor runtime is unavailable.');
  }
  const depth = options.depth || 'normal';
  const limit = TEXT_LIMITS[depth] || TEXT_LIMITS.normal;
  const pageContext = HermesContentExtractor.collectPageContext(document, {
    maxTextChars: limit,
    maxSelectedTextChars: Math.min(limit, 8_000),
    selectedText: globalThis.getSelection?.().toString() || '',
    source: 'content-script',
    url: location.href,
  });
  if (!HermesSiteAdapters?.inspectSite || !HermesSiteAdapters?.applySiteAdapterPolicy) return pageContext;
  const siteAdapter = HermesSiteAdapters.inspectSite(document, {
    url: location.href,
    explicitCapture: Boolean(options.explicitSiteCapture),
  });
  return HermesSiteAdapters.applySiteAdapterPolicy(pageContext, siteAdapter);
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
  const requestOptions = { credentials: 'omit', redirect: 'error' };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    requestOptions.signal = AbortSignal.timeout(8_000);
  }
  const response = await fetch(url.toString(), requestOptions);
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

function ensurePickStyles() {
  if (document.getElementById(PICK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PICK_STYLE_ID;
  style.textContent = `
    .hermes-element-pick-highlight {
      outline: 2px solid #e11d48 !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
    html.hermes-element-pick-mode, html.hermes-element-pick-mode * {
      cursor: crosshair !important;
    }
    html.hermes-element-pick-mode::before {
      content: 'Hermes: click an element (Esc to cancel)';
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483646;
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      padding: 8px 14px;
      border-radius: 8px;
      font: 13px/1.4 system-ui, sans-serif;
      pointer-events: none;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function clearHighlight() {
  if (highlightedElement) {
    highlightedElement.classList.remove('hermes-element-pick-highlight');
    highlightedElement = null;
  }
}

function setHighlight(element) {
  if (!element || element === highlightedElement) return;
  clearHighlight();
  highlightedElement = element;
  highlightedElement.classList.add('hermes-element-pick-highlight');
}

function teardownPickMode({ cancelled = false, pickedElement = null } = {}) {
  if (!pickModeActive) return;
  pickModeActive = false;
  clearHighlight();
  document.documentElement.classList.remove('hermes-element-pick-mode');
  document.removeEventListener('mousemove', onPickMouseMove, true);
  document.removeEventListener('click', onPickClick, true);
  document.removeEventListener('keydown', onPickKeydown, true);
  if (cancelled) {
    chrome.runtime.sendMessage({
      type: ELEMENT_PICK_MESSAGES.CANCELLED,
      url: location.href,
    }).catch(() => {});
  } else if (pickedElement) {
    chrome.runtime.sendMessage({
      type: ELEMENT_PICK_MESSAGES.RESULT,
      url: location.href,
      pickedElement,
    }).catch(() => {});
  }
}

function elementUnderPointer(event) {
  let target = document.elementFromPoint(event.clientX, event.clientY);
  while (target?.shadowRoot) {
    const inner = target.shadowRoot.elementFromPoint(event.clientX, event.clientY);
    if (!inner || inner === target) break;
    target = inner;
  }
  if (!target || target === document.documentElement || target === document.body) return null;
  if (target.id === PICK_STYLE_ID) return null;
  return target;
}

function onPickMouseMove(event) {
  if (!pickModeActive) return;
  const element = elementUnderPointer(event);
  if (element) setHighlight(element);
}

function onPickClick(event) {
  if (!pickModeActive) return;
  event.preventDefault();
  event.stopPropagation();
  const element = elementUnderPointer(event) || highlightedElement;
  if (!element) return;
  const snapshot = captureElementSnapshot(element);
  if (!snapshot.ok) return;
  teardownPickMode({ pickedElement: snapshot });
}

function onPickKeydown(event) {
  if (!pickModeActive) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    teardownPickMode({ cancelled: true });
  }
}

function startPickMode() {
  if (pickModeActive) return { ok: true, alreadyActive: true };
  pickModeActive = true;
  ensurePickStyles();
  document.documentElement.classList.add('hermes-element-pick-mode');
  document.addEventListener('mousemove', onPickMouseMove, true);
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', onPickKeydown, true);
  chrome.runtime.sendMessage({ type: ELEMENT_PICK_MESSAGES.PICKING, url: location.href }).catch(() => {});
  return { ok: true };
}

function cancelPickMode() {
  teardownPickMode({ cancelled: true });
  return { ok: true };
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
  if (message?.type === ELEMENT_PICK_MESSAGES.START) {
    try {
      sendResponse(startPickMode());
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }
  if (message?.type === ELEMENT_PICK_MESSAGES.CANCEL) {
    try {
      sendResponse(cancelPickMode());
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  }
  return false;
};

chrome.runtime.onMessage.addListener(messageListener);
globalThis.__HERMES_BROWSER_CONTENT_LISTENER__ = messageListener;