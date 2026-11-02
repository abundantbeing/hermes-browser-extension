import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parseHTML } from 'linkedom';

import { inspectInlineSite } from '../extension/lib/site-adapters.mjs';

// Each fixture reproduces a site's composer. data-expect-slot marks the control the circle should sit
// beside, data-expect-row the row it lines up with, and data-rect="left top width height" gives each
// element its box for the end-to-end checks.
const FIXTURES = new URL('./fixtures/assist/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');
const SITES = [
  ['x-reply.html', 'https://x.com/someone/status/1'],
  ['x-reply-deep.html', 'https://x.com/someone/status/1'],
  ['chatgpt.html', 'https://chatgpt.com/'],
  ['chatgpt-pill.html', 'https://chatgpt.com/'],
  ['claude.html', 'https://claude.ai/new'],
  ['perplexity.html', 'https://www.perplexity.ai/'],
  ['hermes-web.html', 'http://127.0.0.1:9119/webapp/window'],
  ['github-issue.html', 'https://github.com/o/r/issues/2'],
  ['linkedin-share.html', 'https://www.linkedin.com/feed/'],
  ['x-grok.html', 'https://x.com/i/grok'],
  ['youtube.html', 'https://www.youtube.com/watch?v=abc'],
  ['gmail.html', 'https://mail.google.com/mail/u/0/#inbox?compose=new'],
  ['reddit.html', 'https://www.reddit.com/r/test/comments/1/x/'],
  ['linkedin.html', 'https://www.linkedin.com/feed/'],
  ['github.html', 'https://github.com/o/r/issues/1'],
  ['github-wide-toolbar.html', 'https://github.com/o/r/pull/147'],
];
const fieldIn = (document) => document.querySelector('[contenteditable="true"], textarea');

// Each element's box from its data-rect, for the slots that are read from the layout.
function withBoxes(document) {
  for (const element of document.querySelectorAll('*')) {
    const [left, top, width, height] = String(element.getAttribute('data-rect') || '0 0 0 0').split(/\s+/).map(Number);
    element.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height });
  }
  return document;
}

for (const [name, url] of SITES) {
  test(`${name}: the circle's slot is the composer's own control`, () => {
    const document = withBoxes(parseHTML(`<!doctype html><html><body>${fixture(name)}</body></html>`).document);
    const profile = inspectInlineSite(document, fieldIn(document), { url });
    const slot = profile.placement.slot;
    assert.ok(slot, `${name} found no slot`);
    // Compared by markup: a failing assert on two DOM nodes would try to print both whole trees.
    assert.ok(slot.element === document.querySelector('[data-expect-slot]'), `${name}: slot is ${slot.element?.outerHTML?.slice(0, 120)}`);
    const row = document.querySelector('[data-expect-row]');
    if (row) assert.equal(slot.rowElement, row);
    assert.deepEqual(profile.placement.preferred, ['corner-outside', 'corner-inside', 'below-end']);
  });
}

test('any other site has no slot and uses the corner rule', () => {
  const { document } = parseHTML(`<!doctype html><html><body>${fixture('generic.html')}</body></html>`);
  const profile = inspectInlineSite(document, fieldIn(document), { url: 'https://forum.example/new' });
  assert.equal(profile.placement.slot, null);
  assert.deepEqual(profile.placement.preferred, ['corner-outside', 'corner-inside', 'below-end']);
});

// End to end: the real content scripts in jsdom, with each element's box taken from data-rect.
const EXTENSION = new URL('../extension/', import.meta.url);
const load = (relative) => readFileSync(new URL(relative, EXTENSION), 'utf8');

function boot(name, url) {
  const dom = new JSDOM(`<!doctype html><html><body>${fixture(name)}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.innerWidth = 1280;
  w.innerHeight = 800;
  w.Element.prototype.getBoundingClientRect = function rectFromFixture() {
    const [left, top, width, height] = String(this.getAttribute?.('data-rect') || '0 0 0 0').split(/\s+/).map(Number);
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} };
  };
  let shadow = null;
  const attachShadow = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function patched(init) { shadow = attachShadow.call(this, init); return shadow; };
  w.chrome = {
    runtime: { id: 'test-extension', getURL: (path) => `chrome-extension://test-extension/${path}`, getManifest: () => ({}), sendMessage: () => Promise.resolve({ ok: true }), onMessage: { addListener() {}, removeListener() {} } },
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {}, removeListener() {} } },
  };
  w.browser = undefined;
  for (const file of ['lib/browser-api-global.js', 'content-extractor.js', 'lib/i18n-content.js', 'content-inline-helper.js']) w.eval(load(file));
  const sleep = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
  return { w, sleep, launcher: () => shadow?.querySelector('.launcher') };
}

async function focusedLauncher(env) {
  await env.sleep();
  fieldIn(env.w.document).focus();
  await env.sleep(80);
  return env.launcher();
}

test('X: the circle sits under the avatar on the media row, 20px clear of it', async () => {
  const env = boot('x-reply.html', 'https://x.com/someone/status/1');
  const launcher = await focusedLauncher(env);
  assert.equal(launcher.hidden, false);
  assert.equal(launcher.dataset.placement, 'below-center');
  assert.equal(launcher.style.left, '24px');
  assert.equal(launcher.style.top, '243px');
});

test('slot element replaced → placement follows the new element', async () => {
  const env = boot('x-reply.html', 'https://x.com/someone/status/1');
  await focusedLauncher(env);
  const avatar = env.w.document.querySelector('[data-testid="UserAvatar-Container-hermes"]');
  const moved = avatar.cloneNode(true);
  moved.setAttribute('data-rect', '20 170 40 40');
  avatar.replaceWith(moved);
  await env.sleep(400);
  assert.equal(env.launcher().style.left, '28px');
});

test('X, nested as deep as x.com nests its editor: still under the avatar on the media row', async () => {
  const launcher = await focusedLauncher(boot('x-reply-deep.html', 'https://x.com/someone/status/1'));
  assert.equal(launcher.dataset.placement, 'below-center');
  assert.equal(launcher.style.left, '24px');
  assert.equal(launcher.style.top, '243px');
});

test('X pop-out reply: the media buttons start under the avatar, so the circle goes at the end of them', async () => {
  const launcher = await focusedLauncher(boot('x-reply-modal.html', 'https://x.com/compose/post'));
  assert.equal(launcher.dataset.placement, 'after');
  // Tag location ends at 301: 12px gap; centred on the media row (328, 36 tall).
  assert.equal(launcher.style.left, '313px');
  assert.equal(launcher.style.top, '334px');
});

test('ChatGPT: the circle sits just before the controls on the right of its row', async () => {
  const env = boot('chatgpt.html', 'https://chatgpt.com/');
  const launcher = await focusedLauncher(env);
  assert.equal(launcher.dataset.placement, 'before');
  assert.equal(launcher.style.left, '834px');
  assert.equal(launcher.style.top, '682px');
});

test('ChatGPT one-line pill: just before the effort pill, and it moves when the pill widens to Thinking effort', async () => {
  const env = boot('chatgpt-pill.html', 'https://chatgpt.com/');
  const launcher = await focusedLauncher(env);
  assert.equal(launcher.dataset.placement, 'before');
  assert.equal(launcher.style.left, '728px');
  assert.equal(launcher.style.top, '614px');
  const pill = env.w.document.querySelector('[data-expect-slot]');
  pill.setAttribute('data-rect', '700 608 140 36');
  pill.textContent = 'Thinking effort';
  await env.sleep(400);
  assert.equal(launcher.style.left, '668px');
});

for (const [name, url, left, top] of [
  ['claude.html', 'https://claude.ai/new', '768px', '234px'],
  ['perplexity.html', 'https://www.perplexity.ai/', '880px', '379px'],
  ['hermes-web.html', 'http://127.0.0.1:9119/webapp/window', '568px', '636px'],
]) {
  test(`${name}: just before the controls on the right of the composer's row, never on a control`, async () => {
    const launcher = await focusedLauncher(boot(name, url));
    assert.equal(launcher.dataset.placement, 'before');
    assert.equal(launcher.style.left, left);
    assert.equal(launcher.style.top, top);
  });
}

test('Gmail: just after More options, covering none of the writing tools', async () => {
  const launcher = await focusedLauncher(boot('gmail.html', 'https://mail.google.com/mail/u/0/#inbox?compose=new'));
  assert.equal(launcher.dataset.placement, 'after');
  assert.equal(launcher.style.left, '1008px');
  assert.equal(launcher.style.top, '730px');
});

test('GitHub issue: before the first toolbar button, as on a pull request', async () => {
  const launcher = await focusedLauncher(boot('github-issue.html', 'https://github.com/o/r/issues/2'));
  assert.equal(launcher.dataset.placement, 'before');
  assert.equal(launcher.style.left, '486px');
  assert.equal(launcher.style.top, '76px');
});

test('LinkedIn comment: a smaller circle just before the emoji button, not on it', async () => {
  const launcher = await focusedLauncher(boot('linkedin.html', 'https://www.linkedin.com/feed/'));
  assert.equal(launcher.dataset.placement, 'before');
  assert.equal(launcher.dataset.size, 'small');
  // Emoji starts at 712: 10px gap, 20px circle, centred on its 24px row.
  assert.equal(launcher.style.left, '682px');
  assert.equal(launcher.style.top, '312px');
});

test('LinkedIn Start a post, drawn inside a shadow root: the circle shows, after the last tool under the editor', async () => {
  const env = boot('generic.html', 'https://www.linkedin.com/feed/');
  await env.sleep();
  const launcher = env.launcher();
  const outlet = env.w.document.createElement('div');
  outlet.id = 'interop-outlet';
  env.w.document.body.append(outlet);
  const root = outlet.attachShadow({ mode: 'open' });
  root.innerHTML = fixture('linkedin-share.html');
  root.querySelector('.ql-editor').focus();
  await env.sleep(80);
  assert.equal(launcher.hidden, false);
  assert.equal(launcher.dataset.placement, 'after');
  assert.equal(launcher.style.left, '244px');
  assert.equal(launcher.style.top, '378px');
});

test('GitHub: the circle sits just before the first toolbar button, not before the toolbar box', async () => {
  const env = boot('github-wide-toolbar.html', 'https://github.com/o/r/pull/147');
  const launcher = await focusedLauncher(env);
  assert.equal(launcher.dataset.placement, 'before');
  // H starts at 412: 8px gap, 24px circle.
  assert.equal(launcher.style.left, '380px');
});

test('any other site: 8px outside the field’s bottom-right corner', async () => {
  const env = boot('generic.html', 'https://forum.example/new');
  const launcher = await focusedLauncher(env);
  assert.equal(launcher.dataset.placement, 'corner-outside');
  assert.equal(launcher.style.left, '1224px');
});

test('a hostname names its adapter and the label Settings shows for it', async () => {
  const { inlineSiteForHost, inlineSiteLabel } = await import('../extension/lib/site-adapters.mjs');
  assert.deepEqual(inlineSiteForHost('www.x.com'), { adapterId: 'x', label: 'X' });
  assert.deepEqual(inlineSiteForHost('mail.google.com'), { adapterId: 'gmail', label: 'Gmail' });
  assert.deepEqual(inlineSiteForHost('forum.example'), { adapterId: 'generic', label: 'forum.example' });
  assert.equal(inlineSiteLabel('youtube'), 'YouTube');
  assert.equal(inlineSiteLabel('notes.example.org'), 'notes.example.org');
});

test('Grok on x.com: just before the Auto picker, as in any chat composer', async () => {
  const launcher = await focusedLauncher(boot('x-grok.html', 'https://x.com/i/grok'));
  assert.equal(launcher.dataset.placement, 'before');
  assert.equal(launcher.style.left, '698px');
  assert.equal(launcher.style.top, '114px');
});

test('X draws its toolbar a moment after focus: the circle goes to its spot then, before any typing', async () => {
  const env = boot('x-reply-deep.html', 'https://x.com/someone/status/1');
  const toolbar = env.w.document.querySelector('[data-testid="toolBar"]');
  const row = toolbar.parentElement;
  toolbar.remove();
  const launcher = await focusedLauncher(env);
  assert.notEqual(launcher.dataset.placement, 'below-center', 'no toolbar yet');
  row.append(toolbar);
  await env.sleep(300);
  assert.equal(launcher.dataset.placement, 'below-center');
  assert.equal(launcher.style.left, '24px');
  assert.equal(launcher.style.top, '243px');
});

// Hard rule: the circle never covers one of the site's own controls (a button, a link, X's character
// counter). Every composer fixture is checked.
const CONTROLS = 'button, [role="button"], a[aria-label], [role="progressbar"]';
for (const [name, url] of [
  ...SITES,
  ['x-reply-modal.html', 'https://x.com/compose/post'],
  ['generic.html', 'https://forum.example/new'],
]) {
  test(`${name}: the circle covers none of the site's controls`, async () => {
    const env = boot(name, url);
    const launcher = await focusedLauncher(env);
    assert.equal(launcher.hidden, false, `${name}: the circle shows`);
    const size = launcher.dataset.size === 'small' ? 20 : 24;
    const left = parseFloat(launcher.style.left);
    const top = parseFloat(launcher.style.top);
    const covered = [...env.w.document.querySelectorAll(CONTROLS)].filter((control) => {
      const box = control.getBoundingClientRect();
      return box.width > 0 && left < box.right && left + size > box.left && top < box.bottom && top + size > box.top;
    });
    assert.deepEqual(covered.map((control) => control.getAttribute('aria-label') || control.textContent.trim() || control.tagName), [], `${name}: covered`);
  });
}
