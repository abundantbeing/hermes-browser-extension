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

// Vivid UI is an output contract the user chose, not a formatting hint. It
// rides inside every Browser turn (response_style), because the dashboard
// socket carries no system prompt and a session's stored prompt can't follow
// a later switch. The renderer still guarantees the look when a reply ignores
// it (adaptive-ui.mjs), so the words here never carry the guarantee alone.
export const VIVID_CONTRACT = [
  'Response style: Vivid UI. The user chose Vivid UI in Hermes Browser for every reply. This is an output contract, not a suggestion: follow it on this reply without being asked, and never ask whether they want cards.',
  'Compose each reply as readable Markdown prose that answers on its own, plus fenced `hermes-ui` blocks that present its substance as native cards. Every substantive reply includes at least one block. A brief conversational reply (a greeting, a yes or no, a one-line fact) may be prose only; the app still draws it in Vivid style. Pick components from the question and the evidence you actually have:',
  '- Article, blog post or web page: a `list` of key points as the summary, `key_value` for facts such as author, date and source, `comparison` when it weighs options, `actions` with open_url for the source and ask for one or two natural follow-ups.',
  '- YouTube video: takeaways as a `list` (timestamps as meta when the transcript has them), built only from the supplied transcript or page text. With no transcript, say so in a `notice` and summarize only what the page shows.',
  '- Weather: `stat` cards for current conditions and a line `chart` for the forecast, only from data a tool returned in this turn, naming the source and time. Without live data, a `notice` says so; never estimate weather.',
  '- Numbers to compare: a `table`, or a `chart` when a trend or ranking reads better drawn; `stat` for one to four headline numbers.',
  '- Steps, plans and how-tos: an ordered `list`.',
  '- Code: keep code in normal fenced code blocks with a language. Add a small `list` (what changed, how to run it) only when it helps.',
  '- Errors, missing sources, unreadable pages and failed tools: a `notice` (tone warning or error) that says exactly what failed or is missing.',
  'Fit the components to the answer: no charts or comparison cards for content that has no numbers or options, no oversized dashboards, no decorative cards or buttons.',
  'Evidence: every number, date, quote, source, weather reading, video detail and action result in a block must come from this conversation, the supplied browser context or a tool result. Never invent data to fill a component, never report an action as done unless a tool did it, and state gaps plainly.',
  'Format: a fence whose info string is exactly hermes-ui, holding one JSON object: {"schema":"hermes.adaptive-ui","version":1,"blocks":[{"id":"<unique>","type":"<type>",...props}]}. Strict JSON (double quotes, no comments, no trailing commas). No HTML, scripts or styles. Usually one fence per reply, placed after the prose it supports. Keep blocks small, and keep the key facts in the prose too.',
  'Block types:',
  '- stat: label, value, optional delta, trend (up|down|flat), caption',
  '- list: optional title, items (1-12 short texts, or objects with text and optional meta), optional ordered: true',
  '- key_value: optional title, items (each key, value)',
  '- comparison: optional title, items (2-4, each title, optional subtitle, points: short texts, optional highlight: true)',
  '- table: optional title, columns (texts), rows (lists of texts or numbers)',
  '- chart: optional title, kind (bar|line), labels (texts), series (1-4, each name, values: one number or null per label), optional unit',
  '- notice: tone (info|warning|error), title, optional body',
  '- disclosure: title, body (Markdown), for long optional detail',
  '- actions: items (each label, action: open_url|ask|copy, value: an https URL, a follow-up question, or the text to copy)',
].join('\n');

// Sent once Vivid is switched off in a conversation that already has Vivid
// replies, so the model stops imitating their blocks.
const VIVID_OFF_NOTE = 'Response style: Rich text. The user turned Vivid UI off. Reply in normal Markdown only and add no hermes-ui blocks, even though earlier replies in this conversation used them.';

const PLAIN_GUIDE = 'Response style: Plain text. Reply in plain text only, with no Markdown: no headings, bold, italics, tables, bullet symbols or code fences. Use short paragraphs and numbered lines when order matters.';

// The note appended to the Hermes Browser system prompt. Rich text sends
// nothing, so the agent behaves exactly as before; Vivid UI travels in each
// turn instead (responseStyleTurnContract).
export function responseStyleInstructions(style) {
  return normalizeResponseStyle(style) === 'plain' ? PLAIN_GUIDE : '';
}

// The response_style section of a Browser turn: the user's own setting, sent
// with every turn while Vivid UI is on. Rich text sends none unless the
// conversation already holds Vivid replies; Plain text keeps its system note.
export function responseStyleTurnContract(style, { conversationHasVivid = false } = {}) {
  const normalized = normalizeResponseStyle(style);
  if (normalized === 'vivid') return { id: 'vivid', name: 'Vivid UI', source: 'user_setting', required: true, contract: VIVID_CONTRACT };
  if (normalized === 'rich' && conversationHasVivid) return { id: 'rich', name: 'Rich text', source: 'user_setting', required: true, contract: VIVID_OFF_NOTE };
  return null;
}
