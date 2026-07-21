import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  SITE_ADAPTER_API,
  SITE_ADAPTER_ORDER,
  SITE_ADAPTER_SCHEMA,
  applySiteAdapterPolicy,
  captureInlineSiteContext,
  inspectInlineSite,
  inspectSite,
  normalizeInlineSiteContextPreferences,
} from '../extension/lib/site-adapters.mjs';
import * as siteAdapters from '../extension/lib/site-adapters.mjs';

function doc(html, url) {
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'URL', { configurable: true, value: url });
  Object.defineProperty(document, 'baseURI', { configurable: true, value: url });
  return document;
}

function generic(text = 'GENERIC PAGE TEXT') {
  return {
    text,
    selectedText: '',
    meta: {},
    extraction: { content: { text }, privacy: {} },
  };
}

test('registry order is stable and every action is draft-copy-only', () => {
  assert.equal(SITE_ADAPTER_SCHEMA, 'hermes.browser.site-capability.v1');
  assert.deepEqual(SITE_ADAPTER_ORDER, [
    'github', 'x', 'youtube', 'reddit', 'facebook', 'chatgpt', 'grok', 'claude', 'perplexity', 'gmail', 'googlecalendar', 'googlechat', 'protonmail',
    'linkedin', 'slack', 'discord', 'teams', 'outlook', 'gitlab', 'stackoverflow', 'linear', 'jira', 'notion', 'googledocs',
    'threads', 'bluesky', 'mastodon', 'substack', 'medium', 'whatsapp', 'telegram',
  ]);
  assert.equal(typeof SITE_ADAPTER_API.inspectSite, 'function');
  for (const url of [
    'https://github.com/nous/hermes/issues/7',
    'https://www.youtube.com/watch?v=abc123',
    'https://x.com/nousresearch/status/123',
    'https://mail.google.com/mail/u/0/#inbox',
  ]) {
    const result = inspectSite(doc('<main><h1>Page</h1></main>', url), { url });
    assert.ok(result.actions.every((action) => action.mode === 'draft-copy-only'));
    assert.doesNotMatch(JSON.stringify(result), /innerHTML|outerHTML|"html"/i);
  }
});

test('GitHub adapter returns bounded issue context', () => {
  const url = 'https://github.com/nous/hermes/issues/42';
  const document = doc(`
    <main>
      <h1 data-testid="issue-title">Extractor regression</h1>
      <div data-testid="comment-body">Initial report text.</div>
      <div data-testid="comment-body">Maintainer reply.</div>
    </main>`, url);
  const result = inspectSite(document, { url });
  assert.equal(result.adapterId, 'github');
  assert.equal(result.route.kind, 'issue');
  assert.equal(result.route.owner, 'nous');
  assert.equal(result.route.repo, 'hermes');
  assert.equal(result.route.number, 42);
  assert.match(result.context.text, /Extractor regression/);
  assert.match(result.context.text, /Maintainer reply/);
  assert.equal(result.policy, 'automatic-read-only');
  const pullRequest = inspectSite(document, { url: 'https://github.com/nous/hermes-browser/pull/77' });
  assert.equal(pullRequest.route.kind, 'pull-request');
  assert.equal(pullRequest.route.number, 77);
});

test('YouTube adapter exposes transcript capability without fetching', () => {
  const url = 'https://www.youtube.com/watch?v=abc123';
  const document = doc(`
    <main><h1 id="title">Hermes demo</h1><div id="channel-name">Nous Research</div>
    <div id="description">A browser walkthrough.</div></main>`, url);
  const result = inspectSite(document, { url });
  assert.equal(result.adapterId, 'youtube');
  assert.equal(result.route.videoId, 'abc123');
  assert.ok(result.capabilities.includes('youtube-transcript'));
  assert.match(result.context.text, /Hermes demo/);
  assert.equal(result.context.transcriptFetched, false);
});

test('X captures one status but suppresses broad feeds', () => {
  const statusUrl = 'https://x.com/nousresearch/status/123';
  const statusDoc = doc(`
    <main>
      <article><div data-testid="User-Name">Nous Research @nousresearch</div><div data-testid="tweetText">Target post text.</div></article>
      <article><div data-testid="tweetText">Unrelated feed text.</div></article>
    </main>`, statusUrl);
  const status = inspectSite(statusDoc, { url: statusUrl });
  assert.equal(status.policy, 'automatic-read-only');
  assert.match(status.context.text, /Target post text/);
  assert.doesNotMatch(status.context.text, /Unrelated feed text/);

  const homeUrl = 'https://x.com/home';
  const home = inspectSite(doc('<main><article><div data-testid="tweetText">Private feed</div></article></main>', homeUrl), { url: homeUrl });
  assert.equal(home.policy, 'ask-first');
  assert.equal(home.context.text, '');
  const guarded = applySiteAdapterPolicy(generic('Private feed'), home);
  assert.equal(guarded.text, '');
  assert.equal(guarded.extraction.content.text, '');
  assert.equal(guarded.meta.siteAdapter.suppressed, true);
});

test('Gmail is ask-first and never captures field values', () => {
  const url = 'https://mail.google.com/mail/u/0/#inbox/thread-1';
  const html = `<main role="main"><h2 data-thread-title>Project update</h2>
    <div data-message-id="m1"><span class="gD">Sender</span><div class="a3s">Visible message body.</div></div>
    <textarea name="body">ORIGINAL USER DRAFT CONTENT</textarea><input name="api_key" value="never-capture-me"></main>`;
  const document = doc(html, url);
  const guarded = inspectSite(document, { url });
  assert.equal(guarded.adapterId, 'gmail');
  assert.equal(guarded.policy, 'ask-first');
  assert.equal(guarded.context.text, '');
  assert.doesNotMatch(JSON.stringify(guarded), /Visible message body|ORIGINAL USER DRAFT CONTENT|never-capture-me/);

  const explicit = inspectSite(document, { url, explicitCapture: true });
  assert.match(explicit.context.text, /Visible message body/);
  assert.doesNotMatch(JSON.stringify(explicit), /ORIGINAL USER DRAFT CONTENT|never-capture-me/);
  assert.ok(explicit.actions.some((action) => action.id === 'draft-reply'));
});

test('explicit Gmail thread capture rejects hidden message nodes and field values', () => {
  const url = 'https://mail.google.com/mail/u/0/#inbox/thread-1';
  const document = doc(`<main role="main"><h2 data-thread-title>Project update</h2>
    <div data-message-id="m1"><span class="gD">Sender</span><div class="a3s">Visible message body.</div></div>
    <div data-message-id="m2" hidden><div class="a3s">HIDDEN ATTRIBUTE BODY</div></div>
    <div data-message-id="m3" aria-hidden="true"><div class="a3s">ARIA HIDDEN BODY</div></div>
    <div data-message-id="m4" style="display:none"><div class="a3s">DISPLAY NONE BODY</div></div>
    <textarea name="body">ORIGINAL USER DRAFT CONTENT</textarea>
    <input name="api_key" value="never-capture-me"></main>`, url);
  const explicit = inspectSite(document, { url, explicitCapture: true });
  assert.match(explicit.context.text, /Visible message body/);
  assert.doesNotMatch(
    JSON.stringify(explicit),
    /HIDDEN ATTRIBUTE BODY|ARIA HIDDEN BODY|DISPLAY NONE BODY|ORIGINAL USER DRAFT CONTENT|never-capture-me/,
  );
});

test('explicit Gmail capture action is available only for a suppressed thread', () => {
  const explicitSiteCaptureAction = siteAdapters.explicitSiteCaptureAction;
  assert.equal(typeof explicitSiteCaptureAction, 'function');
  const base = {
    schema: 'hermes.browser.page-context.v1',
    meta: {
      siteAdapter: {
        schema: SITE_ADAPTER_SCHEMA,
        version: '1.0.0',
        id: 'gmail',
        policy: 'ask-first',
        route: { kind: 'thread' },
        suppressed: true,
      },
    },
  };
  assert.deepEqual(explicitSiteCaptureAction(base), {
    id: 'gmail-visible-thread',
    label: 'Capture visible Gmail thread',
    description: 'Capture only rendered message bodies. Draft and input values stay excluded.',
  });
  assert.equal(explicitSiteCaptureAction({ ...base, meta: { siteAdapter: { ...base.meta.siteAdapter, suppressed: false } } }), null);
  assert.equal(explicitSiteCaptureAction({ ...base, meta: { siteAdapter: { ...base.meta.siteAdapter, route: { kind: 'mailbox' } } } }), null);
  assert.equal(explicitSiteCaptureAction({ ...base, meta: { siteAdapter: { ...base.meta.siteAdapter, id: 'x' } } }), null);
});

test('inline site adapters cover the requested sites with distinct surfaces and actions', () => {
  const cases = [
    ['github', 'https://github.com/nousresearch/hermes-agent/issues/42', '<form><textarea aria-label="Comment body"></textarea></form>', /maintainer|diagnostic|reply/i],
    ['x', 'https://x.com/NousResearch/status/123', '<article>Source post<form><div contenteditable="true" role="textbox" data-testid="tweetTextarea_0"></div></form></article>', /reply|post|thread/i],
    ['youtube', 'https://www.youtube.com/watch?v=abc', '<ytd-comments><form><div contenteditable="true" role="textbox" aria-label="Add a comment"></div></form></ytd-comments>', /reply/i],
    ['reddit', 'https://www.reddit.com/r/hermes/comments/abc/topic', '<shreddit-composer><textarea aria-label="Add a comment"></textarea></shreddit-composer>', /reply/i],
    ['facebook', 'https://www.facebook.com/story.php?id=1', '<article><div contenteditable="true" role="textbox" aria-label="Write a comment"></div></article>', /reply/i],
    ['chatgpt', 'https://chatgpt.com/', '<form id="composer"><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div><button aria-label="Start dictation"></button><button aria-label="Start Voice"></button></form>', /prompt|constraint|research/i],
    ['grok', 'https://grok.com/', '<form><div contenteditable="true" role="textbox" aria-label="Ask Grok"></div><button aria-label="Connectors"></button></form>', /source|real-time|query/i],
    ['claude', 'https://claude.ai/new', '<form><div contenteditable="true" role="textbox" aria-label="Chat with Claude"></div><button aria-label="Add files"></button></form>', /artifact|brief|constraint/i],
    ['perplexity', 'https://www.perplexity.ai/', '<form><textarea aria-label="Ask anything"></textarea><button aria-label="Attach"></button></form>', /source|research|comparison/i],
    ['gmail', 'https://mail.google.com/mail/u/0/#inbox/thread', '<main>Visible message thread<form role="dialog"><div contenteditable="true" role="textbox" aria-label="Message Body"></div><button aria-label="Send"></button></form></main>', /email|reply|follow-up/i],
    ['googlecalendar', 'https://calendar.google.com/calendar/u/0/r/eventedit', '<main><form role="dialog"><input aria-label="Add title" value="Weekly sync"><div contenteditable="true" role="textbox" aria-label="Add description"></div><button aria-label="Save"></button></form></main>', /event|agenda|attendee/i],
    ['googlechat', 'https://chat.google.com/u/0/room/AAAA', '<main><form><div contenteditable="true" role="textbox" aria-label="Reply in thread"></div><button aria-label="Send message"></button></form></main>', /reply/i],
    ['protonmail', 'https://mail.proton.me/u/0/inbox', '<main>Visible encrypted message<form><div contenteditable="true" role="textbox" aria-label="Message body"></div><button aria-label="Send"></button></form></main>', /email|reply|follow-up/i],
  ];

  for (const [adapterId, url, html, actionPattern] of cases) {
    const document = doc(html, url);
    const target = document.querySelector('textarea,[contenteditable="true"]');
    const profile = inspectInlineSite(document, target, { url });
    assert.equal(profile.adapterId, adapterId, `${adapterId} was not identified`);
    assert.ok(profile.surface && profile.surface !== 'generic', `${adapterId} surface was generic`);
    assert.ok(profile.confidence >= 0.7, `${adapterId} confidence was ${profile.confidence}`);
    assert.match(profile.actions.map((action) => action.label).join(' '), actionPattern, `${adapterId} actions were not site-aware`);
    assert.equal(profile.placement.preferred[0], adapterId === 'chatgpt' ? 'outside-end' : 'inside-end', `${adapterId} launcher placement regressed`);
    if (adapterId !== 'chatgpt') assert.equal(profile.placement.anchorElement, target, `${adapterId} should anchor to the editable itself`);
  }
});

test('private-site context defaults are strict and per-site preferences are allowlisted', () => {
  const cases = [
    ['facebook', 'https://facebook.com/', 'draft'],
    ['chatgpt', 'https://chatgpt.com/', 'draft'],
    ['grok', 'https://grok.com/', 'draft'],
    ['claude', 'https://claude.ai/', 'draft'],
    ['perplexity', 'https://perplexity.ai/', 'draft'],
    ['gmail', 'https://mail.google.com/', 'draft'],
    ['googlecalendar', 'https://calendar.google.com/', 'draft'],
    ['googlechat', 'https://chat.google.com/', 'draft'],
    ['protonmail', 'https://mail.proton.me/', 'draft'],
    ['github', 'https://github.com/nous/hermes/issues/1', 'visible'],
    ['x', 'https://x.com/nous/status/1', 'visible'],
    ['youtube', 'https://youtube.com/watch?v=1', 'visible'],
    ['reddit', 'https://reddit.com/r/hermes/comments/1/topic', 'visible'],
  ];
  for (const [adapterId, url, expectedMode] of cases) {
    const document = doc('<article>Current item<form><textarea aria-label="Reply"></textarea></form></article>', url);
    const profile = inspectInlineSite(document, document.querySelector('textarea'), { url });
    assert.equal(profile.adapterId, adapterId);
    assert.equal(profile.contextMode, expectedMode, `${adapterId} context default was wrong`);
  }

  assert.deepEqual(normalizeInlineSiteContextPreferences({
    chatgpt: 'visible', gmail: 'draft', evil: 'visible', protonmail: 'everything',
  }), { chatgpt: 'visible', gmail: 'draft' });
});

test('private inline context is empty until the site is explicitly opted in', () => {
  const document = doc('<main><article>Private conversation detail.</article><form><textarea aria-label="Message Body"></textarea></form></main>', 'https://mail.google.com/mail/u/0/#inbox/thread');
  const target = document.querySelector('textarea');
  const strict = inspectInlineSite(document, target, { url: document.URL });
  assert.equal(captureInlineSiteContext(document, target, strict), '');

  const optedIn = inspectInlineSite(document, target, {
    url: document.URL,
    contextPreferences: { gmail: 'visible' },
  });
  const captured = captureInlineSiteContext(document, target, optedIn);
  assert.match(captured, /Private conversation detail/);
  assert.ok(captured.length <= 6_000);
});

test('ChatGPT inline profile anchors to the outer composer and treats native controls as obstacles', () => {
  const document = doc('<form id="composer"><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div><button aria-label="Add files and more"></button><button aria-label="Start dictation"></button><button aria-label="Start Voice"></button></form>', 'https://chatgpt.com/');
  const profile = inspectInlineSite(document, document.querySelector('#prompt-textarea'), { url: document.URL });
  assert.equal(profile.placement.anchorElement.id, 'composer');
  assert.equal(profile.placement.preferred[0], 'outside-end');
  assert.equal(profile.placement.obstacleElements.length, 3);
  assert.equal(profile.applyMode, 'copy-only');

  const fixture = doc('<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div><button aria-label="Voice"></button></form>', 'http://127.0.0.1/qa-chatgpt');
  assert.equal(inspectInlineSite(fixture, fixture.querySelector('#prompt-textarea'), { url: fixture.URL }).adapterId, 'chatgpt');
});

test('inline adapters cover common work, developer, publishing, social, and messaging sites', () => {
  const cases = [
    ['linkedin', 'https://www.linkedin.com/feed/', '<form><div contenteditable="true" role="textbox" aria-label="Text editor for creating content"></div></form>', /LinkedIn|post|comment/i, 'visible'],
    ['slack', 'https://app.slack.com/client/T1/C1', '<form><div contenteditable="true" role="textbox" data-qa="message_input" aria-label="Message #general"></div></form>', /Slack|message|channel/i, 'draft'],
    ['discord', 'https://discord.com/channels/1/2', '<form><div contenteditable="true" role="textbox" aria-label="Message #general"></div></form>', /Discord|message|reply/i, 'draft'],
    ['teams', 'https://teams.microsoft.com/v2/', '<form><div contenteditable="true" role="textbox" data-tid="ckeditor" aria-label="Type a new message"></div></form>', /Teams|message|meeting/i, 'draft'],
    ['outlook', 'https://outlook.office.com/mail/inbox/id/1', '<main>Visible mail thread<form><div contenteditable="true" role="textbox" aria-label="Message body"></div></form></main>', /email|reply|follow-up/i, 'draft'],
    ['gitlab', 'https://gitlab.com/nous/hermes/-/merge_requests/7', '<form><textarea aria-label="Comment"></textarea></form>', /reply/i, 'visible'],
    ['stackoverflow', 'https://stackoverflow.com/questions/1/example', '<form><textarea id="wmd-input" aria-label="Answer body"></textarea></form>', /answer|question|code/i, 'visible'],
    ['linear', 'https://linear.app/nous/issue/HER-1/title', '<form><div contenteditable="true" role="textbox" data-slate-editor="true" aria-label="Issue description"></div></form>', /issue|acceptance|update/i, 'draft'],
    ['jira', 'https://nous.atlassian.net/browse/HER-1', '<form><div contenteditable="true" role="textbox" aria-label="Comment"></div></form>', /reply/i, 'draft'],
    ['notion', 'https://www.notion.so/workspace/page-1', '<main><div contenteditable="true" role="textbox" aria-label="Page content"></div></main>', /page|outline|rewrite/i, 'draft'],
    ['googledocs', 'https://docs.google.com/document/d/1/edit', '<main><div contenteditable="true" role="textbox" aria-label="Document content"></div></main>', /document|outline|rewrite/i, 'draft'],
    ['threads', 'https://www.threads.net/', '<form><div contenteditable="true" role="textbox" aria-label="Start a thread"></div></form>', /thread|reply|post/i, 'visible'],
    ['bluesky', 'https://bsky.app/', '<form><textarea placeholder="What’s up?"></textarea></form>', /post|reply|thread/i, 'visible'],
    ['mastodon', 'https://mastodon.social/home', '<form><textarea class="autosuggest-textarea" aria-label="What is on your mind?"></textarea></form>', /post|reply|alt text/i, 'visible'],
    ['substack', 'https://writer.substack.com/publish/post/1', '<main><div contenteditable="true" role="textbox" aria-label="Post content"></div></main>', /newsletter|post|subject/i, 'draft'],
    ['medium', 'https://medium.com/p/new-story', '<main><div contenteditable="true" role="textbox" data-contents="true" aria-label="Story content"></div></main>', /story|headline|section/i, 'draft'],
    ['whatsapp', 'https://web.whatsapp.com/', '<main><div contenteditable="true" role="textbox" aria-label="Type a message"></div></main>', /message|reply|concise/i, 'draft'],
    ['telegram', 'https://web.telegram.org/k/', '<main><div contenteditable="true" role="textbox" class="input-message-input" aria-label="Message"></div></main>', /message|reply|concise/i, 'draft'],
  ];

  for (const [adapterId, url, html, actionPattern, contextMode] of cases) {
    const document = doc(html, url);
    const target = document.querySelector('textarea,[contenteditable="true"]');
    const profile = inspectInlineSite(document, target, { url });
    assert.equal(profile.adapterId, adapterId, `${url} did not resolve to ${adapterId}`);
    assert.ok(profile.surface && profile.surface !== 'generic', `${adapterId} surface was generic`);
    assert.match(`${profile.label} ${profile.actions.map((item) => item.label).join(' ')}`, actionPattern);
    assert.equal(profile.contextMode, contextMode, `${adapterId} context default was wrong`);
    assert.equal(profile.placement.preferred[0], 'inside-end', `${adapterId} launcher should stay inside the editable boundary`);
    assert.equal(profile.placement.anchorElement, target, `${adapterId} should anchor to the editable itself`);
  }
});

test('composer modes keep a simple primary action plus useful site-specific options', () => {
  const xReply = doc(`
    <div role="dialog" aria-label="Compose a reply">
      <article>Source post text</article>
      <div>Replying to @nous</div>
      <form><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text"></div></form>
      <button data-testid="tweetButton">Reply</button>
    </div>
  `, 'https://x.com/compose/post');
  const xReplyProfile = inspectInlineSite(xReply, xReply.querySelector('[contenteditable]'), { url: xReply.URL });
  assert.equal(xReplyProfile.surface, 'reply');
  assert.deepEqual(xReplyProfile.actions.map((item) => item.label), ['Draft a reply', 'Draft a post', 'Refine reply tone', 'Add a useful point']);

  const xInlineReply = doc(`
    <section>
      <article>Source post text</article>
      <div>Replying to @nous</div>
      <form><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text"></div></form>
      <button>Reply</button>
    </section>
  `, 'https://x.com/home');
  const xInlineReplyProfile = inspectInlineSite(xInlineReply, xInlineReply.querySelector('[contenteditable]'), { url: xInlineReply.URL });
  assert.equal(xInlineReplyProfile.surface, 'reply');
  assert.equal(xInlineReplyProfile.actions[0].label, 'Draft a reply');
  assert.match(
    captureInlineSiteContext(xInlineReply, xInlineReply.querySelector('[contenteditable]'), xInlineReplyProfile),
    /Source post text/,
  );

  const xPost = doc('<div role="dialog"><form><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text"></div></form><button>Post</button></div>', 'https://x.com/compose/post');
  const xPostProfile = inspectInlineSite(xPost, xPost.querySelector('[contenteditable]'), { url: xPost.URL });
  assert.equal(xPostProfile.surface, 'post');
  assert.deepEqual(xPostProfile.actions.map((item) => item.label), ['Draft a post', 'Draft a reply', 'Strengthen the hook', 'Add supporting detail']);

  const commonCases = [
    ['https://www.youtube.com/watch?v=1', '<form><div contenteditable="true" role="textbox" aria-label="Add a comment"></div></form>', 'Draft a reply'],
    ['https://mail.google.com/mail/u/0/#inbox/thread', '<main>Reply<form><div contenteditable="true" role="textbox" aria-label="Message Body"></div></form></main>', 'Draft a reply'],
    ['https://app.slack.com/client/T1/C1', '<form><div contenteditable="true" role="textbox" aria-label="Message #general"></div></form>', 'Draft a message'],
    ['https://web.whatsapp.com/', '<main><div contenteditable="true" role="textbox" aria-label="Type a message"></div></main>', 'Draft a message'],
  ];
  for (const [url, html, primaryLabel] of commonCases) {
    const document = doc(html, url);
    const profile = inspectInlineSite(document, document.querySelector('[contenteditable]'), { url });
    assert.equal(profile.actions.length, 3, `${profile.adapterId} lost useful secondary actions`);
    assert.equal(profile.actions[0].label, primaryLabel);
  }

  const chatgpt = doc('<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div></form>', 'https://chatgpt.com/');
  assert.deepEqual(
    inspectInlineSite(chatgpt, chatgpt.querySelector('[contenteditable]'), { url: chatgpt.URL }).actions.map((item) => item.label),
    ['Improve ChatGPT prompt', 'Add constraints and checks', 'Turn into research brief'],
  );
});

test('safe apply stays allowlisted while framework-heavy editors remain copy-only', () => {
  const github = doc('<form><textarea aria-label="Comment"></textarea></form>', 'https://github.com/nous/hermes/issues/1');
  assert.equal(inspectInlineSite(github, github.querySelector('textarea'), { url: github.URL }).applyMode, 'safe-apply');
  const docs = doc('<main><div contenteditable="true" role="textbox"></div></main>', 'https://docs.google.com/document/d/1/edit');
  assert.equal(inspectInlineSite(docs, docs.querySelector('[contenteditable]'), { url: docs.URL }).applyMode, 'copy-only');
});

test('high-risk web messengers remain explicit conservative fallback profiles', () => {
  for (const [adapterId, url] of [
    ['whatsapp', 'https://web.whatsapp.com/'],
    ['telegram', 'https://web.telegram.org/k/'],
  ]) {
    const document = doc('<main><div contenteditable="true" role="textbox" aria-label="Message"></div></main>', url);
    const profile = inspectInlineSite(document, document.querySelector('[contenteditable]'), { url });
    assert.equal(profile.adapterId, adapterId);
    assert.equal(profile.supportTier, 'conservative-fallback');
    assert.equal(profile.contextMode, 'draft');
    assert.equal(profile.applyMode, 'copy-only');
  }
});
