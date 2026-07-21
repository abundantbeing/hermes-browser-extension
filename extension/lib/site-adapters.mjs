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
    && node.getClientRects().length === 0) return false;
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

function action(id, label, instruction) {
  return Object.freeze({ id, label, instruction, mode: 'draft-copy-only' });
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
      text: bounded(context.text || '', MAX_CONTEXT_CHARS),
      title: bounded(context.title || '', 500),
      itemCount: Math.max(0, Number(context.itemCount || 0)),
      transcriptFetched: Boolean(context.transcriptFetched),
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

function gmail(document, url, explicitCapture) {
  const route = { kind: /#(?:inbox|all|sent)\//i.test(url.hash) ? 'thread' : 'mailbox' };
  const title = explicitCapture
    ? visibleTextOf(document.querySelector('[data-thread-title], h2.hP, main[role="main"] h2'), 500)
    : '';
  const messageNodes = explicitCapture
    ? Array.from(document.querySelectorAll('[data-message-id]')).filter(isVisibleElement).slice(0, 30)
    : [];
  const messages = explicitCapture
    ? uniqueTexts(messageNodes.map((message) => {
      const body = visibleTextOf(message.querySelector('.a3s, [role="document"]'), 4_000);
      if (!body) return '';
      const sender = visibleTextOf(message.querySelector('.gD, [email]'), 500);
      return [sender, body].filter(Boolean).join(': ');
    }), 30)
    : [];
  return baseResult('gmail', 'Gmail', 'ask-first', route, ['thread-context', 'focused-draft'], [
    action('draft-reply', 'Draft reply', 'Draft a reply for preview and copy only.'),
    action('summarize-thread', 'Summarize thread', 'Summarize only after explicit capture.'),
  ], {
    title,
    text: explicitCapture ? [title, ...messages].filter(Boolean).join('\n\n') : '',
    itemCount: messages.length,
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
    if (/\/messages/.test(path) && /message|send/.test(`${label} ${nearby}`)) return 'direct-message';
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
  return target.closest?.('article, [data-message-id], ytd-comment-thread-renderer, main, [role="main"]') || target.parentElement;
}

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
  const anchorElement = inlineAnchor(target, adapterId);
  const obstacleElements = adapterId === 'chatgpt'
    ? Array.from(anchorElement?.querySelectorAll?.('button, [role="button"], select') || [])
      .filter((element) => element !== target && !target?.contains?.(element))
    : [];
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
      preferred: adapterId === 'chatgpt'
        ? ['outside-end', 'outside-start', 'above-end', 'below-end']
        : ['inside-end'],
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

export function captureInlineSiteContext(document, target, profile = null) {
  const resolved = profile || inspectInlineSite(document, target);
  if (resolved.contextMode !== 'visible') return '';
  return visibleContextText(resolved.contextElement, target, 6_000);
}

export function inspectSite(document, options = {}) {
  const url = parsedUrl(options.url || document?.URL || document?.baseURI || '');
  const host = url?.hostname?.toLowerCase?.() || '';
  if (!url) return { schema: SITE_ADAPTER_SCHEMA, version: SITE_ADAPTER_VERSION, matched: false, adapterId: 'generic', policy: 'generic', route: { kind: 'unknown' }, capabilities: [], actions: [], context: { text: '' } };
  if (host === 'github.com' || host.endsWith('.github.com')) return github(document, url);
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return youtube(document, url);
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return xAdapter(document, url);
  if (host === 'mail.google.com') return gmail(document, url, Boolean(options.explicitCapture));
  const adapterId = adapterIdForHost(host);
  if (adapterId !== 'generic') {
    const explicitCapture = Boolean(options.explicitCapture);
    const privateSite = PRIVATE_INLINE_SITES.has(adapterId);
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
      },
    },
  };
  if (shouldSuppress && !adapterText) next.text = '';
  else if (adapterText) next.text = adapterText;
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
  normalizeInlineSiteContextPreferences,
  applySiteAdapterPolicy,
  explicitSiteCaptureAction,
  safeUrl,
});
