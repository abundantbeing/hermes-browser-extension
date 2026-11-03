import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedMediaCache } from '../extension/lib/media-data-cache.mjs';

const pictureUrl = (name) => `data:image/png;base64,${name}`;

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

test('a loaded picture is served from memory without loading it again', async () => {
  const cache = createBoundedMediaCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return pictureUrl('AAAA');
  };
  assert.equal(await cache.getOrLoad('gw|a.png', load), pictureUrl('AAAA'));
  assert.equal(await cache.getOrLoad('gw|a.png', load), pictureUrl('AAAA'));
  assert.equal(loads, 1);
});

test('callers that arrive during one download share that download', async () => {
  const cache = createBoundedMediaCache();
  const release = gate();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await release.wait;
    return pictureUrl('BBBB');
  };
  const first = cache.getOrLoad('gw|b.png', load);
  const second = cache.getOrLoad('gw|b.png', load);
  release.open();
  assert.deepEqual(await Promise.all([first, second]), [pictureUrl('BBBB'), pictureUrl('BBBB')]);
  assert.equal(loads, 1);
});

test('empty and failed downloads are not stored, so the next call retries', async () => {
  const cache = createBoundedMediaCache();
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    if (attempts === 1) return '';
    if (attempts === 2) throw new Error('gateway unreachable');
    return pictureUrl('CCCC');
  };
  assert.equal(await cache.getOrLoad('gw|c.png', load), '');
  assert.equal(await cache.getOrLoad('gw|c.png', load), '');
  assert.equal(cache.has('gw|c.png'), false);
  assert.equal(await cache.getOrLoad('gw|c.png', load), pictureUrl('CCCC'));
  assert.equal(attempts, 3);
});

test('a loader that throws synchronously cannot leave a stuck download behind', async () => {
  const cache = createBoundedMediaCache();
  let attempts = 0;
  const load = () => {
    attempts += 1;
    if (attempts === 1) throw new Error('boom');
    return pictureUrl('DDDD');
  };
  assert.equal(await cache.getOrLoad('gw|d.png', load), '');
  assert.equal(await cache.getOrLoad('gw|d.png', load), pictureUrl('DDDD'));
  assert.equal(attempts, 2);
});

test('the least recently used picture is evicted, and a read counts as a use', async () => {
  const cache = createBoundedMediaCache({ maxEntries: 2 });
  await cache.getOrLoad('a', async () => pictureUrl('a'));
  await cache.getOrLoad('b', async () => pictureUrl('b'));
  // Reading a again makes b the least recently used entry.
  await cache.getOrLoad('a', async () => {
    throw new Error('a should come from memory');
  });
  await cache.getOrLoad('c', async () => pictureUrl('c'));
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.size, 2);
});

test('a picture larger than the entry bound is returned but not stored', async () => {
  const cache = createBoundedMediaCache({ maxEntryChars: 16 });
  const big = pictureUrl('E'.repeat(64));
  assert.equal(await cache.getOrLoad('gw|big.png', async () => big), big);
  assert.equal(cache.has('gw|big.png'), false);
});
