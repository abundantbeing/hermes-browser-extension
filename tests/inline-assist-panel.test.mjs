import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';

async function openPanel(settings = {}) {
  const env = bootAssist({ settings: { inlineAssistDefaultRoute: 'background', inlineAssistModel: 'gpt-6.1-terra', ...settings } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  return { env, root: env.root(), panel: env.root().querySelector('.panel'), launcher };
}

test('the full panel is 380px wide', () => {
  assert.match(loadExtensionFile('content-inline-helper.js'), /\.panel \{[^}]*width:min\(380px,calc\(100vw - 20px\)\)/);
});

test('the footer holds where it runs, auto-replace, the model and the safety line', async () => {
  const { root } = await openPanel();
  const foot = root.querySelector('.foot');
  const route = foot.querySelector('.dd[data-setting="route"]');
  assert.ok(route, 'route control in the footer');
  assert.match(route.textContent, /Run in background/);
  assert.ok(foot.querySelector('input.toggle[data-setting="auto-replace"]'), 'auto-replace in the footer');
  assert.match(foot.textContent, /gpt-6\.1-terra/);
  assert.match(foot.textContent, /Never posts or sends\. Only this field changes\./);
  assert.equal(root.querySelector('.body input.toggle[data-setting="auto-replace"]'), null, 'no second auto-replace switch in the body');
});

test('at most four actions show; the rest sit behind More actions', async () => {
  const { env, root } = await openPanel();
  const visible = () => [...root.querySelectorAll('.actions .action')].filter((item) => !item.hidden);
  assert.equal(visible().length, 4);
  const more = root.querySelector('.more-actions');
  assert.ok(more, 'More actions button');
  env.userClick(more);
  await env.sleep();
  assert.equal(visible().length, 6);
});

test('the panel opens just below the circle, lined up with it', async () => {
  const { panel, launcher } = await openPanel();
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.top, `${parseInt(launcher.style.top, 10) + 24 + 8}px`);
  assert.equal(panel.style.left, launcher.style.left);
});

test('a finished draft offers Try again, and Shorter once it is in the field', async () => {
  const { env, root } = await openPanel();
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  assert.ok(request, 'a draft was requested');
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text: 'A drafted reply.', sessionId: 's1', sessionTitle: 'Inline assist' });
  await env.sleep(60);
  const labels = [...root.querySelectorAll('.result-actions button')].map((item) => item.textContent.trim());
  assert.ok(labels.includes('Try again'), labels.join(', '));
  assert.ok(labels.includes('Shorter'), labels.join(', '));
});

test('the full panel keeps square controls; only the quick menu tool chips are rounded', () => {
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(loadExtensionFile('content-inline-helper.js'))[1];
  assert.doesNotMatch(/\.local-actions \.action \{[^}]*\}/.exec(css)?.[0] || '', /border-radius/);
  assert.match(css, /\.quick-chip \{[^}]*border-radius:999px/);
});

test('every Assist area that scrolls floats the branded thumb over its content; none keeps a strip for it', async () => {
  const source = loadExtensionFile('content-inline-helper.js');
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(source)[1];
  assert.doesNotMatch(css, /scrollbar-gutter/);
  const scrolling = [...css.matchAll(/(?:^|\n)\s*([^{}\n]+?)\s*\{[^}]*overflow(?:-y)?:\s*(?:auto|scroll)/g)]
    .flatMap((match) => match[1].split(',').map((selector) => selector.trim()));
  assert.ok(scrolling.includes('.dd-list'), 'the dropdown list scrolls');
  // Each scrolling area is given the floating thumb where it is made, except the instruction textarea,
  // which cannot hold one and keeps the canonical sharp bar.
  const madeAs = { '.panel': 'panel', '.preview': 'preview', '.dd-list': 'list' };
  for (const selector of scrolling) {
    if (selector === '.custom') {
      assert.match(css, /\.custom::-webkit-scrollbar \{ width:8px; \}/);
      continue;
    }
    assert.ok(madeAs[selector], `${selector} is a known scrolling area`);
    assert.match(source, new RegExp(`attachOverlayScrollbar\\(${madeAs[selector]}[,)]`), `${selector} floats its thumb`);
  }
  // In the page: the panel and an open dropdown carry the thumb, as their own ::before box.
  const { env, root, panel } = await openPanel();
  await env.sleep(40);
  assert.equal(panel.hasAttribute('data-overlay-scroll'), true);
  assert.equal(panel.firstElementChild.className, 'head', 'the thumb adds no element');
  env.userClick(root.querySelector('.dd[data-setting="route"] .dd-button'));
  await env.sleep(40);
  const list = root.querySelector('.dd[data-setting="route"] .dd-list');
  assert.equal(list.hasAttribute('data-overlay-scroll'), true);
  // A sticky box only moves within its own grid cell, so a floating thumb's area is a flex column, not a grid.
  assert.match(css, /\.dd-list \{[^}]*display:flex; flex-direction:column;/);
  assert.ok(root.querySelector('style.overlay-scrollbar').textContent.includes('scrollbar-width:none'), 'the browser bar is hidden');
});

test('the full panel failure screen has a plain secondary Back to actions button', () => {
  const source = loadExtensionFile('content-inline-helper.js');
  const failure = source.match(/function renderFailure\(reason\) \{[\s\S]*?\n {2}\}/)?.[0] || '';
  assert.match(failure, /button\('failure-back', 'Back to actions'\)/);
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(source)[1];
  assert.match(css, /\.failure-back \{[^}]*background:transparent;[^}]*\}/);
  assert.match(css, /\.failure-detail \{[^}]*overflow-wrap:anywhere;[^}]*\}/);
});

const assistCss = () => /style\.textContent = `([\s\S]*?)`;/.exec(loadExtensionFile('content-inline-helper.js'))[1];

test('the footer is a tidy grid: four equal cells, label above control, the safety line across both', async () => {
  const css = assistCss();
  assert.match(css, /\.foot \{[^}]*display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\);/);
  assert.match(css, /\.foot-control \{[^}]*display:grid;[^}]*align-content:start;/);
  assert.match(css, /\.foot-safety \{[^}]*grid-column:1 \/ -1;/);
  const { root } = await openPanel();
  const cells = [...root.querySelectorAll('.foot .foot-control')].map((cell) => cell.querySelector('em')?.textContent);
  assert.deepEqual(cells, ['Runs', 'Auto-replace', 'Model', 'Effort']);
});

test('the panel above the circle is placed again when its height settles, so a press never lands on moved content', async () => {
  const env = bootAssist({ settings: { inlineAssistDefaultRoute: 'background' } });
  const field = env.w.document.getElementById('field');
  field.getBoundingClientRect = () => ({ x: 20, y: 800, top: 800, left: 20, bottom: 840, right: 320, width: 300, height: 40, toJSON() {} });
  const launcher = await focusField(env);
  // Opened after the circle's settling time following focus, as a person does: from here only a size change
  // can move the panel.
  await env.sleep(1_400);
  env.userClick(launcher);
  await env.sleep(60);
  const panel = env.root().querySelector('.panel');
  let height = 674;
  panel.getBoundingClientRect = () => ({ x: 20, y: 0, top: 0, left: 20, bottom: height, right: 400, width: 380, height, toJSON() {} });
  env.resized(panel);
  await env.sleep(60);
  const tall = parseFloat(panel.style.top);
  height = 620;
  env.resized(panel);
  await env.sleep(60);
  assert.equal(parseFloat(panel.style.top) - tall, 54, 'it keeps 8px above the circle at its real height');
});

test('the Bounded row says how much it read, shows exactly what Hermes gets, and sends that', async () => {
  const env = bootAssist({ url: 'https://github.com/o/r/issues/7', settings: { inlineAssistDefaultRoute: 'background' } });
  env.w.document.body.insertAdjacentHTML('afterbegin', `<h1 data-testid="issue-title">Crash on start</h1>
    <div data-testid="issue-body"><a data-testid="issue-body-header-author">ada</a><div data-testid="markdown-body">It crashes with password: hunter22 set.</div></div>
    <div data-testid="comment-viewer-outer-box-1"><div data-testid="comment-header"><a href="/bob">bob</a></div><div data-testid="markdown-body">Same here.</div></div>`);
  env.userClick(await focusField(env));
  await env.sleep(60);
  const root = env.root();
  assert.match(root.querySelector('.setting').textContent, /Reads 2 messages · \d+ characters · saved for GitHub/);
  const peek = root.querySelector('.context-peek');
  assert.equal(peek.textContent, 'See what Hermes reads');
  assert.equal(root.querySelector('.context-preview'), null);
  env.userClick(peek);
  await env.sleep();
  const preview = root.querySelector('.context-preview');
  assert.match(preview.textContent, /^GitHub issue #7 in o\/r: Crash on start/);
  assert.match(preview.textContent, /bob:\nSame here\./);
  assert.match(preview.textContent, /It crashes with \[secret removed\] set\./);
  assert.equal(peek.textContent, 'Hide what Hermes reads');
  assert.equal(preview.hasAttribute('data-overlay-scroll'), true, 'the long preview floats the branded thumb');
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  assert.ok(request, 'a thread quoting a password still drafts');
  assert.equal(request.pageContext, preview.textContent, 'Hermes gets what the preview shows');
});

test('a draft written without the page says so, and why', async () => {
  const { env, root } = await openPanel();
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST')?.request;
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text: 'A drafted reply.', contextWithheld: true });
  await env.sleep(60);
  assert.match(root.textContent, /Hermes wrote this without the page: page context is off for this connection\. Turn it on in the side panel to include the thread\./);
});

test('the background run tells the page when the consent gate kept the thread back', () => {
  const background = loadExtensionFile('background.js');
  const runner = background.match(/async function runInlineDraftInServiceWorker\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(runner, /contextWithheld = Boolean\(request\.pageContext\) && !gatedRequest\.allowed;/);
  assert.match(runner, /sendDirectInlineResult\(tabId, request, \{[^}]*contextWithheld,/);
});

test('the header is one row: the side panel wing, the name over what Assist is on, the state and a small ×', async () => {
  const css = assistCss();
  assert.match(css, /\.head \{[^}]*grid-template-columns:46px minmax\(0,1fr\) auto 32px;/);
  assert.match(css, /\.close \{[^}]*width:32px; height:32px;/);
  assert.doesNotMatch(css, /\.context \{/, 'no separate context row');
  const { root, panel } = await openPanel();
  const head = panel.querySelector('.head');
  assert.deepEqual([...head.children].map((child) => child.classList[0]), ['brand-wing', 'head-copy', 'head-state', 'close']);
  assert.match(head.querySelector('.brand-wing').style.maskImage, /hermes-wing-mark\.svg/, 'the wing the side panel shows');
  assert.equal(head.querySelector('.head-copy .title').textContent, 'Hermes Assist');
  assert.ok(head.querySelector('.head-copy .head-detail').textContent.trim(), 'the site line sits under the name');
  assert.equal(head.querySelector('.head-state').textContent, 'DRAFT ONLY');
  assert.equal(root.querySelector('.kicker'), null, 'no Hermes Browser line above the name');
  assert.equal(panel.querySelector('.context'), null);
});

test('the Auto-replace cell reads like the others: what it does in words, the switch at its right edge', async () => {
  const css = assistCss();
  assert.match(css, /\.foot-value \{[^}]*display:flex;[^}]*justify-content:space-between;/);
  assert.match(css, /\.foot-value \.toggle \{[^}]*order:2;/, 'the switch sits where the dropdowns have their arrow');
  // The words follow the switch itself, so they stay right when Settings changes it without a click.
  assert.match(css, /\.foot-value \.toggle:checked ~ \.foot-state-off, \.foot-value \.toggle:not\(:checked\) ~ \.foot-state-on \{ display:none; \}/);
  const { root } = await openPanel();
  const cell = root.querySelector('.foot .foot-replace');
  assert.equal(cell.tagName, 'LABEL', 'a press anywhere in the cell flips the switch');
  const value = cell.querySelector('.foot-value');
  assert.ok(value.querySelector('input.toggle[data-setting="auto-replace"]'));
  assert.equal(value.querySelector('.foot-state-on').textContent, 'Replaces the text');
  assert.equal(value.querySelector('.foot-state-off').textContent, 'Shows a preview');
});

test('the instant tools share their row in equal parts, with no gap left over', () => {
  assert.match(assistCss(), /\.local-actions \{[^}]*display:grid; grid-template-columns:repeat\(auto-fit,minmax\(0,1fr\)\);/);
  assert.match(assistCss(), /\.local-actions \.action \{[^}]*text-align:center;/, 'each label sits in the middle of its button');
});

test('the instruction box is one line that grows as you type, with a short hint and a button its height', async () => {
  const css = assistCss();
  assert.match(css, /\.custom \{[^}]*height:34px;[^}]*resize:none;/);
  assert.match(css, /\.custom-go \{[^}]*min-height:34px;/);
  assert.match(css, /\.custom:focus-visible \{[^}]*outline:2px solid var\(--hb-blue\);/, 'a square focus ring, not the browser rounded one');
  const { env, root } = await openPanel();
  const box = root.querySelector('textarea.custom');
  assert.equal(box.rows, 1);
  assert.equal(box.placeholder, 'Say what to change…');
  // A 1px border on each side: the box is 2px taller than its scroll area, or a scrollbar shows with nothing to scroll.
  Object.defineProperty(box, 'offsetHeight', { configurable: true, value: 36 });
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: 34 });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 70 });
  box.value = 'one\ntwo\nthree';
  for (const listener of env.listenersFor(box, 'input')) listener.call(box, { type: 'input', target: box, isTrusted: true });
  assert.equal(box.style.height, '72px');
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 400 });
  for (const listener of env.listenersFor(box, 'input')) listener.call(box, { type: 'input', target: box, isTrusted: true });
  assert.equal(box.style.height, '96px', 'it stops growing at four lines and scrolls');
});
