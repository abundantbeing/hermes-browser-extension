import { redactSensitiveText } from './browser-context-protocol.mjs';
import { FRAME_ELEMENT_SHARE, FRAME_TEXT_SHARE } from './browser-control-frames.mjs';
import { controlToolName } from './control-tool-names.mjs';

// Character budgets for the rendered page view. Post-action results stay small
// because every action carries one; an explicit snapshot may be larger.
export const SNAPSHOT_VIEW_BUDGETS = Object.freeze({
  turn: 6_000,
  postAction: 12_000,
  snapshot: 15_000,
  full: 60_000,
});

const MIN_VIEW_CHARS = 500;
const HINT_RESERVE_CHARS = 120;
const SECTION_RESERVE_MAX = 3_000;
const SECTION_RESERVE_FRACTION = 0.25;
const HEADINGS_FRACTION = 0.35;
const HEADINGS_MAX_CHARS = 1_500;
const HEADINGS_MAX_COUNT = 40;
const EXCERPT_FRACTION = 0.3;
const NAME_MAX_CHARS = 120;
const HEADING_MAX_CHARS = 120;
const EXCERPT_LINE_MAX_CHARS = 600;
const FULL_EXCERPT_LINE_MAX_CHARS = 5_000;
const FRAME_TEXT_HEADER = '[text inside embedded frames]';
// The heading, its line break, and the blank line that separates the section from the text before it.
const FRAME_SECTION_OVERHEAD = FRAME_TEXT_HEADER.length + 3;

function compact(value, limit = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function clipped(value, limit) {
  const text = compact(value, limit + 1);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function redactedLine(value, limit) {
  return clipped(redactSensitiveText(compact(value, limit * 4)), limit);
}

function elementFlags(node = {}) {
  const flags = [];
  if (node.disabled === true) flags.push('disabled');
  if (node.checked === true) flags.push('checked');
  else if (node.checked === 'mixed') flags.push('mixed');
  if (node.expanded === true) flags.push('expanded');
  else if (node.expanded === false) flags.push('collapsed');
  if (node.selected === true) flags.push('selected');
  if (node.focused === true) flags.push('focused');
  // Presence only; the value itself never reaches the view.
  if (node.hasValue === true && node.sensitive !== true) flags.push('has value');
  return flags;
}

function elementLine(node = {}) {
  const name = node.sensitive === true ? 'Sensitive field' : redactedLine(node.name, NAME_MAX_CHARS);
  const flags = elementFlags(node);
  return [
    `[${compact(node.ref, 32)}]`,
    compact(node.role || 'generic', 40),
    name ? `"${name.replace(/"/g, '\\"')}"` : '',
    flags.length ? `(${flags.join(', ')})` : '',
  ].filter(Boolean).join(' ');
}

function safeRef(node = {}, name = '') {
  return {
    ref: compact(node.ref, 32),
    role: compact(node.role || 'generic', 80),
    name,
    ...(node.sensitive === true ? { sensitive: true } : {}),
    ...(node.frameId ? { frameId: node.frameId } : {}),
  };
}

function headingLines(headings = [], budget = 0) {
  const lines = [];
  let used = 0;
  let previous = '';
  for (const heading of Array.isArray(headings) ? headings : []) {
    if (lines.length >= HEADINGS_MAX_COUNT) break;
    const name = redactedLine(heading?.name, HEADING_MAX_CHARS);
    if (!name || name === previous) continue;
    const line = `## ${name}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    previous = name;
  }
  return lines;
}

// Page text without lines the element and heading lists already carry.
function excerptText(text = '', skip = new Set(), budget = 0, lineLimit = EXCERPT_LINE_MAX_CHARS) {
  if (budget < 40) return { text: '', cut: Boolean(compact(text, 1)) };
  const lines = redactSensitiveText(String(text || ''))
    .split(/\r?\n/)
    .map((line) => compact(line, lineLimit))
    .filter((line) => line && !skip.has(line.toLowerCase()));
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) {
      const room = budget - used - 1;
      if (room >= 40) kept.push(`${line.slice(0, room - 1)}…`);
      return { text: kept.join('\n'), cut: true };
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { text: kept.join('\n'), cut: false };
}

/**
 * Renders the compact, model-facing view of a page snapshot:
 *   [@e12] button "Add to cart" (disabled)
 *   ## Heading
 *   short page-text excerpt
 * Everything is redacted here, so every caller (action results, browser_snapshot,
 * turn context) gets the same privacy guarantees. `snapshot` carries the minted
 * `refs` (with state flags), `headings`, raw page `text`, and `element_count`.
 * Returns the model-visible `{ text, refs, truncated, element_count }`, where
 * `refs` lists only the elements that made it into the text.
 */
export function renderControlSnapshot(snapshot = {}, { maxChars = SNAPSHOT_VIEW_BUDGETS.postAction, fullText = false } = {}) {
  const limit = Math.max(MIN_VIEW_CHARS, Math.floor(Number(maxChars)) || SNAPSHOT_VIEW_BUDGETS.postAction);
  const nodes = Array.isArray(snapshot?.refs) ? snapshot.refs : [];
  const elementCount = Math.max(nodes.length, Math.floor(Number(snapshot?.element_count)) || 0);
  const sectionReserve = Math.min(SECTION_RESERVE_MAX, Math.floor(limit * SECTION_RESERVE_FRACTION));
  const elementBudget = limit - sectionReserve - HINT_RESERVE_CHARS;

  // The page's own elements are listed first, then those inside child frames. When there are child-frame
  // elements, part of the list is held back for them, so a long page cannot push a live chat's composer out
  // of the view the model reads first.
  const own = nodes.filter((node) => !node.frameId);
  const framed = nodes.filter((node) => node.frameId);
  const framedLines = framed.map(elementLine);
  const framedWanted = framedLines.reduce((sum, line) => sum + line.length + 1, 0);
  const framedReserve = Math.min(framedWanted, Math.floor(elementBudget * FRAME_ELEMENT_SHARE));

  const shown = [];
  const refs = [];
  let used = 0;
  const list = (node, line, budget) => {
    if (used + line.length + 1 > budget) return false;
    shown.push(line);
    refs.push(safeRef(node, node.sensitive === true ? 'Sensitive field' : redactedLine(node.name, NAME_MAX_CHARS)));
    used += line.length + 1;
    return true;
  };
  for (const node of own) {
    if (!list(node, elementLine(node), elementBudget - framedReserve)) break;
  }
  for (const [index, node] of framed.entries()) {
    if (!list(node, framedLines[index], elementBudget)) break;
  }
  const omitted = elementCount - shown.length;
  const hint = omitted > 0
    ? `… ${omitted} more element${omitted === 1 ? '' : 's'} — ${fullText ? 'scroll to reveal more' : `scroll or call ${controlToolName('browser_snapshot')} with full=true`}`
    : '';
  const elementBlock = shown.length
    ? [...shown, ...(hint ? [hint] : [])].join('\n')
    : (hint || '(no interactive elements)');

  const remaining = Math.max(0, limit - elementBlock.length - 4);
  const headingBudget = Math.min(HEADINGS_MAX_CHARS, Math.floor(remaining * HEADINGS_FRACTION));
  const headings = headingLines(snapshot?.headings, headingBudget);
  const headingChars = headings.reduce((sum, line) => sum + line.length + 1, 0);
  const skip = new Set([
    ...refs.map((node) => node.name.toLowerCase()),
    ...headings.map((line) => line.slice(3).toLowerCase()),
  ]);
  const excerptBudget = fullText
    ? remaining - headingChars
    : Math.min(remaining - headingChars, Math.max(MIN_VIEW_CHARS, Math.floor(limit * EXCERPT_FRACTION)));
  const lineLimit = fullText ? FULL_EXCERPT_LINE_MAX_CHARS : EXCERPT_LINE_MAX_CHARS;
  // Text of child frames (a live chat's messages) is read after the page's own, under its own heading, with a
  // share of the excerpt held back for it so a long page cannot leave it no room.
  const frameSource = typeof snapshot?.frameText === 'string' ? snapshot.frameText : '';
  const frameLength = frameSource ? compact(frameSource, excerptBudget + 1).length : 0;
  const frameReserve = frameSource ? Math.min(frameLength + FRAME_SECTION_OVERHEAD, Math.floor(excerptBudget * FRAME_TEXT_SHARE)) : 0;
  const excerpt = excerptText(snapshot?.text, skip, excerptBudget - frameReserve, lineLimit);
  const frameRoom = excerptBudget - excerpt.text.length - FRAME_SECTION_OVERHEAD;
  // A text that fits is shown whole, however short the room: excerptText would otherwise drop a short remainder.
  const frameExcerpt = frameSource
    ? excerptText(frameSource, skip, frameRoom >= frameLength ? Math.max(frameRoom, 40) : frameRoom, lineLimit)
    : { text: '', cut: false };

  let text = [
    elementBlock,
    headings.join('\n'),
    excerpt.text,
    frameExcerpt.text ? `${FRAME_TEXT_HEADER}\n${frameExcerpt.text}` : '',
  ].filter(Boolean).join('\n\n');
  let truncated = omitted > 0 || excerpt.cut || frameExcerpt.cut || snapshot?.truncated === true;
  if (text.length > limit) {
    text = `${text.slice(0, limit - 1)}…`;
    truncated = true;
  }
  return { text, refs, truncated, element_count: elementCount };
}
