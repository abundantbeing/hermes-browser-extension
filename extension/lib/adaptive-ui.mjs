// Hermes Adaptive UI (HAUI) v1: the Vivid UI response style.
//
// A reply stays Markdown. A model may add fenced `hermes-ui` blocks holding a
// validated JSON envelope (docs: guides/haui-v1.md); the Hermes Mobile `vivid`
// fence (A2UI v0.9 lines) is read too, for the components that map onto HAUI.
// Everything here turns text into an HTML string: no DOM, no network, nothing
// from the model ever runs. Text is escaped, URLs are checked, sizes are capped,
// and the caller sanitizes the result with DOMPurify. Anything malformed or
// unknown falls back to the original Markdown, so a reply is always readable.
//
// Ids are stable while a reply streams: a block's id is the offset of its
// fence plus the id the model gave it, and appending text never moves an
// earlier fence. Each rendered block carries a content signature so the
// streaming patcher can keep a finished block (and its local view state)
// untouched while later text arrives.

import { escapeHtml, markdownFenceBodyLine, markdownFenceRegions, redactSensitiveText, renderMarkdown } from './common.mjs';

export const HAUI_SCHEMA = 'hermes.adaptive-ui';
export const HAUI_VERSION = 1;
export const HAUI_FENCE_LANGS = Object.freeze(['hermes-ui', 'vivid']);
// Spellings models use for the same fence. A ```json fence counts only when
// its body names the HAUI schema.
const HAUI_FENCE_ALIASES = Object.freeze({ 'hermes-ui': 'hermes-ui', hermes_ui: 'hermes-ui', hermesui: 'hermes-ui', haui: 'hermes-ui', 'hermes-adaptive-ui': 'hermes-ui', vivid: 'vivid' });
const JSON_FENCE_LANGS = new Set(['json', 'jsonc', 'json5']);
const SCHEMA_MARKER = /"schema"\s*:\s*"hermes\.adaptive-ui"/;
export const HAUI_BLOCK_TYPES = Object.freeze(['stat', 'comparison', 'key_value', 'table', 'chart', 'list', 'notice', 'disclosure', 'actions']);
export const HAUI_ACTIONS = Object.freeze(['copy', 'open_url', 'ask']);
export const HAUI_LIMITS = Object.freeze({
  maxFenceBytes: 32 * 1024,
  maxBlocks: 16,
  maxDepth: 2,
  maxText: 300,
  maxLongText: 4000,
  maxItems: 12,
  maxPoints: 8,
  maxTableColumns: 8,
  maxTableRows: 50,
  maxChartSeries: 4,
  maxChartPoints: 24,
  maxActions: 6,
});

export const HAUI_DEFAULT_LABELS = Object.freeze({
  viewChart: 'Chart',
  viewTable: 'Table',
  viewAsChart: 'View as chart',
  copy: 'Copy',
  copied: 'Copied',
  building: 'Building view…',
  opensNewTab: 'Opens in a new tab',
  askHint: 'Puts this question in the message box',
  unreadable: 'Shown as text: this card could not be drawn.',
});

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const TRENDS = new Set(['up', 'down', 'flat']);
const NOTICE_TONES = new Set(['info', 'warning', 'error', 'success']);
const CHART_KINDS = Object.freeze({
  bar: 'bar', bars: 'bar', column: 'bar', columns: 'bar', histogram: 'bar',
  line: 'line', lines: 'line', trend: 'line', area: 'line', sparkline: 'line',
});

// ---------------------------------------------------------------------------
// Fence splitting. Same fence rule as renderMarkdown (markdownFenceOpening): three or
// more backticks or tildes open a fence, and a line of the same character, at least
// as long, closes it. While a reply streams, an
// open fence is unfinished; once it has settled, an open fence ran to the end
// of the reply and is read as it stands.

function adaptiveFenceLang(lang, body, closed) {
  if (HAUI_FENCE_ALIASES[lang]) return HAUI_FENCE_ALIASES[lang];
  if (closed && JSON_FENCE_LANGS.has(lang) && body.length <= HAUI_LIMITS.maxFenceBytes && SCHEMA_MARKER.test(body)) return 'hermes-ui';
  return '';
}

export function splitAdaptiveSegments(text = '', { streaming = true } = {}) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const segments = [];
  let prose = [];
  let proseStart = 0;
  const flush = () => {
    const value = prose.join('\n');
    if (value.trim()) segments.push({ kind: 'markdown', id: `m${proseStart}`, text: value });
    prose = [];
  };
  const regions = new Map(markdownFenceRegions(lines).map((region) => [region.start, region]));
  for (let index = 0; index < lines.length; index += 1) {
    const region = regions.get(index);
    if (!region) {
      if (!prose.length) proseStart = offsets[index];
      prose.push(lines[index]);
      continue;
    }
    // Only a fence at the top level can hold UI blocks. A fence a list item opened (`- ~~~~md`) is that
    // item's code, so a hermes-ui example inside it stays an example and the whole fence goes to prose.
    const opening = region.fence.owner ? null : region.fence;
    const close = region.closed ? region.end : -1;
    if (!opening) {
      if (!prose.length) proseStart = offsets[index];
      // One push per line: a spread of a long fence would pass the engine's argument limit.
      for (let next = index; next <= region.end; next += 1) prose.push(lines[next]);
      index = region.end;
      continue;
    }
    const rawLang = opening.info.split(/\s+/)[0].toLowerCase();
    const closed = close >= 0;
    const bodyLines = lines.slice(index + 1, closed ? close : lines.length);
    const lang = adaptiveFenceLang(rawLang, closed ? bodyLines.join('\n') : '', closed);
    if (lang) {
      flush();
      const end = closed ? close + 1 : lines.length;
      const complete = closed || !streaming;
      segments.push({
        kind: 'ui',
        id: `u${offsets[index]}`,
        lang,
        complete,
        // An open fence is still streaming: never expose half-written JSON.
        body: complete ? bodyLines.join('\n') : '',
        raw: lines.slice(index, end).join('\n'),
      });
      if (!closed) return segments;
      index = close;
      continue;
    }
    if (!prose.length) proseStart = offsets[index];
    const end = close < 0 ? lines.length - 1 : close;
    for (let next = index; next <= end; next += 1) prose.push(lines[next]);
    index = end;
  }
  flush();
  return segments;
}

// Copy and search see the reply as prose: structured blocks are dropped (the
// model is asked to state their facts in prose too).
export function stripAdaptiveFences(text = '') {
  return splitAdaptiveSegments(text, { streaming: false })
    .filter((segment) => segment.kind === 'markdown')
    .map((segment) => segment.text.trim())
    .join('\n\n');
}

// Whether a reply carries Vivid UI blocks: the conversation used Vivid UI.
export function containsAdaptiveBlocks(text = '') {
  return splitAdaptiveSegments(text, { streaming: false }).some((segment) => segment.kind === 'ui');
}

// ---------------------------------------------------------------------------
// Validation.

function clampText(value, max = HAUI_LIMITS.maxText) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function longText(value, max = HAUI_LIMITS.maxLongText) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return undefined;
}

// Only absolute http(s) URLs without embedded credentials can be opened.
export function safeAdaptiveUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizeStat(raw) {
  const label = clampText(raw.label, 60);
  const value = clampText(raw.value, 40);
  if (!label || !value) return { error: 'stat needs label and value' };
  const trend = TRENDS.has(String(raw.trend || '').toLowerCase()) ? String(raw.trend).toLowerCase() : '';
  return { block: { label, value, delta: clampText(raw.delta, 24), trend, caption: clampText(raw.caption, 80) } };
}

function normalizeComparison(raw) {
  if (!Array.isArray(raw.items)) return { error: 'comparison needs items' };
  const items = raw.items.slice(0, 6).filter(isPlainObject).map((item) => ({
    title: clampText(item.title, 60),
    subtitle: clampText(item.subtitle, 80),
    points: (Array.isArray(item.points) ? item.points : []).slice(0, HAUI_LIMITS.maxPoints).map((point) => clampText(point, 160)).filter(Boolean),
    highlight: item.highlight === true,
  })).filter((item) => item.title);
  if (items.length < 2) return { error: 'comparison needs at least two titled items' };
  return { block: { title: clampText(raw.title, 80), items } };
}

function normalizeKeyValue(raw) {
  if (!Array.isArray(raw.items)) return { error: 'key_value needs items' };
  const items = raw.items.slice(0, 20).filter(isPlainObject)
    .map((item) => ({ key: clampText(item.key ?? item.label, 60), value: clampText(item.value, 200) }))
    .filter((item) => item.key && item.value);
  if (!items.length) return { error: 'key_value needs key and value items' };
  return { block: { title: clampText(raw.title, 80), items } };
}

function normalizeTable(raw) {
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return { error: 'table needs columns and rows' };
  const columns = raw.columns.slice(0, HAUI_LIMITS.maxTableColumns).map((column) => clampText(isPlainObject(column) ? column.label : column, 60));
  if (!columns.length || columns.some((column) => !column)) return { error: 'table columns must be text' };
  const rows = raw.rows.slice(0, HAUI_LIMITS.maxTableRows).filter(Array.isArray)
    .map((row) => columns.map((_column, index) => clampText(row[index] ?? '', 160)));
  if (!rows.length) return { error: 'table needs rows' };
  return { block: { title: clampText(raw.title, 80), columns, rows } };
}

function normalizeChart(raw) {
  const kind = CHART_KINDS[String(raw.kind || '').toLowerCase()];
  if (!kind) return { error: 'chart kind must be bar or line' };
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.series)) return { error: 'chart needs labels and series' };
  const labels = raw.labels.map((label) => clampText(label, 40));
  if (labels.length < 1 || labels.length > HAUI_LIMITS.maxChartPoints || labels.some((label) => !label)) return { error: 'chart labels must be 1-24 texts' };
  if (raw.series.length < 1 || raw.series.length > HAUI_LIMITS.maxChartSeries) return { error: 'chart needs 1-4 series' };
  const series = [];
  for (const entry of raw.series) {
    if (!isPlainObject(entry) || !Array.isArray(entry.values) || entry.values.length !== labels.length) return { error: 'every series needs one value per label' };
    const values = entry.values.map(finiteOrNull);
    if (values.some((value) => value === undefined)) return { error: 'chart values must be numbers' };
    if (values.every((value) => value === null)) return { error: 'chart series has no numbers' };
    series.push({ name: clampText(entry.name, 40), values });
  }
  return { block: { title: clampText(raw.title, 80), kind, labels, series, unit: clampText(raw.unit, 12) } };
}

function normalizeList(raw) {
  if (!Array.isArray(raw.items)) return { error: 'list needs items' };
  const items = raw.items.slice(0, HAUI_LIMITS.maxItems)
    .map((item) => (isPlainObject(item)
      ? { text: clampText(item.text ?? item.title ?? item.label, 240), meta: clampText(item.meta ?? item.time ?? item.timestamp, 24) }
      : { text: clampText(item, 240), meta: '' }))
    .filter((item) => item.text);
  if (!items.length) return { error: 'list needs text items' };
  return { block: { title: clampText(raw.title, 80), ordered: raw.ordered === true, items } };
}

function normalizeNotice(raw) {
  const title = clampText(raw.title, 120);
  const body = clampText(raw.body ?? raw.text, 600);
  if (!title && !body) return { error: 'notice needs title or body' };
  const tone = NOTICE_TONES.has(String(raw.tone || '').toLowerCase()) ? String(raw.tone).toLowerCase() : 'info';
  return { block: { tone, title: title || body, body: title ? body : '' } };
}

function normalizeActions(raw) {
  if (!Array.isArray(raw.items)) return { error: 'actions needs items' };
  const items = [];
  // Bounded input; the cap counts usable actions so a bad one does not hide a good one.
  for (const item of raw.items.slice(0, HAUI_LIMITS.maxActions * 4)) {
    if (items.length >= HAUI_LIMITS.maxActions) break;
    if (!isPlainObject(item)) continue;
    const label = clampText(item.label, 40);
    const action = String(item.action || '').toLowerCase();
    if (!label || !HAUI_ACTIONS.includes(action)) continue;
    if (action === 'open_url') {
      const url = safeAdaptiveUrl(item.value ?? item.url);
      if (url) items.push({ label, action, value: url });
    } else if (action === 'copy') {
      const value = longText(item.value);
      if (value) items.push({ label, action, value });
    } else {
      const value = clampText(item.value, 500);
      if (value) items.push({ label, action, value });
    }
  }
  if (!items.length) return { error: 'actions has no supported items' };
  return { block: { items } };
}

const NORMALIZERS = {
  stat: normalizeStat,
  comparison: normalizeComparison,
  key_value: normalizeKeyValue,
  table: normalizeTable,
  chart: normalizeChart,
  list: normalizeList,
  notice: normalizeNotice,
  actions: normalizeActions,
};

function normalizeBlocks(rawBlocks, { depth = 1, errors, seen }) {
  const out = [];
  for (const [index, raw] of rawBlocks.slice(0, HAUI_LIMITS.maxBlocks).entries()) {
    if (!isPlainObject(raw)) { errors.push(`block ${index} is not an object`); continue; }
    const type = String(raw.type || '').toLowerCase();
    let id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : `b${index}`;
    if (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    let result;
    if (type === 'disclosure') {
      const title = clampText(raw.title, 80);
      const body = longText(raw.body);
      const nested = Array.isArray(raw.blocks) && depth < HAUI_LIMITS.maxDepth
        ? normalizeBlocks(raw.blocks, { depth: depth + 1, errors, seen })
        : [];
      if (Array.isArray(raw.blocks) && depth >= HAUI_LIMITS.maxDepth) errors.push(`block ${id} nests too deep`);
      result = title && (body || nested.length) ? { block: { title, body, blocks: nested } } : { error: 'disclosure needs title and body' };
    } else if (NORMALIZERS[type]) {
      result = NORMALIZERS[type](raw);
    } else {
      result = { error: `unknown block type '${type}'` };
    }
    if (result.block) {
      out.push({ id, type, ...result.block });
    } else {
      errors.push(`block ${id}: ${result.error}`);
      // A newer agent may send a type this build does not know; its own
      // fallback text keeps the answer readable. Without one, the block's own
      // words are shown as text rather than dropped.
      const fallback = longText(raw.fallback);
      if (fallback) out.push({ id, type: 'markdown', text: fallback });
      else {
        const lines = salvageLines(raw);
        if (lines.length) out.push({ id, type: 'salvage', lines });
      }
    }
  }
  if (rawBlocks.length > HAUI_LIMITS.maxBlocks) errors.push(`only the first ${HAUI_LIMITS.maxBlocks} blocks are shown`);
  return out;
}

export function validateAdaptiveEnvelope(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, blocks: [], errors: ['envelope must be a JSON object'] };
  if (value.schema !== undefined && value.schema !== HAUI_SCHEMA) return { ok: false, blocks: [], errors: [`schema must be ${HAUI_SCHEMA}`] };
  if (value.version !== HAUI_VERSION) return { ok: false, blocks: [], errors: [`version must be ${HAUI_VERSION}`] };
  if (!Array.isArray(value.blocks) || !value.blocks.length) return { ok: false, blocks: [], errors: ['blocks must be a non-empty array'] };
  const blocks = normalizeBlocks(value.blocks, { errors, seen: new Set() });
  // Text kept from invalid blocks rides along, but alone it isn't a valid card.
  return { ok: blocks.some((block) => block.type !== 'salvage'), blocks, errors };
}

// ---------------------------------------------------------------------------
// Hermes Mobile `vivid` fences: A2UI v0.9 lines. Components that map onto
// HAUI are kept; layout containers are walked; the rest is left to the prose.

const VIVID_MAX_NODES = 200;

// Text under a component, for Compare points. Bounded: a component is read at
// most once, three levels deep, and the result is capped, so a fence whose ids
// repeat or loop cannot fan out.
function vividText(component, byId, seen = new Set(), depth = 0) {
  if (!component || depth > 3 || seen.has(component) || seen.size >= VIVID_MAX_NODES) return '';
  seen.add(component);
  if (typeof component.text === 'string') return component.text.slice(0, 300);
  const children = Array.isArray(component.children) ? component.children.slice(0, 12) : [];
  return children.map((childId) => vividText(byId.get(childId), byId, seen, depth + 1)).filter(Boolean).join(' ').slice(0, 300);
}

export function vividToEnvelope(body = '') {
  const components = [];
  for (const line of String(body).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const message = JSON.parse(trimmed);
    const list = message?.updateComponents?.components;
    if (Array.isArray(list)) components.push(...list.filter(isPlainObject));
  }
  const byId = new Map(components.map((component) => [String(component.id || ''), component]));
  const blocks = [];
  // Each component is walked once and the walk stops after a fixed number of
  // nodes, so repeated or cyclic child ids cannot multiply the work.
  const visited = new Set();
  const visit = (component, depth) => {
    if (!component || depth > 6 || blocks.length >= HAUI_LIMITS.maxBlocks) return;
    if (visited.has(component) || visited.size >= VIVID_MAX_NODES) return;
    visited.add(component);
    const id = String(component.id || `v${blocks.length}`);
    const name = String(component.component || '');
    if (name === 'Stat') blocks.push({ id, type: 'stat', label: component.label, value: component.value });
    else if (name === 'Table') {
      const columns = Array.isArray(component.columns) ? component.columns.map((column) => (isPlainObject(column) ? column.label || column.key : column)) : [];
      const keys = Array.isArray(component.columns) ? component.columns.map((column) => (isPlainObject(column) ? column.key || column.label : column)) : [];
      const rows = (Array.isArray(component.rows) ? component.rows : []).map((row) => (Array.isArray(row) ? row : keys.map((key) => row?.[key])));
      blocks.push({ id, type: 'table', columns, rows });
    } else if (name === 'Chart') {
      const series = Array.isArray(component.series) ? component.series : [];
      const labels = Array.isArray(component.labels) ? component.labels
        : (Array.isArray(series[0]?.data) ? series[0].data.map((point) => point?.label ?? point?.x) : []);
      blocks.push({
        id, type: 'chart', kind: component.kind, labels,
        series: series.map((entry) => ({
          name: entry?.name,
          values: Array.isArray(entry?.values) ? entry.values : (Array.isArray(entry?.data) ? entry.data.map((point) => (isPlainObject(point) ? point.value ?? point.y : point)) : []),
        })),
      });
    } else if (name === 'Compare') {
      const items = (Array.isArray(component.items) ? component.items : []).map((item) => ({
        title: item?.title,
        points: (Array.isArray(item?.children) ? item.children.slice(0, HAUI_LIMITS.maxPoints) : []).map((childId) => vividText(byId.get(childId), byId)).filter(Boolean),
      }));
      blocks.push({ id, type: 'comparison', items });
      return;
    } else if (name === 'Link') blocks.push({ id, type: 'actions', items: [{ label: component.title || component.url, action: 'open_url', value: component.url }] });
    else if (name === 'Choices') {
      const options = Array.isArray(component.options) ? component.options : [];
      blocks.push({ id, type: 'actions', items: options.map((option) => ({ label: option, action: 'ask', value: option })) });
    }
    for (const childId of Array.isArray(component.children) ? component.children : []) visit(byId.get(childId), depth + 1);
  };
  visit(byId.get('root'), 1);
  return { schema: HAUI_SCHEMA, version: HAUI_VERSION, blocks };
}

// Human words inside a block or envelope, in order, for the text fallback.
// Bounded: at most 40 lines from four levels.
// A cut-off fence can end on a key with no colon after it.
const HAUI_PROP_NAMES = new Set(['schema', 'version', 'blocks', 'id', 'type', 'label', 'value', 'title', 'items', 'points', 'columns', 'rows', 'labels', 'series', 'values', 'body', 'text', 'meta', 'caption', 'delta']);
const SALVAGE_SKIP_KEYS = new Set(['schema', 'version', 'id', 'type', 'kind', 'action', 'tone', 'trend', 'ordered', 'highlight', 'unit']);

function salvageLines(value, lines = [], depth = 0, key = '') {
  if (lines.length >= 40 || depth > 4 || SALVAGE_SKIP_KEYS.has(key)) return lines;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
    const text = clampText(value, 240);
    if (text) lines.push(text);
  } else if (Array.isArray(value)) {
    if (value.length && value.every((entry) => typeof entry === 'number' || entry === null)) {
      lines.push(value.map((entry) => (entry === null ? '–' : formatNumber(entry))).join(', '));
    } else {
      for (const entry of value.slice(0, 24)) salvageLines(entry, lines, depth + 1);
    }
  } else if (isPlainObject(value)) {
    const name = ['label', 'key', 'title', 'name'].map((field) => value[field]).find((entry) => typeof entry === 'string' && entry.trim());
    if (name && (typeof value.value === 'string' || typeof value.value === 'number')) {
      lines.push(`${clampText(name, 80)}: ${clampText(value.value, 160)}`);
      return lines;
    }
    for (const [field, entry] of Object.entries(value).slice(0, 24)) salvageLines(entry, lines, depth + 1, field);
  }
  return lines;
}

// When the JSON can't be read at all, its string values still carry the
// card's words. Keys and the values of enum-like keys are skipped.
function salvageFromBrokenJson(source) {
  const lines = [];
  const pattern = /"((?:[^"\\\n]|\\.){0,600})"(\s*:)?/g;
  let previousKey = '';
  let match;
  while ((match = pattern.exec(source)) && lines.length < 40) {
    let text = match[1];
    try { text = JSON.parse(`"${text}"`); } catch { /* keep the raw spelling */ }
    if (match[2]) { previousKey = text; continue; }
    if (!SALVAGE_SKIP_KEYS.has(previousKey) && !HAUI_PROP_NAMES.has(text)) {
      const clean = clampText(text, 240);
      if (clean) lines.push(clean);
    }
    previousKey = '';
  }
  return lines;
}

// Small, common slips are repaired before giving up: curly quotes, trailing
// commas, a bare block list or block, and a missing or quoted version.
function repairedEnvelope(source) {
  const attempts = [source, source.replace(/[\u201c\u201d]/g, '"').replace(/,(\s*[}\]])/g, '$1')];
  for (const attempt of attempts) {
    let value;
    try { value = JSON.parse(attempt); } catch { continue; }
    if (Array.isArray(value)) return { schema: HAUI_SCHEMA, version: HAUI_VERSION, blocks: value };
    if (isPlainObject(value) && !Array.isArray(value.blocks) && typeof value.type === 'string') return { schema: HAUI_SCHEMA, version: HAUI_VERSION, blocks: [value] };
    if (isPlainObject(value) && Array.isArray(value.blocks) && (value.version === undefined || value.version === '1')) return { ...value, version: HAUI_VERSION };
    return value;
  }
  return undefined;
}

export function parseAdaptiveFence(lang, body = '') {
  const source = String(body || '').replace(/^\uFEFF/, '');
  if (new TextEncoder().encode(source).length > HAUI_LIMITS.maxFenceBytes) {
    return { ok: false, blocks: [], errors: [`block is larger than ${HAUI_LIMITS.maxFenceBytes} bytes`], salvage: [] };
  }
  let envelope;
  try {
    envelope = lang === 'vivid' ? vividToEnvelope(source) : repairedEnvelope(source);
  } catch (error) {
    return { ok: false, blocks: [], errors: [`not valid JSON: ${error?.message || error}`], salvage: salvageFromBrokenJson(source) };
  }
  if (envelope === undefined) return { ok: false, blocks: [], errors: ['not valid JSON'], salvage: salvageFromBrokenJson(source) };
  const result = validateAdaptiveEnvelope(envelope);
  return result.ok ? result : { ...result, salvage: salvageLines(envelope) };
}

// ---------------------------------------------------------------------------
// Rendering.

function signature(value) {
  // FNV-1a over the JSON: cheap and stable across renders.
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const esc = (value) => escapeHtml(String(value ?? ''));

function parseNumber(text) {
  const cleaned = String(text ?? '').replace(/[,\s]/g, '').replace(/^[~≈]/, '').replace(/^([+-]?)[$€£¥]/, '$1').replace(/%$/, '');
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function isNumericColumn(rows, index) {
  const cells = rows.map((row) => row[index]).filter((cell) => String(cell ?? '').trim() !== '');
  return cells.length > 0 && cells.every((cell) => parseNumber(cell) !== null);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 10000) return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: abs < 10 ? 2 : 1 }).format(value);
}

// A handful of ticks is all an axis ever needs (the step is at least a quarter of the span).
const MAX_SCALE_TICKS = 12;

// null when the numbers are too large or too small to put on an axis: a bound that rounds up past the largest
// number, a span or step that is not finite, or a step of zero. The chart is then shown as its table.
function niceScale(min, max) {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  const span = high - low || Math.abs(high) || 1;
  const rough = span / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) || power * 10;
  const lower = Math.floor(low / step) * step;
  const upper = Math.ceil(high / step) * step || step;
  if (![span, step, lower, upper, upper - lower].every(Number.isFinite) || !(step > 0)) return null;
  const ticks = [];
  for (let tick = lower; tick <= upper + step / 2; tick += step) {
    if (ticks.length >= MAX_SCALE_TICKS) return null;
    ticks.push(Number(tick.toFixed(10)));
  }
  return { lower, upper, ticks };
}

const CHART_BOX = Object.freeze({ width: 320, height: 172, left: 38, right: 8, top: 10, bottom: 24 });

// '' when the numbers cannot be drawn on an axis; the caller shows the table instead.
export function renderChartSvg(chart, { title = '' } = {}) {
  const { width, height, left, right, top, bottom } = CHART_BOX;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = chart.series.flatMap((entry) => entry.values).filter((value) => value !== null);
  const scale = niceScale(Math.min(...values), Math.max(...values));
  if (!scale) return '';
  const { lower, upper, ticks } = scale;
  const y = (value) => top + plotHeight - ((value - lower) / (upper - lower || 1)) * plotHeight;
  const count = chart.labels.length;
  const slot = plotWidth / count;
  const parts = [];
  for (const tick of ticks) {
    const ty = y(tick).toFixed(1);
    parts.push(`<line class="haui-grid${tick === 0 ? ' haui-zero' : ''}" x1="${left}" x2="${width - right}" y1="${ty}" y2="${ty}"></line>`);
    parts.push(`<text class="haui-axis" x="${left - 5}" y="${ty}" text-anchor="end" dominant-baseline="middle">${esc(formatNumber(tick))}</text>`);
  }
  const every = Math.ceil(count / 8);
  chart.labels.forEach((label, index) => {
    if (index % every !== 0) return;
    const short = label.length > 9 ? `${label.slice(0, 8)}…` : label;
    parts.push(`<text class="haui-axis" x="${(left + slot * (index + 0.5)).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(short)}</text>`);
  });
  const zero = y(Math.max(lower, Math.min(0, upper)));
  if (chart.kind === 'bar') {
    const groupWidth = slot * 0.72;
    const barWidth = groupWidth / chart.series.length;
    chart.series.forEach((entry, seriesIndex) => {
      entry.values.forEach((value, index) => {
        if (value === null) return;
        const x = left + slot * index + (slot - groupWidth) / 2 + barWidth * seriesIndex;
        const top = Math.min(y(value), zero);
        const barHeight = Math.max(1, Math.abs(zero - y(value)));
        parts.push(`<rect class="haui-s${seriesIndex}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, barWidth - 1.5).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5"><title>${esc(`${entry.name ? `${entry.name} · ` : ''}${chart.labels[index]}: ${formatNumber(value)}${chart.unit ? ` ${chart.unit}` : ''}`)}</title></rect>`);
      });
    });
  } else {
    chart.series.forEach((entry, seriesIndex) => {
      let run = [];
      const runs = [];
      entry.values.forEach((value, index) => {
        if (value === null) { if (run.length) runs.push(run); run = []; return; }
        run.push([left + slot * (index + 0.5), y(value), index, value]);
      });
      if (run.length) runs.push(run);
      for (const points of runs) {
        if (points.length > 1) parts.push(`<polyline class="haui-line haui-s${seriesIndex}" points="${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}"></polyline>`);
        for (const [px, py, index, value] of points) {
          parts.push(`<circle class="haui-dot haui-s${seriesIndex}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6"><title>${esc(`${entry.name ? `${entry.name} · ` : ''}${chart.labels[index]}: ${formatNumber(value)}${chart.unit ? ` ${chart.unit}` : ''}`)}</title></circle>`);
        }
      }
    });
  }
  return `<svg class="haui-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title || chart.title || 'Chart')}" focusable="false">${parts.join('')}</svg>`;
}

function renderTableHtml({ title = '', columns, rows }) {
  const numeric = columns.map((_column, index) => isNumericColumn(rows, index));
  const head = columns.map((column, index) => `<th scope="col"${numeric[index] ? ' class="haui-num"' : ''}>${esc(column)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((cell, index) => `<td${numeric[index] ? ' class="haui-num"' : ''}>${esc(cell)}</td>`).join('')}</tr>`).join('');
  return `<div class="haui-table-scroll" role="region" tabindex="0" aria-label="${esc(title || columns.join(', '))}"><table class="haui-data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function blockAttrs(block, scope, extra = '') {
  return `data-haui-id="${esc(`${scope}:${block.id}`)}" data-haui-type="${esc(block.type)}" data-haui-sig="${signature(block)}"${extra}`;
}

function renderStatCard(block) {
  const trend = block.trend ? ` data-trend="${block.trend}"` : '';
  const arrow = block.trend === 'up' ? '▲ ' : block.trend === 'down' ? '▼ ' : '';
  return `<div class="haui-stat"${trend}><span class="haui-stat-label">${esc(block.label)}</span><span class="haui-stat-value">${esc(block.value)}</span>${block.delta ? `<span class="haui-stat-delta">${arrow}${esc(block.delta)}</span>` : ''}${block.caption ? `<span class="haui-stat-caption">${esc(block.caption)}</span>` : ''}</div>`;
}

function renderBlock(block, scope, labels) {
  const title = (text) => (text ? `<div class="haui-title">${esc(text)}</div>` : '');
  switch (block.type) {
    case 'comparison': {
      const cards = block.items.map((item) => `<section class="haui-compare-card" role="listitem"${item.highlight ? ' data-highlight="true"' : ''}><div class="haui-card-title" role="heading" aria-level="4">${esc(item.title)}</div>${item.subtitle ? `<p class="haui-sub">${esc(item.subtitle)}</p>` : ''}${item.points.length ? `<ul>${item.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>` : ''}</section>`).join('');
      return `<div class="haui-block haui-comparison" ${blockAttrs(block, scope)}>${title(block.title)}<div class="haui-compare-track" role="list" data-count="${block.items.length}">${cards}</div></div>`;
    }
    case 'key_value':
      return `<div class="haui-block haui-key-value" ${blockAttrs(block, scope)}>${title(block.title)}<dl class="haui-kv">${block.items.map((item) => `<div><dt>${esc(item.key)}</dt><dd>${esc(item.value)}</dd></div>`).join('')}</dl></div>`;
    case 'table':
      return `<div class="haui-block haui-table" ${blockAttrs(block, scope)}>${title(block.title)}${renderTableHtml(block)}</div>`;
    case 'chart': {
      const legend = block.series.length > 1
        ? `<div class="haui-legend">${block.series.map((entry, index) => `<span><i class="haui-swatch haui-s${index}"></i>${esc(entry.name || `${index + 1}`)}</span>`).join('')}</div>`
        : '';
      const columns = ['', ...block.series.map((entry, index) => entry.name || `${index + 1}`)];
      const rows = block.labels.map((label, index) => [label, ...block.series.map((entry) => (entry.values[index] === null ? '' : `${formatNumber(entry.values[index])}${block.unit ? ` ${block.unit}` : ''}`))]);
      const svg = renderChartSvg(block);
      const tableHtml = renderTableHtml({ title: block.title, columns, rows });
      const caption = block.title ? `<span class="haui-title">${esc(block.title)}</span>` : '<span></span>';
      // Numbers that cannot go on an axis are shown as the table, with nothing to toggle.
      if (!svg) return `<figure class="haui-block haui-chart" ${blockAttrs(block, scope, ' data-haui-view="table"')}><figcaption class="haui-chart-head">${caption}</figcaption><div class="haui-chart-table">${tableHtml}</div></figure>`;
      return `<figure class="haui-block haui-chart" ${blockAttrs(block, scope, ' data-haui-view="chart"')}><figcaption class="haui-chart-head">${caption}<span class="haui-view-toggle" role="group"><button type="button" data-haui-action="view" data-haui-value="chart" aria-pressed="true">${esc(labels.viewChart)}</button><button type="button" data-haui-action="view" data-haui-value="table" aria-pressed="false">${esc(labels.viewTable)}</button></span></figcaption><div class="haui-chart-canvas">${svg}</div><div class="haui-chart-table" hidden>${tableHtml}</div>${legend}</figure>`;
    }
    case 'disclosure': {
      const nested = renderBlockList(block.blocks || [], scope, labels);
      return `<details class="haui-block haui-disclosure" ${blockAttrs(block, scope)}><summary>${esc(block.title)}</summary><div class="haui-disclosure-body">${block.body ? renderMarkdown(block.body) : ''}${nested}</div></details>`;
    }
    case 'actions': {
      const items = block.items.map((item) => {
        if (item.action === 'open_url') {
          const host = new URL(item.value).host;
          return `<a class="haui-action" href="${esc(item.value)}" target="_blank" rel="noopener noreferrer" title="${esc(`${labels.opensNewTab}: ${item.value}`)}"><span class="haui-action-label">${esc(item.label)}</span><span class="haui-action-preview">${esc(host)} ↗</span></a>`;
        }
        if (item.action === 'copy') {
          // The label is the model's; the preview is the clipboard text itself,
          // so a button can never copy something other than what it shows.
          const preview = clampText(item.value, 60);
          return `<button type="button" class="haui-action haui-action-copy" data-haui-action="copy" data-haui-value="${esc(item.value)}" title="${esc(item.value.slice(0, 600))}"><span class="haui-action-label">${esc(item.label)}</span><code class="haui-action-preview">${esc(preview)}</code></button>`;
        }
        return `<button type="button" class="haui-action" data-haui-action="${item.action}" data-haui-value="${esc(item.value)}" title="${esc(labels.askHint)}"><span class="haui-action-label">${esc(item.label)}</span></button>`;
      }).join('');
      return `<div class="haui-block haui-actions" ${blockAttrs(block, scope)}>${items}</div>`;
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${item.meta ? `<span class="haui-list-meta">${esc(item.meta)}</span>` : ''}<span class="haui-list-text">${esc(item.text)}</span></li>`).join('');
      return `<div class="haui-block haui-list" ${blockAttrs(block, scope)}>${title(block.title)}<${tag} class="haui-list-items">${items}</${tag}></div>`;
    }
    case 'notice':
      return `<div class="haui-block haui-notice" ${blockAttrs(block, scope, ` data-tone="${block.tone}" role="note"`)}><div class="haui-notice-title">${esc(block.title)}</div>${block.body ? `<p class="haui-notice-body">${esc(block.body)}</p>` : ''}</div>`;
    case 'salvage':
      // A card this build could not draw: its own words, as text, never JSON.
      return `<div class="haui-block haui-salvage" ${blockAttrs(block, scope)}><p class="haui-salvage-note">${esc(labels.unreadable)}</p>${block.lines.length ? `<ul>${block.lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}</div>`;
    case 'markdown':
      return `<div class="haui-block haui-fallback" ${blockAttrs(block, scope)}>${renderMarkdown(block.text)}</div>`;
    default:
      return '';
  }
}

function renderBlockList(blocks, scope, labels) {
  const out = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].type !== 'stat') {
      out.push(renderBlock(blocks[index], scope, labels));
      continue;
    }
    // Neighbouring stats share one responsive grid of metric cards.
    const group = [];
    while (index < blocks.length && blocks[index].type === 'stat') group.push(blocks[index++]);
    index -= 1;
    out.push(`<div class="haui-block haui-stat-grid" data-haui-id="${esc(`${scope}:${group[0].id}:stats`)}" data-haui-type="stat" data-haui-sig="${signature(group)}" data-count="${group.length}">${group.map(renderStatCard).join('')}</div>`);
  }
  return out.join('');
}

export function renderAdaptiveBlocksHtml(blocks = [], { scope = 'h', labels = HAUI_DEFAULT_LABELS } = {}) {
  return renderBlockList(blocks, scope, { ...HAUI_DEFAULT_LABELS, ...labels });
}

// ---------------------------------------------------------------------------
// Deterministic presentation of plain Markdown. Only unambiguous structures
// change, and only once complete (followed by more text): a short list of
// bold-label metrics becomes metric cards; a table with a label column and
// numeric columns gains a collapsed chart of the same numbers. Prose is never
// touched and no number is ever made up.

const METRIC_LINE = /^\s{0,3}[-*+]\s+\*\*([^*\n]{1,40}?):?\*\*\s*:?\s*(.+?)\s*$/;
const METRIC_VALUE = /^([~≈]?[+-]?[$€£¥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|[KMBkmb]|bn|ms|s|x|×|pts|GB|MB|TB|USD|EUR)?)(?:\s*\(([^()]{1,40})\))?$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const TEMPORAL_LABEL = /^((19|20)\d\d([-/]\d{1,2})?|q[1-4]( ?(19|20)?\d\d)?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?( \d{2,4})?|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|(week|day|month|wk) ?\d+)$/i;

function tableCells(line = '') {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().replace(/^\*\*(.*)\*\*$/, '$1'));
}

// Pattern tests only see short lines, so model text can't make them slow.
const shortLine = (line = '', max = 160) => line.length <= max;

function metricRun(lines, start) {
  const items = [];
  let index = start;
  while (index < lines.length && shortLine(lines[index]) && METRIC_LINE.test(lines[index])) {
    const [, label, rest] = METRIC_LINE.exec(lines[index]);
    const value = METRIC_VALUE.exec(rest.trim());
    if (!value) return null;
    items.push({ label: label.trim(), value: value[1].trim(), caption: (value[2] || '').trim() });
    index += 1;
  }
  return items.length ? { items, end: index } : null;
}

// A run of `- **Label:** short text` lines that are not all numbers: facts as
// label and value. Values holding links, code or emphasis stay Markdown.
function keyValueRun(lines, start) {
  const items = [];
  let index = start;
  while (index < lines.length && shortLine(lines[index]) && METRIC_LINE.test(lines[index])) {
    const [, label, rest] = METRIC_LINE.exec(lines[index]);
    const value = rest.trim();
    if (!value || value.length > 120 || /[[\]`*]|\]\(/.test(value)) return null;
    items.push({ key: label.trim(), value });
    index += 1;
  }
  return items.length ? { items, end: index } : null;
}

// A list whose every item is just a link: the sources of an answer.
const LINK_LINE = /^\s{0,3}[-*+]\s+\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]{1,2000})\)\s*$/;

function linkRun(lines, start) {
  const items = [];
  let index = start;
  while (index < lines.length && shortLine(lines[index], 2200) && LINK_LINE.test(lines[index])) {
    const [, label, href] = LINK_LINE.exec(lines[index]);
    const url = safeAdaptiveUrl(href);
    if (!url) return null;
    items.push({ label: clampText(label, 40), action: 'open_url', value: url });
    index += 1;
  }
  return items.length ? { items, end: index } : null;
}

function chartFromTable(headerLine, rowLines) {
  const columns = tableCells(headerLine);
  const rows = rowLines.map(tableCells);
  if (columns.length < 2 || columns.length > 6 || rows.length < 3 || rows.length > HAUI_LIMITS.maxChartPoints) return null;
  if (rows.some((row) => row.length !== columns.length)) return null;
  if (isNumericColumn(rows, 0)) return null;
  const numeric = columns.map((_column, index) => index > 0 && isNumericColumn(rows, index)).map((flag, index) => (flag ? index : -1)).filter((index) => index > 0).slice(0, HAUI_LIMITS.maxChartSeries);
  if (!numeric.length) return null;
  const labels = rows.map((row) => clampText(row[0], 40));
  if (labels.some((label) => !label)) return null;
  const units = numeric.map((index) => (rows.every((row) => /%\s*$/.test(row[index])) ? '%' : ''));
  return {
    type: 'chart',
    kind: labels.every((label) => TEMPORAL_LABEL.test(label)) ? 'line' : 'bar',
    title: '',
    labels,
    series: numeric.map((index) => ({ name: clampText(columns[index], 40), values: rows.map((row) => parseNumber(row[index])) })),
    unit: units.every((unit) => unit === '%') ? '%' : '',
  };
}

export function presentMarkdownParts(text = '', { settled = false } = {}) {
  const lines = String(text).split('\n');
  const parts = [];
  let markdown = [];
  const flush = () => {
    if (markdown.join('\n').trim()) parts.push({ kind: 'markdown', text: markdown.join('\n') });
    markdown = [];
  };
  const followed = (end) => settled || lines.slice(end).some((line) => line.trim());
  // The same fence rule as splitAdaptiveSegments and renderMarkdown: a fenced block stays one piece of
  // Markdown, whatever its lines look like.
  // A fence a list item opens (`- ~~~~md`) counts too, up to its close or the end of that item.
  const regions = new Map(markdownFenceRegions(lines).map((region) => [region.start, region]));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const region = regions.get(index);
    if (region) {
      for (let next = index; next <= region.end; next += 1) markdown.push(lines[next]);
      index = region.end;
      continue;
    }
    const previousBlank = index === 0 || !lines[index - 1].trim();
    const standalone = (run) => (run.end >= lines.length || !lines[run.end].trim()) && followed(run.end);
    if (previousBlank && shortLine(line) && METRIC_LINE.test(line)) {
      const run = metricRun(lines, index);
      if (run && run.items.length >= 2 && run.items.length <= 6 && standalone(run)) {
        flush();
        parts.push({ kind: 'blocks', derived: 'metrics', blocks: run.items.map((item, offset) => ({ id: `l${index + offset}`, type: 'stat', label: clampText(item.label, 60), value: item.value, caption: item.caption, delta: '', trend: '' })) });
        index = run.end - 1;
        continue;
      }
      const facts = run ? null : keyValueRun(lines, index);
      if (facts && facts.items.length >= 3 && facts.items.length <= 12 && standalone(facts)) {
        flush();
        parts.push({ kind: 'blocks', derived: 'facts', blocks: [{ id: `k${index}`, type: 'key_value', title: '', items: facts.items.map((item) => ({ key: clampText(item.key, 60), value: clampText(item.value, 200) })) }] });
        index = facts.end - 1;
        continue;
      }
    }
    if (previousBlank && shortLine(line, 2200) && LINK_LINE.test(line)) {
      const run = linkRun(lines, index);
      if (run && run.items.length >= 2 && run.items.length <= HAUI_LIMITS.maxActions && standalone(run)) {
        flush();
        parts.push({ kind: 'blocks', derived: 'links', blocks: [{ id: `a${index}`, type: 'actions', items: run.items }] });
        index = run.end - 1;
        continue;
      }
    }
    if (line.includes('|') && shortLine(lines[index + 1] || '', 400) && TABLE_DIVIDER.test(lines[index + 1] || '')) {
      let end = index + 2;
      while (end < lines.length && lines[end].includes('|') && lines[end].trim()) end += 1;
      for (let next = index; next < end; next += 1) markdown.push(lines[next]);
      const rowLines = lines.slice(index + 2, end);
      const chart = followed(end) && rowLines.every((row) => row.trim().endsWith('|') || row.split('|').length > 2) ? chartFromTable(line, rowLines) : null;
      if (chart) {
        flush();
        parts.push({ kind: 'blocks', derived: 'table-chart', blocks: [{ id: `t${index}`, type: 'disclosure', title: '', body: '', blocks: [{ id: `t${index}c`, ...chart }] }] });
      }
      index = end - 1;
      continue;
    }
    markdown.push(line);
  }
  flush();
  return parts;
}

function renderDerived(part, scope, labels) {
  // The table stays as written; the chart is one click away.
  const html = part.derived === 'table-chart'
    ? renderBlock({ ...part.blocks[0], title: labels.viewAsChart }, scope, labels)
    : renderBlockList(part.blocks, scope, labels);
  return html.replace('class="haui-block ', 'class="haui-block haui-derived ');
}

export function renderPendingBlock(id, labels = HAUI_DEFAULT_LABELS) {
  return `<div class="haui-pending" data-haui-id="${esc(`${id}:pending`)}" role="status" aria-label="${esc(labels.building)}"><span></span><span></span><span></span></div>`;
}

// The Vivid UI renderer: Markdown with HAUI blocks and the deterministic
// presentation layer. Returns unsanitized HTML; callers run DOMPurify. Only a
// reply that is still streaming may hold an unfinished block; a settled reply
// shows every block it has, and a block that can't be drawn shows its words.
export function renderAdaptiveMarkdown(value = '', { labels = HAUI_DEFAULT_LABELS, enhance = true, streaming = false } = {}) {
  const merged = { ...HAUI_DEFAULT_LABELS, ...labels };
  const source = redactSensitiveText(String(value || ''));
  const segments = splitAdaptiveSegments(source, { streaming });
  const html = [];
  segments.forEach((segment, position) => {
    if (segment.kind === 'markdown') {
      const settled = position < segments.length - 1;
      const parts = enhance ? presentMarkdownParts(segment.text, { settled }) : [{ kind: 'markdown', text: segment.text }];
      for (const part of parts) html.push(part.kind === 'markdown' ? renderMarkdown(part.text) : renderDerived(part, segment.id, merged));
      return;
    }
    if (!segment.complete) {
      html.push(renderPendingBlock(segment.id, merged));
      return;
    }
    const parsed = parseAdaptiveFence(segment.lang, segment.body);
    html.push(parsed.ok
      ? renderAdaptiveBlocksHtml(parsed.blocks, { scope: segment.id, labels: merged })
      : renderBlock({ id: 'x', type: 'salvage', lines: parsed.salvage || [] }, segment.id, merged));
  });
  return html.join('');
}

// The code lines of a fence region, without its opening and closing lines or the indent of the list item
// that holds it.
function fenceCode(lines, region) {
  const code = [];
  const last = region.closed ? region.end - 1 : region.end;
  for (let index = region.start + 1; index <= last; index += 1) code.push(markdownFenceBodyLine(lines[index], region.fence));
  return code;
}

// Plain text: the words without Markdown formatting. Code stays in a plain
// monospace block and generated images still show, so nothing is lost.
export function markdownToPlainText(value = '') {
  const lines = stripAdaptiveFences(value).split('\n');
  const out = [];
  // The shared fence rules: ``` or ~~~, closed only by the same character at least as long; a fence a
  // list item opens ends with that item too, and its lines lose the item's indent.
  const regions = new Map(markdownFenceRegions(lines).map((region) => [region.start, region]));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const region = regions.get(index);
    if (region) {
      for (const code of fenceCode(lines, region)) out.push(code);
      index = region.end;
      continue;
    }
    if (TABLE_DIVIDER.test(line)) continue;
    let text = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1• ')
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/, '');
    if (/^\s*\|.*\|\s*$/.test(text)) text = tableCells(text).join(' · ');
    text = text
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1');
    out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function renderPlainResponse(value = '') {
  const source = redactSensitiveText(String(value || ''));
  const lines = stripAdaptiveFences(source).split('\n');
  const html = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p class="plain-response">${paragraph.map((line) => esc(markdownToPlainText(line))).join('<br>')}</p>`);
    paragraph = [];
  };
  const regions = new Map(markdownFenceRegions(lines).map((region) => [region.start, region]));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const region = regions.get(index);
    if (region) {
      flush();
      html.push(`<pre class="plain-response-code">${esc(fenceCode(lines, region).join('\n'))}</pre>`);
      index = region.end;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    // A generated image or media line keeps its own rendering.
    if (/^\s*(!\[[^\]]*\]\([^)]+\)|MEDIA:\s*\S+)\s*$/.test(line)) { flush(); html.push(renderMarkdown(line.trim())); continue; }
    if (TABLE_DIVIDER.test(line)) continue;
    paragraph.push(line);
  }
  flush();
  return html.join('');
}

// ---------------------------------------------------------------------------
// Typed action dispatcher. Only these actions exist; a link opens through its
// own validated anchor. Nothing here sends a message or touches the browser:
// "ask" only fills the composer for the user to send.

export function readAdaptiveAction(target) {
  const button = target?.closest?.('[data-haui-action]');
  if (!button) return null;
  const type = button.getAttribute('data-haui-action');
  if (!['view', 'copy', 'ask'].includes(type)) return null;
  return { type, value: button.getAttribute('data-haui-value') || '', button };
}

export function setAdaptiveChartView(figure, view) {
  if (!figure || !['chart', 'table'].includes(view)) return;
  figure.setAttribute('data-haui-view', view);
  const canvas = figure.querySelector('.haui-chart-canvas');
  const table = figure.querySelector('.haui-chart-table');
  if (canvas) canvas.hidden = view !== 'chart';
  if (table) table.hidden = view !== 'table';
  for (const toggle of figure.querySelectorAll('[data-haui-action="view"]')) {
    toggle.setAttribute('aria-pressed', String(toggle.getAttribute('data-haui-value') === view));
  }
}

export async function dispatchAdaptiveAction(action, { copyText, askHermes, labels = HAUI_DEFAULT_LABELS, setTimer = setTimeout } = {}) {
  if (!action) return false;
  if (action.type === 'view') {
    setAdaptiveChartView(action.button.closest('[data-haui-type="chart"]'), action.value);
    return true;
  }
  if (action.type === 'copy') {
    if (!copyText) return false;
    await copyText(action.value);
    const { button } = action;
    const label = button.querySelector('.haui-action-label') || button;
    const original = label.textContent;
    button.classList.add('is-copied');
    label.textContent = labels.copied || HAUI_DEFAULT_LABELS.copied;
    setTimer(() => { button.classList.remove('is-copied'); label.textContent = original; }, 1400);
    return true;
  }
  if (action.type === 'ask') {
    if (!askHermes) return false;
    askHermes(action.value);
    return true;
  }
  return false;
}
