// Read a reply aloud. Pure logic with every environment piece injected: what a
// reply says (its prose, never code, tools or thinking), how to cut it for a
// speech engine, which voice route to use, and the one-reply-at-a-time player.
//
// Routes, in order of preference:
//   gateway  POST /api/audio/speak on the Hermes dashboard: the profile's own
//            configured voice, returned as audio this panel plays and can stop.
//   browser  the browser's speechSynthesis, cut into short chunks because Chrome
//            stops a long utterance after about 15 seconds.

export const READ_ALOUD_STATUS = Object.freeze({ idle: 'idle', loading: 'loading', speaking: 'speaking' });
export const READ_ALOUD_ROUTES = Object.freeze({ gateway: 'gateway', browser: 'browser', none: 'none' });

export const BROWSER_CHUNK_CHARS = 180;
export const GATEWAY_CHUNK_CHARS = 1200;

// ---- What a reply says ---------------------------------------------------------

const SKIPPED_TAGS = new Set([
  'PRE', 'SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'CANVAS', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME',
  'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'MATH',
]);
const SKIPPED_SELECTOR = [
  '.message-tool-activity', '.tool-activity', '.tool-history-row', '.message-reasoning',
  '.live-thinking-slot', '.md-code-copy', '.generated-image', '.message-rail',
  '[hidden]', '[aria-hidden="true"]',
].join(',');
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION',
  'SUMMARY', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL',
]);
const PUNCTUATED_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DT']);
const ENDS_A_SENTENCE = /[.!?…:;。！？]["'”’)\]」』]*$/u;
const BARE_URL = /\bhttps?:\/\/[^\s<>()]+/gi;

function spokenAddress(match) {
  const trailing = /[.,;:!?]+$/.exec(match)?.[0] || '';
  const address = trailing ? match.slice(0, -trailing.length) : match;
  try {
    return `${new URL(address).hostname.replace(/^www\./, '')}${trailing}`;
  } catch {
    return match;
  }
}

function tidyLine(text, punctuate) {
  const line = String(text || '').replace(/\s+/g, ' ').trim().replace(BARE_URL, spokenAddress);
  if (!line) return '';
  return punctuate && !ENDS_A_SENTENCE.test(line) ? `${line}.` : line;
}

function skipped(node) {
  const tag = String(node.tagName || '').toUpperCase();
  return SKIPPED_TAGS.has(tag) || Boolean(node.matches?.(SKIPPED_SELECTOR));
}

function createLineWriter() {
  const lines = [];
  let buffer = '';
  let punctuate = 0;
  return {
    text(value) { buffer += value; },
    hold() { punctuate += 1; },
    release() { punctuate -= 1; },
    flush(force = false) {
      const line = tidyLine(buffer, force || punctuate > 0);
      buffer = '';
      if (line) lines.push(line);
    },
    lines,
  };
}

function cellText(cell) {
  const writer = createLineWriter();
  const visit = (node) => {
    if (node.nodeType === 3) { writer.text(node.nodeValue || ''); return; }
    if (node.nodeType !== 1 || skipped(node)) return;
    writer.text(' ');
    for (const child of Array.from(node.childNodes || [])) visit(child);
    writer.text(' ');
  };
  for (const child of Array.from(cell.childNodes || [])) visit(child);
  writer.flush();
  return writer.lines.join(' ');
}

/** The words of a rendered reply, one line per block, with nothing that is not meant to be spoken. */
export function readableTextFromElement(root) {
  if (!root?.childNodes) return '';
  const writer = createLineWriter();
  const visit = (node) => {
    if (node.nodeType === 3) { writer.text(node.nodeValue || ''); return; }
    if (node.nodeType !== 1 || skipped(node)) return;
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BR') { writer.flush(); return; }
    if (tag === 'TR') {
      writer.flush();
      const cells = Array.from(node.children || []).filter((child) => /^(TD|TH)$/i.test(child.tagName || ''));
      const row = cells.map(cellText).filter(Boolean).join(', ');
      if (row) writer.lines.push(tidyLine(row, true));
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    const punctuated = PUNCTUATED_TAGS.has(tag);
    if (block) writer.flush();
    if (punctuated) writer.hold();
    for (const child of Array.from(node.childNodes || [])) visit(child);
    if (block) writer.flush();
    if (punctuated) writer.release();
  };
  for (const child of Array.from(root.childNodes)) visit(child);
  writer.flush();
  return writer.lines.join('\n');
}

// ---- Cutting text for a speech engine -------------------------------------------

function codePoints(text) {
  return Array.from(text);
}

function packWords(words, maxChars) {
  const out = [];
  let current = '';
  for (const word of words) {
    if (codePoints(word).length > maxChars) {
      if (current) { out.push(current); current = ''; }
      const letters = codePoints(word);
      for (let at = 0; at < letters.length; at += maxChars) out.push(letters.slice(at, at + maxChars).join(''));
      continue;
    }
    const joined = current ? `${current} ${word}` : word;
    if (codePoints(joined).length <= maxChars) current = joined;
    else { out.push(current); current = word; }
  }
  if (current) out.push(current);
  return out;
}

function splitLongSentence(sentence, maxChars) {
  const pieces = sentence.split(/(?<=[,;:，、；：])\s*/u).filter(Boolean);
  const out = [];
  let current = '';
  for (const piece of pieces) {
    if (codePoints(piece).length > maxChars) {
      if (current) { out.push(current); current = ''; }
      out.push(...packWords(piece.split(/\s+/).filter(Boolean), maxChars));
      continue;
    }
    const joined = current ? `${current} ${piece}` : piece;
    if (codePoints(joined).length <= maxChars) current = joined;
    else { out.push(current); current = piece; }
  }
  if (current) out.push(current);
  return out;
}

function sentencesOf(line) {
  const out = [];
  for (const part of line.split(/(?<=[.!?…]["'”’)\]]*)\s+/u)) {
    const cjk = part.match(/[^。！？]+[。！？]+["'”’)\]」』]*|[^。！？]+$/gu);
    if (cjk && cjk.length > 1) out.push(...cjk); else out.push(part);
  }
  return out.map((sentence) => sentence.trim()).filter(Boolean);
}

/** Cut text into pieces of at most maxChars, on line breaks and sentence ends where it can. */
export function splitForSpeech(text, { maxChars = BROWSER_CHUNK_CHARS } = {}) {
  const limit = Math.max(1, Number(maxChars) || BROWSER_CHUNK_CHARS);
  const chunks = [];
  for (const line of String(text || '').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let current = '';
    const add = (sentence) => {
      const glue = current && !/[。！？]["'”’)\]」』]*$/u.test(current) ? ' ' : '';
      const joined = current ? `${current}${glue}${sentence}` : sentence;
      if (codePoints(joined).length <= limit) { current = joined; return; }
      if (current) chunks.push(current);
      current = sentence;
    };
    for (const sentence of sentencesOf(trimmed)) {
      if (codePoints(sentence).length <= limit) { add(sentence); continue; }
      if (current) { chunks.push(current); current = ''; }
      const pieces = splitLongSentence(sentence, limit);
      current = pieces.pop() || '';
      chunks.push(...pieces);
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

// ---- Which voice ------------------------------------------------------------------

/** The route a press uses first: the profile's voice through the gateway, else the browser's, else none. */
export function chooseReadAloudRoute({ gatewayAvailable = false, browserAvailable = false } = {}) {
  if (gatewayAvailable) return READ_ALOUD_ROUTES.gateway;
  if (browserAvailable) return READ_ALOUD_ROUTES.browser;
  return READ_ALOUD_ROUTES.none;
}

/** Every route worth trying, best first: a failed gateway voice falls through to the browser's. */
export function readAloudRouteOrder({ gatewayAvailable = false, browserAvailable = false } = {}) {
  return [
    ...(gatewayAvailable ? [READ_ALOUD_ROUTES.gateway] : []),
    ...(browserAvailable ? [READ_ALOUD_ROUTES.browser] : []),
  ];
}

/** The Voice row in Settings > About & Diagnostics: copy keys, not text, so the panel can translate. */
export function describeVoiceRoute({ gatewayAvailable = false, browserAvailable = false, lastFallback = '' } = {}) {
  const route = chooseReadAloudRoute({ gatewayAvailable, browserAvailable });
  const fellBack = route === READ_ALOUD_ROUTES.gateway && Boolean(lastFallback);
  return {
    route,
    stateKey: `read_aloud.route.${route}`,
    reasonKey: fellBack ? 'read_aloud.reason.gateway_fell_back' : `read_aloud.reason.${route}`,
    status: route === READ_ALOUD_ROUTES.none ? 'warn' : 'ok',
    params: fellBack ? { reason: String(lastFallback) } : {},
  };
}

// ---- Audio from the gateway ---------------------------------------------------------

/** { bytes, mimeType } from an audio data URL, or null for anything else. */
export function dataUrlToBytes(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (!text.startsWith('data:') || comma < 0) return null;
  const [mimeType = '', ...flags] = text.slice(5, comma).toLowerCase().split(';');
  if (!/^(?:audio\/[a-z0-9.+-]+|application\/ogg)$/.test(mimeType) || !flags.includes('base64')) return null;
  try {
    const binary = atob(text.slice(comma + 1).replace(/\s+/g, ''));
    if (!binary.length) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

/**
 * Plays audio bytes through Web Audio. A media element would need the page's content
 * security policy to allow data: or blob: media; decoding the bytes does not.
 */
export function createGatewayAudioPlayback({
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext || null,
} = {}) {
  let context = null;
  function ensureContext() {
    if (!AudioContextCtor) throw new Error('Web Audio is not available in this browser.');
    context ||= new AudioContextCtor();
    return context;
  }
  return {
    available: Boolean(AudioContextCtor),
    /** Call inside the press: the browser only lets audio start from a user gesture. */
    prepare() {
      if (!AudioContextCtor) return;
      try {
        const ctx = ensureContext();
        if (ctx.state !== 'running') void Promise.resolve(ctx.resume()).catch(() => undefined);
      } catch { /* playing reports the failure */ }
    },
    async play(bytes) {
      const ctx = ensureContext();
      if (ctx.state !== 'running') await ctx.resume();
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buffer = await ctx.decodeAudioData(copy);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      let settle;
      const finished = new Promise((resolve) => { settle = resolve; });
      source.onended = () => settle();
      source.start();
      return {
        finished,
        stop() {
          source.onended = null;
          try { source.stop(); } catch { /* already ended */ }
          settle();
        },
      };
    },
  };
}

// ---- The browser's own voice ------------------------------------------------------------

const QUIET_SPEECH_ERRORS = new Set(['canceled', 'cancelled', 'interrupted']);

export function createBrowserSpeech({
  synth = globalThis.speechSynthesis || null,
  Utterance = globalThis.SpeechSynthesisUtterance || null,
  lang = '',
} = {}) {
  return {
    available: Boolean(synth && Utterance),
    speak(chunks) {
      if (!synth || !Utterance) throw new Error('Browser speech is not available.');
      let at = 0;
      let stopped = false;
      let settle;
      let fail;
      const finished = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
      const next = () => {
        if (stopped) return;
        if (at >= chunks.length) { settle(); return; }
        const utterance = new Utterance(chunks[at]);
        if (lang) utterance.lang = lang;
        utterance.onend = () => {
          if (stopped) return;
          at += 1;
          next();
        };
        utterance.onerror = (event) => {
          if (stopped) return;
          stopped = true;
          const code = String(event?.error || 'speech-error');
          if (QUIET_SPEECH_ERRORS.has(code)) settle(); else fail(new Error(code));
        };
        synth.speak(utterance);
      };
      synth.cancel();
      next();
      return {
        finished,
        stop() {
          stopped = true;
          synth.cancel();
          settle();
        },
      };
    },
  };
}

// ---- One reply at a time ------------------------------------------------------------------

function messageOf(error) {
  return String(error?.message || error || 'failed');
}

/**
 * The playback state machine. idle -> loading (audio being made) -> speaking -> idle.
 * One reply at a time: a press on another reply switches, a press on the one being read
 * stops it, and a new turn or a chat switch stops it. Every run holds a generation number;
 * anything that finishes after its run was stopped is discarded and touches nothing.
 *
 *   gateway  { prepare(), synthesize(text, { signal }) -> audio, play(audio) -> { stop, finished } }
 *   browser  { speak(chunks) -> { stop, finished } }
 */
export function createReadAloudPlayer({ gateway = null, browser = null, onChange = () => {} } = {}) {
  let generation = 0;
  let controller = null;
  let current = null;
  let releaseRun = null;
  let state = { status: READ_ALOUD_STATUS.idle, target: null, route: null, fallbackReason: '', lastFallback: '' };

  function set(patch) {
    state = { ...state, ...patch };
    onChange({ ...state });
  }

  function stop() {
    generation += 1;
    controller?.abort?.();
    controller = null;
    releaseRun?.();
    releaseRun = null;
    const clip = current;
    current = null;
    try { clip?.stop?.(); } catch { /* already finished */ }
    if (state.status !== READ_ALOUD_STATUS.idle || state.target !== null) {
      set({ status: READ_ALOUD_STATUS.idle, target: null, route: null });
    }
  }

  async function playThroughGateway(text, { token, signal, chunkChars, cancelled }) {
    const live = () => token === generation;
    const chunks = splitForSpeech(text, { maxChars: chunkChars });
    const request = (index) => Promise.resolve()
      .then(() => gateway.synthesize(chunks[index], { signal }))
      .then((audio) => ({ audio }), (error) => ({ error }));
    let upcoming = request(0);
    for (let index = 0; index < chunks.length; index += 1) {
      const made = await Promise.race([upcoming, cancelled]);
      if (!live()) return { stale: true };
      if (made.error) return { failedAt: index, error: made.error };
      if (index + 1 < chunks.length) upcoming = request(index + 1);
      let clip;
      try {
        clip = await Promise.race([gateway.play(made.audio), cancelled]);
        if (!clip) return { stale: true };
      } catch (error) {
        return { failedAt: index, error };
      }
      if (!live()) { clip.stop(); return { stale: true }; }
      current = clip;
      if (state.status !== READ_ALOUD_STATUS.speaking) set({ status: READ_ALOUD_STATUS.speaking, route: READ_ALOUD_ROUTES.gateway });
      await clip.finished;
      if (!live()) return { stale: true };
      current = null;
    }
    return { done: true, remaining: '' };
  }

  async function playThroughBrowser(text, { token, chunkChars }) {
    const live = () => token === generation;
    const clip = browser.speak(splitForSpeech(text, { maxChars: chunkChars }));
    current = clip;
    set({ status: READ_ALOUD_STATUS.speaking, route: READ_ALOUD_ROUTES.browser });
    await clip.finished;
    if (!live()) return { stale: true };
    current = null;
    return { done: true };
  }

  async function run(target, text, { order, gatewayChunkChars, browserChunkChars, cancelled }) {
    const token = generation;
    const signal = controller?.signal;
    let remaining = text;
    let lastError = null;
    for (const route of order) {
      try {
        if (route === READ_ALOUD_ROUTES.gateway && gateway) {
          const outcome = await playThroughGateway(remaining, { token, signal, chunkChars: gatewayChunkChars, cancelled });
          if (outcome.stale) return { ok: true, stopped: true };
          if (outcome.done) {
            set({ status: READ_ALOUD_STATUS.idle, target: null, route: null, lastFallback: '' });
            return { ok: true };
          }
          lastError = outcome.error;
          const chunks = splitForSpeech(remaining, { maxChars: gatewayChunkChars });
          remaining = chunks.slice(outcome.failedAt).join('\n');
        } else if (route === READ_ALOUD_ROUTES.browser && browser) {
          const outcome = await playThroughBrowser(remaining, { token, chunkChars: browserChunkChars });
          if (outcome.stale) return { ok: true, stopped: true };
          set({ status: READ_ALOUD_STATUS.idle, target: null, route: null });
          return { ok: true, fellBackFrom: state.fallbackReason || '' };
        } else {
          continue;
        }
      } catch (error) {
        if (token !== generation) return { ok: true, stopped: true };
        lastError = error;
      }
      if (token !== generation) return { ok: true, stopped: true };
      if (route === READ_ALOUD_ROUTES.gateway) {
        const reason = messageOf(lastError);
        set({ fallbackReason: reason, lastFallback: reason });
      }
    }
    if (token !== generation) return { ok: true, stopped: true };
    current = null;
    set({ status: READ_ALOUD_STATUS.idle, target: null, route: null });
    return { ok: false, error: lastError ? messageOf(lastError) : 'No voice is available.' };
  }

  async function toggle(target, text, {
    order = [], gatewayChunkChars = GATEWAY_CHUNK_CHARS, browserChunkChars = BROWSER_CHUNK_CHARS,
  } = {}) {
    if (state.target === target && state.status !== READ_ALOUD_STATUS.idle) {
      stop();
      return { ok: true, stopped: true };
    }
    stop();
    const spoken = String(text || '').trim();
    if (!spoken) return { ok: false, error: 'Nothing to read.' };
    if (!order.length) return { ok: false, error: 'No voice is available.' };
    if (order.includes(READ_ALOUD_ROUTES.gateway)) gateway?.prepare?.();
    generation += 1;
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    const cancelled = new Promise((resolve) => { releaseRun = resolve; });
    set({ status: READ_ALOUD_STATUS.loading, target, route: null, fallbackReason: '' });
    return run(target, spoken, { order, gatewayChunkChars, browserChunkChars, cancelled });
  }

  return {
    state: () => ({ ...state }),
    toggle,
    stop,
    turnStarted() { if (state.status !== READ_ALOUD_STATUS.idle) stop(); },
    chatChanged() { if (state.status !== READ_ALOUD_STATUS.idle) stop(); },
  };
}
