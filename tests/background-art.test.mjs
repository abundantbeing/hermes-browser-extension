import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';

const moduleUrl = new URL('../extension/lib/background-art.mjs', import.meta.url);
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const extension = new URL('../extension/', import.meta.url);

function fixture(previous = '', { hidden = false, readFails = false, writeFails = false } = {}) {
  const saved = {};
  const values = new Map();
  const listeners = new Map();
  const document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
  };
  const root = { style: { setProperty(name, value) { values.set(name, value); } } };
  const storage = {
    async get(key) {
      if (readFails) throw new Error('Storage unavailable');
      return { [key]: Object.hasOwn(saved, key) ? saved[key] : previous };
    },
    async set(value) {
      if (writeFails) throw new Error('Storage unavailable');
      Object.assign(saved, value);
    },
  };
  const visibility = async (state) => {
    document.visibilityState = state;
    await listeners.get('visibilitychange')?.();
  };
  return { document, root, storage, saved, values, listeners, visibility };
}

test('background rotation module exists', () => {
  assert.ok(existsSync(moduleUrl), 'the eleven-background rotation is not implemented');
});

// When implementation is absent the first test is the intentional RED failure.
if (existsSync(moduleUrl)) {
  const {
    BACKGROUND_ART,
    BACKGROUND_ART_STORAGE_KEY,
    ORIGINAL_BACKGROUND_ART,
    pickBackgroundArt,
    backgroundArtCssValue,
    createBackgroundArtRotation,
  } = await import(moduleUrl);

  test('the fifteen-entry pool preserves the current image and all approved full-bleed artwork', () => {
    assert.equal(ORIGINAL_BACKGROUND_ART, 'assets/img/hermes-browser-enter-gate-ink.png');
    assert.equal(BACKGROUND_ART.length, 15);
    assert.equal(new Set(BACKGROUND_ART).size, 15);
    assert.deepEqual(BACKGROUND_ART.slice(-4), [
      'assets/img/background-art/stack-graf10-ink.webp',
      'assets/img/background-art/stack-graf13-ink.webp',
      'assets/img/background-art/stack-graf14-ink.webp',
      'assets/img/background-art/stack-graf12-ink.webp',
    ]);
    assert.ok(Object.isFrozen(BACKGROUND_ART));
    assert.equal(BACKGROUND_ART[0], ORIGINAL_BACKGROUND_ART);
    for (const entry of BACKGROUND_ART) assert.ok(statSync(new URL(entry, extension)).size > 0);
    for (const entry of BACKGROUND_ART.slice(1)) {
      const data = readFileSync(new URL(entry, extension));
      assert.equal(data.toString('ascii', 0, 4), 'RIFF');
      assert.equal(data.toString('ascii', 8, 12), 'WEBP');
      let dimensions;
      for (let offset = 12; offset + 8 <= data.length;) {
        const type = data.toString('ascii', offset, offset + 4);
        const size = data.readUInt32LE(offset + 4);
        if (type === 'VP8L') {
          assert.equal(data[offset + 8], 0x2f);
          const bits = data.readUInt32LE(offset + 9);
          dimensions = [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
          break;
        }
        offset += 8 + size + (size % 2);
      }
      assert.deepEqual(dimensions, entry.includes('/stack-graf') ? [1672, 941] : [1054, 1448], entry + ' retains full-size alpha dimensions');
    }
  });

  test('every entry can be selected and the previous entry never repeats', () => {
    for (let i = 0; i < BACKGROUND_ART.length; i += 1) {
      assert.equal(pickBackgroundArt((i + 0.5) / BACKGROUND_ART.length), BACKGROUND_ART[i]);
    }
    for (const previous of BACKGROUND_ART) {
      const pool = BACKGROUND_ART.filter((entry) => entry !== previous);
      for (let i = 0; i < pool.length; i += 1) {
        assert.equal(pickBackgroundArt((i + 0.5) / pool.length, previous), pool[i]);
      }
    }
    assert.equal(pickBackgroundArt(-1), BACKGROUND_ART[0]);
    assert.equal(pickBackgroundArt(1), BACKGROUND_ART.at(-1));
    assert.equal(pickBackgroundArt(Number.NaN), BACKGROUND_ART[0]);
    assert.equal(pickBackgroundArt(() => 0), BACKGROUND_ART[0]);
  });

  test('CSS URLs only allow the shipped images', () => {
    for (const entry of BACKGROUND_ART) assert.equal(backgroundArtCssValue(entry), `url("${entry}")`);
    for (const entry of ['', 'https://example.com/picture.png', 'assets/img/not-shipped.webp']) {
      assert.equal(backgroundArtCssValue(entry), '');
    }
  });

  test('initial opening and page recreation persist a non-repeating choice', async () => {
    const shared = fixture(ORIGINAL_BACKGROUND_ART);
    const first = createBackgroundArtRotation({ ...shared, random: () => 0, locks: null });
    const selected = await first.ready;
    assert.equal(selected, BACKGROUND_ART[1]);
    assert.equal(shared.saved[BACKGROUND_ART_STORAGE_KEY], selected);
    assert.equal(shared.values.get('--background-art'), backgroundArtCssValue(selected));
    first.dispose();
    const second = createBackgroundArtRotation({ ...shared, random: () => 0, locks: null });
    assert.notEqual(await second.ready, selected);
    second.dispose();
  });

  test('a retained panel changes only after a hidden-to-visible reopening', async () => {
    const view = fixture(ORIGINAL_BACKGROUND_ART);
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null });
    const first = await rotation.ready;
    await view.visibility('visible');
    await view.visibility('visible');
    assert.equal(view.values.get('--background-art'), backgroundArtCssValue(first));
    assert.deepEqual([...view.listeners.keys()], ['visibilitychange'], 'no resize or focus rotation');
    await view.visibility('hidden');
    assert.equal(view.values.get('--background-art'), backgroundArtCssValue(first));
    await view.visibility('visible');
    assert.notEqual(view.values.get('--background-art'), backgroundArtCssValue(first));
    rotation.dispose();
    assert.equal(view.listeners.size, 0);
  });

  test('hidden preload waits until the panel is actually visible', async () => {
    const view = fixture('', { hidden: true });
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null });
    assert.equal(await rotation.ready, '');
    assert.equal(view.values.size, 0);
    await view.visibility('visible');
    assert.equal(view.values.get('--background-art'), backgroundArtCssValue(ORIGINAL_BACKGROUND_ART));
    rotation.dispose();
  });

  test('optional storage failure does not break the panel or repeat the same in-memory choice', async () => {
    const view = fixture('', { readFails: true, writeFails: true });
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null });
    const first = await rotation.ready;
    assert.ok(BACKGROUND_ART.includes(first));
    await view.visibility('hidden');
    await view.visibility('visible');
    assert.notEqual(view.values.get('--background-art'), backgroundArtCssValue(first));
    rotation.dispose();
  });

  test('shared Web Lock serializes choices between concurrently opening panels', async () => {
    let queue = Promise.resolve();
    const locks = { request(name, callback) {
      assert.equal(name, 'hermes-background-art');
      const result = queue.then(callback);
      queue = result.catch(() => {});
      return result;
    } };
    const shared = fixture(ORIGINAL_BACKGROUND_ART);
    const first = createBackgroundArtRotation({ ...shared, random: () => 0, locks });
    const other = fixture();
    const second = createBackgroundArtRotation({ ...other, storage: shared.storage, random: () => 0, locks });
    assert.notEqual(await first.ready, await second.ready);
    first.dispose();
    second.dispose();
  });

  test('shell and startup share the selected mask without changing full-bleed sizing', () => {
    const selectedMasks = css.match(/var\(--background-art, url\("assets\/img\/hermes-browser-enter-gate-ink\.png"\)\) center \/ cover no-repeat/g) || [];
    assert.equal(selectedMasks.length, 4, 'both prefixed and standard masks on shell and startup');
    assert.match(panel, /import \{ createBackgroundArtRotation \} from '\.\/lib\/background-art\.mjs';/);
    assert.match(panel, /createBackgroundArtRotation\(\{[\s\S]*?root: document\.documentElement,[\s\S]*?document,[\s\S]*?storage: browserApi\?\.storage\?\.local,/);
    assert.match(panel, /^applySidecarArt\(\);/m, 'existing banner rotation remains independent');
  });
}
