import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8');
const [sidepanel, html, css, en, pkg] = await Promise.all([
  read('../extension/sidepanel.js'),
  read('../extension/sidepanel.html'),
  read('../extension/sidepanel.css'),
  read('../extension/lib/locales/en.mjs'),
  read('../scripts/check-js.mjs'),
]);

function functionBody(name) {
  const start = sidepanel.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = sidepanel.indexOf('\nfunction ', start + 10);
  return sidepanel.slice(start, next === -1 ? undefined : next);
}

test('the pill is a real, initially hidden button with an i18n label inside the dock', () => {
  const dock = html.slice(html.indexOf('<footer class="bottom-dock"'));
  assert.match(dock, /<button id="jumpToLatestButton" class="jump-to-latest" type="button" hidden aria-label="Jump to latest"/);
  assert.match(dock, /data-i18n-aria-label="chat\.jump_to_latest"/);
  assert.match(dock, /id="jumpToLatestLabel"[^>]*data-i18n="chat\.jump_to_latest"/);
});

test('the pill keeps square corners, the accent border and theme tokens', () => {
  const rule = css.slice(css.indexOf('.jump-to-latest {'), css.indexOf('.jump-to-latest[hidden]'));
  assert.match(rule, /border-radius: 0/);
  assert.match(rule, /var\(--hermes-accent\)/);
  assert.match(rule, /var\(--hermes-font-mono\)/);
  assert.match(rule, /inset-block-end: calc\(100% \+/);
  assert.match(rule, /max-inline-size: calc\(100% - 24px\)/);
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.jump-to-latest \{ animation: none/);
});

test('the pill strings are translated and count with a plural form', () => {
  assert.match(en, /"chat\.jump_to_latest": "Jump to latest"/);
  assert.match(en, /"chat\.jump_to_latest_count": Object\.freeze\(\{"one":"\{count\} new message","other":"\{count\} new messages"\}\)/);
  assert.match(en, /"chat\.jump_to_latest_count_aria"/);
});

test('the click scrolls smoothly, or instantly under reduced motion', () => {
  const body = functionBody('jumpToLatest');
  assert.match(body, /prefers-reduced-motion: reduce/);
  assert.match(body, /behavior: reduceMotion \? 'auto' : 'smooth'/);
  assert.match(sidepanel, /jumpToLatestButton\.addEventListener\('click', jumpToLatest\)/);
});

test('visibility follows scrolling through the shared near-bottom rule and drops the tab stop', () => {
  const body = functionBody('updateJumpToLatest');
  assert.match(body, /shouldShowJumpToLatest\(/);
  assert.match(body, /threshold: MESSAGE_STICKY_SCROLL_THRESHOLD_PX/);
  assert.match(body, /button\.hidden = !show/);
  assert.match(body, /newBelowTracker\.reset\(\)/);
  assert.match(sidepanel, /scroller\.addEventListener\('scroll', scheduleJumpToLatestUpdate, \{ passive: true \}\)/);
  assert.match(sidepanel, /^ {2}bindJumpToLatest\(\);$/m);
});

test('a reply that arrives while scrolled up is counted instead of yanking the view', () => {
  const add = sidepanel.slice(sidepanel.indexOf('function addMessage('), sidepanel.indexOf('function appendContextReceipt('));
  assert.match(add, /const followedTail = !scroll \|\| isMessageStreamNearBottom\(\);\s*els\.messages\.appendChild\(row\)/);
  assert.match(add, /role === 'assistant' && !followedTail\) noteMessageBelow\(node\)/);
  assert.match(add, /else scrollMessageStreamToBottom\(\{ force: true \}\)/);
});

test('streaming growth counts the live reply once', () => {
  const body = functionBody('handleMessageListResize');
  assert.match(body, /liveStreamingMessageNode\(\)/);
  assert.match(body, /newBelowTracker\.note\(live\)/);
});

test('rendering a different transcript opens at the newest message', () => {
  const render = functionBody('renderMessagesFromStorage');
  assert.match(render, /isTranscriptOpen\(renderedTranscriptKey, transcriptKey\)/);
  assert.match(render, /const stickToBottom = !scroller \|\| opening \|\| openPin\.isActive\(performance\.now\(\)\) \|\| isMessageStreamNearBottom\(\)/);
  assert.match(render, /if \(opening\) pinMessageStreamToLatest\(\)/);
  // A refresh of the transcript on screen still restores a reader who scrolled up.
  assert.match(render, /else if \(scroller\) requestAnimationFrame\(\(\) => \{ scroller\.scrollTop = previousTop; \}\)/);
});

test('the transcript identity covers storage scope, room, thread and session', () => {
  const body = functionBody('currentTranscriptKey');
  for (const part of ['activeMessagesStorageKey()', 'activeGroupProjection', 'activeGroupThreadId', 'settings.sessionId']) {
    assert.ok(body.includes(part), part);
  }
});

test('late layout re-pins an opened transcript until the person takes over', () => {
  assert.match(functionBody('repinOpenedTranscript'), /openPin\.isActive\(now\)/);
  assert.match(sidepanel, /new globalThis\.ResizeObserver\(handleMessageListResize\)/);
  assert.match(sidepanel, /for \(const type of \['wheel', 'touchstart', 'pointerdown'\]\)/);
  assert.match(sidepanel, /scroller\.addEventListener\(type, releaseOpenPin/);
});

test('every transcript path renders through the one function that opens at the bottom', () => {
  // Session open, startup restore, scope change, bot chat and room openers all
  // call renderMessagesFromStorage; none paints message rows by another route.
  assert.equal((sidepanel.match(/function renderMessagesFromStorage\(/g) || []).length, 1);
  assert.match(sidepanel, /renderMessagesFromStorage\(\);\s*updateSessionLabel\(\);\s*let groupRuntime = null;/);
  assert.match(sidepanel, /async function loadMessagesForActiveScope[\s\S]{0,900}renderMessagesFromStorage\(\);/);
  assert.match(sidepanel, /async function commitFetchedSessionMessages[\s\S]{0,4000}renderMessagesFromStorage\(\);/);
});

test('the new module is syntax-checked with the rest', () => {
  assert.match(pkg, /node --check extension\/lib\/scroll-latest\.mjs/);
});
