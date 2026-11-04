// The side panel's own picture code, run in a DOM: setToolActivity as tool events arrive,
// settleTurnImages at the turn end, and the teardown. The diffusion canvas and the picture
// download are stand-ins that record what they were asked to do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderMarkdown } from '../extension/lib/common.mjs';
import { rawGeneratedImageCandidatesFromResult, resolveImageSource } from '../extension/lib/image-render.mjs';
import { mediaDisplayName } from '../extension/lib/media-source.mjs';
import { isFinishedImageStatus, pickImageGenerationCard, planImageReveals } from '../extension/lib/image-reveal-plan.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `sidepanel.js no longer has ${start} … ${end}`);
  return source.slice(from, to);
}

const pictureCode = [
  slice('// Every picture a reply shows inline', '// A local media path is not a browser URL.'),
  slice('// One image_generate call can deliver more than one picture', 'function loadGeneratedImageForReveal('),
  slice('// A card claims its picture the moment', 'function imageVisualSeed('),
  slice('function setToolActivity(', '// ── Sticky autoscroll'),
].join('\n');

const IMAGES = '/home/u/.hermes/cache/images';
const asDataUrl = (value) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`;
const fromDataUrl = (value = '') => Buffer.from(String(value).split(',')[1] || '', 'base64').toString();
const shownIn = (card) => fromDataUrl(card.querySelector('img')?.getAttribute('src') || '');
const pic = (name) => `${IMAGES}/${name}.png`;

function harness({ revealHold = null, cancelReveal = () => false } = {}) {
  const { document } = parseHTML('<html><body><article class="message assistant"><div class="message-content"></div></article></body></html>');
  const node = document.querySelector('article');
  const log = [];
  const context = vm.createContext({
    document,
    renderMarkdownSafe: renderMarkdown,
    rawGeneratedImageCandidatesFromResult,
    resolveImageSource,
    mediaDisplayName,
    planImageReveals,
    pickImageGenerationCard,
    isFinishedImageStatus,
    imageVisualSeed: (activity) => `seed-${activity.activityId || 'none'}`,
    scrollMessageStreamToBottom: () => {},
    wrapGeneratedImagesForInspection: () => {},
    // Every picture resolves; a held one waits for the test to release it.
    resolveGeneratedImageSource: async (value) => {
      if (revealHold?.source === value) await revealHold.wait;
      return asDataUrl(value);
    },
    loadGeneratedImageForReveal: async (displayable) => {
      const image = document.createElement('img');
      image.className = 'generated-image-reveal-source';
      image.src = displayable;
      return image;
    },
    renderImageGenPlaceholder: (activity) => {
      const root = document.createElement('div');
      root.className = 'image-gen-placeholder';
      root.dataset.toolStatus = activity.status || 'progress';
      root._start = () => log.push(['start', activity.activityId || '']);
      root._reveal = async (image) => {
        log.push(['reveal', fromDataUrl(image.src)]);
        return cancelReveal(fromDataUrl(image.src)) ? { cancelled: true } : { cancelled: false };
      };
      root._dispose = () => log.push(['dispose', root.dataset.activityKey || '']);
      root._settle = () => log.push(['settle', shownIn(root)]);
      return root;
    },
  });
  vm.runInContext(`${pictureCode}\nglobalThis.api = { setToolActivity, settleTurnImages };`, context);
  const { api } = context;
  const slot = () => node.querySelector('.message-tool-activity');
  return {
    node,
    log,
    api,
    tool: (activity) => api.setToolActivity(node, { rawName: 'image_generate', ...activity }),
    placeholders: () => [...node.querySelectorAll('.image-gen-placeholder')],
    // What each card in the slot shows: the picture it revealed or loaded, '' while empty.
    cards: () => [...(slot()?.children || [])].map(shownIn),
    slot,
  };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

test('events without a call id keep one card for one generation', () => {
  const panel = harness();
  panel.tool({ status: 'started' });
  panel.tool({ status: 'progress' });
  panel.tool({ status: 'progress' });
  assert.equal(panel.placeholders().length, 1, 'progress updates the card instead of adding one');
  panel.tool({ status: 'completed' });
  assert.equal(panel.placeholders().length, 1);
  assert.equal(panel.placeholders()[0].dataset.toolStatus, 'completed');
  assert.deepEqual(panel.log.filter(([kind]) => kind === 'start'), [['start', '']], 'one animation started');
  // A new start after that generation finished is a new generation.
  panel.tool({ status: 'started' });
  assert.equal(panel.placeholders().length, 2);
});

test('generations with call ids each keep their own card', () => {
  const panel = harness();
  for (const id of ['call-a', 'call-b', 'call-c']) panel.tool({ activityId: id, status: 'started' });
  panel.tool({ activityId: 'call-b', status: 'completed' });
  assert.equal(panel.placeholders().length, 3);
  assert.deepEqual(panel.placeholders().map((item) => item.dataset.toolStatus), ['started', 'completed', 'started']);
});

test('every Markdown picture in the reply reveals in its own card, then the reply takes over', async () => {
  const panel = harness();
  for (const id of ['call-a', 'call-b', 'call-c']) panel.tool({ activityId: id, status: 'started' });
  const urls = ['https://img.example.test/a.png', 'https://img.example.test/b.png', 'https://img.example.test/c.png'];
  await panel.api.settleTurnImages(panel.node, {
    content: `Three options:\n\n![A](${urls[0]})\n\n![B](${urls[1]})\n\n![C](${urls[2]})`,
  });
  assert.deepEqual(panel.log.filter(([kind]) => kind === 'reveal').map(([, value]) => value), urls);
  assert.equal(panel.slot(), null, 'every card gave way to the inline reply');
});

test('MEDIA tags reveal in order, and stored files count as the reply showing them', async () => {
  const panel = harness();
  for (const id of ['call-a', 'call-b']) panel.tool({ activityId: id, status: 'started' });
  await panel.api.settleTurnImages(panel.node, { content: `Done.\nMEDIA:${pic('a')}\nMEDIA:${pic('b')}` });
  assert.deepEqual(panel.log.filter(([kind]) => kind === 'reveal').map(([, value]) => value), [pic('a'), pic('b')]);
  assert.equal(panel.slot(), null);
});

test('a recovered picture the reply does not name stays in its card', async () => {
  const panel = harness();
  for (const id of ['call-a', 'call-b']) panel.tool({ activityId: id, status: 'started' });
  await panel.api.settleTurnImages(panel.node, {
    content: `Here is A.\nMEDIA:${pic('a')}`,
    imageSources: [pic('a'), pic('b')],
  });
  assert.deepEqual(panel.cards(), [pic('b')], 'A gave way to the reply; B is still shown');
  panel.api.setToolActivity(panel.node, null);
  assert.deepEqual(panel.cards(), [pic('b')], 'the turn end keeps the revealed picture');
});

test('recovered pictures beyond the waiting generations get cards of their own', async () => {
  const panel = harness();
  panel.tool({ activityId: 'call-a', status: 'started' });
  await panel.api.settleTurnImages(panel.node, {
    content: `Here is A.\nMEDIA:${pic('a')}`,
    imageSources: [pic('a'), pic('b'), pic('c')],
  });
  await flushMicrotasks();
  assert.deepEqual(panel.cards(), [pic('b'), pic('c')]);
});

test('an alternate from a tool result stays when the reply names only the primary', async () => {
  const panel = harness();
  panel.tool({ activityId: 'call-a', status: 'started' });
  panel.tool({ activityId: 'call-a', status: 'completed', result: { success: true, image: pic('primary'), url: pic('alternate') } });
  await flushMicrotasks();
  assert.deepEqual(panel.cards(), [pic('primary'), pic('alternate')]);
  await panel.api.settleTurnImages(panel.node, { content: `Here it is.\nMEDIA:${pic('primary')}` });
  assert.deepEqual(panel.cards(), [pic('alternate')]);
});

test('a picture still loading at the turn end lands in its own card, once', async () => {
  let release;
  const hold = { source: pic('a'), wait: new Promise((resolve) => { release = resolve; }) };
  const panel = harness({ revealHold: hold });
  panel.tool({ activityId: 'call-a', status: 'started' });
  panel.tool({ activityId: 'call-b', status: 'started' });
  panel.tool({ activityId: 'call-a', status: 'completed', result: { success: true, image: pic('a') } });
  const settled = panel.api.settleTurnImages(panel.node, { content: `Two.\nMEDIA:${pic('a')}\nMEDIA:${pic('b')}` });
  release();
  await settled;
  assert.deepEqual(panel.log.filter(([kind]) => kind === 'reveal').map(([, value]) => value), [pic('a'), pic('b')],
    'A revealed once, in its own card; B in the other');
  assert.equal(panel.slot(), null);
});

test('teardown stops the animation of a revealed picture and keeps the picture', async () => {
  const panel = harness();
  panel.tool({ activityId: 'call-a', status: 'started' });
  panel.tool({ activityId: 'call-b', status: 'started' });
  panel.tool({ activityId: 'call-a', status: 'completed', result: { success: true, image: pic('a') } });
  await flushMicrotasks();
  panel.api.setToolActivity(panel.node, null, { settle: true });
  assert.deepEqual(panel.cards(), [pic('a')], 'the revealed picture stays');
  assert.deepEqual(panel.log.filter(([kind]) => kind === 'settle'), [['settle', pic('a')]], 'its animation stopped');
  assert.deepEqual(panel.log.filter(([kind]) => kind === 'dispose'), [['dispose', 'call-b']], 'the waiting one was dropped');
});

test('a reply with generation cards marks itself so its inline pictures wait', () => {
  const panel = harness();
  panel.api.setToolActivity(panel.node, { rawName: 'terminal', status: 'started' });
  assert.equal(panel.node.classList.contains('image-cards-pending'), false, 'no card, nothing to hide');
  panel.tool({ activityId: 'call-a', status: 'started' });
  assert.equal(panel.node.classList.contains('image-cards-pending'), true);
});

test('a reveal its canvas cancelled does not count as shown', async () => {
  // The canvas stopped (its card was away too long): the card must not keep a hidden picture
  // and pass as revealed, so the turn end can still show that picture.
  const panel = harness({ cancelReveal: (source) => source === pic('b') });
  panel.tool({ activityId: 'call-b', status: 'started' });
  panel.tool({ activityId: 'call-b', status: 'completed', result: { success: true, image: pic('b') } });
  await flushMicrotasks();
  const card = panel.placeholders()[0];
  assert.equal(Boolean(card.querySelector('.generated-image-reveal-source')), false, 'no hidden picture left behind');
  assert.equal(card.dataset.revealSource, undefined, 'the claim is given back');
  await panel.api.settleTurnImages(panel.node, { content: 'Here it is.', imageSources: [pic('b')] });
  await flushMicrotasks();
  assert.ok(panel.cards().includes(pic('b')), 'the recovered picture is still shown');
});

test('the same picture under two spellings of its URL is shown once', async () => {
  const panel = harness();
  panel.tool({ activityId: 'call-a', status: 'started' });
  panel.tool({ activityId: 'call-a', status: 'completed', result: { success: true, image: 'https://CDN.example:443/result.png' } });
  await flushMicrotasks();
  await panel.api.settleTurnImages(panel.node, { content: 'Done.\n\n![Result](https://cdn.example/result.png)' });
  assert.deepEqual(panel.cards(), [], 'the card gave way to the inline picture with the normalized URL');
});

test('ordinary tool calls never reach the bubble', () => {
  const panel = harness();
  panel.api.setToolActivity(panel.node, { rawName: 'terminal', status: 'started' });
  assert.equal(panel.slot(), null);
  panel.tool({ status: 'completed' });
  assert.equal(panel.slot(), null, 'a finish nothing started has nothing to show');
});
