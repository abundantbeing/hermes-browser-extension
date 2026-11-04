export const SITE_ADAPTER_SCHEMA = 'hermes.browser.site-capability.v1';
export const SITE_ADAPTER_VERSION = '2.0.0';
export const SITE_ADAPTER_ORDER = Object.freeze([
  'github',
  'x',
  'youtube',
  'reddit',
  'facebook',
  'chatgpt',
  'grok',
  'claude',
  'perplexity',
  'gmail',
  'googlecalendar',
  'googlechat',
  'protonmail',
  'linkedin',
  'slack',
  'discord',
  'teams',
  'outlook',
  'gitlab',
  'stackoverflow',
  'linear',
  'jira',
  'notion',
  'googledocs',
  'threads',
  'bluesky',
  'mastodon',
  'substack',
  'medium',
  'whatsapp',
  'telegram',
]);

const MAX_CONTEXT_CHARS = 12_000;

function bounded(value = '', max = 500) {
  const text = String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 12))} [truncated]`;
}

function textOf(node, max = 2_000) {
  return bounded(node?.innerText || node?.textContent || '', max);
}

function isVisibleElement(node) {
  if (!node || node.nodeType !== 1) return false;
  for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;
    const inlineStyle = String(current.getAttribute?.('style') || '').toLowerCase().replace(/\s+/g, '');
    if (inlineStyle.includes('display:none')
      || inlineStyle.includes('visibility:hidden')
      || inlineStyle.includes('visibility:collapse')) return false;
    const view = current.ownerDocument?.defaultView;
    if (typeof view?.getComputedStyle === 'function') {
      const computed = view.getComputedStyle(current);
      if (computed?.display === 'none'
        || computed?.visibility === 'hidden'
        || computed?.visibility === 'collapse') return false;
    }
  }
  const view = node.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle === 'function'
    && typeof node.getClientRects === 'function'
    && node.getClientRects().length === 0
    && view.getComputedStyle(node)?.display !== 'contents') return false;
  return true;
}

function visibleTextOf(node, max = 2_000) {
  return isVisibleElement(node) ? textOf(node, max) : '';
}

function safeUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function parsedUrl(value = '') {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function uniqueTexts(nodes = [], maxItems = 40, maxChars = MAX_CONTEXT_CHARS) {
  const seen = new Set();
  const parts = [];
  let size = 0;
  for (const node of Array.from(nodes || [])) {
    const text = typeof node === 'string' ? bounded(node, 4_000) : textOf(node, 4_000);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    if (size + text.length > maxChars) break;
    seen.add(key);
    parts.push(text);
    size += text.length + 1;
    if (parts.length >= maxItems) break;
  }
  return parts;
}

// Actions that write new text from the page run on an empty field: every "Draft …" action, and these, which
// answer what the page shows. The rest edit the text already in the field (tone, shorten, structure).
const PAGE_DRAFT_ACTIONS = new Set(['youtube-timestamp', 'github-diagnostics', 'gmail-asks', 'outlook-asks', 'slack-thread']);
function action(id, label, instruction) {
  const startsFromPage = /^Draft\b/.test(label) || PAGE_DRAFT_ACTIONS.has(id);
  return Object.freeze({ id, label, instruction, mode: 'draft-copy-only', startsFromPage });
}

function baseResult(adapterId, label, policy, route, capabilities, actions, context = {}) {
  return {
    schema: SITE_ADAPTER_SCHEMA,
    version: SITE_ADAPTER_VERSION,
    matched: true,
    adapterId,
    label,
    policy,
    route,
    capabilities,
    actions,
    context: {
      text: bounded(context.text || '', adapterId === 'gmail' ? Math.max(4_000, Math.min(200_000, Number(context.maxTextChars) || 30_000)) : MAX_CONTEXT_CHARS),
      title: bounded(context.title || '', 500),
      itemCount: Math.max(0, Number(context.itemCount || 0)),
      transcriptFetched: Boolean(context.transcriptFetched),
      truncated: Boolean(context.truncated),
    },
  };
}

function github(document, url) {
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  const route = match
    ? { kind: match[3].toLowerCase() === 'pull' ? 'pull-request' : 'issue', owner: match[1], repo: match[2], number: Number(match[4]) }
    : { kind: 'repository', owner: url.pathname.split('/')[1] || '', repo: url.pathname.split('/')[2] || '', number: null };
  const title = textOf(document.querySelector('[data-testid="issue-title"], .js-issue-title, h1'), 500);
  const comments = uniqueTexts(document.querySelectorAll('[data-testid="comment-body"], .js-comment-body, .markdown-body'), 30);
  const context = [title, ...comments].filter(Boolean);
  const actions = route.kind === 'pull-request'
    ? [action('summarize-pr', 'Summarize PR', 'Summarize the visible pull request.'), action('draft-review', 'Draft review', 'Draft review feedback without posting it.')]
    : [action('summarize-issue', 'Summarize issue', 'Summarize the visible issue.'), action('draft-comment', 'Draft comment', 'Draft a comment without posting it.')];
  return baseResult('github', 'GitHub', 'automatic-read-only', route, ['issue-context', 'pull-request-context'], actions, {
    title,
    text: context.join('\n\n'),
    itemCount: comments.length,
  });
}

function youtube(document, url) {
  const route = { kind: 'video', videoId: url.searchParams.get('v') || (url.hostname === 'youtu.be' ? url.pathname.slice(1) : '') };
  const title = textOf(document.querySelector('#title h1, h1#title, h1'), 500);
  const channel = textOf(document.querySelector('#channel-name, ytd-channel-name'), 300);
  const description = textOf(document.querySelector('#description, ytd-text-inline-expander'), 4_000);
  return baseResult('youtube', 'YouTube', 'automatic-read-only', route, ['video-metadata', 'youtube-transcript'], [
    action('summarize-video', 'Summarize video', 'Summarize the visible video and transcript when available.'),
    action('draft-notes', 'Draft notes', 'Draft structured notes without changing the page.'),
  ], {
    title,
    text: [title, channel && `Channel: ${channel}`, description].filter(Boolean).join('\n\n'),
    itemCount: description ? 1 : 0,
    transcriptFetched: false,
  });
}

function xAdapter(document, url) {
  const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
  const route = match ? { kind: 'status', handle: match[1], statusId: match[2] } : { kind: 'feed', handle: '' };
  const automatic = route.kind === 'status';
  const article = automatic ? document.querySelector('main article, article') : null;
  const author = textOf(article?.querySelector?.('[data-testid="User-Name"]'), 500);
  const post = textOf(article?.querySelector?.('[data-testid="tweetText"]'), 4_000);
  return baseResult('x', 'X', automatic ? 'automatic-read-only' : 'ask-first', route, ['status-context', 'thread-context'], [
    action('draft-reply', 'Draft reply', 'Draft a reply without typing or posting it.'),
    action('summarize-thread', 'Summarize thread', 'Summarize only the explicitly selected thread.'),
  ], {
    title: author,
    text: automatic ? [author, post].filter(Boolean).join('\n') : '',
    itemCount: post ? 1 : 0,
  });
}

// --- Gmail thread capture (explicit only) -----------------------------------
//
// Current Gmail keeps every message of an open thread in the DOM, including
// older messages that are collapsed behind the "N older messages" expander, so
// explicit capture selects every [data-message-id] node in document order and
// reads its rendered body even when the node is currently hidden by CSS.
// Messages whose body is not present in the DOM at all (Gmail can lazily hold
// back very long threads) are skipped rather than fabricated, and itemCount
// counts only captured messages. Compose surfaces are never read: only the
// .a3s / [role="document"] message body is walked, and form-control tags are
// skipped so draft textareas, inputs, and select values can never leak.
const GMAIL_MESSAGE_LIMIT = 60;
const GMAIL_BODY_LIMIT = 200_000;
const GMAIL_BODY_SELECTOR = '.a3s, [role="document"]';
const GMAIL_BODY_SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select',
]);

function gmailBodyText(root, max = GMAIL_BODY_LIMIT) {
  if (!root) return '';
  const parts = [];
  let size = 0;
  const visit = (node) => {
    if (!node || size >= max) return;
    if (node.nodeType === 3) {
      const text = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (text) {
        parts.push(text);
        size += text.length + 1;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (GMAIL_BODY_SKIP_TAGS.has(tag)) return;
    const editable = node.getAttribute?.('contenteditable');
    if (node !== root && (node.isContentEditable === true || editable === '' || editable === 'true')) return;
    for (const child of Array.from(node.childNodes || [])) visit(child);
  };
  visit(root);
  const text = parts.join(' ');
  return text.length > max ? `${text.slice(0, max - 13).trimEnd()} [truncated]` : bounded(text, max);
}

function gmailSubject(document) {
  const candidates = Array.from(document.querySelectorAll('[data-thread-title], h2.hP, .hP, main[role="main"] h2'));
  let collapsed = '';
  for (const node of candidates) {
    const visible = visibleTextOf(node, 500);
    if (visible) return visible;
    const text = textOf(node, 500);
    if (text && !collapsed) collapsed = text;
  }
  return collapsed;
}

function gmailMessageSender(message) {
  const node = message.querySelector('.gD, [email]');
  const sender = textOf(node, 200);
  if (sender) return sender;
  return bounded(node?.getAttribute?.('email') || '', 200);
}

function gmailMessageDate(message) {
  const node = message.querySelector('.g3');
  if (!node) return '';
  return bounded(node.getAttribute?.('title') || textOf(node, 200), 200);
}

export function isGmailThreadUrl(value = '') {
  const url = parsedUrl(value);
  if (url?.hostname !== 'mail.google.com') return false;
  const parts = url.hash.slice(1).split('?')[0].split('/');
  const [folder] = parts;
  if (!parts.at(-1) || /^p\d+$/i.test(parts.at(-1))) return false;
  if (['label', 'search', 'category'].includes(folder)) return parts.length >= 3;
  return ['inbox', 'all', 'sent', 'starred', 'imp', 'snoozed', 'trash', 'spam'].includes(folder)
    && parts.length >= 2;
}

function gmail(document, url, explicitCapture, maxTextChars = 30_000) {
  const route = { kind: isGmailThreadUrl(url.href) ? 'thread' : 'mailbox' };
  explicitCapture = explicitCapture && route.kind === 'thread';
  const title = explicitCapture ? gmailSubject(document) : '';
  const messages = [];
  const limit = Math.max(4_000, Math.min(200_000, Number(maxTextChars) || 30_000));
  let truncated = false;
  if (explicitCapture) {
    let size = title ? title.length + 2 : 0;
    const seenBodies = new Set();
    let messageNodes = Array.from(document.querySelectorAll('[data-message-id]'));
    if (!messageNodes.length) messageNodes = Array.from(document.querySelectorAll('[data-legacy-message-id], .adn'));
    // Keep the latest reply when a thread is larger than the budget, while
    // preserving chronological order for every message that fits.
    for (const message of messageNodes.reverse()) {
      const bodyNode = message.querySelector(GMAIL_BODY_SELECTOR);
      if (!bodyNode || bodyNode.isContentEditable === true || bodyNode.getAttribute?.('contenteditable') === 'true' || seenBodies.has(bodyNode)) continue;
      seenBodies.add(bodyNode);
      if (messages.length >= GMAIL_MESSAGE_LIMIT) { truncated = true; break; }
      const body = gmailBodyText(bodyNode, limit);
      if (!body) continue;
      const sender = gmailMessageSender(message);
      const date = gmailMessageDate(message);
      const label = [sender, date ? `(${date})` : ''].filter(Boolean).join(' ');
      const line = label ? `${label}: ${body}` : body;
      if (size + line.length + 2 > limit) {
        if (!messages.length || line.length > limit - (title.length + 2)) messages.unshift(`${line.slice(0, Math.max(0, limit - size - 20))} [truncated]`);
        truncated = true;
        break;
      }
      messages.unshift(line);
      if (body.endsWith(' [truncated]')) truncated = true;
      size += line.length + 2;
    }
  }
  return baseResult('gmail', 'Gmail', 'ask-first', route, ['thread-context', 'focused-draft'], [
    action('draft-reply', 'Draft reply', 'Draft a reply for preview and copy only.'),
    action('summarize-thread', 'Summarize thread', 'Summarize only after explicit capture.'),
  ], {
    title,
    text: explicitCapture && messages.length ? [title, ...messages].filter(Boolean).join('\n\n') : '',
    itemCount: messages.length,
    maxTextChars: limit,
    truncated,
  });
}

const INLINE_SITE_IDS = new Set(SITE_ADAPTER_ORDER);
const PRIVATE_INLINE_SITES = new Set([
  'facebook', 'chatgpt', 'grok', 'claude', 'perplexity', 'gmail', 'protonmail',
  'googlecalendar', 'googlechat',
  'slack', 'discord', 'teams', 'outlook', 'linear', 'jira', 'notion', 'googledocs',
  'substack', 'medium', 'whatsapp', 'telegram',
]);
const SAFE_INLINE_APPLY_SITES = new Set(['generic', 'github', 'x', 'gmail', 'gitlab', 'stackoverflow']);
const CONSERVATIVE_FALLBACK_INLINE_SITES = new Set(['whatsapp', 'telegram']);

const INLINE_SITE_LABELS = Object.freeze({
  generic: 'this site',
  github: 'GitHub',
  x: 'X',
  youtube: 'YouTube',
  reddit: 'Reddit',
  facebook: 'Facebook',
  chatgpt: 'ChatGPT',
  grok: 'Grok',
  claude: 'Claude',
  perplexity: 'Perplexity',
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googlechat: 'Google Chat',
  protonmail: 'Proton Mail',
  linkedin: 'LinkedIn',
  slack: 'Slack',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  outlook: 'Outlook',
  gitlab: 'GitLab',
  stackoverflow: 'Stack Overflow',
  linear: 'Linear',
  jira: 'Jira / Confluence',
  notion: 'Notion',
  googledocs: 'Google Docs',
  threads: 'Threads',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  substack: 'Substack',
  medium: 'Medium',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
});

// For Settings → Hermes Assist → Sites: an adapter id shows its site name, anything else its hostname.
export function inlineSiteLabel(site = '') {
  const key = String(site || '').toLowerCase();
  return key !== 'generic' && Object.hasOwn(INLINE_SITE_LABELS, key) ? INLINE_SITE_LABELS[key] : key;
}

export function inlineSiteForHost(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const adapterId = adapterIdForHost(host);
  return { adapterId, label: adapterId === 'generic' ? host : inlineSiteLabel(adapterId) };
}

// A site typed into Settings → Hermes Assist → Sites: a site Assist knows by its name ("Gmail") or any
// address of it, else any other website by its hostname. '' when it is neither.
export function inlineSiteFromInput(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const named = Object.keys(INLINE_SITE_LABELS).find((id) => id !== 'generic' && (id === raw || INLINE_SITE_LABELS[id].toLowerCase() === raw));
  if (named) return named;
  let host = '';
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
  if (!host.includes('.')) {
    const guessed = adapterIdForHost(`${host}.com`);
    return guessed === 'generic' ? '' : guessed;
  }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return '';
  const adapterId = adapterIdForHost(host);
  return adapterId === 'generic' ? host : adapterId;
}

function adapterIdForHost(host = '') {
  const normalized = String(host || '').toLowerCase();
  if (normalized === 'github.com' || normalized.endsWith('.github.com')) return 'github';
  if (normalized === 'x.com' || normalized.endsWith('.x.com') || normalized === 'twitter.com' || normalized.endsWith('.twitter.com')) return 'x';
  if (normalized === 'youtube.com' || normalized.endsWith('.youtube.com') || normalized === 'youtu.be') return 'youtube';
  if (normalized === 'reddit.com' || normalized.endsWith('.reddit.com')) return 'reddit';
  if (normalized === 'facebook.com' || normalized.endsWith('.facebook.com') || normalized === 'messenger.com' || normalized.endsWith('.messenger.com')) return 'facebook';
  if (normalized === 'chatgpt.com' || normalized.endsWith('.chatgpt.com') || normalized === 'chat.openai.com') return 'chatgpt';
  if (normalized === 'grok.com' || normalized.endsWith('.grok.com')) return 'grok';
  if (normalized === 'claude.ai' || normalized.endsWith('.claude.ai')) return 'claude';
  if (normalized === 'perplexity.ai' || normalized.endsWith('.perplexity.ai')) return 'perplexity';
  if (normalized === 'mail.google.com') return 'gmail';
  if (normalized === 'calendar.google.com') return 'googlecalendar';
  if (normalized === 'chat.google.com') return 'googlechat';
  if (normalized === 'mail.proton.me' || normalized.endsWith('.mail.proton.me') || normalized === 'protonmail.com' || normalized.endsWith('.protonmail.com')) return 'protonmail';
  if (normalized === 'linkedin.com' || normalized.endsWith('.linkedin.com')) return 'linkedin';
  if (normalized === 'app.slack.com' || normalized.endsWith('.slack.com')) return 'slack';
  if (normalized === 'discord.com' || normalized.endsWith('.discord.com')) return 'discord';
  if (normalized === 'teams.microsoft.com' || normalized.endsWith('.teams.microsoft.com') || normalized === 'teams.cloud.microsoft') return 'teams';
  if (normalized === 'outlook.office.com' || normalized === 'outlook.office365.com' || normalized === 'outlook.live.com') return 'outlook';
  if (normalized === 'gitlab.com' || normalized.endsWith('.gitlab.com')) return 'gitlab';
  if (normalized === 'stackoverflow.com' || normalized.endsWith('.stackoverflow.com') || normalized.endsWith('.stackexchange.com') || ['askubuntu.com', 'superuser.com', 'serverfault.com'].includes(normalized)) return 'stackoverflow';
  if (normalized === 'linear.app' || normalized.endsWith('.linear.app')) return 'linear';
  if (normalized === 'atlassian.net' || normalized.endsWith('.atlassian.net')) return 'jira';
  if (normalized === 'notion.so' || normalized.endsWith('.notion.so') || normalized === 'notion.site' || normalized.endsWith('.notion.site')) return 'notion';
  if (normalized === 'docs.google.com') return 'googledocs';
  if (normalized === 'threads.net' || normalized.endsWith('.threads.net')) return 'threads';
  if (normalized === 'bsky.app' || normalized.endsWith('.bsky.app')) return 'bluesky';
  if (normalized === 'mastodon.social' || normalized.endsWith('.mastodon.social')) return 'mastodon';
  if (normalized === 'substack.com' || normalized.endsWith('.substack.com')) return 'substack';
  if (normalized === 'medium.com' || normalized.endsWith('.medium.com')) return 'medium';
  if (normalized === 'web.whatsapp.com') return 'whatsapp';
  if (normalized === 'web.telegram.org') return 'telegram';
  return 'generic';
}

function targetLabel(target) {
  const labelledBy = String(target?.getAttribute?.('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => textOf(target?.ownerDocument?.getElementById?.(id), 200))
    .join(' ');
  return bounded([
    target?.getAttribute?.('aria-label'),
    target?.getAttribute?.('aria-placeholder'),
    target?.getAttribute?.('placeholder'),
    labelledBy,
    target?.getAttribute?.('name'),
    target?.id,
  ].filter(Boolean).join(' '), 500).toLowerCase();
}

function nearbyText(target, max = 1_500) {
  const containers = [
    target?.closest?.('form'),
    target?.closest?.('[role="dialog"]'),
    target?.closest?.('article'),
    target?.closest?.('shreddit-composer, ytd-commentbox'),
  ].filter(Boolean);
  if (!containers.length && target?.parentElement) containers.push(target.parentElement);
  return bounded(uniqueTexts(containers, 4, max).join(' '), max).toLowerCase();
}

function nearbyComposerIntent(target) {
  let current = target?.parentElement;
  for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
    if (current.matches?.('main, body, html')) break;
    const text = textOf(current, 4_000).toLowerCase();
    if (/replying to|post your reply/.test(text)) return 'reply';
  }
  return '';
}

function classifyInlineSurface(adapterId, url, target) {
  const path = `${url?.pathname || ''}${url?.hash || ''}`.toLowerCase();
  const label = targetLabel(target);
  const nearby = nearbyText(target);
  if (adapterId === 'github') {
    if (/\/pull\/new|\/compare\//.test(path)) return 'pull-request-description';
    if (/\/pull\/\d+\/files/.test(path) && /finish your review|approve|request changes/.test(nearby)) return 'pull-request-summary';
    if (/\/pull\/\d+\/files/.test(path)) return 'pull-request-review';
    if (/\/pull\/\d+/.test(path)) return 'pull-request-comment';
    if (/\/issues\/new/.test(path)) return /title/.test(label) ? 'issue-title' : 'issue-description';
    if (/\/issues\/\d+/.test(path)) return 'issue-comment';
    if (/\/discussions\/new/.test(path)) return 'discussion-body';
    if (/\/discussions\/\d+/.test(path)) return 'discussion-comment';
    if (/\/edit\//.test(path)) return 'markdown-editor';
    return 'repository-editor';
  }
  if (adapterId === 'x') {
    if (/\/(messages|i\/chat)(\/|$)/.test(path) && /message|send/.test(`${label} ${nearby}`)) return 'direct-message';
    const composer = target?.closest?.('form, [role="dialog"]') || target?.parentElement;
    if ((composer?.querySelectorAll?.('[data-testid^="tweetTextarea_"]')?.length || 0) > 1) return 'thread';
    if (/status\//.test(path) || /replying to|post your reply|\breply\b/.test(`${label} ${nearby}`) || nearbyComposerIntent(target) === 'reply') return 'reply';
    return 'post';
  }
  if (adapterId === 'youtube') {
    if (url?.hostname?.toLowerCase?.() === 'studio.youtube.com') {
      if (/description/.test(label)) return 'studio-description';
      if (/title/.test(label)) return 'studio-title';
      return 'studio-comment-reply';
    }
    return /reply/.test(`${label} ${nearby}`) ? 'comment-reply' : 'comment';
  }
  if (adapterId === 'reddit') {
    if (/title/.test(label)) return 'post-title';
    if (/\/submit/.test(path)) return 'post-body';
    return /reply/.test(`${label} ${nearby}`) ? 'comment-reply' : 'comment';
  }
  if (adapterId === 'facebook') {
    if (/\/messages|messenger/.test(`${url?.hostname || ''}${path}`) && /message|\baa\b/.test(label)) return 'direct-message';
    if (/what.?s on your mind|create post/.test(`${label} ${nearby}`)) return 'post';
    return /reply/.test(`${label} ${nearby}`) ? 'comment-reply' : 'comment';
  }
  if (['chatgpt', 'grok', 'claude', 'perplexity'].includes(adapterId)) return 'prompt';
  if (adapterId === 'gmail' || adapterId === 'protonmail' || adapterId === 'outlook') {
    if (/forward/.test(nearby)) return 'forward';
    if (/reply/.test(nearby) || /#(?:inbox|all|sent)\//.test(path) || /\/mail\/inbox\//.test(path)) return 'reply';
    return 'new-message';
  }
  if (adapterId === 'googlecalendar') {
    if (/title|event name/.test(label)) return 'event-title';
    if (/reply|response|message to attendees/.test(`${label} ${nearby}`)) return 'attendee-reply';
    return 'event-description';
  }
  if (adapterId === 'googlechat') {
    if (/thread|reply/.test(`${label} ${nearby}`)) return 'thread-reply';
    return /direct message|\bdm\b/.test(`${label} ${nearby}`) ? 'direct-message' : 'space-message';
  }
  if (adapterId === 'linkedin') {
    if (/\/messaging/.test(path) || /message/.test(label)) return 'direct-message';
    if (/comment|reply/.test(`${label} ${nearby}`)) return 'comment';
    return 'post';
  }
  if (adapterId === 'slack') return /thread|reply/.test(`${label} ${nearby}`) ? 'thread-reply' : 'channel-message';
  if (adapterId === 'discord') return /reply/.test(nearby) ? 'reply' : 'channel-message';
  if (adapterId === 'teams') return /meeting/.test(`${path} ${nearby}`) ? 'meeting-chat' : 'chat-message';
  if (adapterId === 'gitlab') {
    if (/merge_requests/.test(path)) return /review|suggestion/.test(`${label} ${nearby}`) ? 'merge-request-review' : 'merge-request-comment';
    if (/issues/.test(path)) return 'issue-comment';
    return 'repository-editor';
  }
  if (adapterId === 'stackoverflow') {
    if (/answer/.test(label) || /questions\//.test(path)) return 'answer';
    return /comment/.test(label) ? 'comment' : 'question';
  }
  if (adapterId === 'linear') {
    if (/description/.test(label)) return 'issue-description';
    if (/title/.test(label)) return 'issue-title';
    return 'issue-comment';
  }
  if (adapterId === 'jira') {
    if (/\/wiki\//.test(path)) return /comment/.test(label) ? 'confluence-comment' : 'confluence-page';
    if (/description/.test(label)) return 'issue-description';
    return 'issue-comment';
  }
  if (adapterId === 'notion') return /comment/.test(label) ? 'comment' : 'page-content';
  if (adapterId === 'googledocs') return /comment|suggest/.test(label) ? 'comment-or-suggestion' : 'document-content';
  if (adapterId === 'threads') {
    if (/message/.test(label)) return 'direct-message';
    return /reply/.test(`${label} ${nearby}`) ? 'reply' : 'post';
  }
  if (adapterId === 'bluesky') {
    if (/chat|message/.test(`${path} ${label}`)) return 'direct-message';
    return /reply/.test(`${label} ${nearby}`) ? 'reply' : 'post';
  }
  if (adapterId === 'mastodon') return /direct|private message/.test(`${label} ${nearby}`) ? 'direct-message' : (/reply/.test(nearby) ? 'reply' : 'post');
  if (adapterId === 'substack') {
    if (/subject/.test(label)) return 'email-subject';
    if (/comment|reply/.test(`${label} ${nearby}`)) return 'comment';
    return 'newsletter-body';
  }
  if (adapterId === 'medium') return /headline|title/.test(label) ? 'story-headline' : 'story-body';
  if (adapterId === 'whatsapp' || adapterId === 'telegram') return 'direct-message';
  return 'generic';
}

function inlineActions(adapterId, surface) {
  const actions = {
    github: surface.includes('review') || surface.includes('summary')
      ? [action('github-actionable-review', 'Draft actionable review', 'Write precise review feedback with impact and a suggested next step.'), action('github-soften-review', 'Soften review tone', 'Keep the technical concern while making the feedback constructive.'), action('github-suggestion', 'Draft suggestion block', 'Draft a GitHub suggestion without posting it.')]
      : [action('github-maintainer-reply', 'Draft maintainer reply', 'Draft a concise maintainer response.'), action('github-diagnostics', 'Ask for diagnostics', 'Request the minimum useful reproduction details.'), action('github-structure', 'Structure issue or PR', 'Organize the draft into a reviewer-friendly GitHub format.')],
    x: surface === 'reply'
      ? [action('draft-reply', 'Draft a reply', 'Draft a concise reply grounded in the visible post context.'), action('draft-post', 'Draft a post', 'Draft a concise standalone X post.'), action('x-reply-tone', 'Refine reply tone', 'Adjust the reply tone while preserving the point.'), action('x-reply-point', 'Add a useful point', 'Add one relevant supported point without inventing facts.')]
      : surface === 'thread'
        ? [action('x-draft-thread', 'Draft a thread', 'Turn the idea into a coherent X thread.'), action('draft-reply', 'Draft a reply', 'Draft a concise reply grounded in visible post context.'), action('x-thread-opener', 'Strengthen the opener', 'Make the first post clear and compelling without clickbait.'), action('x-thread-split', 'Split into posts', 'Split the draft into concise ordered posts.')]
        : surface === 'direct-message'
          ? [action('draft-message', 'Draft a message', 'Draft a concise private message.'), action('draft-reply', 'Draft a reply', 'Draft a concise response to the visible message.'), action('x-message-tone', 'Refine message tone', 'Adjust tone while preserving intent.'), action('x-message-shorten', 'Make it concise', 'Tighten the message without losing meaning.')]
          : [action('draft-post', 'Draft a post', 'Draft a concise standalone X post.'), action('draft-reply', 'Draft a reply', 'Draft a concise reply grounded in visible post context.'), action('x-post-hook', 'Strengthen the hook', 'Improve the opening without adding hype or clickbait.'), action('x-post-detail', 'Add supporting detail', 'Add one concrete supported detail without inventing facts.')],
    youtube: [action('youtube-grounded-comment', 'Draft video-grounded comment', 'Draft a useful comment grounded in the current video context.'), action('youtube-timestamp', 'Add useful timestamp', 'Reference a relevant verified transcript timestamp.'), action('youtube-creator-reply', 'Draft creator reply', 'Answer the viewer clearly and warmly.')],
    reddit: [action('reddit-constructive-reply', 'Draft constructive reply', 'Draft a useful Reddit reply that addresses the argument.'), action('reddit-tldr', 'Create TL;DR', 'Create a concise TL;DR from the draft.'), action('reddit-structure', 'Structure Reddit post', 'Improve the title and body structure without adding unsupported claims.')],
    facebook: [action('facebook-comment', surface === 'post' ? 'Draft Facebook post' : 'Draft comment or reply', 'Draft natural copy appropriate for this Facebook surface.'), action('facebook-empathy', 'Make it more empathetic', 'Adjust tone without inventing personal details.'), action('facebook-shorten', 'Make it concise', 'Tighten the message.')],
    chatgpt: [action('chatgpt-prompt', 'Improve ChatGPT prompt', 'Clarify the objective, context, constraints, and desired output.'), action('chatgpt-constraints', 'Add constraints and checks', 'Add explicit constraints, acceptance criteria, and verification.'), action('chatgpt-research-brief', 'Turn into research brief', 'Structure the prompt as a rigorous research brief.')],
    grok: [action('grok-query', 'Improve Grok query', 'Structure a concise query for Grok.'), action('grok-sources', 'Request real-time sources', 'Ask for current sources and explicit verification.'), action('grok-x-research', 'Optimize for X research', 'Frame the request for current X discussion and evidence.')],
    claude: [action('claude-brief', 'Structure Claude brief', 'Create a clear long-context brief.'), action('claude-artifact', 'Draft artifact specification', 'Define the artifact, audience, constraints, and acceptance criteria.'), action('claude-constraints', 'Add analysis rubric', 'Add a useful reasoning and evaluation rubric.')],
    perplexity: [action('perplexity-research', 'Structure research question', 'Define the question, scope, timeframe, and evidence standard.'), action('perplexity-sources', 'Require source comparison', 'Ask for primary sources and disagreement analysis.'), action('perplexity-followup', 'Draft citation follow-up', 'Write a focused follow-up that probes missing evidence.')],
    gmail: [action('gmail-reply', 'Draft email reply', 'Draft a clear email reply without sending it.'), action('gmail-asks', 'Address every ask', 'Identify and answer each request in the visible context.'), action('gmail-followup', 'Draft concise follow-up', 'Draft a polite concise follow-up.')],
    googlecalendar: [action('calendar-description', surface === 'event-title' ? 'Improve event title' : 'Draft event description', 'Draft concise event details without changing attendees or scheduling.'), action('calendar-agenda', 'Clarify agenda', 'Turn supplied notes into an agenda with outcomes and preparation.'), action('calendar-attendee-note', surface === 'attendee-reply' ? 'Draft attendee reply' : 'Draft attendee note', 'Draft a concise note for attendees without sending it.')],
    googlechat: [action('googlechat-message', 'Draft Google Chat message', 'Draft a clear private work message.'), action('googlechat-thread', 'Draft thread reply', 'Reply using only explicit context.'), action('googlechat-update', 'Structure work update', 'Turn the draft into progress, blockers, and next steps.')],
    protonmail: [action('proton-reply', 'Draft private email reply', 'Draft a clear email without making encryption claims.'), action('proton-followup', 'Draft concise follow-up', 'Draft a concise follow-up.'), action('proton-tone', 'Adjust email tone', 'Adjust tone while preserving facts and privacy.')],
    linkedin: [action('linkedin-draft', surface === 'direct-message' ? 'Draft LinkedIn message' : (surface === 'comment' ? 'Draft LinkedIn comment' : 'Draft LinkedIn post'), 'Draft professional copy appropriate for this LinkedIn surface.'), action('linkedin-hook', 'Strengthen opening hook', 'Improve the opening without adding hype.'), action('linkedin-proof', 'Add concrete proof', 'Make the point more specific and credible using only supplied facts.')],
    slack: [action('slack-message', 'Draft Slack message', 'Draft a clear channel or direct message.'), action('slack-thread', 'Summarize and reply to thread', 'Answer the visible thread concisely.'), action('slack-update', 'Structure status update', 'Turn the draft into progress, blockers, and next steps.')],
    discord: [action('discord-message', 'Draft Discord message', 'Draft a natural message for the current channel.'), action('discord-reply', 'Draft concise reply', 'Reply directly without overexplaining.'), action('discord-format', 'Format announcement', 'Structure an announcement for readability.')],
    teams: [action('teams-message', 'Draft Teams message', 'Draft a clear chat or channel message.'), action('teams-meeting', 'Draft meeting follow-up', 'Turn notes into decisions, owners, and next steps.'), action('teams-update', 'Structure work update', 'Create a concise work update.')],
    outlook: [action('outlook-reply', 'Draft email reply', 'Draft a clear Outlook reply without sending it.'), action('outlook-asks', 'Address every ask', 'Identify and answer each visible request.'), action('outlook-followup', 'Draft concise follow-up', 'Draft a polite follow-up.')],
    gitlab: [action('gitlab-review', 'Draft merge request review', 'Draft actionable review feedback.'), action('gitlab-comment', 'Draft GitLab comment', 'Draft a concise issue or merge request comment.'), action('gitlab-suggestion', 'Draft code suggestion', 'Create a focused code suggestion block.')],
    stackoverflow: [action('stackoverflow-answer', 'Draft evidence-backed answer', 'Draft a reproducible answer with code and explanation.'), action('stackoverflow-question', 'Improve question', 'Add a minimal reproduction, expected behavior, and diagnostics.'), action('stackoverflow-code', 'Explain code clearly', 'Explain the relevant code and tradeoffs without filler.')],
    linear: [action('linear-issue', 'Structure Linear issue', 'Turn the draft into problem, scope, and acceptance criteria.'), action('linear-acceptance', 'Draft acceptance criteria', 'Write testable acceptance criteria.'), action('linear-update', 'Draft project update', 'Summarize progress, blockers, and next steps.')],
    jira: [action('jira-ticket', 'Structure Jira ticket', 'Turn the draft into a clear ticket with scope and impact.'), action('jira-acceptance', 'Draft acceptance criteria', 'Write testable acceptance criteria.'), action('jira-comment', 'Draft concise comment', 'Draft a useful Jira or Confluence comment.')],
    notion: [action('notion-outline', 'Create page outline', 'Organize the page into a useful hierarchy.'), action('notion-rewrite', 'Rewrite selected section', 'Improve clarity while preserving facts.'), action('notion-summary', 'Draft decision summary', 'Capture decisions, owners, and follow-ups.')],
    googledocs: [action('docs-outline', 'Create document outline', 'Organize the document into a clear structure.'), action('docs-rewrite', 'Rewrite document section', 'Improve the section while preserving meaning.'), action('docs-comment', 'Draft review comment', 'Draft constructive document feedback.')],
    threads: [action('threads-post', surface === 'reply' ? 'Draft Threads reply' : 'Draft Threads post', 'Draft natural social copy.'), action('threads-shorter', 'Make it punchier', 'Tighten the post without forcing a hook.'), action('threads-series', 'Split into a series', 'Turn the idea into a coherent short series.')],
    bluesky: [action('bluesky-post', surface === 'reply' ? 'Draft Bluesky reply' : 'Draft Bluesky post', 'Draft concise copy for Bluesky.'), action('bluesky-shorter', 'Shorten post', 'Keep the meaning within a tighter format.'), action('bluesky-thread', 'Split into a thread', 'Create a coherent post thread.')],
    mastodon: [action('mastodon-post', surface === 'reply' ? 'Draft Mastodon reply' : 'Draft Mastodon post', 'Draft copy appropriate for the current audience.'), action('mastodon-alt', 'Draft image alt text', 'Write factual accessible alt text from supplied details.'), action('mastodon-cw', 'Draft content warning', 'Write a clear content warning when appropriate.')],
    substack: [action('substack-newsletter', 'Structure newsletter', 'Create a strong newsletter arc and readable sections.'), action('substack-subject', 'Draft subject and preview', 'Draft subject-line and preview-text options.'), action('substack-post', 'Improve Substack post', 'Improve clarity and pacing without generic filler.')],
    medium: [action('medium-story', 'Structure Medium story', 'Create a clear story arc and sections.'), action('medium-headline', 'Draft headline options', 'Write specific non-clickbait headline options.'), action('medium-section', 'Rewrite story section', 'Improve clarity, evidence, and flow.')],
    whatsapp: [action('whatsapp-message', 'Draft WhatsApp message', 'Draft a natural private message.'), action('whatsapp-reply', 'Draft concise reply', 'Reply directly using only explicit context.'), action('whatsapp-shorter', 'Make it more concise', 'Tighten the message.')],
    telegram: [action('telegram-message', 'Draft Telegram message', 'Draft a natural private or group message.'), action('telegram-reply', 'Draft concise reply', 'Reply directly using only explicit context.'), action('telegram-shorter', 'Make it more concise', 'Tighten the message.')],
    generic: [action('improve', 'Improve writing', 'Improve clarity while preserving meaning.'), action('shorten', 'Shorten', 'Make the draft more concise.')],
  };
  const selected = actions[adapterId] || actions.generic;
  if (adapterId === 'x') return selected;

  const replySurfaces = new Set([
    'reply', 'comment', 'comment-reply', 'issue-comment', 'pull-request-comment',
    'discussion-comment', 'thread-reply', 'merge-request-comment', 'confluence-comment',
    'attendee-reply', 'studio-comment-reply', 'comment-or-suggestion',
  ]);
  if (replySurfaces.has(surface)) {
    return [action('draft-reply', 'Draft a reply', 'Draft one clear reply using only the current draft and approved context.'), ...selected.slice(1)];
  }

  const messageSurfaces = new Set(['direct-message', 'channel-message', 'chat-message', 'meeting-chat', 'space-message']);
  if (messageSurfaces.has(surface)) {
    return [action('draft-message', 'Draft a message', 'Draft one clear message using only the current draft and approved context.'), ...selected.slice(1)];
  }

  if (surface === 'post' && ['facebook', 'linkedin', 'threads', 'bluesky', 'mastodon'].includes(adapterId)) {
    return [action('draft-post', 'Draft a post', 'Draft one clear post using only the current draft and approved context.'), ...selected.slice(1)];
  }
  return selected;
}

function inlineAnchor(target, adapterId) {
  if (!target) return null;
  if (adapterId === 'chatgpt') return target.closest?.('form') || target.parentElement || target;
  return target;
}

function firstMatch(root, selectors) {
  for (const selector of selectors) {
    const found = root?.querySelector?.(selector);
    if (found) return found;
  }
  return null;
}

// The nearest ancestor of the field (within a few levels) that holds every selector: the composer.
function composerAround(target, selectors, levels = 12) {
  let node = target?.parentElement || null;
  for (let depth = 0; node && depth < levels; depth += 1, node = node.parentElement) {
    if (selectors.every((selector) => node.querySelector?.(selector))) return node;
  }
  return null;
}

function laidOutBox(element) {
  const box = element?.getBoundingClientRect?.();
  return box && box.width > 0 && box.height > 0 ? box : null;
}

// A composer's own controls that are showing, the field and anything inside it left out.
function shownControls(root, target) {
  return Array.from(root?.querySelectorAll?.('button, [role="button"], a[aria-label]') || [])
    .filter((element) => element !== target && !target?.contains?.(element) && !element.contains?.(target))
    .map((element) => ({ element, box: laidOutBox(element) }))
    .filter((item) => item.box);
}

// Chat composers (ChatGPT, Claude, Perplexity, Grok, Hermes Web): just before the controls on the right of
// the composer's own row (the model or effort picker, else the microphone), so the circle covers neither
// the text nor a control. Which control that is depends on the layout (ChatGPT's effort pill widens to
// "Thinking effort", a model picker comes and goes), so it is read from where the controls are: the
// leftmost of the right-hand ones on the composer's lowest row of controls.
function trailingControlsSlot(target, { gap = 8 } = {}) {
  // The composer has a box of its own: chatgpt.com wraps the field and its controls in a display:contents
  // box, which has none, so the walk goes on to the form.
  let composer = target?.parentElement || null;
  for (let depth = 0; composer && depth < 10; depth += 1, composer = composer.parentElement) {
    if (composer === target.ownerDocument?.body) return null;
    if (laidOutBox(composer) && shownControls(composer, target).length >= 2) break;
  }
  const box = laidOutBox(composer);
  if (!box) return null;
  const controls = shownControls(composer, target);
  const middle = box.left + box.width / 2;
  const centre = (item) => item.box.top + item.box.height / 2;
  const right = controls.filter((item) => item.box.left + item.box.width / 2 > middle);
  if (!right.length) return null;
  const lowest = Math.max(...right.map(centre));
  const row = right.filter((item) => Math.abs(centre(item) - lowest) <= item.box.height / 2);
  const first = row.reduce((best, item) => (item.box.left < best.box.left ? item : best));
  // The site's own buttons share the field's box (a one-line pill), so the circle may too.
  return { element: first.element, strategy: 'before', gap, overField: true, obstacles: controls.map((item) => item.element) };
}

// Composers with a row of tools under the editor (LinkedIn's share box, a mail reply box): just after the last
// of those tools, on their row. The tools are the first row of controls below the editor that starts on its
// left. `near` (any other site) asks more of that row: two tools or more, under the editor's own width, no
// further below it than `near`, so a form's buttons further down keep the corner rule.
function toolRowEndSlot(target, { gap = 12, near = Infinity } = {}) {
  const field = laidOutBox(target);
  if (!field) return null;
  const strict = Number.isFinite(near);
  let node = target.parentElement;
  for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
    const below = shownControls(node, target).filter((item) => item.box.top >= field.bottom - 4);
    if (below.length < 2) continue;
    const top = Math.min(...below.map((item) => item.box.top));
    const row = below.filter((item) => item.box.top - top < item.box.height / 2 && item.box.left < field.left + field.width * 0.75
      && (!strict || (item.box.left >= field.left - 24 && item.box.right <= field.right + 24)));
    if (!row.length || (strict && (row.length < 2 || top - field.bottom > near))) return null;
    const last = row.reduce((best, item) => (item.box.left > best.box.left ? item : best));
    return { element: last.element, strategy: 'after', gap, obstacles: below.map((item) => item.element) };
  }
  return null;
}

// A one-line chat box on any site (a message pill with its buttons at the right end, beside the text): just
// before those buttons, as in a chat composer, so it needs no site's own names for its parts. A taller
// field, or buttons only under it, keep the other rules. Buttons past the field's edge leave the draft
// uncovered: the circle goes between, its gap narrowed to fit, or takes the corner rule where it cannot.
function chatRowSlot(target, { size = 24 } = {}) {
  const field = laidOutBox(target);
  if (!field || field.height > 64) return null;
  const slot = trailingControlsSlot(target);
  const box = laidOutBox(slot?.element);
  if (!box) return null;
  const middle = box.top + box.height / 2;
  const beside = middle > field.top - 16 && middle < field.bottom + 16
    && box.left >= field.left + field.width / 2 && box.left <= field.right + 96;
  if (!beside) return null;
  if (box.left < field.right) return slot;
  return { ...slot, overField: false, gap: Math.max(0, Math.min(slot.gap, box.left - field.right - size)) };
}

const CHAT_COMPOSER_SITES = new Set(['chatgpt', 'claude', 'perplexity', 'grok']);

// Hermes Web, the web app a Hermes gateway serves: its composer is a chat composer as well.
// The site's own controls around the field, which no placement may cover (the generic corner rule
// included): those in the nearest box above the field that has any.
function controlsAroundField(target, anchor) {
  let node = (anchor || target)?.parentElement || null;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    if (node === target?.ownerDocument?.body) break;
    const controls = Array.from(node.querySelectorAll?.('button, [role="button"], a[aria-label], select, [role="progressbar"]') || [])
      .filter((element) => element !== target && !target?.contains?.(element) && !element.contains?.(target));
    if (controls.length) return controls.slice(0, 40);
  }
  return [];
}

// The Webapp on its own origin names its tab after the open chat ("● Fix the flaky test · Hermes").
function isHermesWeb(document, url) {
  if (/^\/webapp(\/|$)/.test(url?.pathname || '')) return true;
  return /(?:^|\s·\s)Hermes(?: HUD)?$/.test(String(document?.title || '').trim()) && Boolean(document?.querySelector?.('[data-tour]'));
}

// The site slot: one of the composer's own controls that the Assist circle sits beside, so it lands in a
// row of buttons the site already has instead of on the text, the avatar or a send button. Selectors
// prefer stable attributes (data-testid, aria-label, roles, element names); when a site changes its
// markup and nothing matches, the slot is null and the content script uses the generic corner rule.
// The slots are tried in order; the first that fits takes the circle.
function inlineSlots(target, adapterId, { chatComposer = false } = {}) {
  if (!target) return [];
  const all = (root, selector) => Array.from(root?.querySelectorAll?.(selector) || []);
  if (chatComposer) {
    const slot = trailingControlsSlot(target);
    return slot ? [slot] : [];
  }
  if (adapterId === 'x') {
    // Reply, post and quote composers: the media toolbar under the editable, the account avatar beside it.
    // X nests its editor deep, so the composer is looked for well up the tree.
    const composer = composerAround(target, ['[data-testid="toolBar"]'], 30);
    const toolbar = composer?.querySelector('[data-testid="toolBar"]');
    // No post toolbar: a direct message wherever it opens (the messages drawer sits over any page). X's
    // post editor waits for its toolbar instead, which it draws a moment after focus.
    if (!toolbar) {
      const slot = target.closest?.('[data-testid^="tweetTextarea"]') ? null : chatRowSlot(target);
      return slot ? [slot] : [];
    }
    const send = all(composer, '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
    // The media buttons only: the character counter and the add-post button by Reply are not tools, and
    // the circle covers none of the toolbar's controls.
    const media = firstMatch(toolbar, ['[data-testid="ScrollSnap-List"]', 'nav[role="navigation"]', 'nav']) || toolbar;
    const tools = all(media, 'button, [role="button"]').filter((element) => !send.includes(element));
    const controls = [...all(toolbar, 'button, [role="button"], [role="progressbar"]'), ...send];
    const slots = [];
    // Centred under the avatar on the media row. The avatar is the composer's own: beside the editable,
    // at its height, not the avatar of the post being replied to.
    const field = laidOutBox(target);
    const avatar = all(composerAround(target, [X_AVATAR], 30), X_AVATAR).find((element) => {
      const box = laidOutBox(element);
      return !box || !field || (box.right <= field.left + 4 && Math.abs(box.top - field.top) < 90);
    });
    if (avatar) slots.push({ element: avatar, rowElement: toolbar, strategy: 'below-center', gap: 12, minGapBelow: 20, obstacles: controls });
    // Where the media buttons start right under the avatar (the pop-out reply), at the end of them instead:
    // the size of X's icons, on the last icon's line, one more step in their spacing.
    const shown = tools.filter((element) => laidOutBox(element) || !field);
    const lastTool = shown.at(-1);
    if (lastTool) {
      const size = X_ICON_SIZE;
      const last = laidOutBox(lastTool);
      const before = laidOutBox(shown.at(-2));
      const step = last && before ? (last.left + last.width / 2) - (before.left + before.width / 2) : 0;
      const gap = step > 0 ? Math.max(6, Math.min(24, Math.round(step - last.width / 2 - size / 2))) : 12;
      slots.push({ element: lastTool, strategy: 'after', gap, size, obstacles: controls.filter((element) => element !== lastTool) });
    }
    return slots;
  }
  const slot = inlineSlot(target, adapterId, { chatComposer, all })
    || chatRowSlot(target)
    || (adapterId === 'generic' ? toolRowEndSlot(target, { near: 40 }) : null);
  return slot ? [slot] : [];
}

const X_AVATAR = '[data-testid^="UserAvatar-Container"], img[src*="profile_images"]';
const X_ICON_SIZE = 20;

function inlineSlot(target, adapterId, { chatComposer = false, all }) {
  if (chatComposer) return trailingControlsSlot(target);
  if (adapterId === 'youtube') {
    // Comment box footer: just after the emoji button, far from Cancel and Comment.
    const box = target.closest?.('ytd-commentbox');
    const element = box?.querySelector?.('#emoji-button');
    return element ? { element, strategy: 'after', gap: 12, obstacles: all(box, '#cancel-button, #submit-button') } : null;
  }
  if (adapterId === 'gmail') {
    // Compose toolbar: just after More options (the ⋮ at the end of the writing tools), so the circle covers
    // none of them. The toolbar is the row around Send that holds More options.
    const compose = target.closest?.('[role="dialog"], .M9, form') || target.ownerDocument;
    const send = firstMatch(compose, ['[role="button"][data-tooltip^="Send"]', '[role="button"][aria-label^="Send"]']);
    const row = send ? composerAround(send, ['[role="button"][aria-label="More options"]'], 8) : null;
    const more = row?.querySelector('[role="button"][aria-label="More options"]');
    return more ? { element: more, strategy: 'after', gap: 8, obstacles: all(row, '[role="button"]').filter((element) => element !== more) } : null;
  }
  if (adapterId === 'reddit') {
    // Comment composer: just after the formatting toggle at the end of the left icon group.
    const composer = target.closest?.('shreddit-composer, comment-composer-host, faceplate-form, form');
    const element = firstMatch(composer, ['button[aria-label="Show formatting options"]', 'button[aria-label*="formatting" i]']);
    return element ? { element, strategy: 'after', gap: 12, obstacles: all(composer, 'button[type="submit"], button[slot="submit-button"], button[slot="cancel-button"]') } : null;
  }
  if (adapterId === 'linkedin') {
    // Comment pill: just before the emoji button inside it, a size smaller so it fits the pill. The site's
    // own buttons sit inside the editable's box there, so the circle may too.
    const pill = composerAround(target, ['button[aria-label*="Emoji" i]'], 8);
    const emoji = pill?.querySelector('button[aria-label*="Emoji" i]');
    const field = laidOutBox(target);
    const emojiBox = laidOutBox(emoji);
    const inPill = emoji && (!field || !emojiBox || (emojiBox.top < field.bottom + 8 && emojiBox.bottom > field.top - 8));
    if (inPill) return { element: emoji, strategy: 'before', gap: 10, size: 20, overField: true, obstacles: all(pill, 'button').filter((element) => element !== emoji) };
    // Start a post (the share box): just after the last of the tools under the editor (the + that opens
    // more of them, or the × once they are open).
    return toolRowEndSlot(target);
  }
  if (adapterId === 'github') {
    // Comment form: at the front of the Markdown toolbar. github.com stretches the toolbar box across the
    // header and lines its buttons up at the far end, so the circle goes before the first button that is
    // showing, not before the box.
    // The toolbar is found from the field: on an issue the comment box is not a form around it.
    const toolbars = ['markdown-toolbar', '[aria-label="Formatting tools"]', '[role="toolbar"]'];
    const form = composerAround(target, [toolbars.join(', ')], 12) || target.closest?.('form, .CommentBox, [class*="MarkdownEditor"]');
    const toolbar = firstMatch(form, toolbars);
    // Visibility is checked only where there is layout (the toolbar itself has a size).
    const laidOut = (toolbar?.getBoundingClientRect?.()?.width || 0) > 0;
    const shown = (element) => !laidOut || (element.getBoundingClientRect?.()?.width || 0) > 0;
    const element = Array.from(toolbar?.querySelectorAll?.('button, [role="button"]') || []).find(shown) || toolbar;
    return element ? { element, strategy: 'before', gap: 8, obstacles: [] } : null;
  }
  return null;
}

function xReplyContextRoot(target) {
  const containingArticle = target?.closest?.('article') || null;
  let ancestor = target?.parentElement || null;
  while (ancestor && ancestor !== target?.ownerDocument?.body) {
    const articles = Array.from(ancestor.querySelectorAll?.('article') || [])
      .filter((article) => article !== containingArticle && !article.contains?.(target));
    if (articles.length) {
      const comparable = typeof articles[0]?.compareDocumentPosition === 'function';
      const preceding = comparable
        ? articles.filter((article) => Boolean(article.compareDocumentPosition(target) & 4))
        : articles;
      if (preceding.length) return preceding[preceding.length - 1];
    }
    if (ancestor.matches?.('main, [role="main"]')) break;
    ancestor = ancestor.parentElement;
  }
  return containingArticle
    || target?.closest?.('[role="dialog"], main, [role="main"]')
    || target?.parentElement
    || target;
}

function contextRootFor(target, adapterId, surface = '') {
  if (!target) return null;
  if (adapterId === 'x') {
    if (surface === 'reply') return xReplyContextRoot(target);
    return target.closest?.('[role="dialog"], form') || target.parentElement;
  }
  if (PRIVATE_INLINE_SITES.has(adapterId)) {
    return target.closest?.('main, [role="main"]') || target.closest?.('[role="dialog"]') || target.parentElement;
  }
  return target.closest?.('article, [role="article"], [data-urn*="urn:li:activity"], [data-id*="urn:li:activity"], .feed-shared-update-v2, shreddit-comment, [data-message-id], ytd-comment-thread-renderer, main, [role="main"]') || target.parentElement;
}

// Where Assist reads the visible thread, per site adapter: written by the Assist panel on a page and by
// Settings → Hermes Assist → Sites.
export const INLINE_SITE_CONTEXT_STORAGE_KEY = 'hermesInlineSiteContextPreferences';

export function normalizeInlineSiteContextPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [adapterId, mode] of Object.entries(value)) {
    if (INLINE_SITE_IDS.has(adapterId) && ['draft', 'visible'].includes(mode)) normalized[adapterId] = mode;
  }
  return normalized;
}

export function inspectInlineSite(document, target, options = {}) {
  const url = parsedUrl(options.url || document?.URL || document?.baseURI || '');
  let adapterId = adapterIdForHost(url?.hostname || '');
  if (adapterId === 'generic') {
    const applicationName = bounded(document?.querySelector?.('meta[name="application-name"]')?.getAttribute?.('content') || '', 100).toLowerCase();
    if (target?.id === 'prompt-textarea' && target?.closest?.('form')) adapterId = 'chatgpt';
    else if (applicationName.includes('mastodon') || target?.matches?.('.autosuggest-textarea, .compose-form textarea')) adapterId = 'mastodon';
    else if (applicationName.includes('gitlab')) adapterId = 'gitlab';
  }
  const surface = classifyInlineSurface(adapterId, url, target);
  const preferences = normalizeInlineSiteContextPreferences(options.contextPreferences);
  const privateSurface = PRIVATE_INLINE_SITES.has(adapterId) || surface === 'direct-message';
  const defaultMode = privateSurface ? 'draft' : adapterId === 'generic' ? 'draft' : 'visible';
  const contextMode = preferences[adapterId] || defaultMode;
  // Grok and direct messages on x.com are one-line chat composers with their buttons at the end, not the
  // post composer's media toolbar.
  const chatComposer = CHAT_COMPOSER_SITES.has(adapterId)
    || (adapterId === 'generic' && isHermesWeb(document, url))
    || (adapterId === 'x' && (/^\/(i\/grok|i\/chat|messages)(\/|$)/.test(url?.pathname || '')
      || Boolean(target?.closest?.('[data-testid="DMDrawer"]'))));
  const slots = inlineSlots(target, adapterId, { chatComposer });
  const anchorElement = inlineAnchor(target, adapterId);
  const obstacleElements = adapterId === 'chatgpt'
    ? Array.from(anchorElement?.querySelectorAll?.('button, [role="button"], select') || [])
      .filter((element) => element !== target && !target?.contains?.(element))
    : controlsAroundField(target, anchorElement);
  const warning = adapterId === 'protonmail'
    ? 'Visible decrypted mail may be sent to your selected Hermes model.'
    : privateSurface
      ? `Visible ${INLINE_SITE_LABELS[adapterId]} context may be sent to your selected Hermes model.`
      : '';
  return {
    adapterId,
    label: INLINE_SITE_LABELS[adapterId] || INLINE_SITE_LABELS.generic,
    surface,
    confidence: adapterId === 'generic' ? 0.5 : 0.9,
    supportTier: CONSERVATIVE_FALLBACK_INLINE_SITES.has(adapterId) ? 'conservative-fallback' : 'dedicated',
    actions: inlineActions(adapterId, surface),
    contextMode,
    applyMode: SAFE_INLINE_APPLY_SITES.has(adapterId) ? 'safe-apply' : 'copy-only',
    contextPolicy: { defaultMode, private: privateSurface, userConfigurable: adapterId !== 'generic', warning },
    contextElement: contextRootFor(target, adapterId, surface),
    placement: {
      anchorElement,
      obstacleElements,
      // The site's own controls to sit beside, tried in order; when none fits the generic corner rule
      // applies: outside the field's bottom-right corner, else inside that corner, else just under it.
      slot: slots[0] || null,
      slots,
      preferred: ['corner-outside', 'corner-inside', 'below-end'],
    },
  };
}

function visibleContextText(root, target, max = 6_000) {
  if (!root) return '';
  const parts = [];
  let size = 0;
  const visit = (node) => {
    if (!node || size >= max || node === target) return;
    if (node.nodeType === 3) {
      const text = bounded(node.nodeValue || '', max - size);
      if (text) {
        parts.push(text);
        size += text.length + 1;
      }
      return;
    }
    if (node.nodeType !== 1 || !isVisibleElement(node)) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'input', 'textarea', 'select'].includes(tag)) return;
    if (node !== root && (node.isContentEditable || node.getAttribute?.('contenteditable') === 'true')) return;
    for (const child of Array.from(node.childNodes || [])) visit(child);
  };
  visit(root);
  return bounded(parts.join(' '), max);
}

// --- What Assist reads: the thread the field belongs to ------------------------------------------
//
// Hermes gets what the page is, what is being written, and the thread's messages, each with who wrote it
// and when. A long thread keeps the opening post, the message being answered and the newest messages, and
// says how many were left out. Sites without a reader send the text nearest the field.
export const ASSIST_CONTEXT_CHARS = 12_000;
const ASSIST_ENTRY_CHARS = 2_500;
const ASSIST_OPENING_CHARS = 3_500;
const ASSIST_BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
const ASSIST_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'input', 'textarea', 'select', 'button', 'nav', 'svg', 'iframe']);
const ASSIST_SKIP_ROLES = new Set(['navigation', 'toolbar', 'menu', 'menubar', 'tablist', 'banner', 'button', 'tooltip']);
const COUNT_LINE = /^[\d.,]+\s*[KMB]?$/i;

function readableText(node, max = ASSIST_ENTRY_CHARS, skip = null) {
  if (!node) return '';
  const parts = [];
  const visit = (current, preformatted) => {
    if (current.nodeType === 3) {
      const value = String(current.nodeValue || '').replace(/\u00a0/g, ' ');
      parts.push(preformatted ? value : value.replace(/\s+/g, ' '));
      return;
    }
    if (current.nodeType !== 1) return;
    const tag = String(current.tagName || '').toLowerCase();
    if (ASSIST_SKIP_TAGS.has(tag) || skip?.(current)) return;
    const block = ASSIST_BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    for (const child of Array.from(current.childNodes || [])) visit(child, preformatted || tag === 'pre');
    if (block) parts.push('\n');
  };
  visit(node, false);
  const text = parts.join('').split('\n').map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return text.length <= max ? text : `${text.slice(0, max - 2).trimEnd()} …`;
}

function contextTime(value = '') {
  const raw = bounded(value, 60);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Whether a node comes before the field in the page, from one pass over the page's elements.
function aboveField(document, target) {
  const position = new Map();
  Array.from(document?.querySelectorAll?.('*') || []).forEach((element, index) => position.set(element, index));
  const fieldAt = position.get(target);
  return (node) => {
    const at = position.get(node);
    if (at === undefined || fieldAt === undefined) {
      return typeof node?.compareDocumentPosition !== 'function' || Boolean(node.compareDocumentPosition(target) & 4);
    }
    return at < fieldAt && !node.contains?.(target);
  };
}

// The first selector, in the order given, with a match that has text: a selector list would return the
// first match in page order, which on real pages is often an empty twin (a miniplayer h1, an avatar link).
function firstText(root, selectors, max = 300, read = (node) => textOf(node, max)) {
  for (const selector of selectors) {
    for (const node of Array.from(root?.querySelectorAll?.(selector) || [])) {
      const text = read(node);
      if (text) return text;
    }
  }
  return '';
}

function fieldLabel(target) {
  return bounded(target?.getAttribute?.('aria-label') || target?.getAttribute?.('placeholder') || '', 120);
}

function renderContextEntry(entry, replying) {
  const who = [entry.author || 'Someone', entry.time].filter(Boolean).join(' · ');
  const notes = [entry.note, replying ? 'you are replying to this' : ''].filter(Boolean).join('; ');
  return `${who}${notes ? ` (${notes})` : ''}:\n${entry.text}`;
}

function composeAssistContext({ header = [], writing = '', notes = [], blocks = [], entries = [], replyingTo = -1 }, max = ASSIST_CONTEXT_CHARS) {
  const head = [...header, writing && `You are writing ${writing}.`, ...notes, ...blocks].filter(Boolean).join('\n\n');
  const rendered = entries.map((entry, index) => renderContextEntry(entry, index === replyingTo));
  const budget = max - head.length - 2;
  const kept = new Set();
  let used = 0;
  const keep = (index) => {
    if (index < 0 || index >= rendered.length || kept.has(index)) return true;
    const cost = rendered[index].length + 2;
    if (used + cost > budget) return false;
    kept.add(index);
    used += cost;
    return true;
  };
  keep(replyingTo);
  keep(0);
  for (let index = rendered.length - 1; index > 0; index -= 1) if (!keep(index)) break;
  const body = [];
  let skipped = 0;
  rendered.forEach((text, index) => {
    if (!kept.has(index)) { skipped += 1; return; }
    if (skipped) body.push(`[${skipped} earlier message${skipped === 1 ? '' : 's'} left out to fit]`);
    skipped = 0;
    body.push(text);
  });
  if (skipped) body.push(`[${skipped} later message${skipped === 1 ? '' : 's'} left out to fit]`);
  return [head, ...body].filter(Boolean).join('\n\n').slice(0, max);
}

const GITHUB_WRITING = {
  'issue-comment': 'a comment on this issue',
  'pull-request-comment': 'a comment on this pull request',
  'discussion-comment': 'a reply in this discussion',
  'pull-request-review': 'a review comment on the code above',
  'pull-request-summary': 'the summary of a review of this pull request',
};
const GITHUB_BODY = '.js-comment-body, [data-testid="issue-body"] [data-testid="markdown-body"], [data-testid^="comment-viewer-outer-box-"] [data-testid="markdown-body"]';
const GITHUB_COMMENT = '[data-testid^="comment-viewer-outer-box-"], [data-testid="issue-body"], .review-comment, .timeline-comment-group, .timeline-comment, .js-comment-container, .TimelineItem';

function githubCommentEntry(body) {
  const container = body.closest(GITHUB_COMMENT) || body.parentElement;
  const author = firstText(container, ['[data-testid="issue-body-header-author"]', '.author', '[data-testid="comment-header"] [data-testid="avatar-link"]', '[data-testid="comment-header"] a[href^="/"]', 'a[data-hovercard-type="user"]'], 80)
    .replace(/^(.+) \(\1\)$/, '$1');
  const time = container?.querySelector?.('relative-time[datetime], time[datetime]')?.getAttribute?.('datetime') || '';
  const opening = Boolean(container?.matches?.('[data-testid="issue-body"]'));
  return { author, time: contextTime(time), text: readableText(body, opening ? ASSIST_OPENING_CHARS : ASSIST_ENTRY_CHARS), opening, body };
}

function githubDiffLines(target) {
  const row = target.closest('tr');
  const lines = [];
  for (let current = row?.previousElementSibling; current && lines.length < 14; current = current.previousElementSibling) {
    const cell = current.querySelector?.('.blob-code-inner');
    if (!cell) continue;
    const mark = cell.matches?.('.blob-code-addition') ? '+ ' : cell.matches?.('.blob-code-deletion') ? '- ' : '  ';
    lines.unshift(`${mark}${String(cell.textContent || '').replace(/\s+$/, '')}`);
  }
  return lines;
}

function githubAssistContext(document, target, surface, url, above) {
  const writing = GITHUB_WRITING[surface];
  if (!writing) return null;
  const route = url?.pathname?.match(/^\/([^/]+)\/([^/]+)\/(issues|pull|discussions)\/(\d+)/i);
  const kind = { issues: 'issue', pull: 'pull request', discussions: 'discussion' }[route?.[3]?.toLowerCase()] || 'page';
  const title = firstText(document, ['[data-testid="issue-title"]', 'bdi.js-issue-title', '.js-issue-title', 'h1'], 300).replace(/[\s·–-]*#\s*\d+\s*$/, '');
  const state = firstText(document, ['[data-testid="header-state"]', '.gh-header-meta .State', '.State'], 40);
  const header = [`GitHub ${kind}${route ? ` #${route[4]} in ${route[1]}/${route[2]}` : ''}${state ? ` (${state})` : ''}${title ? `: ${title}` : ''}`];
  const thread = target.closest('.js-inline-comments-container, tr.inline-comments, .js-resolvable-timeline-thread-container');
  const scope = surface === 'pull-request-review' ? (thread || null) : document;
  const bodies = scope ? Array.from(scope.querySelectorAll(GITHUB_BODY)) : [];
  const entries = bodies
    .filter((body, index) => !body.closest('form') && !bodies.slice(0, index).some((other) => other.contains(body)) && above(body))
    .map(githubCommentEntry)
    .filter((entry) => entry.text);
  if (entries[0] && (entries[0].opening || kind !== 'page') && surface !== 'pull-request-review') entries[0].note = 'opening post';
  const notes = [];
  const hidden = textOf(document.querySelector('[data-testid^="issue-timeline-load-more-count"], .js-timeline-progressive-focus-container .ajax-pagination-btn, .ajax-pagination-form button'), 200).match(/([\d,]+)\s+(?:remaining|hidden)/i);
  if (hidden) notes.push(`GitHub is hiding ${hidden[1]} items in the middle of this thread; they are not included.`);
  const blocks = [];
  if (surface === 'pull-request-review') {
    const file = target.closest('[data-tagsearch-path], [data-path]');
    const filePath = file?.getAttribute?.('data-tagsearch-path') || file?.getAttribute?.('data-path') || '';
    const lines = githubDiffLines(target);
    if (lines.length) blocks.push(`${filePath ? `File ${filePath}, the` : 'The'} lines above the comment:\n${lines.join('\n')}`);
  }
  const replying = thread && entries.length ? entries.length - 1 : -1;
  return { header, writing, notes, blocks, entries, replyingTo: replying };
}

function xAuthor(article) {
  const name = article.querySelector('[data-testid="User-Name"]');
  if (!name) return '';
  const pieces = [];
  const collect = (node) => {
    if (node.nodeType === 3) {
      const text = bounded(node.nodeValue || '', 80);
      if (text) pieces.push(text);
    } else if (node.nodeType === 1 && String(node.tagName).toLowerCase() !== 'time') {
      for (const child of Array.from(node.childNodes || [])) collect(child);
    }
  };
  collect(name);
  const handle = pieces.find((piece) => /^@\w+/.test(piece)) || '';
  const display = pieces.find((piece) => piece !== handle && piece !== '·') || '';
  return [display, handle && `(${handle})`].filter(Boolean).join(' ');
}

function xPostEntry(article) {
  const texts = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
  const extras = [];
  for (const image of Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img[alt]'))) {
    const alt = bounded(image.getAttribute('alt'), 300);
    if (alt && alt.toLowerCase() !== 'image') extras.push(`[Image: ${alt}]`);
  }
  const card = textOf(article.querySelector('[data-testid="card.wrapper"]'), 300);
  if (card) extras.push(`[Link: ${card}]`);
  let text = readableText(texts[0], ASSIST_ENTRY_CHARS);
  if (texts[1]) extras.push(`[Quoting: ${readableText(texts[1], 1_000)}]`);
  let author = xAuthor(article);
  if (!texts.length) {
    const lines = readableText(article, ASSIST_ENTRY_CHARS, (node) => node.getAttribute?.('role') === 'group')
      .split('\n').filter((line) => line && !COUNT_LINE.test(line));
    const handleAt = lines.findIndex((line) => /^@\w+$/.test(line));
    if (handleAt >= 0) {
      author ||= [lines[handleAt - 1], `(${lines[handleAt]})`].filter(Boolean).join(' ');
      lines.splice(0, handleAt + 1);
    }
    text = lines.filter((line) => !/^\d{1,2}:\d{2}\s*[AP]M\s*·/i.test(line)).join('\n');
  }
  return {
    author,
    time: contextTime(article.querySelector('time[datetime]')?.getAttribute('datetime') || ''),
    text: [text, ...extras].filter(Boolean).join('\n'),
  };
}

function xAssistContext(document, target, surface, url, above) {
  if (surface !== 'reply') return null;
  const scope = target.closest('[role="dialog"]') || target.closest('main, [role="main"]') || document.body;
  const articles = Array.from(scope?.querySelectorAll?.('article') || [])
    .filter((article) => !article.contains(target) && !article.parentElement?.closest?.('article') && above(article));
  const entries = articles.map(xPostEntry).filter((entry) => entry.text);
  if (!entries.length) return null;
  const answered = entries[entries.length - 1];
  return { header: ['X conversation'], writing: `a reply to ${answered.author || 'the post above'}`, entries, replyingTo: entries.length - 1 };
}

function gmailAssistBody(body, stripQuotes) {
  if (!stripQuotes || typeof body.cloneNode !== 'function') return gmailBodyText(body, ASSIST_ENTRY_CHARS);
  const copy = body.cloneNode(true);
  for (const quote of Array.from(copy.querySelectorAll('.gmail_quote, blockquote[type="cite"], .gmail_extra'))) quote.remove();
  return gmailBodyText(copy, ASSIST_ENTRY_CHARS) || gmailBodyText(body, ASSIST_ENTRY_CHARS);
}

function gmailAssistContext(document, target, surface) {
  if (!['reply', 'forward'].includes(surface)) return null;
  let nodes = Array.from(document.querySelectorAll('[data-message-id]'));
  if (!nodes.length) nodes = Array.from(document.querySelectorAll('[data-legacy-message-id], .adn'));
  const seen = new Set();
  const messages = nodes.map((message) => {
    const body = message.querySelector(GMAIL_BODY_SELECTOR);
    if (!body || seen.has(body) || body.contains(target) || body.isContentEditable === true || body.getAttribute?.('contenteditable') === 'true') return null;
    seen.add(body);
    return { message, body };
  }).filter(Boolean).slice(-GMAIL_MESSAGE_LIMIT);
  const entries = messages.map(({ message, body }) => ({
    author: gmailMessageSender(message),
    time: gmailMessageDate(message),
    text: gmailAssistBody(body, messages.length > 1),
  })).filter((entry) => entry.text);
  if (!entries.length) return null;
  const subject = gmailSubject(document);
  return {
    header: [subject ? `Email thread: ${subject}` : 'Email thread'],
    writing: surface === 'forward' ? 'a forward of this email' : 'a reply to this email thread',
    entries,
    replyingTo: entries.length - 1,
  };
}

function youtubeCommentEntry(comment, note = '') {
  return {
    author: textOf(comment.querySelector('#author-text'), 80),
    time: textOf(comment.querySelector('#published-time-text'), 40),
    text: readableText(comment.querySelector('#content-text'), ASSIST_ENTRY_CHARS),
    note,
  };
}

function youtubeAssistContext(document, target, surface, url, above) {
  if (!['comment', 'comment-reply'].includes(surface)) return null;
  const title = firstText(document, ['ytd-watch-metadata #title h1', '#title h1', 'h1'], 300);
  const channel = firstText(document, ['ytd-watch-metadata ytd-channel-name #text', 'ytd-channel-name #text'], 120);
  const description = firstText(document, ['#description-inline-expander yt-attributed-string', '#description-inline-expander', 'ytd-watch-metadata ytd-text-inline-expander', '#description'], 1_500, (node) => bounded(node.textContent || '', 1_500))
    .replace(/\s*(?:…|\.\.\.)\s*more\b/i, '').replace(/\s*Show less\s*$/i, '');
  const entries = description ? [{ author: channel || 'The channel', text: description, note: 'video description' }] : [];
  const thread = target.closest('ytd-comment-thread-renderer');
  let writing = 'a comment on this video';
  let replyingTo = -1;
  if (thread) {
    const answered = target.closest('ytd-comment-view-model, ytd-comment-renderer');
    const comments = Array.from(thread.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer'))
      .filter((comment) => comment === answered || above(comment));
    entries.push(...comments.map((comment) => youtubeCommentEntry(comment)).filter((entry) => entry.text));
    replyingTo = entries.length - 1;
    const author = answered ? textOf(answered.querySelector('#author-text'), 80) : '';
    writing = author ? `a reply to ${author}'s comment` : 'a reply in this comment thread';
  } else {
    const top = Array.from(document.querySelectorAll('ytd-comment-thread-renderer')).slice(0, 5)
      .map((item) => item.querySelector('ytd-comment-view-model, ytd-comment-renderer'))
      .filter(Boolean)
      .map((comment) => youtubeCommentEntry(comment, 'top comment'));
    entries.push(...top.filter((entry) => entry.text));
  }
  if (!entries.length && !title) return null;
  return { header: [`YouTube video: ${title || 'this video'}${channel ? `, by ${channel}` : ''}`], writing, entries, replyingTo };
}

function redditCommentEntry(comment, note = '') {
  const body = Array.from(comment.querySelectorAll('[slot="comment"]')).find((node) => node.closest('shreddit-comment') === comment);
  const author = comment.getAttribute('author');
  return { author: author ? `u/${author}` : '', time: contextTime(comment.getAttribute('created') || ''), text: readableText(body, ASSIST_ENTRY_CHARS), note };
}

function redditAssistContext(document, target) {
  const post = document.querySelector('shreddit-post');
  if (!post) return null;
  const title = bounded(post.getAttribute('post-title') || textOf(post.querySelector('[slot="title"], h1'), 300), 300);
  const community = bounded(post.getAttribute('subreddit-prefixed-name') || '', 80);
  const author = post.getAttribute('author');
  const link = String(post.getAttribute('content-href') || '');
  const postText = readableText(post.querySelector('[slot="text-body"]'), ASSIST_OPENING_CHARS)
    || (link ? `Link: ${bounded(link.startsWith('/') ? `https://www.reddit.com${link}` : link, 300)}` : '');
  const entries = [{ author: author ? `u/${author}` : '', time: contextTime(post.getAttribute('created-timestamp') || ''), text: postText || title, note: 'the post' }];
  const answered = target.closest('shreddit-comment');
  let writing = 'a comment on this post';
  if (answered) {
    const chain = [];
    for (let comment = answered; comment; comment = comment.parentElement?.closest?.('shreddit-comment')) chain.unshift(comment);
    entries.push(...chain.map((comment) => redditCommentEntry(comment)).filter((entry) => entry.text));
    writing = `a reply to u/${answered.getAttribute('author') || 'someone'}'s comment`;
  } else {
    entries.push(...Array.from(document.querySelectorAll('shreddit-comment[depth="0"]')).slice(0, 5)
      .map((comment) => redditCommentEntry(comment, 'top comment')).filter((entry) => entry.text));
  }
  return {
    header: [`Reddit post${community ? ` in ${community}` : ''}: ${title}`],
    writing,
    entries,
    replyingTo: answered ? entries.length - 1 : 0,
  };
}

const LINKEDIN_POST = '[data-urn*="urn:li:activity"], [data-id*="urn:li:activity"], .feed-shared-update-v2, .fie-impression-container';
const LINKEDIN_COMMENT = '.comments-comment-entity, .comments-comment-item, article.comments-comment-item';

function linkedinAssistContext(document, target, surface) {
  if (surface !== 'comment') return null;
  const post = target.closest(LINKEDIN_POST);
  if (!post) return null;
  const outsideComments = (read) => (node) => (node.closest(LINKEDIN_COMMENT) ? '' : read(node));
  const author = firstText(post, ['.update-components-actor__title span[aria-hidden="true"]', '.update-components-actor__name', '.feed-shared-actor__name'], 120, outsideComments((node) => textOf(node, 120)));
  const postText = firstText(post, ['.update-components-text', '.feed-shared-update-v2__description', '.feed-shared-inline-show-more-text', '.feed-shared-text'], ASSIST_OPENING_CHARS, outsideComments((node) => readableText(node, ASSIST_OPENING_CHARS)))
    || readableText(post, ASSIST_OPENING_CHARS, (node) => node.matches?.(`${LINKEDIN_COMMENT}, .comments-comment-box`));
  const entries = [{ author, text: postText, note: 'the post' }];
  const answered = target.closest(LINKEDIN_COMMENT);
  if (answered) {
    entries.push({
      author: firstText(answered, ['.comments-comment-meta__description-title', '.comments-post-meta__name-text', '.comments-comment-meta__actor'], 120),
      text: firstText(answered, ['.comments-comment-item__main-content', '.update-components-text'], ASSIST_ENTRY_CHARS, (node) => readableText(node, ASSIST_ENTRY_CHARS)),
    });
  }
  return {
    header: ['LinkedIn post'],
    writing: answered ? `a reply to ${entries[1].author || 'the comment above'}` : `a comment on ${author ? `${author}'s` : 'this'} post`,
    entries: entries.filter((entry) => entry.text),
    replyingTo: answered ? 1 : 0,
  };
}

const ASSIST_CONTEXT_READERS = Object.freeze({
  github: githubAssistContext,
  x: xAssistContext,
  gmail: gmailAssistContext,
  youtube: youtubeAssistContext,
  reddit: redditAssistContext,
  linkedin: linkedinAssistContext,
});

function selfVisible(node) {
  if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
  const inlineStyle = String(node.getAttribute?.('style') || '').toLowerCase().replace(/\s+/g, '');
  if (inlineStyle.includes('display:none') || inlineStyle.includes('visibility:hidden')) return false;
  const view = node.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle !== 'function') return true;
  const computed = view.getComputedStyle(node);
  if (computed?.display === 'none' || computed?.visibility === 'hidden' || computed?.visibility === 'collapse') return false;
  return computed?.display === 'contents' || typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
}

// The text around the field, nearest first when there is too much: what is just above a composer is what it
// answers (a chat's newest messages, a form's question). The start of the area is kept too, for its title.
function textAroundField(root, target, max) {
  const before = [];
  const after = [];
  let passed = false;
  let afterSize = 0;
  const visit = (node, isRoot) => {
    if (!node) return;
    if (node === target) { passed = true; return; }
    if (node.nodeType === 3) {
      const text = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (!passed) before.push(text);
      else if (afterSize < 1_000) { after.push(text); afterSize += text.length + 1; }
      return;
    }
    if (node.nodeType !== 1 || (passed && afterSize >= 1_000)) return;
    const tag = String(node.tagName || '').toLowerCase();
    const holdsTarget = node.contains?.(target);
    if (!holdsTarget && (ASSIST_SKIP_TAGS.has(tag) || ASSIST_SKIP_ROLES.has(node.getAttribute?.('role') || ''))) return;
    if (!isRoot && !holdsTarget && (node.isContentEditable || node.getAttribute?.('contenteditable') === 'true' || !selfVisible(node))) return;
    const block = ASSIST_BLOCK_TAGS.has(tag);
    if (block) (passed ? after : before).push('\n');
    for (const child of Array.from(node.childNodes || [])) visit(child, false);
    if (block) (passed ? after : before).push('\n');
  };
  visit(root, true);
  const tidy = (parts) => parts.join(' ').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  let above = tidy(before);
  const below = tidy(after).slice(0, 1_000);
  const room = max - (below ? below.length + 40 : 0);
  if (above.length > room) {
    const head = above.slice(0, 1_200).trimEnd();
    const tailLength = Math.max(0, room - head.length - 60);
    above = `${head}\n[${above.length - head.length - tailLength} characters left out to fit]\n${above.slice(above.length - tailLength).trimStart()}`;
  }
  return [above, below && `After the field:\n${below}`].filter(Boolean).join('\n\n');
}

function genericAssistContext(document, target, profile) {
  const root = profile.contextElement || target.parentElement;
  const label = fieldLabel(target);
  const writing = `You are writing ${label ? `in the field "${label}"` : 'in a text field on this page'}.`;
  const title = bounded(document?.title || '', 200);
  const head = [title && `Page: ${title}`, writing].filter(Boolean).join('\n');
  const text = textAroundField(root, target, ASSIST_CONTEXT_CHARS - head.length - 2);
  return text ? `${head}\n\n${text}` : '';
}

export function inlineSiteContext(document, target, profile = null) {
  const resolved = profile || inspectInlineSite(document, target);
  if (!target || resolved.contextMode !== 'visible') return { text: '', messages: 0 };
  const url = parsedUrl(document?.URL || document?.baseURI || '');
  let thread = null;
  try {
    thread = ASSIST_CONTEXT_READERS[resolved.adapterId]?.(document, target, resolved.surface, url, aboveField(document, target)) || null;
  } catch {
    thread = null;
  }
  if (thread && (thread.entries?.length || thread.blocks?.length)) {
    return { text: composeAssistContext(thread), messages: thread.entries.length };
  }
  return { text: genericAssistContext(document, target, resolved), messages: 0 };
}

export function captureInlineSiteContext(document, target, profile = null) {
  return inlineSiteContext(document, target, profile).text;
}

export function inspectSite(document, options = {}) {
  const url = parsedUrl(options.url || document?.URL || document?.baseURI || '');
  const host = url?.hostname?.toLowerCase?.() || '';
  if (!url) return { schema: SITE_ADAPTER_SCHEMA, version: SITE_ADAPTER_VERSION, matched: false, adapterId: 'generic', policy: 'generic', route: { kind: 'unknown' }, capabilities: [], actions: [], context: { text: '' } };
  if (host === 'github.com' || host.endsWith('.github.com')) return github(document, url);
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return youtube(document, url);
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return xAdapter(document, url);
  if (host === 'mail.google.com') return gmail(document, url, Boolean(options.explicitCapture), options.maxTextChars);
  const adapterId = adapterIdForHost(host);
  if (adapterId !== 'generic') {
    const explicitCapture = Boolean(options.explicitCapture);
    const publicArticle = (adapterId === 'medium' && /\/[\w-]+-[a-f0-9]{8,}(?:\/)?$/i.test(url.pathname)
      && !/^\/(?:me|new-story|settings|draft|edit)(?:\/|$)/i.test(url.pathname))
      || (adapterId === 'substack' && /^\/p\/[^/]+\/?$/.test(url.pathname));
    const readingArticle = publicArticle && Boolean(document.querySelector('article, [itemprop="articleBody"]'))
      && !document.querySelector('article [contenteditable="true"], article textarea');
    const privateSite = PRIVATE_INLINE_SITES.has(adapterId) && !readingArticle;
    const context = explicitCapture
      ? visibleContextText(document.querySelector('main, [role="main"], body') || document.body, null, MAX_CONTEXT_CHARS)
      : '';
    return baseResult(
      adapterId,
      INLINE_SITE_LABELS[adapterId],
      privateSite ? 'ask-first' : 'automatic-read-only',
      { kind: 'page' },
      ['focused-draft', 'bounded-context'],
      inlineActions(adapterId, 'page'),
      { text: privateSite && !explicitCapture ? '' : context, itemCount: context ? 1 : 0 },
    );
  }
  return { schema: SITE_ADAPTER_SCHEMA, version: SITE_ADAPTER_VERSION, matched: false, adapterId: 'generic', policy: 'generic', route: { kind: 'page' }, capabilities: [], actions: [], context: { text: '' } };
}

export function applySiteAdapterPolicy(pageContext = {}, siteAdapter = {}) {
  if (!siteAdapter?.matched) return pageContext;
  const shouldSuppress = siteAdapter.policy === 'ask-first';
  const adapterText = String(siteAdapter?.context?.text || '');
  const next = {
    ...pageContext,
    meta: {
      ...(pageContext.meta || {}),
      siteAdapter: {
        schema: siteAdapter.schema,
        version: siteAdapter.version,
        id: siteAdapter.adapterId,
        policy: siteAdapter.policy,
        route: siteAdapter.route,
        capabilities: siteAdapter.capabilities,
        actions: siteAdapter.actions,
        suppressed: shouldSuppress && !adapterText,
        itemCount: Number(siteAdapter?.context?.itemCount || 0),
        truncated: Boolean(siteAdapter?.context?.truncated),
      },
    },
  };
  if (shouldSuppress && !adapterText) next.text = '';
  else if (adapterText) next.text = adapterText;
  if (siteAdapter.adapterId === 'gmail' && adapterText) {
    next.meta.extraction = { ...(next.meta.extraction || {}), method: 'gmail-thread', confidence: 0.95, wordCount: adapterText.split(/\s+/).length, truncated: Boolean(siteAdapter.context?.truncated) };
  }
  if (pageContext.extraction) {
    next.extraction = {
      ...pageContext.extraction,
      content: { ...(pageContext.extraction.content || {}), text: next.text || '' },
      privacy: { ...(pageContext.extraction.privacy || {}), sitePolicySuppressed: shouldSuppress && !adapterText },
    };
  }
  return next;
}

export function explicitSiteCaptureAction(pageContext = {}) {
  const adapter = pageContext?.meta?.siteAdapter;
  if (adapter?.id !== 'gmail'
    || adapter?.policy !== 'ask-first'
    || adapter?.route?.kind !== 'thread'
    || adapter?.suppressed !== true) return null;
  return {
    id: 'gmail-visible-thread',
    label: 'Capture visible Gmail thread',
    description: 'Capture only rendered message bodies. Draft and input values stay excluded.',
  };
}

export const SITE_ADAPTER_API = Object.freeze({
  schema: SITE_ADAPTER_SCHEMA,
  version: SITE_ADAPTER_VERSION,
  order: SITE_ADAPTER_ORDER,
  inspectSite,
  inspectInlineSite,
  captureInlineSiteContext,
  inlineSiteContext,
  normalizeInlineSiteContextPreferences,
  isGmailThreadUrl,
  applySiteAdapterPolicy,
  explicitSiteCaptureAction,
  safeUrl,
});
