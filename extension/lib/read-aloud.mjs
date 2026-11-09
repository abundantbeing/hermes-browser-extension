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

export const GATEWAY_SPEAK_PATH = '/api/audio/speak';
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

/**
 * Cut text into pieces of at most maxChars, on line breaks and sentence ends where it can.
 * A line break always ends a piece, unless packLines lets whole lines share one (a speech
 * service takes a few paragraphs in one request; the browser's engine wants short pieces).
 */
export function splitForSpeech(text, { maxChars = BROWSER_CHUNK_CHARS, packLines = false } = {}) {
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
  if (!packLines) return chunks;
  const packed = [];
  for (const chunk of chunks) {
    const last = packed[packed.length - 1];
    if (last !== undefined && codePoints(last).length + 1 + codePoints(chunk).length <= limit) packed[packed.length - 1] = `${last}\n${chunk}`;
    else packed.push(chunk);
  }
  return packed;
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

/** English line for the support report: which route read-aloud uses and why. */
export function voiceRouteSummary({ gatewayAvailable = false, browserAvailable = false, lastFallback = '' } = {}) {
  const route = chooseReadAloudRoute({ gatewayAvailable, browserAvailable });
  if (route === READ_ALOUD_ROUTES.gateway) {
    const note = lastFallback ? `; the last read fell back to browser speech (${String(lastFallback).replace(/\s+/g, ' ').slice(0, 120)})` : '';
    return `gateway TTS (Hermes dashboard ${GATEWAY_SPEAK_PATH}), then browser speech if it fails${note}`;
  }
  if (route === READ_ALOUD_ROUTES.browser) return 'browser speech (speechSynthesis); the Hermes dashboard speech route is not reachable';
  return 'none (no Hermes dashboard speech route and no browser speech)';
}

const READ_ALOUD_ROW_PREFIX = 'r:';
const READ_ALOUD_TS_PREFIX = 't:';
const READ_ALOUD_REPLY_PREFIX = 'u:';

export function hashReadAloudContent(text) {
  const content = String(text ?? '');
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readAloudRowId(record) {
  const rowId = record?.rowId ?? record?.row_id;
  return Number.isInteger(rowId) && rowId > 0 ? rowId : null;
}

function readAloudTs(record) {
  const ts = Number(record?.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/** Content fingerprint for a reply (stable across history refresh). */
export function readAloudContentKey(record) {
  const content = String(record?.content ?? '');
  return `${content.length}:${hashReadAloudContent(content)}`;
}

function readAloudGatewayMessageId(record) {
  for (const candidate of [record?.message_id, record?.id, record?.messageId]) {
    const id = String(candidate ?? '').trim();
    if (id) return id;
  }
  return null;
}

/** Stable per-reply id: gateway message id, a panel-local id, or null. */
export function readAloudStableReplyId(record) {
  const stored = String(record?.readAloudReplyId ?? '').trim();
  if (stored) return stored;
  return readAloudGatewayMessageId(record);
}

let readAloudReplyIdCounter = 0;

export function allocateReadAloudReplyId() {
  readAloudReplyIdCounter += 1;
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${random}-${readAloudReplyIdCounter}`;
}

/** Assign a durable read-aloud id on assistant records that lack one. */
export function ensureReadAloudReplyId(record) {
  if (!record || record.role !== 'assistant') return record;
  const id = readAloudStableReplyId(record);
  if (id) {
    if (!record.readAloudReplyId) record.readAloudReplyId = id;
    return record;
  }
  record.readAloudReplyId = allocateReadAloudReplyId();
  return record;
}

/** Carry local read-aloud ids forward when history refresh re-merges the transcript. */
export function preserveReadAloudReplyIds(refreshedMessages = [], localMessages = []) {
  if (!Array.isArray(refreshedMessages)) return [];
  const localAssistants = (Array.isArray(localMessages) ? localMessages : [])
    .filter((message) => message?.role === 'assistant');
  const localByRowId = new Map();
  for (const message of localAssistants) {
    const rowId = readAloudRowId(message);
    if (rowId !== null) localByRowId.set(rowId, message);
  }
  const claimed = new Set();
  return refreshedMessages.map((message) => {
    if (message?.role !== 'assistant') return message;
    if (readAloudStableReplyId(message)) return ensureReadAloudReplyId({ ...message });
    let donor = null;
    if (Number.isInteger(message.rowId) && message.rowId > 0) donor = localByRowId.get(message.rowId);
    if (!donor) {
      const incomingRowId = readAloudRowId(message);
      if (incomingRowId !== null) donor = localByRowId.get(incomingRowId);
    }
    if (!donor) {
      const contentKey = readAloudContentKey(message);
      const ts = readAloudTs(message);
      donor = localAssistants.find((local, index) => {
        if (claimed.has(index)) return false;
        const localRowId = readAloudRowId(local);
        const incomingRowId = readAloudRowId(message);
        if (localRowId && incomingRowId && localRowId !== incomingRowId) return false;
        if (readAloudContentKey(local) !== contentKey) return false;
        const localTs = readAloudTs(local);
        if (localTs !== null && ts !== null && localTs !== ts && !(incomingRowId && !localRowId)) return false;
        return true;
      });
      if (donor) claimed.add(localAssistants.indexOf(donor));
    }
    const id = readAloudStableReplyId(donor) || readAloudGatewayMessageId(message) || allocateReadAloudReplyId();
    return { ...message, readAloudReplyId: id };
  });
}

/** Names a reply for playback; row ids are prefixed so content like `12:30` is not parsed as an id. */
export function readAloudKey(record) {
  const contentKey = readAloudContentKey(record);
  const rowId = readAloudRowId(record);
  if (rowId !== null) return `${READ_ALOUD_ROW_PREFIX}${rowId}:${contentKey}`;
  const replyId = readAloudStableReplyId(record);
  if (replyId !== null) return `${READ_ALOUD_REPLY_PREFIX}${replyId}#${contentKey}`;
  const ts = readAloudTs(record);
  return ts !== null ? `${READ_ALOUD_TS_PREFIX}${ts}:${contentKey}` : contentKey;
}

function parsePrefixedReadAloudTarget(text, prefix) {
  if (!text.startsWith(prefix)) return null;
  const after = text.slice(prefix.length);
  const firstColon = after.indexOf(':');
  if (firstColon < 0) return { head: null, contentKey: text };
  return { head: after.slice(0, firstColon), contentKey: after.slice(firstColon + 1) };
}

function parseReadAloudTarget(target) {
  const text = String(target ?? '');
  const row = parsePrefixedReadAloudTarget(text, READ_ALOUD_ROW_PREFIX);
  if (row) {
    if (!/^\d+$/.test(row.head || '')) return { rowId: null, replyId: null, contentKey: text, ts: null };
    return { rowId: Number(row.head), replyId: null, contentKey: row.contentKey, ts: null };
  }
  if (text.startsWith(READ_ALOUD_REPLY_PREFIX)) {
    const after = text.slice(READ_ALOUD_REPLY_PREFIX.length);
    const split = after.indexOf('#');
    if (split < 0) return { rowId: null, replyId: null, contentKey: text, ts: null };
    const replyId = after.slice(0, split);
    if (!replyId) return { rowId: null, replyId: null, contentKey: text, ts: null };
    return { rowId: null, replyId, contentKey: after.slice(split + 1), ts: null };
  }
  const tsMarked = parsePrefixedReadAloudTarget(text, READ_ALOUD_TS_PREFIX);
  if (tsMarked) {
    if (!/^\d+$/.test(tsMarked.head || '')) return { rowId: null, replyId: null, contentKey: text, ts: null };
    return { rowId: null, replyId: null, contentKey: tsMarked.contentKey, ts: Number(tsMarked.head) };
  }
  return { rowId: null, replyId: null, contentKey: text, ts: null };
}

/** Same reply across refresh when rowId was missing live then set; distinct when rowIds differ. */
export function readAloudKeysMatch(targetKey, record) {
  const playing = parseReadAloudTarget(targetKey);
  const contentKey = readAloudContentKey(record);
  if (playing.contentKey !== contentKey) return false;
  const rowId = readAloudRowId(record);
  if (playing.rowId !== null && rowId !== null && playing.rowId !== rowId) return false;
  const replyId = readAloudStableReplyId(record);
  if (playing.replyId !== null && replyId !== null && playing.replyId !== replyId) return false;
  if (playing.rowId === null && rowId === null && playing.replyId === null && playing.ts !== null) {
    const recordTs = readAloudTs(record);
    if (recordTs !== null && playing.ts !== recordTs) return false;
  }
  return true;
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

const SPEAK_MIN_TIMEOUT_MS = 20_000;
const SPEAK_MAX_TIMEOUT_MS = 180_000;
const SPEAK_MS_PER_CHAR = 35;

export function gatewaySpeakUrl(baseUrl = '', profile = '') {
  const url = new URL(String(baseUrl || '').trim());
  url.hash = '';
  url.search = '';
  url.pathname = GATEWAY_SPEAK_PATH;
  const name = String(profile || '').trim();
  if (name) url.searchParams.set('profile', name);
  return url.toString();
}

/**
 * Ask the Hermes dashboard to say `text` in the profile's configured voice.
 * Resolves to { bytes, mimeType, provider }; rejects with the server's own words
 * (and `status`) when it cannot. `signal` cancels the request when playback is stopped.
 */
function abortErrorAlready() {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

export async function requestGatewaySpeech({
  baseUrl = '', token = '', profile = '', text = '', signal = undefined, fetchFn = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (!String(baseUrl || '').trim() || !String(token || '').trim() || typeof fetchFn !== 'function') {
    throw new Error('The Hermes dashboard is not reachable from this panel.');
  }
  if (signal?.aborted) {
    throw abortErrorAlready();
  }
  const body = String(text || '');
  const timeoutMs = Math.min(SPEAK_MAX_TIMEOUT_MS, Math.max(SPEAK_MIN_TIMEOUT_MS, body.length * SPEAK_MS_PER_CHAR));
  const timeout = typeof AbortController === 'function' ? new AbortController() : null;
  const linked = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = timeout ? setTimeout(() => {
    timeout.abort();
    linked?.abort();
  }, timeoutMs) : null;
  const onStop = () => {
    timeout?.abort();
    linked?.abort();
  };
  signal?.addEventListener?.('abort', onStop, { once: true });
  if (signal?.aborted) {
    onStop();
    throw abortErrorAlready();
  }
  try {
    const response = await fetchFn(gatewaySpeakUrl(baseUrl, profile), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Hermes-Session-Token': String(token).trim() },
      body: JSON.stringify({ text: body }),
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      ...(linked ? { signal: linked.signal } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.detail;
      const error = new Error(String((typeof detail === 'string' && detail) || payload?.error?.message || payload?.error || `Hermes speech request failed (${response.status}).`));
      error.status = response.status;
      throw error;
    }
    const audio = dataUrlToBytes(payload?.data_url);
    if (!audio) throw new Error('Hermes did not return audio.');
    return { ...audio, provider: String(payload?.provider || '') };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', onStop);
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
    async play(bytes, { isActive = () => true } = {}) {
      const ctx = ensureContext();
      if (ctx.state !== 'running') await ctx.resume();
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buffer = await ctx.decodeAudioData(copy);
      if (!isActive()) return null;
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
    const chunks = splitForSpeech(text, { maxChars: chunkChars, packLines: true });
    const request = (index) => Promise.resolve()
      .then(() => gateway.synthesize(chunks[index], { signal }))
      .then((audio) => ({ audio }), (error) => ({ error }));
    let upcoming = request(0);
    for (let index = 0; index < chunks.length; index += 1) {
      const made = await Promise.race([upcoming, cancelled]);
      if (!live()) return { stale: true };
      if (made.error) return { failedAt: index, error: made.error };
      let clip;
      try {
        clip = await gateway.play(made.audio, { isActive: live });
        if (!clip) return { stale: true };
      } catch (error) {
        return { failedAt: index, error };
      }
      if (index + 1 < chunks.length) upcoming = request(index + 1);
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
          const chunks = splitForSpeech(remaining, { maxChars: gatewayChunkChars, packLines: true });
          remaining = chunks.slice(outcome.failedAt).join('\n');
        } else if (route === READ_ALOUD_ROUTES.browser && browser) {
          const outcome = await playThroughBrowser(remaining, { token, chunkChars: browserChunkChars });
          if (outcome.stale) return { ok: true, stopped: true };
          set({
            status: READ_ALOUD_STATUS.idle,
            target: null,
            route: null,
            lastFallback: state.fallbackReason || '',
          });
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
        set({ fallbackReason: messageOf(lastError) });
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
