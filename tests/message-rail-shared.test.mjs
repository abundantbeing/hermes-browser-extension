// Full-tab message parity (M-A5): the full-tab surface reuses the shared
// message-thread-ui / message-actions / message-meta modules for time, copy,
// and day dividers, and mirrors the side panel's rail, divider, run grouping,
// and dark glass in app.css. Edit and restore stay off in the full tab because
// it does not send through the dashboard WebSocket prompt.submit path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const app = read('extension/app.js');
const appCss = read('extension/app.css');
const appHtml = read('extension/app.html');
const threadUi = read('extension/lib/message-thread-ui.mjs');
const actions = read('extension/lib/message-actions.mjs');

test('full-tab reuses the shared thread controller and truthful timestamps', () => {
  assert.match(app, /import\s*\{[^}]*createMessageThreadUi[^}]*\}\s*from\s*['"]\.\/lib\/message-thread-ui\.mjs['"]/);
  assert.match(app, /import\s*\{[^}]*normalizeMessageTimestamp[^}]*\}\s*from\s*['"]\.\/lib\/message-meta\.mjs['"]/);
  assert.match(app, /webMessageThread\s*\|\|=\s*createMessageThreadUi\(/);
  assert.match(app, /webMessageThread\.attach\(\{/);
  assert.match(app, /ts:\s*normalizeMessageTimestamp\(message\.timestamp\s*\?\?\s*message\.ts\)/);
});

test('full-tab rows wrap the article so the shared rail has a row to attach to', () => {
  assert.match(app, /article\.className\s*=\s*`message web-message \$\{role\}`/);
  assert.match(app, /row\.className\s*=\s*'message-row web-message-row'/);
  assert.match(app, /row\.append\(article\)/);
});

test('full-tab rails carry copy and time on user messages and replies', () => {
  assert.match(threadUi, /buildMessageRail/);
  // Every user message and reply shows its time; a reply only once it has
  // finished streaming.
  assert.match(threadUi, /showTime:\s*!streaming\b/);
  assert.match(actions, /message-action-copy/);
  assert.match(app, /buildCleanClipboardPayload/);
});

test('full-tab live turns stamp the send time and the reply finish time', () => {
  assert.match(app, /const user = \{[^}]*\bts:\s*Date\.now\(\)/);
  assert.match(app, /const stampReply = \(\) => \{\s*assistant\.ts \?\?= Date\.now\(\);\s*\}/);
  // Both stream transports and the accepted-turn recovery stamp the reply.
  const send = app.slice(app.indexOf('async function sendPrompt('), app.indexOf('function showError('));
  assert.equal(send.match(/stampReply\(\);/g)?.length, 3);
  assert.ok(send.indexOf('stampReply();') < send.indexOf('client.getSessionMessages(runSessionId)'));
});

test('full-tab does not build edit or restore actions', () => {
  // canRewind defaults to false and the full tab never overrides it.
  assert.doesNotMatch(app, /canRewind/);
  assert.doesNotMatch(app, /message-rewind\.mjs/);
  assert.doesNotMatch(app, /beginEditMessage|confirmRestoreMessage|message-editor|message-restore-popover/);
});

test('full-tab honours the Show message times preference', () => {
  assert.match(app, /classList\.toggle\('hide-message-times',\s*settings\.showMessageTimes === false\)/);
  assert.match(appCss, /body\.hide-message-times\s+\.message-time\s*\{\s*display:\s*none/);
});

test('app.css mirrors the rail, divider, run grouping, and entrance from the side panel', () => {
  assert.match(appCss, /\.message-row\s*\{[^}]*position:\s*relative/);
  assert.match(appCss, /\.message-row\[data-role="user"\]\s*\{[^}]*align-items:\s*flex-end/);
  assert.match(appCss, /\.message-rail\s*\{[^}]*min-height:\s*24px/);
  assert.match(appCss, /\.message-row\.is-pinned\s*>\s*\.message-rail/);
  assert.match(appCss, /\.message-row\[data-actions="left"\]\s*>?\s*\.message-rail/);
  assert.match(appCss, /\.message-day-divider/);
  assert.match(appCss, /\.message-day-divider-label/);
  assert.match(appCss, /\.message-row\.is-run-continuation/);
  assert.match(appCss, /\.message-row\.has-run-next\s*>\s*\.message/);
  assert.match(appCss, /prefers-reduced-motion:\s*reduce[\s\S]*?\.message-row\.is-entering|\.message-row\.is-entering[\s\S]*?prefers-reduced-motion:\s*reduce/);
});

test('app.css glasses dark bubbles from tokens while light stays opaque', () => {
  // The parity :root block sets the light defaults to opaque (any :root block,
  // so an earlier token block in the file cannot satisfy the check by accident).
  assert.match(appCss, /--hermes-bubble-user-alpha:\s*100%/);
  assert.match(appCss, /--hermes-bubble-assistant-alpha:\s*100%/);
  assert.match(appCss, /--hermes-bubble-blur:\s*0px/);
  const dark = appCss.match(/html\[data-hermes-mode="dark"\]\s*\{([\s\S]*?)\}/)?.[1] || '';
  const userAlpha = Number(dark.match(/--hermes-bubble-user-alpha:\s*(\d+)%/)?.[1]);
  const assistantAlpha = Number(dark.match(/--hermes-bubble-assistant-alpha:\s*(\d+)%/)?.[1]);
  assert.ok(userAlpha >= 25 && userAlpha <= 90, `dark user alpha ${userAlpha}% in range`);
  assert.ok(assistantAlpha >= 25 && assistantAlpha <= 90, `dark assistant alpha ${assistantAlpha}% in range`);
  assert.match(dark, /--hermes-bubble-blur:\s*\d+(?:\.\d+)?px/);
  assert.match(appCss, /html\[data-hermes-mode="dark"\]\s+\.message-row\s*>\s*\.message\.user\s*\{[^}]*var\(--hermes-bubble-user-alpha\)/);
  assert.match(appCss, /html\[data-hermes-mode="dark"\]\s+\.message-row\s*>\s*\.message\.assistant\s*\{[^}]*var\(--hermes-bubble-assistant-alpha\)/);
  assert.match(appCss, /backdrop-filter:\s*blur\(var\(--hermes-bubble-blur\)\)\s*saturate\(var\(--hermes-bubble-saturate\)\)/);
  assert.match(appCss, /@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*,\s*\(forced-colors:\s*active\)/);
  // No unconditional (non dark-scoped) glass rule that could override light opacity.
  assert.doesNotMatch(appCss, /^\.message\.user\s*\{[^}]*background:\s*color-mix/m);
});

test('app.html still loads app.css, app-parity.css, and fulltab-themes.css in order', () => {
  assert.match(appHtml, /href="app\.css"/);
  assert.match(appHtml, /href="app-parity\.css"/);
  assert.match(appHtml, /href="fulltab-themes\.css"/);
});