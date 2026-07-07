/**
 * Hermes Browser Extension — built-in quick command registry.
 *
 * Commands are local prompt shapers. They do not grant new browser abilities,
 * make network calls, or bypass the normal untrusted browser-context wrapper.
 *
 * @module lib/commands
 */

/**
 * @typedef {object} CommandDef
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string} description
 * @property {string} category
 * @property {string} icon
 * @property {boolean} requiresInput
 * @property {string} promptHint
 * @property {(ctx: object) => string} prompt
 */

/** @type {ReadonlyArray<Readonly<CommandDef>>} */
export const BUILTIN_COMMANDS = Object.freeze([
  {
    name: 'summarize',
    aliases: ['summary'],
    description: 'Summarize this page in a few paragraphs.',
    category: 'Page',
    icon: '📋',
    requiresInput: false,
    promptHint: 'Summarize the active page in a few clear paragraphs.',
    prompt: (ctx) => `Summarize the page "${ctx.activeTab?.title || 'active tab'}" in a few clear paragraphs. Call out the main purpose, key arguments, conclusions, and anything the reader should notice. Use plain English and keep it scannable with short paragraphs.`,
  },
  {
    name: 'tldr',
    description: 'Too Long; Didn\'t Read - 3 bullet points max.',
    category: 'Page',
    icon: '⚡',
    requiresInput: false,
    promptHint: 'TL;DR of this page in 3 bullet points.',
    prompt: (ctx) => `Give a TL;DR of the page "${ctx.activeTab?.title || 'active tab'}" in at most 3 bullet points. Use plain language. No fluff.`,
  },
  {
    name: 'extract',
    description: 'Extract links, emails, code, or data from this page.',
    category: 'Page',
    icon: '🔍',
    requiresInput: true,
    promptHint: 'Extract … from this page (links, emails, code, data).',
    prompt: (ctx) => `Extract useful data from the page "${ctx.activeTab?.title || 'active tab'}". List all links in markdown format, detect any email addresses, code blocks, tables, and structured data. Present results organized by type with counts.`,
  },
  {
    name: 'translate',
    description: 'Translate this page content.',
    category: 'Page',
    icon: '🌍',
    requiresInput: true,
    promptHint: 'Translate this page to … (language).',
    prompt: (ctx) => `Translate the visible text content of the page "${ctx.activeTab?.title || 'active tab'}" into the requested language. Preserve markdown-style formatting, code blocks, and link URLs. Output only the translation.`,
  },
  {
    name: 'explain',
    description: 'Explain technical content on this page.',
    category: 'Page',
    icon: '💡',
    requiresInput: false,
    promptHint: 'Explain the technical content on this page in simple terms.',
    prompt: (ctx) => `Explain the technical content on the page "${ctx.activeTab?.title || 'active tab'}" in simple terms. Break down the key concepts, jargon, and architecture. If there is code, explain what it does and why it matters. Assume the reader is familiar with general programming but not the specific domain.`,
  },
  {
    name: 'rewrite',
    description: 'Rewrite selected or visible page text in the requested style.',
    category: 'Page',
    icon: '✎',
    requiresInput: true,
    promptHint: 'Rewrite this page/selection as … (tone, format, audience).',
    prompt: (ctx) => `Rewrite the relevant content from the page "${ctx.activeTab?.title || 'active tab'}" according to the user's requested style, format, or audience. Prefer selected text when present. Preserve important facts, names, links, code, and numbers unless the user explicitly asks to change them. Return only the rewritten content plus a short note if assumptions were needed.`,
  },
  {
    name: 'tabs',
    description: 'List all open tabs with their titles and URLs.',
    category: 'Tabs',
    icon: '📑',
    requiresInput: false,
    promptHint: 'List every open tab with title, URL and a short description.',
    prompt: (ctx) => `List every open tab in the current window. For each tab give the title, URL, and a one-line description of what the page appears to be based on its content category. Total: ${ctx.tabs?.length || 0} tabs.`,
  },
  {
    name: 'actions',
    description: 'List interactive elements on this page.',
    category: 'Page',
    icon: '⚡',
    requiresInput: false,
    promptHint: 'List interactive elements (buttons, links, forms) on this page.',
    prompt: (ctx) => `List every interactive element visible on the page "${ctx.activeTab?.title || 'active tab'}". Group them by type (links, buttons, forms, inputs, dropdowns). For each element, describe what it does. Keep the answer ordered and scannable.`,
  },
  {
    name: 'action-items',
    aliases: ['todos', 'tasks'],
    description: 'Extract concrete action items and follow-ups from this page.',
    category: 'Page',
    icon: '☑',
    requiresInput: false,
    promptHint: 'Extract action items, owners, deadlines, and open questions.',
    prompt: (ctx) => `Extract concrete action items from the page "${ctx.activeTab?.title || 'active tab'}". List tasks, owners, deadlines, blockers, decisions, and open questions when they appear. If the page has no real action items, say that clearly and summarize the closest follow-up-worthy points.`,
  },
  {
    name: 'compare',
    description: 'Compare the active tab with other open tabs.',
    category: 'Tabs',
    icon: '⇆',
    requiresInput: false,
    promptHint: 'Compare the active tab against the other open tabs.',
    prompt: (ctx) => `Compare the active tab "${ctx.activeTab?.title || 'active tab'}" with the other ${(ctx.tabs?.length || 1) > 1 ? `${ctx.tabs.length - 1} open tab${ctx.tabs.length - 1 === 1 ? '' : 's'}` : 'open tabs'}. Explain how the pages relate to each other, what themes connect them, and what the user's browsing session suggests they are working on. List each tab and its relevance to the active page.`,
  },
  {
    name: 'find',
    description: 'Find information about a topic on this page.',
    category: 'Page',
    icon: '⊙',
    requiresInput: true,
    promptHint: 'Find … on this page.',
    prompt: (ctx) => `Search the page "${ctx.activeTab?.title || 'active tab'}" for the user's topic and report everything relevant. Quote specific sections. If the topic does not appear on the page, say so clearly and suggest related topics that do appear.`,
  },
  {
    name: 'meta',
    aliases: ['metadata', 'head'],
    description: 'Summarize captured page metadata and SEO signals.',
    category: 'Page',
    icon: '🏷',
    requiresInput: false,
    promptHint: 'Report captured title, description, headings, canonical/OG/JSON-LD when available.',
    prompt: (ctx) => `Analyze the browser context for captured page metadata from "${ctx.activeTab?.title || 'active tab'}".

Use only data that is actually present in the Browser context: active tab title/URL, captured page metadata, headings, visible page text, and selected text. Do not imply Hermes Browser Extension captured raw <head> HTML, Open Graph tags, Twitter Cards, JSON-LD, hreflang, canonical tags, robots meta, or favicon links unless those exact values are present in the supplied context.

Return a structured, scannable report with:

1. **Captured basics** — page title, URL/origin, meta description/language/headings if available.
2. **Structured metadata observed** — OG/Twitter/JSON-LD/canonical/hreflang/robots only when explicitly present in context.
3. **SEO/content signals** — heading structure, apparent page purpose, and any visible metadata-like content.
4. **Not captured** — clearly list important metadata classes that are unavailable from the current Browser context.
5. **Recommended next check** — what to inspect manually or with page-source/devtools if richer metadata is needed.`,
  },
]);

function normalizeCommandName(name = '') {
  return String(name || '').replace(/^\//, '').trim().toLowerCase();
}

const COMMAND_LOOKUP = Object.freeze(Object.fromEntries(
  BUILTIN_COMMANDS.flatMap((command) => [
    command.name,
    ...(Array.isArray(command.aliases) ? command.aliases : []),
  ].map((name) => [normalizeCommandName(name), command])),
));

export function getCommand(name) {
  return COMMAND_LOOKUP[normalizeCommandName(name)];
}

export function suggestCommands(input = '', limit = 6) {
  const needle = normalizeCommandName(input);
  if (!needle) return BUILTIN_COMMANDS.slice(0, limit);
  return BUILTIN_COMMANDS.filter((command) => {
    const haystack = [command.name, ...(command.aliases || []), command.description, command.category]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  }).slice(0, limit);
}

export function resolveCommandPrompt(commandName, userInput, ctx) {
  const command = getCommand(commandName);
  if (!command) return null;
  const extra = String(userInput || '').trim();
  const prompt = command.prompt(ctx);
  return {
    command,
    prompt: extra ? `${prompt}\n\nThe user added: ${extra}` : prompt,
  };
}

export function parseCommandInput(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i);
  if (!match) return null;
  const [, name, tail = ''] = match;
  const command = getCommand(name);
  if (!command) return null;
  return { command, userInput: tail.trim(), tail };
}
