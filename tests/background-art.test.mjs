import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
    BACKGROUND_ART_RECENT_LIMIT,
    BACKGROUND_ART_STORAGE_KEY,
    ORIGINAL_BACKGROUND_ART,
    BACKGROUND_ART_WEIGHTS,
    MAIN_BACKGROUND_ART,
    MAIN_BACKGROUND_WEIGHT,
    ONBOARDING_BACKGROUND_ART,
    OTHER_BACKGROUND_WEIGHT,
    isFirstRunStorage,
    pickBackgroundArt,
    pickOnboardingBackgroundArt,
    recentBackgroundArt,
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

  test('every entry can be selected (weighted, deterministic) and the previous entry never repeats', () => {
    const total = BACKGROUND_ART.reduce((sum, entry) => sum + BACKGROUND_ART_WEIGHTS[entry], 0);
    let passed = 0;
    for (const entry of BACKGROUND_ART) {
      const weight = BACKGROUND_ART_WEIGHTS[entry];
      assert.equal(pickBackgroundArt((passed + weight / 2) / total), entry, `the middle of ${entry} share picks it`);
      assert.equal(pickBackgroundArt((passed + weight / 2) / total), entry, 'the same random() gives the same pick');
      passed += weight;
    }
    for (const previous of BACKGROUND_ART) {
      for (const value of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.999, 1]) {
        assert.notEqual(pickBackgroundArt(value, previous), previous, `${previous} at ${value}`);
      }
    }
    assert.equal(pickBackgroundArt(-1), BACKGROUND_ART[0]);
    assert.equal(pickBackgroundArt(1), BACKGROUND_ART.at(-1));
    assert.equal(pickBackgroundArt(Number.NaN), BACKGROUND_ART[0]);
    assert.equal(pickBackgroundArt(() => 0), BACKGROUND_ART[0]);
  });

  test('the main four and the setup seven are data: the right files, in the right order, all shipped', () => {
    const dir = 'assets/img/background-art/';
    assert.deepEqual(MAIN_BACKGROUND_ART, ['05-messenger-axis', '04-network-crossing', '03-first-contact', '10-recursive-presence'].map((name) => `${dir}${name}-ink.webp`));
    assert.deepEqual(ONBOARDING_BACKGROUND_ART, ['05-messenger-axis', '04-network-crossing', '03-first-contact', '10-recursive-presence', '09-winged-dispatch', '02-memory-orrery', '01-living-browser-gate'].map((name) => `${dir}${name}-ink.webp`));
    assert.ok(Object.isFrozen(MAIN_BACKGROUND_ART) && Object.isFrozen(ONBOARDING_BACKGROUND_ART));
    for (const entry of [...MAIN_BACKGROUND_ART, ...ONBOARDING_BACKGROUND_ART]) assert.ok(BACKGROUND_ART.includes(entry), `${entry} is in the full pool`);
    assert.deepEqual(ONBOARDING_BACKGROUND_ART.slice(0, 4), [...MAIN_BACKGROUND_ART], 'the main four lead the seven');
    assert.equal(MAIN_BACKGROUND_WEIGHT, 3);
    assert.equal(OTHER_BACKGROUND_WEIGHT, 1);
    for (const entry of BACKGROUND_ART) assert.equal(BACKGROUND_ART_WEIGHTS[entry], MAIN_BACKGROUND_ART.includes(entry) ? 3 : 1);
    assert.ok(Object.isFrozen(BACKGROUND_ART_WEIGHTS));
    const tracked = new Set(execFileSync('git', ['ls-files', 'extension/assets/img'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' }).split('\n').filter(Boolean));
    for (const entry of ONBOARDING_BACKGROUND_ART) {
      assert.ok(tracked.has(`extension/${entry}`), `${entry} is tracked by git`);
      assert.ok(statSync(new URL(entry, extension)).size > 0);
    }
    const build = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    assert.match(build, /copyDir\(src, dest\);/, 'the build copies the whole extension folder, images included');
  });

  // A seeded generator so the samples below are exact and repeatable.
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const share = (picks, set) => picks.filter((entry) => set.includes(entry)).length / picks.length;

  test('the main four are picked noticeably more often: at least half in the full pool, three quarters in the setup pool', () => {
    const random = seeded(2024);
    const full = Array.from({ length: 20000 }, () => pickBackgroundArt(random));
    assert.ok(share(full, MAIN_BACKGROUND_ART) >= 0.5, `full pool main share ${share(full, MAIN_BACKGROUND_ART).toFixed(3)}`);
    assert.ok(share(full, MAIN_BACKGROUND_ART) < 0.6, 'the others still appear, just rarer');
    for (const entry of BACKGROUND_ART.filter((item) => !MAIN_BACKGROUND_ART.includes(item))) assert.ok(full.includes(entry), `${entry} still appears`);
    const setup = Array.from({ length: 20000 }, () => pickOnboardingBackgroundArt(random));
    assert.ok(share(setup, MAIN_BACKGROUND_ART) >= 0.75, `setup main share ${share(setup, MAIN_BACKGROUND_ART).toFixed(3)}`);
    for (const entry of ONBOARDING_BACKGROUND_ART.slice(4)) assert.ok(setup.includes(entry), `${entry} still appears in setup`);
  });

  test('with recent picks avoided as a panel really does, the main four still lead in both pools', () => {
    const random = seeded(7);
    const run = (pick, pool) => {
      let recent = [];
      const picks = [];
      for (let i = 0; i < 20000; i += 1) {
        const entry = pick(random, recent);
        picks.push(entry);
        recent = [entry, ...recent].slice(0, BACKGROUND_ART_RECENT_LIMIT);
        assert.ok(pool.includes(entry));
      }
      return picks;
    };
    const full = run((rand, recent) => pickBackgroundArt(rand, recent), BACKGROUND_ART);
    assert.ok(share(full, MAIN_BACKGROUND_ART) >= 0.4 && share(full, MAIN_BACKGROUND_ART) > 4 / 15, `full pool, avoiding recents: ${share(full, MAIN_BACKGROUND_ART).toFixed(3)}`);
    const setup = run((rand, recent) => pickOnboardingBackgroundArt(rand, recent), ONBOARDING_BACKGROUND_ART);
    assert.ok(share(setup, MAIN_BACKGROUND_ART) >= 0.6, `setup, avoiding recents: ${share(setup, MAIN_BACKGROUND_ART).toFixed(3)}`);
  });

  test('the setup pool never yields an image outside the seven, whatever was recent', () => {
    const random = seeded(99);
    for (let i = 0; i < 5000; i += 1) {
      const recent = Array.from({ length: Math.floor(random() * 8) }, () => BACKGROUND_ART[Math.floor(random() * BACKGROUND_ART.length)]);
      const entry = pickOnboardingBackgroundArt(random, recent);
      assert.ok(ONBOARDING_BACKGROUND_ART.includes(entry), `${entry} is one of the seven`);
    }
    for (const value of [0, 0.3, 0.7, 0.999, 1, Number.NaN, -3]) assert.ok(ONBOARDING_BACKGROUND_ART.includes(pickOnboardingBackgroundArt(value)));
  });

  test('five recent picks in the seven-image pool degrade gracefully: never empty, never the newest', () => {
    const recent = ONBOARDING_BACKGROUND_ART.slice(0, 5);
    for (let i = 0; i < 100; i += 1) {
      const entry = pickOnboardingBackgroundArt((i + 0.5) / 100, recent);
      assert.ok(ONBOARDING_BACKGROUND_ART.includes(entry));
      assert.notEqual(entry, recent[0], 'the newest recent pick is avoided');
    }
    for (let i = 0; i < 20; i += 1) {
      assert.ok(ONBOARDING_BACKGROUND_ART.includes(pickOnboardingBackgroundArt(i / 20, [...ONBOARDING_BACKGROUND_ART])), 'even with every image recent it still answers');
    }
    assert.ok(pickBackgroundArt(0.5, BACKGROUND_ART, { pool: ['not-an-image'] }), 'an unusable pool falls back to the full one');
  });

  test('a first-run panel picks from the setup seven, decided from storage before the first paint', async () => {
    const keys = { completedKey: 'done', introSeenKey: 'seen' };
    assert.equal(isFirstRunStorage({}, keys), true, 'nothing stored: first run');
    assert.equal(isFirstRunStorage({ done: true }, keys), false);
    assert.equal(isFirstRunStorage({ seen: true }, keys), false, 'a legacy intro-seen user is not first run');
    assert.equal(isFirstRunStorage({ done: false }, keys), true);
    for (let i = 0; i < 40; i += 1) {
      const view = fixture();
      const rotation = createBackgroundArtRotation({ ...view, random: () => (i + 0.5) / 40, locks: null, firstRun: async () => true });
      const picked = await rotation.ready;
      assert.ok(ONBOARDING_BACKGROUND_ART.includes(picked), `${picked} is one of the seven`);
      assert.equal(view.values.get('--background-art'), backgroundArtCssValue(picked));
    }
    const seen = new Set();
    for (let i = 0; i < 60; i += 1) {
      const view = fixture();
      seen.add(await createBackgroundArtRotation({ ...view, random: () => (i + 0.5) / 60, locks: null, firstRun: async () => false }).ready);
    }
    assert.ok([...seen].some((entry) => !ONBOARDING_BACKGROUND_ART.includes(entry)), 'a returning user still draws from the whole pool');
    const failing = fixture();
    const survivor = createBackgroundArtRotation({ ...failing, random: () => 0, locks: null, firstRun: async () => { throw new Error('storage'); } });
    assert.ok(BACKGROUND_ART.includes(await survivor.ready), 'an unreadable flag falls back to the normal pool rather than blocking');
  });

  test('the screens wait for the pick: nothing shows the fallback image before the panel has chosen', async () => {
    const view = fixture();
    view.root.dataset = {};
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null, firstRun: async () => true });
    assert.equal(view.root.dataset.backgroundArtReady, undefined, 'not ready before the pick');
    await rotation.ready;
    assert.equal(view.root.dataset.backgroundArtReady, 'true');
    assert.match(css, /html:not\(\[data-background-art-ready\]\) :is\(\.startup-screen, \.onboarding\)::before \{ visibility: hidden; \}/);
  });

  test('opening setup (a rerun from Settings) swaps a picture outside the seven for one of them, and keeps one inside', async () => {
    const outside = fixture();
    const rotation = createBackgroundArtRotation({ ...outside, random: () => 0, locks: null, firstRun: async () => false });
    assert.equal(await rotation.ready, ORIGINAL_BACKGROUND_ART, 'the normal pool, first entry');
    const swapped = await rotation.ensureOnboardingArt();
    assert.ok(ONBOARDING_BACKGROUND_ART.includes(swapped));
    assert.equal(outside.values.get('--background-art'), backgroundArtCssValue(swapped));
    assert.equal(await rotation.ensureOnboardingArt(), swapped, 'asking again changes nothing');
    const inside = fixture();
    const kept = createBackgroundArtRotation({ ...inside, random: () => 0.3, locks: null, firstRun: async () => true });
    const first = await kept.ready;
    assert.equal(await kept.ensureOnboardingArt(), first, 'already one of the seven: kept');
  });

  test('the panel wires the setup pool from storage and asks for it whenever setup opens, and never swaps when it ends', () => {
    assert.match(panel, /import \{ createBackgroundArtRotation, isFirstRunStorage \} from '\.\/lib\/background-art\.mjs';/);
    assert.match(panel, /const backgroundArtRotation = createBackgroundArtRotation\(\{[\s\S]*?firstRun: async \(\) => isFirstRunStorage\(\s*await browserApi\.storage\.local\.get\(\[ONBOARDING_COMPLETED_STORAGE_KEY, HERMES_BROWSER_INTRO_SEEN_STORAGE_KEY\]\)/);
    const open = panel.match(/function openOnboarding\([\s\S]*?\n\}/)?.[0] || '';
    assert.match(open, /void backgroundArtRotation\.ensureOnboardingArt\(\);/);
    const complete = panel.match(/async function completeOnboarding\([\s\S]*?\n\}/)?.[0] || '';
    assert.doesNotMatch(complete, /backgroundArt|--background-art/, 'finishing or skipping keeps the picture on screen until the next open');
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
    assert.deepEqual(shared.saved[BACKGROUND_ART_STORAGE_KEY], [selected, ORIGINAL_BACKGROUND_ART], 'recent picks, newest first; the old single-string value is read too');
    assert.equal(shared.values.get('--background-art'), backgroundArtCssValue(selected));
    first.dispose();
    const second = createBackgroundArtRotation({ ...shared, random: () => 0, locks: null });
    assert.notEqual(await second.ready, selected);
    second.dispose();
  });

  test('an open panel keeps its picture: switching tabs or hiding the panel never changes it', async () => {
    const view = fixture(ORIGINAL_BACKGROUND_ART);
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null });
    const first = await rotation.ready;
    await view.visibility('hidden');
    await view.visibility('visible');
    await view.visibility('hidden');
    await view.visibility('visible');
    assert.equal(view.values.get('--background-art'), backgroundArtCssValue(first));
    assert.equal(view.listeners.size, 0, 'no visibility, focus or resize listeners');
    assert.doesNotMatch(readFileSync(moduleUrl, 'utf8'), /visibilitychange/);
  });

  test('a panel that loads in a background tab still picks its picture right away', async () => {
    const view = fixture('', { hidden: true });
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null });
    assert.equal(await rotation.ready, ORIGINAL_BACKGROUND_ART);
    assert.equal(view.values.get('--background-art'), backgroundArtCssValue(ORIGINAL_BACKGROUND_ART));
  });

  test('optional storage failure does not break the panel', async () => {
    const view = fixture('', { readFails: true, writeFails: true });
    const rotation = createBackgroundArtRotation({ ...view, random: () => 0, locks: null });
    const first = await rotation.ready;
    assert.ok(BACKGROUND_ART.includes(first));
    assert.equal(view.values.get('--background-art'), backgroundArtCssValue(first));
  });

  test('panels open in several tabs at once all get different pictures', async () => {
    let queue = Promise.resolve();
    const locks = { request(name, callback) {
      assert.equal(name, 'hermes-background-art');
      const result = queue.then(callback);
      queue = result.catch(() => {});
      return result;
    } };
    const shared = fixture(ORIGINAL_BACKGROUND_ART);
    const picks = await Promise.all(Array.from({ length: BACKGROUND_ART_RECENT_LIMIT }, () => {
      const view = fixture();
      return createBackgroundArtRotation({ ...view, storage: shared.storage, random: () => 0, locks }).ready;
    }));
    assert.equal(new Set(picks).size, picks.length, picks.join(', '));
    assert.equal(shared.saved[BACKGROUND_ART_STORAGE_KEY].length, BACKGROUND_ART_RECENT_LIMIT, 'the remembered list stays short');
  });

  test('recent list ignores unknown entries and never runs the pool dry', () => {
    assert.deepEqual(recentBackgroundArt(['nope', BACKGROUND_ART[2], BACKGROUND_ART[2], BACKGROUND_ART[3]]), [BACKGROUND_ART[2], BACKGROUND_ART[3]]);
    assert.deepEqual(recentBackgroundArt(undefined), []);
    assert.ok(BACKGROUND_ART.includes(pickBackgroundArt(() => 0.5, [...BACKGROUND_ART])));
  });

  test('shell and startup share the selected mask without changing full-bleed sizing', () => {
    const selectedMasks = css.match(/var\(--background-art, url\("assets\/img\/hermes-browser-enter-gate-ink\.png"\)\) center \/ cover no-repeat/g) || [];
    assert.equal(selectedMasks.length, 4, 'both prefixed and standard masks on shell and startup');
    assert.match(panel, /import \{ createBackgroundArtRotation, isFirstRunStorage \} from '\.\/lib\/background-art\.mjs';/);
    assert.match(panel, /createBackgroundArtRotation\(\{[\s\S]*?root: document\.documentElement,[\s\S]*?storage: browserApi\?\.storage\?\.local,/);
    assert.match(panel, /^applySidecarArt\(\);/m, 'existing banner rotation remains independent');
  });
}
