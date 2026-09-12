import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamPacer, STREAM_PACER_DEFAULTS } from '../extension/lib/stream-pacing.mjs';

const FRAME_MS = 16;

// Manual clock + scheduler. Each tick advances simulated time by `ms` and
// fires the timers that were pending when the tick started; timers scheduled
// during a tick wait for the next one, like real timers.
function createHarness({ frameMs = FRAME_MS } = {}) {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const frames = [];
  const schedule = (cb) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, cb);
    return id;
  };
  const cancel = (id) => {
    timers.delete(id);
  };
  const pacer = createStreamPacer({
    onFrame: (text, meta) => frames.push({ t: time, text, done: meta.done, backlog: meta.backlog }),
    now: () => time,
    schedule,
    cancel,
  });
  const step = (ms = frameMs) => {
    time += ms;
    const due = [...timers.values()];
    timers.clear();
    for (const cb of due) cb();
  };
  const runFor = (ms) => {
    const target = time + ms;
    while (time < target) step(Math.min(frameMs, target - time));
  };
  const runUntil = (predicate, limitMs = 20_000) => {
    while (!predicate()) {
      assert.ok(time < limitMs, `pacer did not settle within ${limitMs}ms of simulated time`);
      step();
    }
  };
  return {
    pacer,
    frames,
    step,
    runFor,
    runUntil,
    pendingTimers: () => timers.size,
    time: () => time,
  };
}

function points(text) {
  return Array.from(String(text));
}

function chunkPoints(text, size) {
  const all = points(text);
  const chunks = [];
  for (let index = 0; index < all.length; index += size) {
    chunks.push(all.slice(index, index + size).join(''));
  }
  return chunks;
}

// A lone surrogate is a single UTF-16 unit in the D800-DFFF range; every
// other code point iterated with for...of is either BMP or a full pair.
function hasLoneSurrogate(text) {
  for (const point of String(text)) {
    const code = point.codePointAt(0);
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

function assertPrefixChain(frames) {
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(
      frames[index].text.startsWith(frames[index - 1].text),
      `frame ${index} must extend frame ${index - 1} (monotonic reveal)`,
    );
  }
}

// Worst-case revealed characters in any anchored 1000ms window of the frame
// timeline (both window anchors checked, to catch boundary alignment).
function maxRevealedPerSecond(frames) {
  const counts = frames.map((frame) => points(frame.text).length);
  let worst = 0;
  for (let start = 0; start < frames.length; start += 1) {
    const from = start > 0 ? counts[start - 1] : 0;
    let end = start;
    while (end + 1 < frames.length && frames[end + 1].t < frames[start].t + 1000) end += 1;
    worst = Math.max(worst, counts[end] - from);
  }
  for (let end = 0; end < frames.length; end += 1) {
    let start = end;
    while (start > 0 && frames[start - 1].t > frames[end].t - 1000) start -= 1;
    const from = start > 0 ? counts[start - 1] : 0;
    worst = Math.max(worst, counts[end] - from);
  }
  return worst;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('exports the documented defaults and the pacing API', () => {
  assert.deepEqual(STREAM_PACER_DEFAULTS, {
    minCharsPerSecond: 420,
    maxCharsPerSecond: 2600,
    minDurationMs: 600,
    maxLagMs: 900,
  });
  const pacer = createStreamPacer({ now: () => 0, schedule: () => 1, cancel: () => {} });
  for (const name of ['push', 'flush', 'finish', 'reset', 'pending', 'revealed']) {
    assert.equal(typeof pacer[name], 'function', `${name} must be a function`);
  }
  assert.equal(pacer.pending(), 0);
  assert.equal(pacer.revealed(), 0);
});

test('push() never renders synchronously and the first frame paints promptly', () => {
  const h = createHarness();
  h.pacer.push('hello world');
  assert.equal(h.frames.length, 0, 'push() must not render synchronously');
  h.step();
  assert.equal(h.frames.length, 1, 'a frame must be scheduled for the next tick');
  assert.equal(h.frames[0].text.length, 1, 'frame one paints exactly one char (min-duration stretches the rest)');
  assert.equal(h.frames[0].backlog, h.pacer.pending());
  assert.equal(h.frames[0].done, false);
  assert.equal(h.pacer.pending() + h.pacer.revealed(), points('hello world').length);
});

test('a 4000-char burst reveals monotonically, caps rate, and completes within 2.5s', () => {
  const h = createHarness();
  const body = 'A'.repeat(4000);
  h.pacer.push(body);
  assert.equal(h.frames.length, 0, 'push() must not render synchronously');
  h.runUntil(() => h.pacer.pending() === 0);
  assert.ok(h.time() <= 2500, `4000-char burst took ${h.time()}ms (target <= 2500ms)`);
  assert.ok(h.time() >= 300, `burst was dumped in ${h.time()}ms instead of being paced`);
  assert.equal(h.pacer.revealed(), 4000);
  assert.equal(h.pacer.pending(), 0);
  assert.equal(h.frames.at(-1).text, body);
  assertPrefixChain(h.frames);
  const worst = maxRevealedPerSecond(h.frames);
  assert.ok(
    worst <= STREAM_PACER_DEFAULTS.maxCharsPerSecond,
    `${worst} chars in one simulated second exceeds maxCharsPerSecond=${STREAM_PACER_DEFAULTS.maxCharsPerSecond}`,
  );
  assert.equal(h.frames.at(-1).done, false, 'an open stream is not done while more text can arrive');
  h.pacer.finish();
  assert.equal(h.frames.at(-1).done, true, 'finish() settles the terminal frame once drained');
  assert.equal(h.frames.at(-1).backlog, 0);
});

test('a 200-char payload is paced to at least ~0.5s and still lands promptly', () => {
  const h = createHarness();
  const body = 'B'.repeat(200);
  h.pacer.push(body);
  h.pacer.finish();
  h.runUntil(() => h.time() >= 300);
  assert.ok(h.pacer.pending() > 0, 'payload must still be revealing at 300ms (paced, not popped)');
  h.runUntil(() => h.pacer.pending() === 0);
  assert.ok(h.time() >= 500, `tiny payload finished after only ${h.time()}ms`);
  assert.ok(h.time() >= STREAM_PACER_DEFAULTS.minDurationMs * 0.9, 'minDurationMs must be enforced by pacing');
  assert.ok(h.time() <= 900, `tiny payload dragged to ${h.time()}ms`);
  assert.equal(h.frames.at(-1).text, body);
  assert.equal(h.frames.at(-1).done, true);
  assertPrefixChain(h.frames);
});

test('a large backlog drains within maxLagMs once the stream has finished', () => {
  const h = createHarness();
  h.pacer.push('C'.repeat(900));
  h.pacer.finish();
  h.runUntil(() => h.pacer.pending() === 0);
  assert.ok(
    h.time() <= STREAM_PACER_DEFAULTS.maxLagMs + FRAME_MS,
    `900-char backlog took ${h.time()}ms (maxLagMs=${STREAM_PACER_DEFAULTS.maxLagMs})`,
  );
  assert.equal(h.frames.at(-1).text, 'C'.repeat(900));
  assert.equal(h.frames.at(-1).done, true);
});

test('flush() renders everything remaining immediately and stops', () => {
  const h = createHarness();
  const body = 'D'.repeat(500);
  h.pacer.push(body);
  h.runFor(80);
  assert.ok(h.pacer.pending() > 0);
  const before = h.frames.length;
  h.pacer.flush();
  assert.equal(h.frames.length, before + 1, 'flush() must emit synchronously');
  const last = h.frames.at(-1);
  assert.equal(last.text, body);
  assert.equal(last.done, true);
  assert.equal(last.backlog, 0);
  assert.equal(h.pacer.pending(), 0);
  assert.equal(h.pacer.revealed(), 500);
  assert.equal(h.pendingTimers(), 0, 'flush() must cancel the scheduled frame');
  h.runFor(320);
  assert.equal(h.frames.length, before + 1, 'flush() must leave the pacer stopped');
});

test('reset() drops buffered text and stops', () => {
  const h = createHarness();
  h.pacer.push('E'.repeat(300));
  h.runFor(80);
  const rendered = h.frames.length;
  assert.ok(rendered > 0);
  h.pacer.reset();
  assert.equal(h.pacer.pending(), 0);
  assert.equal(h.pacer.revealed(), 0);
  assert.equal(h.pendingTimers(), 0);
  h.runFor(320);
  assert.equal(h.frames.length, rendered, 'reset() must stop all rendering');
  const t0 = h.time();
  h.pacer.push('fresh');
  h.runUntil(() => h.time() > t0 && h.pacer.pending() === 0);
  assert.equal(h.frames.at(-1).text, 'fresh');
  assert.equal(h.pacer.revealed(), points('fresh').length);
});

test('finish() drains smoothly instead of truncating a big backlog', () => {
  const h = createHarness();
  const body = 'F'.repeat(3000);
  h.pacer.push(body);
  h.runFor(64);
  assert.ok(h.pacer.pending() > 0);
  h.pacer.finish();
  assert.ok(h.pacer.pending() > 0, 'finish() must not dump the backlog instantly');
  assert.equal(h.frames.at(-1).done, false);
  h.runUntil(() => h.pacer.pending() === 0);
  assert.equal(h.frames.at(-1).text, body, 'finish() must never truncate');
  assert.equal(h.frames.at(-1).done, true);
  assertPrefixChain(h.frames);
});

test('interleaved pushes during draining keep order with no duplication or loss', () => {
  const h = createHarness();
  const full = 'The quick brown fox jumps over the lazy dog. '.repeat(30);
  let pushed = 0;
  for (const chunk of chunkPoints(full, 9)) {
    h.pacer.push(chunk);
    pushed += points(chunk).length;
    h.step();
    assert.equal(h.pacer.pending() + h.pacer.revealed(), pushed, 'pending + revealed must equal pushed');
  }
  h.pacer.finish();
  h.runUntil(() => h.pacer.pending() === 0);
  assert.equal(h.pacer.revealed(), points(full).length);
  assert.equal(h.frames.at(-1).text, full);
  assertPrefixChain(h.frames);
  for (const frame of h.frames) {
    assert.ok(full.startsWith(frame.text), 'every frame must be a prefix of the final text');
  }
});

test('never reveals a lone surrogate; emoji and multibyte text stay whole', () => {
  const h = createHarness();
  const full = '🙂漢é'.repeat(60) + '🧑🚀'.repeat(20);
  for (const chunk of chunkPoints(full, 3)) {
    h.pacer.push(chunk);
    h.step();
  }
  h.pacer.finish();
  h.runUntil(() => h.pacer.pending() === 0);
  assert.equal(h.pacer.revealed(), points(full).length);
  assert.equal(h.frames.at(-1).text, full);
  for (const frame of h.frames) {
    assert.ok(!hasLoneSurrogate(frame.text), 'revealed text must never contain a lone surrogate');
    assert.ok(full.startsWith(frame.text));
  }
});

test('a surrogate pair split across pushes is healed before it renders', () => {
  const h = createHarness();
  h.pacer.push('a\uD83D');
  h.step();
  assert.equal(h.frames.at(-1).text, 'a', 'the lone high half must not render');
  h.pacer.push('\uDE00b'); // 😀 (U+1F600) split by the producer across two pushes
  h.runUntil(() => h.pacer.pending() === 0);
  assert.equal(h.frames.at(-1).text, 'a😀b');
  assert.equal(h.pacer.revealed(), 3);
  for (const frame of h.frames) {
    assert.ok(!hasLoneSurrogate(frame.text));
  }
});

test('property: revealed length always equals pushed length exactly (random splits)', () => {
  const POOL = ['a', 'b', 'z', ' ', '\n', 'é', 'ß', '漢', '字', '🙂', '🚀', '🧑', '\u200D'];
  for (const seed of [7, 21, 1337, 90210]) {
    const random = mulberry32(seed);
    const h = createHarness();
    let pushed = '';
    for (let round = 0; round < 40; round += 1) {
      const size = 1 + Math.floor(random() * 24);
      let chunk = '';
      for (let index = 0; index < size; index += 1) {
        chunk += POOL[Math.floor(random() * POOL.length)];
      }
      pushed += chunk;
      h.pacer.push(chunk);
      const steps = 1 + Math.floor(random() * 4);
      for (let index = 0; index < steps; index += 1) h.step(1 + Math.floor(random() * 48));
      assert.equal(h.pacer.pending() + h.pacer.revealed(), points(pushed).length);
      if (random() < 0.15) h.pacer.finish();
    }
    h.pacer.finish();
    h.runUntil(() => h.pacer.pending() === 0, 60_000);
    assert.equal(h.pacer.revealed(), points(pushed).length, `seed ${seed}: revealed length must equal pushed length`);
    assert.equal(h.pacer.pending(), 0, `seed ${seed}: nothing may be left buffered`);
    assert.equal(h.frames.at(-1).text, pushed, `seed ${seed}: final text must match exactly`);
    assertPrefixChain(h.frames);
    for (const frame of h.frames) {
      assert.ok(!hasLoneSurrogate(frame.text), `seed ${seed}: lone surrogate in revealed text`);
      assert.ok(pushed.startsWith(frame.text), `seed ${seed}: frame must be a prefix of the pushed text`);
    }
  }
});
