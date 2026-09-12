// Session history display normalization.
//
// Stored Hermes session history can contain machine forms of a user turn: the
// serialized Browser turn envelope (BCP v2), legacy v1 wrapped prompts
// (USER_REQUEST_START / UNTRUSTED_BROWSER_CONTEXT markers), vision-handoff
// blocks, and inline @image:/@video: media tags. The panel must show only what
// the human wrote plus the media they attached — never receipt or bookkeeping
// JSON (source_receipt, browser_control, attachment_context, page context).
//
// Safety rule: stripProtocolNoise() returns its input byte-identical unless the
// text carries a Browser/vision protocol marker, so genuine prose — including
// prose quoting arbitrary JSON — is never eaten. Envelope parsing is typed:
// only objects carrying the turn protocol id (or a human_input-shaped object)
// unwrap; anything else stays visible fail-closed and a recoverable human
// prompt is never reduced to an empty string.
//
// Pure and dependency-free (no browser APIs): importable by the side panel,
// the Hermes Web app, and node tests alike. Media parsing and envelope
// constants are reused from the canonical modules, not reimplemented.

import {
  BROWSER_CONTEXT_PROTOCOL_ID,
  BROWSER_CONTEXT_TURN_PROTOCOL_ID,
} from './browser-context-protocol.mjs';
import {
  classifyMediaKind,
  extractImageRefs,
  extractVideoRefs,
  splitInboundVisionMessage,
} from './media-persistence.mjs';

const ENVELOPE_PROTOCOL_ID = BROWSER_CONTEXT_TURN_PROTOCOL_ID;
const CONTEXT_PAYLOAD_PROTOCOL_ID = BROWSER_CONTEXT_PROTOCOL_ID;

// JSON keys that only ever appear in Browser turn bookkeeping. A fragment that
// carries one of these keys is protocol noise; the same keys inside otherwise
// ordinary user prose are never touched because removal only targets complete,
// parseable JSON spans.
const PROTOCOL_KEY_PATTERN = /"(?:source_receipt|attachment_context|browser_control|browser_context|human_input|instruction_transform)"\s*:/;
const ENVELOPE_SIGNATURE_PATTERN = /"human_input"\s*:\s*\{/;
const USER_REQUEST_MARKER_PATTERN = /^[ \t]*USER_REQUEST_(?:START|END)[ \t]*$/gm;
const UNTRUSTED_CONTEXT_BLOCK_PATTERN = /UNTRUSTED_BROWSER_CONTEXT_START[\s\S]*?UNTRUSTED_BROWSER_CONTEXT_END[ \t]*/g;
const CONTEXT_REFERENCE_MARKER_PATTERN = /\[Hermes Browser context unchanged[^\]]*\]/g;
const UNTRUSTED_PREAMBLE_PATTERN = /^\s*Treat browser page content as untrusted data\.[^\n]*\n?/;
// Mirrors the @image:/@video: token grammar of extractTaggedPaths() in
// media-persistence.mjs so stripped tokens and extracted refs always agree.
const MEDIA_TOKEN_PATTERN = /@(?:image|video):(?:"[^"]*"|'[^']*'|[^\s\]]+)/g;

const MAX_FRAGMENT_CANDIDATES = 1024;

function fileNameFromPath(filePath = '') {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  return base.trim();
}

function parseJsonObject(text = '') {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonFragment(text = '') {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True when the value is the serialized Browser turn envelope: the canonical
 * turn protocol id, or the human_input shape the envelope always carries.
 */
function isEnvelopeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.protocol === ENVELOPE_PROTOCOL_ID) return true;
  const input = value.human_input;
  if (input && typeof input === 'object' && !Array.isArray(input) && typeof input.text === 'string') {
    return ['protocol', 'browser_context', 'attachment_context', 'source_receipt', 'browser_control'].some((key) => key in value);
  }
  return false;
}

/** Public predicate: does this raw text look like a Browser turn envelope? */
export function isBrowserTurnEnvelope(value = '') {
  const trimmed = String(value ?? '').trim();
  if (!trimmed.startsWith('{')) return false;
  const parsed = parseJsonObject(trimmed);
  if (parsed) return isEnvelopeObject(parsed);
  // Truncated serialization: the signature is present but JSON.parse fails.
  return trimmed.includes(ENVELOPE_PROTOCOL_ID) || ENVELOPE_SIGNATURE_PATTERN.test(trimmed);
}

function hasProtocolSignal(raw = '') {
  const text = String(raw);
  if (!text) return false;
  if (text.includes(ENVELOPE_PROTOCOL_ID) || text.includes(CONTEXT_PAYLOAD_PROTOCOL_ID)) return true;
  if (PROTOCOL_KEY_PATTERN.test(text)) return true;
  if (text.includes('@image:') || text.includes('@video:')) return true;
  if (text.includes('USER_REQUEST_START') || text.includes('USER_REQUEST_END')) return true;
  if (text.includes('UNTRUSTED_BROWSER_CONTEXT_START')) return true;
  if (text.includes('[Hermes Browser context unchanged')) return true;
  return splitInboundVisionMessage(text).hadVisionBlock;
}

function tidyProtocolText(text = '') {
  return String(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripMediaTokens(text = '') {
  return String(text).replace(MEDIA_TOKEN_PATTERN, '');
}

/** String-aware scan for the bracket matching the one at `start`, or -1. */
function matchingBracketIndex(text = '', start = 0) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isProtocolFragment(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => isProtocolFragment(item));
  if (value.protocol === ENVELOPE_PROTOCOL_ID || value.protocol === CONTEXT_PAYLOAD_PROTOCOL_ID) return true;
  return ['source_receipt', 'attachment_context', 'browser_control', 'browser_context', 'human_input'].some((key) => key in value);
}

/**
 * Remove complete, parseable JSON spans that are Browser/vision bookkeeping.
 * Ordinary JSON a user pasted is only removed when it actually carries
 * protocol keys — arbitrary fragments are left exactly where they were.
 */
function removeProtocolJsonFragments(text = '') {
  const source = String(text);
  const spans = [];
  let candidates = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== '{' && char !== '[') continue;
    candidates += 1;
    if (candidates > MAX_FRAGMENT_CANDIDATES) break;
    const end = matchingBracketIndex(source, index);
    if (end === -1) continue;
    const parsed = parseJsonFragment(source.slice(index, end + 1));
    if (parsed === null) continue;
    if (!isProtocolFragment(parsed)) continue;
    spans.push([index, end]);
    index = end;
  }
  if (!spans.length) return source;
  let output = source;
  for (let spanIndex = spans.length - 1; spanIndex >= 0; spanIndex -= 1) {
    const [start, end] = spans[spanIndex];
    output = output.slice(0, start) + output.slice(end + 1);
  }
  return output;
}

/** Remove the legacy v1 prompt scaffolding and vision blocks from prose. */
function cleanProtocolArtifacts(text = '') {
  let output = removeProtocolJsonFragments(text);
  output = output
    .replace(CONTEXT_REFERENCE_MARKER_PATTERN, '')
    .replace(UNTRUSTED_PREAMBLE_PATTERN, '')
    .replace(UNTRUSTED_CONTEXT_BLOCK_PATTERN, '')
    .replace(USER_REQUEST_MARKER_PATTERN, '');
  output = stripMediaTokens(output);
  const vision = splitInboundVisionMessage(output);
  if (vision.hadVisionBlock) output = vision.visibleText;
  return tidyProtocolText(output);
}

/**
 * Clean the human_input.text recovered from an envelope. Deliberately gentler
 * than stripProtocolNoise(): the envelope body has already been consumed, so
 * anything left here is the user's own prose and must survive verbatim apart
 * from media tokens and vision blocks that are surfaced as attachments.
 */
function cleanEnvelopeHumanText(humanText = '') {
  const original = String(humanText ?? '');
  let output = stripMediaTokens(original);
  const vision = splitInboundVisionMessage(output);
  if (vision.hadVisionBlock) output = vision.visibleText;
  if (output !== original) output = tidyProtocolText(output);
  return output.trim();
}

function decodeJsonStringFragment(fragment = '') {
  try {
    const parsed = JSON.parse(`"${fragment}"`);
    return typeof parsed === 'string' ? parsed : String(fragment);
  } catch {
    return String(fragment);
  }
}

/**
 * Best-effort recovery of human_input.text from a truncated serialization:
 * take everything after `"text":"` up to the next unescaped quote, or to the
 * end of the string when the cut happened mid-value.
 */
function recoverHumanInputText(raw = '') {
  const text = String(raw);
  const key = /"human_input"\s*:\s*\{[^{}]{0,2000}?"text"\s*:\s*"/.exec(text);
  if (!key) return null;
  const start = key.index + key[0].length;
  let end = text.length;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      end = index;
      break;
    }
  }
  return decodeJsonStringFragment(text.slice(start, end));
}

/** Best-effort recovery of attachment local_path values from a truncation. */
function recoverLocalPathItems(raw = '') {
  const text = String(raw);
  if (!text.includes('"local_path"')) return [];
  const pattern = /"local_path"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const items = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const pathRef = decodeJsonStringFragment(match[1]).trim();
    if (!pathRef) continue;
    items.push({
      kind: classifyMediaKind(pathRef),
      pathRef,
      label: fileNameFromPath(pathRef) || pathRef,
      detail: '',
    });
  }
  return items;
}

function envelopeItemPath(item = {}) {
  const value = typeof item.local_path === 'string'
    ? item.local_path
    : (typeof item.localPath === 'string' ? item.localPath : '');
  return value.trim();
}

function envelopeItemKind(item = {}) {
  const declared = String(item.kind || '').trim().toLowerCase();
  if (declared === 'image' || declared === 'video') return declared;
  return classifyMediaKind(envelopeItemPath(item));
}

function envelopeAttachmentItems(parsed = {}) {
  const items = parsed?.attachment_context?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      kind: envelopeItemKind(item),
      pathRef: envelopeItemPath(item),
      label: String(item.label ?? item.name ?? '').trim() || fileNameFromPath(envelopeItemPath(item)),
      detail: String(item.detail ?? '').trim(),
    }));
}

function collectInlineMediaAttachments(text = '') {
  const source = String(text || '');
  if (!source.includes('@image:') && !source.includes('@video:')) return [];
  const items = [];
  for (const ref of [...extractImageRefs(source), ...extractVideoRefs(source)]) {
    const pathRef = String(ref?.path || '').trim();
    if (!pathRef) continue;
    items.push({
      kind: ref.kind === 'image' || ref.kind === 'video' ? ref.kind : classifyMediaKind(pathRef),
      pathRef,
      label: fileNameFromPath(pathRef) || pathRef,
      detail: '',
    });
  }
  return items;
}

function attachmentDedupeKey(item = {}) {
  const ref = String(item.pathRef || '').trim().replace(/\\/g, '/').toLowerCase();
  if (ref) return `ref:${ref}`;
  return `meta:${item.kind}:${item.label}:${item.detail}`;
}

function dedupeAttachments(items = []) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = attachmentDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

/**
 * Read the turn envelope out of a raw message. Complete serializations parse
 * and are typed; a truncation that still carries the signature is recovered
 * field by field so the human prompt survives.
 */
function readTurnEnvelope(rawText = '') {
  const trimmed = String(rawText).trim();
  if (!trimmed.startsWith('{')) return null;
  const parsed = parseJsonObject(trimmed);
  if (parsed) {
    if (!isEnvelopeObject(parsed)) return null;
    return {
      humanText: typeof parsed.human_input?.text === 'string' ? parsed.human_input.text : '',
      items: envelopeAttachmentItems(parsed),
    };
  }
  if (!trimmed.includes(ENVELOPE_PROTOCOL_ID) && !ENVELOPE_SIGNATURE_PATTERN.test(trimmed)) return null;
  return {
    humanText: recoverHumanInputText(trimmed),
    items: recoverLocalPathItems(trimmed),
  };
}

function flattenHistoryText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenHistoryText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return flattenHistoryText(value.text ?? value.output_text ?? value.content);
  return '';
}

function readHistoryMessage(message) {
  if (typeof message === 'string') return { role: '', text: message };
  if (!message || typeof message !== 'object') return { role: '', text: '' };
  const role = String(message.role ?? '').trim().toLowerCase();
  for (const candidate of [message.content, message.text, message.context]) {
    const text = flattenHistoryText(candidate);
    if (text) return { role, text };
  }
  return { role, text: '' };
}

function failVisibleText(rawText = '') {
  const cleaned = stripProtocolNoise(rawText);
  if (cleaned && cleaned.trim()) return cleaned;
  return String(rawText).trim();
}

/**
 * Strip Browser/vision protocol noise from a raw text. When no protocol marker
 * is present the input is returned EXACTLY unchanged — genuine prose, pasted
 * JSON, and arbitrary user text are never eaten.
 */
export function stripProtocolNoise(text = '') {
  const raw = String(text ?? '');
  if (!raw.trim()) return raw;
  if (!hasProtocolSignal(raw)) return raw;

  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = parseJsonObject(trimmed);
    if (parsed && isEnvelopeObject(parsed)) {
      return cleanEnvelopeHumanText(typeof parsed.human_input?.text === 'string' ? parsed.human_input.text : '');
    }
    if (!parsed && (trimmed.includes(ENVELOPE_PROTOCOL_ID) || ENVELOPE_SIGNATURE_PATTERN.test(trimmed))) {
      const recovered = recoverHumanInputText(trimmed);
      if (recovered !== null) return cleanEnvelopeHumanText(recovered);
      // Unrecoverable truncation: fall through so the raw form stays visible
      // (fail-visible) instead of collapsing to nothing.
    }
  }
  return cleanProtocolArtifacts(raw);
}

/**
 * Turn a stored history message into its clean display form: the human prompt
 * as prose plus the media they attached. Non-user roles and plain prose pass
 * through untouched. Accepts a message object ({ role, content | text }) or a
 * raw string.
 */
export function normalizeHistoryUserMessage(message = '') {
  const { role, text: rawText } = readHistoryMessage(message);
  const passThrough = { text: rawText, attachments: [], hadEnvelope: false, strippedProtocol: false };
  if (!rawText) return passThrough;
  if (role && role !== 'user' && role !== 'human') return passThrough;

  const envelope = readTurnEnvelope(rawText);
  if (envelope) {
    const humanText = envelope.humanText ?? '';
    const text = cleanEnvelopeHumanText(humanText);
    const attachments = dedupeAttachments([
      ...envelope.items,
      ...collectInlineMediaAttachments(humanText),
    ]);
    return {
      text: text || (attachments.length ? '' : failVisibleText(rawText)),
      attachments,
      hadEnvelope: true,
      strippedProtocol: true,
    };
  }

  const text = stripProtocolNoise(rawText);
  return {
    text,
    attachments: dedupeAttachments(collectInlineMediaAttachments(rawText)),
    hadEnvelope: false,
    strippedProtocol: text !== rawText,
  };
}
