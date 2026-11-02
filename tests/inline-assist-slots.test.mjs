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
  ['chatgpt.html', 'https://chatgpt.com/'],
  ['youtube.html', 'https://www.youtube.com/watch?v=abc'],
  ['gmail.html', 'https://mail.google.com/mail/u/0/#inbox?compose=new'],
  ['reddit.html', 'https://www.reddit.com/r/test/comments/1/x/'],
  ['linkedin.html', 'https://www.linkedin.com/feed/'],
  ['github.html', 'https://github.com/o/r/issues/1'],
  ['github-wide-toolbar.html', 'https://github.com/o/r/pull/147'],
];
const fieldIn = (document) => document.querySelector('[contenteditable="true"], textarea');

for (const [name, url] of SITES) {
  test(`${name}: the circle's slot is the composer's own control`, () => {
    const { document } = parseHTML(`<!doctype html><html><body>${fixture(name)}</body></html>`);
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
  const avatar = env.w.document.querySelector('[data-testid^="UserAvatar-Container"]');
  const moved = avatar.cloneNode(true);
  moved.setAttribute('data-rect', '16 300 40 40');
  avatar.replaceWith(moved);
  await env.sleep(400);
  assert.equal(env.launcher().style.top, '360px');
});

test('ChatGPT: the circle sits 12px before the dictate button', async () => {
  const env = boot('chatgpt.html', 'https://chatgpt.com/');
  const launcher = await focusedLauncher(env);
  assert.equal(launcher.dataset.placement, 'before');
  assert.equal(launcher.style.left, '830px');
  assert.equal(launcher.style.top, '682px');
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
