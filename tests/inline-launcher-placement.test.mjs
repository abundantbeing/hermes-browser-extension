import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineLauncherPlacement, inlineSlotPlacement } from '../extension/lib/inline-draft-policy.mjs';

// Placement preferences the site adapters hand to the policy. Every adapter now
// leads with an outside placement and keeps inside-end only as the last resort.
const OUTSIDE_FIRST = ['outside-end', 'outside-start', 'above-end', 'below-end', 'inside-end'];

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test('launcher stays outside a full-width composer instead of covering the draft', () => {
  const viewport = { width: 1280, height: 800 };
  const target = { left: 100, top: 700, right: 1000, bottom: 740, width: 900, height: 40 };
  const anchor = { left: 80, top: 690, right: 1020, bottom: 750, width: 940, height: 60 };

  const placement = inlineLauncherPlacement(anchor, viewport, { targetRect: target, preferred: OUTSIDE_FIRST });

  assert.ok(placement, 'a placement should be found');
  assert.equal(placement.strategy, 'outside-end');
  assert.ok(
    !overlaps({ ...placement, right: placement.left + 32, bottom: placement.top + 32 }, target),
    'the launcher must not intersect the editable text box',
  );
  assert.ok(placement.left > target.right, 'the launcher should sit past the end of the draft');
});

test('an edge-to-edge composer at the bottom still avoids the draft', () => {
  const viewport = { width: 1280, height: 800 };
  const target = { left: 16, top: 730, right: 1200, bottom: 770, width: 1184, height: 40 };
  const anchor = { left: 0, top: 720, right: 1280, bottom: 780, width: 1280, height: 60 };

  const placement = inlineLauncherPlacement(anchor, viewport, { targetRect: target, preferred: OUTSIDE_FIRST });

  assert.ok(placement, 'a placement should be found');
  assert.notEqual(placement.strategy, 'inside-end', 'an outside placement exists, so inside-end must not win');
  assert.ok(
    !overlaps({ ...placement, right: placement.left + 32, bottom: placement.top + 32 }, target),
    'the launcher must not intersect the editable text box',
  );
  assert.ok(placement.left >= 8 && placement.left + 32 <= 1272, 'the launcher stays inside the safe area');
});

test('inside-end survives as the last resort for a compact edge-to-edge field', () => {
  const viewport = { width: 400, height: 200 };
  const target = { left: 8, top: 20, right: 392, bottom: 186, width: 384, height: 166 };

  const placement = inlineLauncherPlacement(target, viewport, { targetRect: target, preferred: OUTSIDE_FIRST });

  assert.ok(placement, 'a placement should be found');
  assert.equal(placement.strategy, 'inside-end', 'no outside placement fits, so inside-end is correct here');
});

test('callers that only allow inside-end keep the original behaviour', () => {
  const viewport = { width: 900, height: 600 };
  const target = { left: 20, top: 120, right: 860, bottom: 200, width: 840, height: 80 };

  const placement = inlineLauncherPlacement(target, viewport, { targetRect: target, preferred: ['inside-end'] });

  assert.ok(placement, 'a placement should be found');
  assert.equal(placement.strategy, 'inside-end');
  assert.equal(placement.left, 822);
  assert.equal(placement.top, 162);
});

test('an outside placement that lands on an obstacle falls through to the next strategy', () => {
  const viewport = { width: 1280, height: 800 };
  const anchor = { left: 100, top: 200, right: 600, bottom: 260, width: 500, height: 60 };
  const target = { left: 120, top: 210, right: 580, bottom: 250, width: 460, height: 40 };
  const obstacle = { left: 608, top: 214, right: 640, bottom: 246 };

  const placement = inlineLauncherPlacement(anchor, viewport, {
    targetRect: target,
    obstacleRects: [obstacle],
    preferred: OUTSIDE_FIRST,
  });

  assert.ok(placement, 'a placement should be found');
  assert.equal(placement.strategy, 'outside-start');
  assert.ok(!overlaps({ ...placement, right: placement.left + 32, bottom: placement.top + 32 }, obstacle));
});

// Site slots: the circle sits beside one of the composer's own controls.
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
const VIEWPORT = { width: 1280, height: 800 };
const box = (placement, size = 24) => ({ left: placement.left, top: placement.top, right: placement.left + size, bottom: placement.top + size });

test('X: centred under the avatar on the media row, at least 20px clear of the avatar', () => {
  const avatar = rect(16, 62, 40, 40);
  const row = rect(68, 137, 532, 20);
  const placement = inlineSlotPlacement({ strategy: 'below-center', rect: avatar, rowRect: row, gap: 12, minGapBelow: 20 }, VIEWPORT, { size: 24, targetRect: rect(68, 62, 532, 60), obstacleRects: [] });
  assert.deepEqual(placement, { left: 24, top: 135, strategy: 'below-center' });
  assert.ok(placement.top - avatar.bottom >= 20);
  assert.ok(!overlaps(box(placement), avatar));
});

test('a short media row still keeps the circle 20px below the avatar', () => {
  const avatar = rect(16, 62, 40, 40);
  const placement = inlineSlotPlacement({ strategy: 'below-center', rect: avatar, rowRect: rect(68, 100, 532, 10), gap: 12, minGapBelow: 20 }, VIEWPORT, { size: 24, obstacleRects: [] });
  assert.equal(placement.top, 122);
});

test('Gmail: 12px after the Send group, centred on it', () => {
  const send = rect(30, 500, 96, 36);
  assert.deepEqual(inlineSlotPlacement({ strategy: 'after', rect: send, gap: 12 }, VIEWPORT, { size: 24, obstacleRects: [] }), { left: 138, top: 506, strategy: 'after' });
});

test('ChatGPT: 12px before the dictate button', () => {
  const mic = rect(900, 700, 36, 36);
  assert.deepEqual(inlineSlotPlacement({ strategy: 'before', rect: mic, gap: 12 }, VIEWPORT, { size: 24, obstacleRects: [] }), { left: 864, top: 706, strategy: 'before' });
});

test('beside a control whose box reaches past its icon: level with the icon, not the box', () => {
  const voice = rect(1188, 737, 30, 37);
  const icon = rect(1197, 753, 12, 12);
  assert.deepEqual(inlineSlotPlacement({ strategy: 'before', rect: voice, levelRect: icon, gap: 8 }, VIEWPORT, { size: 24, obstacleRects: [] }), { left: 1156, top: 747, strategy: 'before' });
});

test('GitHub: at the front of the toolbar', () => {
  const toolbar = rect(600, 120, 220, 32);
  assert.deepEqual(inlineSlotPlacement({ strategy: 'before', rect: toolbar, gap: 8 }, VIEWPORT, { size: 24, obstacleRects: [] }), { left: 568, top: 124, strategy: 'before' });
});

test('a slot that would cover a send button, the text or nothing at all gives no placement', () => {
  const send = rect(30, 500, 96, 36);
  assert.equal(inlineSlotPlacement({ strategy: 'after', rect: send, gap: 12 }, VIEWPORT, { size: 24, obstacleRects: [rect(130, 500, 40, 36)] }), null);
  assert.equal(inlineSlotPlacement({ strategy: 'after', rect: send, gap: 12 }, VIEWPORT, { size: 24, targetRect: rect(120, 490, 300, 60), obstacleRects: [] }), null);
  assert.equal(inlineSlotPlacement({ strategy: 'after', rect: rect(30, 500, 0, 0), gap: 12 }, VIEWPORT, { size: 24, obstacleRects: [] }), null);
});

test('slot scrolled out of view → no placement', () => {
  assert.equal(inlineSlotPlacement({ strategy: 'after', rect: rect(30, -80, 96, 36), gap: 12 }, VIEWPORT, { size: 24, obstacleRects: [] }), null);
  assert.equal(inlineSlotPlacement({ strategy: 'after', rect: rect(30, 900, 96, 36), gap: 12 }, VIEWPORT, { size: 24, obstacleRects: [] }), null);
});

const GENERIC = ['corner-outside', 'corner-inside', 'below-end'];

test('any other site: 8px outside the field’s bottom-right corner when there is room', () => {
  const field = rect(100, 100, 400, 120);
  assert.deepEqual(inlineLauncherPlacement(field, VIEWPORT, { targetRect: field, preferred: GENERIC, size: 24, gap: 8 }), { left: 508, top: 196, strategy: 'corner-outside' });
});

test('a field flush with the right edge gets the circle 8px inside its corner', () => {
  const field = rect(400, 100, 872, 120);
  assert.deepEqual(inlineLauncherPlacement(field, VIEWPORT, { targetRect: field, preferred: GENERIC, size: 24, gap: 8 }), { left: 1240, top: 188, strategy: 'corner-inside' });
});

test('when neither corner fits, the circle goes under the field, never over the text', () => {
  const field = rect(400, 100, 872, 120);
  const handle = rect(1236, 184, 36, 36);
  const placement = inlineLauncherPlacement(field, VIEWPORT, { targetRect: field, obstacleRects: [handle], preferred: GENERIC, size: 24, gap: 8 });
  assert.deepEqual(placement, { left: 1248, top: 228, strategy: 'below-end' });
  assert.ok(!overlaps(box(placement), field));
});
