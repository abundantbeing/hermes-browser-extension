import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';

const ORIGINAL = 'a rough first draft';

async function boot(settings = {}) {
  const env = bootAssist({ settings: { inlineAssistDefaultRoute: 'background', inlineAssistModel: 'gpt-6.1-terra', ...settings } });
  const launcher = await focusField(env);
  env.w.document.getElementById('field').value = ORIGINAL;
  env.userClick(launcher);
  await env.sleep(60);
  return { env, root: env.root(), panel: env.root().querySelector('.panel'), field: env.w.document.getElementById('field') };
}

const requests = (env) => env.sent.filter((message) => message.type === 'HERMES_INLINE_DRAFT_REQUEST').map((message) => message.request);

async function deliverLast(env, text = 'A drafted reply.') {
  const request = requests(env).at(-1);
  assert.ok(request, 'a draft was requested');
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text, sessionId: 's1', sessionTitle: 'Inline assist' });
  await env.sleep(60);
}

const labels = (root, selector) => [...root.querySelectorAll(selector)].map((item) => item.textContent.trim());
const buttonNamed = (root, selector, name) => [...root.querySelectorAll(selector)].find((item) => item.textContent.trim() === name);

test('the full panel\'s follow-ups come in pairs: Shorter has Longer beside it', async () => {
  const { env, root } = await boot();
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  await deliverLast(env);
  assert.deepEqual(labels(root, '.follow-ups button'), ['Try again', 'Quick menu', 'Shorter', 'Longer']);
});

test('Longer asks Hermes to expand the draft that is in the field', async () => {
  const { env, root } = await boot();
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  await deliverLast(env, 'Short draft.');
  env.userClick(buttonNamed(root, '.follow-ups button', 'Longer'));
  await env.sleep(60);
  const request = requests(env).at(-1);
  assert.equal(request.actionId, 'expand');
  assert.equal(request.draftText, 'Short draft.');
});

test('an odd number of result buttons never leaves a hole: the last one takes the whole row', () => {
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(loadExtensionFile('content-inline-helper.js'))[1];
  assert.match(css, /\.result-actions > button:last-child:nth-child\(odd\) \{ grid-column:1 \/ -1; \}/);
});

test('the bar decides first, Undo beside a filled Keep, then changes the draft from one joined strip', async () => {
  const { env, root } = await boot({ inlineAssistOpenMode: 'quick' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  await deliverLast(env);
  assert.deepEqual(labels(root, '.bar-actions > .bar-main button'), ['Undo', 'Keep']);
  assert.equal(root.querySelector('.bar-main button.main').textContent.trim(), 'Keep');
  assert.deepEqual(labels(root, '.bar-actions > .bar-tools button'), ['Again', 'Shorter', 'Longer', 'Copy', 'Open session']);
  assert.ok(root.querySelector('.bar-head .bar-name .bar-mark'), 'the Assist mark beside the title');
  // One pair, then a grid of equal cells: no row of loose buttons, so no row leaves a hole.
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(loadExtensionFile('content-inline-helper.js'))[1];
  assert.match(css, /\.bar-main \{ display:grid; grid-template-columns:1fr 1fr;/);
  assert.doesNotMatch(css, /\.bar-actions \{ display:flex/);
});

test("the bar's mark is the icon chosen for the circle (Wing, Staff or Nous girl), never the extension logo", async () => {
  for (const [icon, asset] of [['wing', /assist-wing\.png/], ['staff', /assist-staff\.svg/], ['girl', /assist-girl-solid\.png/]]) {
    const { env, root } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistIcon: icon, appearanceTheme: 'mono', colorMode: 'light' });
    env.userClick(root.querySelector('.quick-item'));
    await env.sleep(60);
    await deliverLast(env);
    const mark = root.querySelector('.bar-head .bar-mark');
    const image = mark.style.maskImage || mark.style.webkitMaskImage || '';
    assert.match(image, asset, icon);
    assert.doesNotMatch(image, /hermes-browser-extension-icon/, icon);
    assert.equal(mark.dataset.icon, icon);
  }
});

test('the failure bar is the same card: its title beside the mark, then Close beside a filled Try again', async () => {
  const { env, root } = await boot({ inlineAssistOpenMode: 'quick' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  const request = requests(env).at(-1);
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: false, reason: 'The gateway is offline.' });
  await env.sleep(60);
  assert.equal(root.querySelector('.bar-head .bar-title').textContent, 'Assist could not run');
  assert.deepEqual(labels(root, '.bar-actions > .bar-main button'), ['Close', 'Try again']);
  assert.equal(root.querySelector('.bar-main button.main').textContent.trim(), 'Try again');
});

test('the bar offers Longer beside Shorter, and the way back to the full panel is a link at its top, not one more button', async () => {
  const { env, root, panel } = await boot({ inlineAssistOpenMode: 'quick' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  await deliverLast(env);
  assert.equal(panel.dataset.mode, 'bar');
  const bar = labels(root, '.bar-actions button');
  assert.equal(bar[bar.indexOf('Shorter') + 1], 'Longer');
  assert.ok(!bar.includes('Full panel'), bar.join(', '));
  const back = root.querySelector('.bar-head .bar-return');
  assert.ok(back, 'a Return to full panel link beside the title');
  assert.equal(back.textContent.trim(), '←Return to full panel');
  assert.equal(root.querySelector('.bar-head .bar-title').textContent, 'Draft in place');
  env.userClick(back);
  await env.sleep();
  assert.equal(panel.dataset.mode, 'full');
  assert.ok(root.querySelector('.follow-ups'), 'the full result');
});

test('a quick-menu draft goes back to the field it came from, even when another field with the same text has focus', async () => {
  const { env, root, field } = await boot({ inlineAssistOpenMode: 'quick' });
  const other = env.w.document.createElement('textarea');
  other.value = ORIGINAL;
  env.w.document.body.append(other);
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  other.focus();
  await env.sleep(40);
  await deliverLast(env, 'The drafted reply.');
  assert.equal(field.value, 'The drafted reply.');
  assert.equal(other.value, ORIGINAL, 'the other field is untouched');
});

test('Try again on the failure bar with Ask every time shows the chooser', async () => {
  const { env, root, panel } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'background' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  const request = requests(env).at(-1);
  env.changeStorage({ hermesBrowserSettings: { newValue: { inlineAssistDefaultRoute: 'ask', inlineAssistOpenMode: 'quick', inlineAssistModel: 'gpt-6.1-terra' } } });
  await env.sleep(20);
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: false, reason: 'The gateway refused.' });
  await env.sleep(60);
  env.userClick(buttonNamed(root, '.bar-actions button', 'Try again'));
  await env.sleep(60);
  assert.equal(panel.hidden, false, 'the chooser is on screen');
  assert.ok(root.querySelector('.route-title'), 'Where should Hermes work?');
});

test('Again after an instant tool runs that tool, not the model action before it', async () => {
  const { env, root, field } = await boot();
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  await deliverLast(env);
  env.userClick(root.querySelector('.head .close'));
  await env.sleep(40);
  field.value = 'Line one   \n\n\n\nLine two';
  env.userClick(root.querySelector('.launcher'));
  await env.sleep(60);
  env.userClick(root.querySelector('.local-actions .action'));
  await env.sleep(40);
  const sent = requests(env).length;
  env.userClick(buttonNamed(root, '.follow-ups button', 'Try again'));
  await env.sleep(40);
  assert.equal(requests(env).length, sent, 'no model request: Again reran the instant tool');
});

test('the bar shows the model fallback notice too', async () => {
  const { env, root } = await boot({ inlineAssistOpenMode: 'quick' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  const request = requests(env).at(-1);
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text: 'A drafted reply.', modelNotice: 'Used this chat\'s model instead.' });
  await env.sleep(60);
  assert.match(root.querySelector('.bar').textContent, /Model routing · Used this chat's model instead\./);
});

test('the bar says when the draft was written without the page', async () => {
  const { env, root } = await boot({ inlineAssistOpenMode: 'quick' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  const request = requests(env).at(-1);
  env.deliver({ type: 'HERMES_INLINE_DRAFT_RESULT', requestId: request.requestId, documentId: request.documentId, ok: true, text: 'A drafted reply.', contextWithheld: true });
  await env.sleep(60);
  assert.equal(root.querySelector('.bar .bar-note')?.textContent, 'Written without the page: page context is off for this connection.');
});

test('Again from the bar asks where to run in the quick menu\'s layout, with Back and Close, and leaves the draft in place', async () => {
  const { env, root, panel, field } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  env.userClick(root.querySelector('.route[data-route="background"]'));
  await env.sleep(60);
  await deliverLast(env);
  assert.equal(field.value, 'A drafted reply.');
  env.userClick(buttonNamed(root, '.bar-actions button', 'Again'));
  await env.sleep(60);
  assert.equal(panel.dataset.view, 'routing');
  assert.equal(panel.dataset.mode, 'quick', 'padded like the quick menu, not squeezed into the bar');
  assert.equal(field.value, 'A drafted reply.', 'nothing is undone until a place is picked');
  assert.ok(root.querySelector('.sheet-nav .sheet-back'), 'Back');
  assert.ok(root.querySelector('.sheet-nav .sheet-close'), 'Close');
  env.userClick(root.querySelector('.sheet-back'));
  await env.sleep();
  assert.equal(panel.dataset.mode, 'bar');
  assert.equal(root.querySelector('.bar-title').textContent, 'Draft in place');
  assert.equal(field.value, 'A drafted reply.');
});

test('picking a place after Again undoes the draft first and runs from the original text', async () => {
  const { env, root, field } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  env.userClick(root.querySelector('.route[data-route="background"]'));
  await env.sleep(60);
  await deliverLast(env);
  env.userClick(buttonNamed(root, '.bar-actions button', 'Again'));
  await env.sleep(60);
  env.userClick(root.querySelector('.route[data-route="background"]'));
  await env.sleep(60);
  assert.equal(field.value, ORIGINAL);
  assert.equal(requests(env).at(-1).draftText, ORIGINAL);
});

test('Close on the chooser closes Assist', async () => {
  const { env, root, panel } = await boot({ inlineAssistOpenMode: 'quick', inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  assert.equal(panel.dataset.view, 'routing');
  env.userClick(root.querySelector('.sheet-close'));
  await env.sleep();
  assert.equal(panel.hidden, true);
});

test('Back on the chooser from the full panel returns to the actions', async () => {
  const { env, root, panel } = await boot({ inlineAssistDefaultRoute: 'ask' });
  env.userClick(root.querySelector('.actions .action'));
  await env.sleep(60);
  assert.equal(panel.dataset.view, 'routing');
  assert.equal(root.querySelector('.sheet-close'), null, 'the full panel\'s header already has its ×');
  env.userClick(root.querySelector('.sheet-back'));
  await env.sleep();
  assert.ok(root.querySelector('.actions .action'), 'the actions again');
});

test('a language change redraws the screen that is open, the quick menu and the bar included', async () => {
  const { env, root, panel } = await boot({ inlineAssistOpenMode: 'quick' });
  env.changeStorage({ hermesBrowserLocale: { newValue: 'es' } });
  await env.sleep();
  assert.equal(panel.dataset.view, 'quick');
  assert.equal(panel.dataset.mode, 'quick');
  env.userClick(root.querySelector('.quick-item'));
  await env.sleep(60);
  await deliverLast(env);
  env.changeStorage({ hermesBrowserLocale: { newValue: 'fr' } });
  await env.sleep();
  assert.equal(panel.dataset.mode, 'bar');
  assert.ok(root.querySelector('.bar-actions'), 'still the bar');
});

test('the bar\'s change buttons wrap so every name shows in full, in pairs with an odd last one across the row', () => {
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(loadExtensionFile('content-inline-helper.js'))[1];
  const rule = (selector) => {
    const found = css.split('\n').map((line) => line.trim()).find((line) => line.startsWith(`${selector} {`));
    assert.ok(found, `${selector} rule`);
    return found;
  };
  assert.match(rule('.bar-tools'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  const tool = rule('.bar-tools button');
  assert.doesNotMatch(tool, /white-space:nowrap|text-overflow:ellipsis|overflow:hidden/, 'a long name (Lebih panjang at 200% text) is never cut');
  assert.doesNotMatch(tool, /[^-]height:\d+px/, 'the height follows the wrapped name');
  assert.match(tool, /min-height:/);
  assert.match(rule('.bar-tools > button:last-child:nth-child(odd)'), /grid-column:1 \/ -1/);
});

test('a bar that only fits a gap between site controls is a smaller panel that scrolls', () => {
  const source = loadExtensionFile('content-inline-helper.js');
  assert.match(source, /panel\.style\.maxHeight = bar\.maxHeight \? `\$\{bar\.maxHeight\}px` : '';/);
  assert.match(source, /panel\.style\.overflowY = bar\.maxHeight \? 'auto' : '';/);
});
