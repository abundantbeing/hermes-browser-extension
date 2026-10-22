// Response presentation preferences shared by the side panel and the full tab:
// how replies are drawn (response style), where messages sit (chat layout), and
// whether the first-run setup still has to show. Pure: no storage, no DOM.

export const RESPONSE_STYLES = Object.freeze(['vivid', 'rich', 'plain']);
// Rich text is today's Markdown rendering, so anyone who never picked a style
// keeps exactly what they had. Setup preselects Vivid UI for new users.
export const RESPONSE_STYLE_DEFAULT = 'rich';
export const RESPONSE_STYLE_SETUP_DEFAULT = 'vivid';

export const MESSAGE_LAYOUTS = Object.freeze(['bubbles', 'user-bubble']);
export const MESSAGE_LAYOUT_DEFAULT = 'bubbles';

export const ONBOARDING_COMPLETED_STORAGE_KEY = 'hermesOnboardingCompleted';

export function normalizeResponseStyle(value, fallback = RESPONSE_STYLE_DEFAULT) {
  const style = String(value || '').trim().toLowerCase();
  return RESPONSE_STYLES.includes(style) ? style : fallback;
}

export function normalizeMessageLayout(value, fallback = MESSAGE_LAYOUT_DEFAULT) {
  const layout = String(value || '').trim().toLowerCase();
  return MESSAGE_LAYOUTS.includes(layout) ? layout : fallback;
}

export function responsePresentationFromSettings(settings = {}) {
  return {
    responseStyle: normalizeResponseStyle(settings?.responseStyle),
    messageLayout: normalizeMessageLayout(settings?.messageLayout),
  };
}

// Returns a settings object with only the presentation keys replaced, so a
// write never drops a key another surface saved.
export function withResponsePresentationUpdate(settings = {}, patch = {}) {
  const next = { ...(settings || {}) };
  if (Object.hasOwn(patch, 'responseStyle')) next.responseStyle = normalizeResponseStyle(patch.responseStyle);
  if (Object.hasOwn(patch, 'messageLayout')) next.messageLayout = normalizeMessageLayout(patch.messageLayout);
  return next;
}

// Setup shows once, for a new user, before the first message. Anyone who
// already used the panel (the old intro was marked seen) skips it; Settings
// can always run it again.
export function shouldShowOnboarding({ completed = false, legacyIntroSeen = false, messageCount = 0, forced = false } = {}) {
  if (forced) return true;
  return !completed && !legacyIntroSeen && Number(messageCount || 0) === 0;
}

const VIVID_GUIDE = [
  'Response style: Vivid UI. Answer in normal Markdown prose. When a structure makes the answer clearer (a few key numbers, options to compare, a dataset, facts as label and value, long optional detail), you may add one fenced block labelled `hermes-ui` holding JSON:',
  '{"schema":"hermes.adaptive-ui","version":1,"blocks":[{"id":"<unique>","type":"<type>",...props}]}',
  'Block types and props:',
  '- stat: label, value, optional delta, trend (up|down|flat), caption',
  '- comparison: optional title, items (2-4, each title, optional subtitle, points: list of short text, optional highlight: true)',
  '- key_value: optional title, items (each key, value)',
  '- table: optional title, columns (list of text), rows (list of lists of text or numbers)',
  '- chart: optional title, kind (bar|line), labels (list of text), series (1-4, each name, values: numbers matching labels), optional unit',
  '- disclosure: title, body (Markdown), for long optional detail',
  '- actions: items (each label, action: copy|open_url|ask, value: text, https URL, or a follow-up question)',
  'Rules: use only supplied or known numbers, never invent data. Put the key facts in prose too, so the answer reads as text without the block. No HTML, scripts or styles. Keep blocks small. Skip the block for short or casual replies.',
].join('\n');

const PLAIN_GUIDE = 'Response style: Plain text. Reply in plain text only, with no Markdown: no headings, bold, italics, tables, bullet symbols or code fences. Use short paragraphs and numbered lines when order matters.';

// The per-turn note appended to the Hermes Browser system prompt. Rich text
// sends nothing, so the agent behaves exactly as before.
export function responseStyleInstructions(style) {
  const normalized = normalizeResponseStyle(style);
  if (normalized === 'vivid') return VIVID_GUIDE;
  if (normalized === 'plain') return PLAIN_GUIDE;
  return '';
}
