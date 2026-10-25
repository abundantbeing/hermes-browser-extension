import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const panel = await read('extension/sidepanel.js');
const html = await read('extension/sidepanel.html');
const css = await read('extension/sidepanel.css');
const common = await read('extension/lib/common.mjs');
const thread = await read('extension/lib/message-thread-ui.mjs');
const pkg = JSON.parse(await read('package.json'));

test('panel uses the shared rail, divider, and truthful timestamp helpers', () => {
  assert.match(panel, /import\s*\{[^}]*createMessageThreadUi[^}]*\}\s*from\s*['"]\.\/lib\/message-thread-ui\.mjs['"]/);
  assert.match(panel, /import\s*\{[^}]*normalizeMessageTimestamp[^}]*\}\s*from\s*['"]\.\/lib\/message-meta\.mjs['"]/);
  assert.match(thread, /buildMessageRail/);
  assert.match(thread, /buildDayDivider/);
});

test('gateway history never substitutes the load time for a missing timestamp', () => {
  assert.doesNotMatch(panel, /message\.timestamp\s*\|\|\s*(?:message\.ts\s*\|\|\s*)?Date\.now\(\)/);
  assert.match(panel, /ts:\s*normalizeMessageTimestamp\(message\.timestamp\s*\?\?\s*message\.ts\)/);
});

test('a live panel reply gets its time when the stream finishes and keeps it when saved', () => {
  // The live bubble streams without a time; flushing the stream ends streaming
  // on the shared thread, which stamps the finish time on the shown record.
  const updater = panel.slice(panel.indexOf('function createStreamingMessageUpdater('), panel.indexOf('const paintStream = '));
  assert.match(updater, /panelMessageThread\?\.setStreaming\(row,\s*false\)/);
  assert.match(panel, /addMessage\('assistant', THINKING_PLACEHOLDER, \{ persist: false, roleLabel: assistantMessageRoleLabel\(\), streaming: true \}\)/);
  assert.match(panel, /messages\.push\(\{ role: 'assistant', content: finalAnswerForStorage, ts: Date\.now\(\) \}\)/);
});

test('history replay passes stored time and row identity rather than inventing them', () => {
  const replay = panel.slice(panel.indexOf('function renderMessagesFromStorage()'), panel.indexOf('function syncSettingsForm()'));
  assert.match(replay, /ts:\s*message\.ts/);
  assert.match(replay, /rowId:\s*message\.rowId/);
  assert.match(replay, /speaker:\s*message\.speaker/);
});

test('message wrapper preserves the focusable article shell', () => {
  assert.match(html, /<template id="messageTemplate">\s*<div class="message-row">\s*<article class="message" tabindex="0">/);
  assert.match(css, /\.message-row\.is-pinned\s*>\s*\.message-rail/);
  assert.match(css, /\.message-day-divider/);
});

test('message time preference defaults on and is wired through settings', () => {
  assert.match(common, /showMessageTimes:\s*true/);
  assert.match(html, /id="showMessageTimesInput"/);
  assert.match(panel, /hide-message-times/);
  assert.match(panel, /showMessageTimesInput/);
});

test('streaming replies explicitly disable and later enable rail copy', () => {
  assert.match(panel, /setRailCopyEnabled\([^;]+false\)/);
  assert.match(panel, /setRailCopyEnabled\([^;]+true\)/);
});

test('all six new shared modules participate in syntax verification', () => {
  for (const name of ['message-meta', 'message-actions', 'message-rewind', 'bot-identity', 'group-presence', 'group-member-models']) {
    assert.ok(pkg.scripts['check:js'].includes(`node --check extension/lib/${name}.mjs`), name);
  }
});
