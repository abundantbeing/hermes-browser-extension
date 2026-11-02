import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parseHTML } from 'linkedom';

import { buildInlineDraftRequest, withoutSecretText } from '../extension/lib/inline-draft-policy.mjs';
import { ASSIST_CONTEXT_CHARS, captureInlineSiteContext, inlineSiteContext, inspectInlineSite } from '../extension/lib/site-adapters.mjs';

function page(html, url, contextPreferences = {}) {
  const { document } = parseHTML(`<!doctype html><html><head><title>Page title</title></head><body>${html}</body></html>`);
  Object.defineProperty(document, 'URL', { configurable: true, value: url });
  const target = document.querySelector('[data-field]');
  const profile = inspectInlineSite(document, target, { url, contextPreferences });
  return { document, target, profile, read: () => inlineSiteContext(document, target, profile) };
}

const order = (text, ...parts) => {
  let at = -1;
  for (const part of parts) {
    const next = text.indexOf(part, at + 1);
    assert.ok(next > at, `"${part}" comes after the previous part`);
    at = next;
  }
};

test('a GitHub pull request reads as its title, state and every comment with its author and time', () => {
  const { read } = page(`<main id="js-repo-pjax-container">
    <nav>Code Issues Pull requests Actions</nav>
    <h1 class="gh-header-title"><bdi class="js-issue-title">Hermes Assist refresh</bdi> <span>#147</span></h1>
    <span class="State">Open</span>
    <div class="TimelineItem"><div class="timeline-comment-group"><a class="author">abundantbeing</a> commented <relative-time datetime="2026-11-01T16:44:21Z">Nov 1</relative-time>
      <div class="edit-comment-hide"><div class="comment-body markdown-body js-comment-body"><p>This PR is the whole refresh.</p></div></div>
      <button>React with 👍 3</button></div></div>
    <div class="TimelineItem"><div class="timeline-comment-group"><a class="author">reviewer-one</a> commented <relative-time datetime="2026-11-02T09:00:00Z">Nov 2</relative-time>
      <div class="comment-body markdown-body js-comment-body"><p>Does the quick menu close on Escape?</p></div></div></div>
    <div class="TimelineItem"><div class="timeline-comment-group"><a class="author">abundantbeing</a> commented <relative-time datetime="2026-11-02T10:30:00Z">Nov 2</relative-time>
      <div class="comment-body markdown-body js-comment-body"><p>It does now.</p></div></div></div>
    <form class="js-new-comment-form"><textarea data-field aria-label="Add a comment"></textarea><div class="comment-body markdown-body js-preview-body">Nothing to preview</div></form>
  </main>`, 'https://github.com/abundantbeing/hermes-browser-extension/pull/147');
  const { text, messages } = read();
  assert.equal(messages, 3);
  assert.match(text, /^GitHub pull request #147 in abundantbeing\/hermes-browser-extension \(Open\): Hermes Assist refresh/);
  assert.match(text, /You are writing a comment on this pull request\./);
  order(text, 'abundantbeing · 2026-11-01 16:44 UTC (opening post):\nThis PR is the whole refresh.', 'reviewer-one · 2026-11-02 09:00 UTC:\nDoes the quick menu close on Escape?', 'abundantbeing · 2026-11-02 10:30 UTC:\nIt does now.');
  assert.doesNotMatch(text, /React with|Code Issues|Nothing to preview/);
});

test('a GitHub issue in the new layout reads its body, its comments and how many items GitHub is hiding', () => {
  const { read } = page(`<main>
    <h1 data-testid="issue-title">Allow changing the workbench font</h1><span data-testid="header-state">Open</span>
    <div data-testid="issue-body"><a data-testid="issue-body-header-author">hsdk123</a><relative-time datetime="2015-11-24T08:00:00Z">Nov 24, 2015</relative-time>
      <div data-testid="issue-body-viewer"><div data-testid="markdown-body" class="markdown-body">We can only change the editor font.</div></div></div>
    <div data-testid="issue-timeline-container">
      <div data-testid="comment-viewer-outer-box-A1"><div data-testid="comment-header"><a data-testid="avatar-link" href="/bpasero"></a><a href="/bpasero">bpasero</a><relative-time datetime="2015-11-25T08:00:00Z">Nov 25</relative-time></div>
        <div data-testid="markdown-body" class="markdown-body">Duplicate of an older request.</div></div>
      <div data-testid="issue-timeline-load-more-container-load-top"><span data-testid="issue-timeline-load-more-count-load-top">1,193 remaining items</span><button>Load more</button></div>
      <div data-testid="comment-viewer-outer-box-A2"><div data-testid="comment-header"><a href="/oli">oli</a><relative-time datetime="2026-07-02T08:00:00Z">Jul 2</relative-time></div>
        <div data-testid="markdown-body" class="markdown-body">Over ten years now.</div></div>
    </div>
    <div data-testid="issue-viewer-comment-box"><textarea data-field aria-label="Add a comment"></textarea></div>
  </main>`, 'https://github.com/microsoft/vscode/issues/519');
  const { text, messages } = read();
  assert.equal(messages, 3);
  assert.match(text, /^GitHub issue #519 in microsoft\/vscode \(Open\): Allow changing the workbench font/);
  assert.match(text, /GitHub is hiding 1,193 items in the middle of this thread/);
  order(text, 'hsdk123 · 2015-11-24 08:00 UTC (opening post):\nWe can only change the editor font.', 'bpasero · 2015-11-25 08:00 UTC:', 'oli · 2026-07-02 08:00 UTC:\nOver ten years now.');
});

test('a long thread keeps the opening post and the newest messages, and says how many were left out', () => {
  const comments = Array.from({ length: 40 }, (_, index) => `<div class="timeline-comment-group"><a class="author">user${index}</a><div class="js-comment-body">${`Comment ${index}. `.repeat(60)}</div></div>`).join('');
  const { read } = page(`<main><bdi class="js-issue-title">Big thread</bdi>${comments}<form><textarea data-field aria-label="Add a comment"></textarea></form></main>`, 'https://github.com/o/r/issues/9');
  const { text } = read();
  assert.ok(text.length <= ASSIST_CONTEXT_CHARS, `${text.length} characters`);
  assert.match(text, /user0 \(opening post\):\nComment 0\./);
  assert.match(text, /user39:\nComment 39\./);
  assert.match(text, /\[\d+ earlier messages left out to fit\]/);
  assert.doesNotMatch(text, /user20:/);
});

test('a GitHub review comment reads the file and the lines of code above it', () => {
  const { read } = page(`<div class="file" data-tagsearch-path="src/panel.js"><table class="diff-table"><tbody>
    <tr><td class="blob-num"></td><td class="blob-code blob-code-inner">@@ -1,3 +1,3 @@</td></tr>
    <tr><td class="blob-num">1</td><td class="blob-code blob-code-deletion blob-code-inner">const size = 44;</td></tr>
    <tr><td class="blob-num">1</td><td class="blob-code blob-code-addition blob-code-inner">const size = 32;</td></tr>
    <tr class="inline-comments"><td colspan="2"><textarea data-field aria-label="Add a comment"></textarea></td></tr>
  </tbody></table></div>`, 'https://github.com/o/r/pull/3/files');
  const { text } = read();
  assert.match(text, /You are writing a review comment on the code above\./);
  assert.match(text, /File src\/panel\.js/);
  order(text, '- const size = 44;', '+ const size = 32;');
});

test('an X reply reads the conversation above the box, newest last, with who wrote each post', () => {
  const post = (name, handle, time, body, extra = '') => `<article data-testid="tweet"><div data-testid="User-Name"><span>${name}</span><span>@${handle}</span><span>·</span><time datetime="${time}">1h</time></div><div data-testid="tweetText">${body}</div>${extra}<div role="group">12 replies 30 reposts 400 likes</div></article>`;
  const { read } = page(`<main role="main">
    ${post('Ada', 'ada', '2026-11-02T08:00:00Z', 'Shipping the new panel today.')}
    ${post('Grace', 'grace', '2026-11-02T08:30:00Z', 'How does it pick where to sit?', '<div data-testid="tweetPhoto"><img alt="A screenshot of the panel"></div>')}
    <div><span>Post your reply</span><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text" data-field></div></div>
    ${post('Later', 'later', '2026-11-02T09:00:00Z', 'A reply below the box.')}
  </main>`, 'https://x.com/ada/status/1');
  const { text, messages } = read();
  assert.equal(messages, 2);
  assert.match(text, /You are writing a reply to Grace \(@grace\)\./);
  order(text, 'Ada (@ada) · 2026-11-02 08:00 UTC:\nShipping the new panel today.', 'Grace (@grace) · 2026-11-02 08:30 UTC (you are replying to this):\nHow does it pick where to sit?\n[Image: A screenshot of the panel]');
  assert.doesNotMatch(text, /400 likes|A reply below the box/);
});

test('an X conversation of more than ten posts keeps the opening post when the thread fits', () => {
  const posts = Array.from({ length: 12 }, (_, index) => `<article data-testid="tweet"><div data-testid="User-Name"><span>User ${index}</span><span>@u${index}</span></div><div data-testid="tweetText">Post number ${index}.</div></article>`).join('');
  const { read } = page(`<main role="main">${posts}<div><span>Post your reply</span><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text" data-field></div></div></main>`, 'https://x.com/u0/status/1');
  const { text, messages } = read();
  assert.equal(messages, 12);
  assert.match(text, /User 0 \(@u0\):\nPost number 0\./);
  assert.doesNotMatch(text, /left out/);
});

test('an X reply in the pop-out reads only the post in the dialog, not the timeline behind it', () => {
  const { read } = page(`<main role="main"><article data-testid="tweet"><div data-testid="tweetText">Timeline post behind the dialog.</div></article></main>
    <div role="dialog"><article data-testid="tweet"><div data-testid="User-Name"><span>Ada</span><span>@ada</span></div><div data-testid="tweetText">The post being replied to.</div></article>
      <div><span>Replying to @ada</span><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text" data-field></div></div></div>`, 'https://x.com/compose/post');
  const { text } = read();
  assert.match(text, /The post being replied to\./);
  assert.doesNotMatch(text, /Timeline post behind the dialog/);
});

test('X without its test ids (signed out) still reads each post, without the counts', () => {
  const { read } = page(`<main role="main"><article><div>jack</div><div>@jack</div><div>just setting up my twttr</div><div>9:50 PM · Mar 21, 2006</div><div>18K</div><div>131K</div></article>
    <div><span>Post your reply</span><div contenteditable="true" role="textbox" aria-label="Post text" data-field></div></div></main>`, 'https://x.com/jack/status/20');
  const { text } = read();
  assert.match(text, /jack \(@jack\) \(you are replying to this\):\njust setting up my twttr$/);
  assert.doesNotMatch(text, /\b131K\b|9:50 PM/);
});

test('a Gmail reply reads the whole thread, collapsed messages included, without each message quoting the last', () => {
  const { read } = page(`<div role="main"><h2 class="hP">Contract renewal</h2>
    <div data-message-id="m1" style="display:none"><span class="gD" email="sam@example.com">Sam Lee</span><span class="g3" title="Mon, Nov 2, 2026, 9:00 AM">Nov 2</span><div class="a3s">Can we renew for another year at the same rate?</div></div>
    <div data-message-id="m2"><span class="gD" email="pat@example.com">Pat Kim</span><span class="g3" title="Mon, Nov 2, 2026, 11:00 AM">Nov 2</span><div class="a3s">We can, if the term starts in January.<div class="gmail_quote">On Mon, Sam Lee wrote: Can we renew for another year at the same rate?</div></div></div>
    <div class="M9"><div class="Am" contenteditable="true" role="textbox" aria-label="Message Body" data-field></div></div>
  </div>`, 'https://mail.google.com/mail/u/0/#inbox/FMfcgz123', { gmail: 'visible' });
  const { text, messages } = read();
  assert.equal(messages, 2);
  assert.match(text, /^Email thread: Contract renewal/);
  assert.match(text, /You are writing a reply to this email thread\./);
  order(text, 'Sam Lee · Mon, Nov 2, 2026, 9:00 AM:\nCan we renew', 'Pat Kim · Mon, Nov 2, 2026, 11:00 AM (you are replying to this):\nWe can, if the term starts in January.');
  assert.doesNotMatch(text, /On Mon, Sam Lee wrote/);
});

test('Gmail stays unread until the site is set to read the thread', () => {
  const { read } = page('<div role="main"><div data-message-id="m1"><div class="a3s">Private body.</div></div><div contenteditable="true" role="textbox" aria-label="Message Body" data-field></div></div>', 'https://mail.google.com/mail/u/0/#inbox/FMfcgz123');
  assert.deepEqual({ ...read() }, { text: '', messages: 0 });
});

test('a YouTube reply reads the video and the comment thread up to the comment being answered', () => {
  const { read } = page(`<ytd-watch-flexy>
    <div id="player-ads">Stream something else now. Sponsored</div>
    <ytd-watch-metadata><div id="title"><h1>Never Gonna Give You Up</h1></div><ytd-channel-name><div id="text">Rick Astley</div></ytd-channel-name>
      <ytd-text-inline-expander id="description-inline-expander"><yt-attributed-string>The official video, remastered in 4K.</yt-attributed-string></ytd-text-inline-expander></ytd-watch-metadata>
    <ytd-comments id="comments"><ytd-comment-thread-renderer>
      <ytd-comment-view-model id="comment"><span id="author-text">@fan</span><span id="published-time-text">6 years ago</span><span id="content-text">This is a banging song.</span></ytd-comment-view-model>
      <div id="replies"><ytd-comment-view-model><span id="author-text">@second</span><span id="published-time-text">5 years ago</span><span id="content-text">Agreed, the bassline!</span>
        <div id="reply-dialog"><div id="contenteditable-root" contenteditable="true" aria-label="Add a reply..." data-field></div></div></ytd-comment-view-model>
        <ytd-comment-view-model><span id="author-text">@third</span><span id="content-text">A later reply.</span></ytd-comment-view-model></div>
    </ytd-comment-thread-renderer></ytd-comments>
    <div id="related">Some other video 1B views</div>
  </ytd-watch-flexy>`, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const { text } = read();
  assert.match(text, /^YouTube video: Never Gonna Give You Up, by Rick Astley/);
  assert.match(text, /You are writing a reply to @second's comment\./);
  order(text, 'The official video, remastered in 4K.', '@fan · 6 years ago:\nThis is a banging song.', '@second · 5 years ago (you are replying to this):\nAgreed, the bassline!');
  assert.doesNotMatch(text, /Sponsored|1B views|A later reply/);
});

test('a Reddit reply reads the post and the chain of comments down to the one being answered', () => {
  const { read } = page(`<main><shreddit-post post-title="Apollo dev posts backend code" author="GhostalMedia" created-timestamp="2023-06-09T01:00:00Z" subreddit-prefixed-name="r/programming"><div slot="text-body">Link to the repository.</div></shreddit-post>
    <shreddit-comment-tree>
      <shreddit-comment author="DoubleF3lix" depth="0" created="2023-06-09T03:19:33Z"><div slot="comment">spez is a mod here lol</div>
        <shreddit-comment author="other" depth="1" created="2023-06-09T04:00:00Z"><div slot="comment">Since when?</div>
          <div slot="reply"><div contenteditable="true" role="textbox" aria-label="Reply" data-field></div></div></shreddit-comment>
      </shreddit-comment>
      <shreddit-comment author="unrelated" depth="0"><div slot="comment">A different thread.</div></shreddit-comment>
    </shreddit-comment-tree></main>`, 'https://www.reddit.com/r/programming/comments/144sn8r/x/');
  const { text } = read();
  assert.match(text, /^Reddit post in r\/programming: Apollo dev posts backend code/);
  order(text, 'u/GhostalMedia · 2023-06-09 01:00 UTC (the post):\nLink to the repository.', 'u/DoubleF3lix · 2023-06-09 03:19 UTC:\nspez is a mod here lol', 'u/other · 2023-06-09 04:00 UTC (you are replying to this):\nSince when?');
  assert.doesNotMatch(text, /A different thread/);
});

test('a LinkedIn comment reads the post it is under, not the whole feed', () => {
  const { read } = page(`<main>
    <div class="feed-shared-update-v2" data-urn="urn:li:activity:1"><span class="update-components-actor__title"><span aria-hidden="true">First Poster</span></span><div class="update-components-text">An unrelated post higher in the feed.</div></div>
    <div class="feed-shared-update-v2" data-urn="urn:li:activity:2"><span class="update-components-actor__title"><span aria-hidden="true">Second Poster</span></span><div class="update-components-text">We just opened our new office.</div>
      <div class="comments-comment-box"><div contenteditable="true" role="textbox" aria-label="Add a comment…" data-field></div></div></div>
  </main>`, 'https://www.linkedin.com/feed/');
  const { text } = read();
  assert.match(text, /Second Poster[^\n]*:\nWe just opened our new office\./);
  assert.doesNotMatch(text, /unrelated post higher in the feed/);
});

test('real page details: an empty twin earlier in the page never hides the title, the author or a nested body', () => {
  // YouTube renders an empty miniplayer h1 before the video's title, and the description outside yt-attributed-string.
  const youtube = page(`<ytd-app><ytd-miniplayer><h1></h1></ytd-miniplayer><ytd-watch-flexy><ytd-watch-metadata><div id="title"><h1>The real title</h1></div>
    <ytd-text-inline-expander id="description-inline-expander"><yt-attributed-string></yt-attributed-string><span>The description text. …more</span></ytd-text-inline-expander></ytd-watch-metadata>
    <ytd-comments><div contenteditable="true" aria-label="Add a comment..." data-field></div></ytd-comments></ytd-watch-flexy></ytd-app>`, 'https://www.youtube.com/watch?v=1').read().text;
  assert.match(youtube, /^YouTube video: The real title/);
  assert.match(youtube, /The description text\./);
  assert.doesNotMatch(youtube, /more$/m);
  // GitHub's comment header starts with an empty avatar link; its avatar link names the user twice; the title ends "- # 147".
  const github = page(`<main><h1>Fix the thing - # 147</h1><div data-testid="comment-viewer-outer-box-1"><div data-testid="comment-header"><a href="/skube"></a><a data-testid="avatar-link" href="/skube">skube (skube)</a></div>
    <div data-testid="markdown-body">Looks good.</div></div><textarea data-field aria-label="Add a comment"></textarea></main>`, 'https://github.com/o/r/pull/147').read().text;
  assert.match(github, /: Fix the thing\n/);
  assert.match(github, /skube \(opening post\):\nLooks good\./);
  // Reddit wraps a comment's body: shreddit-comment > details > div > div[slot="comment"].
  const reddit = page(`<shreddit-post post-title="Title" author="op" content-href="/r/other/comments/1/x/"></shreddit-post>
    <shreddit-comment author="first"><details><div><div slot="comment">The wrapped body.</div></div></details>
      <div contenteditable="true" role="textbox" aria-label="Reply" data-field></div></shreddit-comment>`, 'https://www.reddit.com/r/a/comments/2/y/').read().text;
  assert.match(reddit, /u\/first \(you are replying to this\):\nThe wrapped body\./);
  assert.match(reddit, /Link: https:\/\/www\.reddit\.com\/r\/other\/comments\/1\/x\//);
});

test('any other site keeps the text nearest the field when there is too much to send', () => {
  const history = Array.from({ length: 900 }, (_, index) => `<div class="message">Message number ${index} in the channel history.</div>`).join('');
  const { read } = page(`<main><h1>#general</h1>${history}<form><div contenteditable="true" role="textbox" aria-label="Message #general" data-field></div></form></main>`, 'https://app.slack.com/client/T1/C1', { slack: 'visible' });
  const { text } = read();
  assert.ok(text.length <= ASSIST_CONTEXT_CHARS, `${text.length} characters`);
  assert.match(text, /#general/);
  assert.match(text, /Message number 899 in the channel history\./);
  assert.match(text, /characters left out/);
  assert.match(text, /You are writing in the field "Message #general"\./);
});

test('captureInlineSiteContext still returns just the text', () => {
  const { document, target, profile } = page('<main><article>Visible thread.</article><form><textarea data-field aria-label="Reply"></textarea></form></main>', 'https://example.com/forum/1', { generic: 'visible' });
  assert.equal(typeof captureInlineSiteContext(document, target, { ...profile, contextMode: 'visible' }), 'string');
});

test('a wrapper with display:contents is read, not skipped as hidden', () => {
  const dom = new JSDOM('<main><div style="display:contents"><p>Inside the contents wrapper.</p></div><form><textarea data-field aria-label="Add a comment"></textarea></form></main>', { url: 'https://example.com/thread' });
  const { window } = dom;
  // Like a real browser: an element laid out as display:contents has no boxes of its own.
  window.Element.prototype.getClientRects = function getClientRects() {
    return window.getComputedStyle(this).display === 'contents' ? [] : [{ width: 10, height: 10 }];
  };
  const target = window.document.querySelector('[data-field]');
  const profile = { ...inspectInlineSite(window.document, target, { url: 'https://example.com/thread' }), contextMode: 'visible' };
  assert.match(captureInlineSiteContext(window.document, target, profile), /Inside the contents wrapper\./);
});

test('a secret on the page is taken out of the context instead of blocking the draft', () => {
  const cleaned = withoutSecretText('Steps: set password: hunter22 then send Bearer [REDACTED_BEARER] with ghp_abcdefghijklmnopqrstuvwxyz0123456789 and it fails.');
  assert.doesNotMatch(cleaned, /hunter22|Bearer|ghp_/);
  assert.match(cleaned, /Steps: set \[secret removed\] then send \[secret removed\] with \[secret removed\] and it fails\./);
  const { document } = parseHTML('<textarea aria-label="Add a comment"></textarea>');
  const built = buildInlineDraftRequest(document.querySelector('textarea'), {
    action: { id: 'draft-reply', label: 'Draft a reply', mode: 'draft-copy-only', startsFromPage: true },
    requestId: 'request-0001',
    documentId: 'document-0001',
    pageContext: cleaned,
  });
  assert.equal(built.ok, true, built.reason);
});

test('the request carries the whole bounded context', () => {
  const { document } = parseHTML('<textarea aria-label="Add a comment"></textarea>');
  const built = buildInlineDraftRequest(document.querySelector('textarea'), {
    action: { id: 'draft-reply', label: 'Draft a reply', mode: 'draft-copy-only', startsFromPage: true },
    requestId: 'request-0001',
    documentId: 'document-0001',
    pageContext: 'x'.repeat(ASSIST_CONTEXT_CHARS),
  });
  assert.equal(built.request.pageContext.length, ASSIST_CONTEXT_CHARS);
});
