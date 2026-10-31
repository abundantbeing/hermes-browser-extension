import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { buildMentionPattern, highlightMentions, insertMention, mentionHandles } from '../extension/lib/room-mentions.mjs';

const members = [{ name: 'luxord', title: 'Luxord' }, { name: 'riku', title: 'Riku Prime' }];
function render(html, options = {}) {
  const { document } = parseHTML(`<html><body><div id="c">${html}</div></body></html>`);
  const root = document.querySelector('#c');
  const count = highlightMentions(root, { document, members, ...options });
  return { root, count, document };
}

test('handles: names, single-word titles and everyone; titles with spaces are not routable', () => {
  const handles = mentionHandles(members).map((h) => h.handle.toLowerCase());
  assert.deepEqual(handles.sort(), ['everyone', 'luxord', 'riku']);
  assert.equal(buildMentionPattern([]), null);
});

test('highlights valid mentions, case-insensitive, preserving surrounding text', () => {
  const { root, count } = render('<p>Hey @Luxord, ask @riku and @everyone.</p>');
  assert.equal(count, 3);
  const spans = [...root.querySelectorAll('.room-mention')];
  assert.deepEqual(spans.map((s) => s.textContent), ['@Luxord', '@riku', '@everyone']);
  assert.equal(root.textContent, 'Hey @Luxord, ask @riku and @everyone.');
  assert.equal(spans[0].getAttribute('data-mention'), 'luxord');
});

test('leaves emails, unknown handles, partial handles, code and links alone', () => {
  const { root, count } = render('<p>mail me@luxord.com, @nobody, @Luxordish</p><pre><code>@luxord</code></pre><p><a href="#">@luxord</a> `<code>@riku</code>`</p>');
  assert.equal(count, 0);
  assert.equal(root.querySelectorAll('.room-mention').length, 0);
});

test('a mention at the very start and back to back both match', () => {
  const { root, count } = render('<p>@luxord @riku</p>');
  assert.equal(count, 2);
  assert.equal(root.textContent, '@luxord @riku');
});

test('applies the per-bot ink as a css variable when provided', () => {
  const { root } = render('<p>@luxord and @everyone</p>', { inkFor: (owner) => (owner === 'luxord' ? '#ff00aa' : '') });
  const [bot, all] = root.querySelectorAll('.room-mention');
  assert.match(bot.getAttribute('style') || '', /--mention-ink:\s*#ff00aa/);
  assert.doesNotMatch(all.getAttribute('style') || '', /--mention-ink/);
});

test('is idempotent: re-running never double wraps', () => {
  const first = render('<p>@luxord</p>');
  const again = highlightMentions(first.root, { document: first.document, members });
  assert.equal(again, 0);
  assert.equal(first.root.querySelectorAll('.room-mention').length, 1);
});

test('insertMention: empty draft, end of text, caret in the middle, replaces selection', () => {
  assert.deepEqual(insertMention('', 0, 0, 'Luxord'), { value: '@Luxord ', caret: 8 });
  assert.deepEqual(insertMention('hello', 5, 5, '@Luxord'), { value: 'hello @Luxord ', caret: 14 });
  assert.deepEqual(insertMention('hello world', 5, 5, 'riku'), { value: 'hello @riku  world'.replace('  ', ' '), caret: 12 });
  assert.equal(insertMention('say XX now', 4, 6, 'riku').value, 'say @riku  now'.replace('  ', ' '));
  assert.deepEqual(insertMention('hi', undefined, undefined, 'riku'), { value: 'hi @riku ', caret: 9 });
});

import fs from 'node:fs';
import { buildMessageRail } from '../extension/lib/message-actions.mjs';
import { createMessageThreadUi } from '../extension/lib/message-thread-ui.mjs';

test('rail: reply button sits before copy, only when a label and handler are given', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const withReply = buildMessageRail({ document, role: 'assistant', ts: Date.now(), replyLabel: 'Reply to @Luxord', onReply: () => {} });
  assert.deepEqual([...withReply.children].map((el) => el.className).filter((c) => /action/.test(c)),
    ['message-action message-action-reply', 'message-action message-action-copy']);
  assert.equal(withReply.querySelector('.message-action-reply').getAttribute('aria-label'), 'Reply to @Luxord');
  const plain = buildMessageRail({ document, role: 'assistant', ts: Date.now() });
  assert.equal(plain.querySelector('.message-action-reply'), null);
});

test('thread ui: reply appears on room bot messages only and calls back with the record', () => {
  const { document, window } = parseHTML('<html><body><section id="m"></section></body></html>');
  const root = document.querySelector('#m');
  const calls = [];
  const ui = createMessageThreadUi({
    root, document, window, ResizeObserver: undefined, requestFrame: (fn) => fn(),
    replyLabelFor: (r) => `Reply to @${r.speaker}`, onReply: (r) => calls.push(r.speaker),
  });
  const add = (record, room) => {
    const row = document.createElement('div'); row.className = 'message-row';
    const node = document.createElement('article'); node.className = `message ${record.role}`; row.append(node);
    ui.attach({ row, node, record, room }); root.append(row); return row;
  };
  const bot = add({ role: 'assistant', speaker: 'luxord', ts: Date.now() }, true);
  const solo = add({ role: 'assistant', speaker: 'luxord', ts: Date.now() }, false);
  const mine = add({ role: 'user', ts: Date.now() }, true);
  assert.ok(solo.querySelector('.message-action-reply') === null);
  assert.ok(mine.querySelector('.message-action-reply') === null);
  bot.querySelector('.message-action-reply').click();
  assert.deepEqual(calls, ['luxord']);
});

test('wiring: panel imports the module, styles exist, locales carry the string', () => {
  const panel = fs.readFileSync('extension/sidepanel.js', 'utf8');
  for (const src of [panel]) {
    assert.match(src, /from '\.\/lib\/room-mentions\.mjs'/);
    assert.match(src, /highlightMentions\(/);
    assert.match(src, /insertMention\(/);
  }
  for (const css of ['extension/sidepanel.css']) {
    assert.match(fs.readFileSync(css, 'utf8'), /\.room-mention\s*\{/);
  }
  for (const file of fs.readdirSync('extension/lib/locales')) {
    assert.match(fs.readFileSync(`extension/lib/locales/${file}`, 'utf8'), /"ui\.reply\.to\.member": ".*\{name\}.*"/, file);
  }
});

test('headers: Hermes keeps its original label; avatar headers and steers are scoped', () => {
  const css = fs.readFileSync('extension/sidepanel.css', 'utf8');
  assert.ok(css.includes('.message.assistant .message-role { font: 700 calc(9px'));
  assert.ok(css.includes('.message.assistant .message-role:has(.room-avatar)'));
  const steer = css.match(/\.message\.steer-sent \.message-role \{[^}]*\}/)[0];
  assert.ok(!/border-radius|background/.test(steer));
  assert.match(fs.readFileSync('extension/sidepanel.js', 'utf8'), /applySoloBotIdentity\(node, record\);/);
});

test('queued steer sits under the newest user message; restore popover flips when clipped', () => {
  const js = fs.readFileSync('extension/sidepanel.js', 'utf8');
  assert.ok(js.includes('function placeSteerPendingRow'));
  assert.ok(js.includes('anchor.after(node)'));
  assert.ok(js.includes("classList.add('is-below')"));
  assert.ok(!/renderMessageContentElement\(body, messageDisplayText\('user', steerText\)\);\s*\}\s*els\.messages\.appendChild\(existing\)/.test(js));
  assert.ok(fs.readFileSync('extension/sidepanel.css', 'utf8').includes('.message-restore-popover.is-below {'));
});
