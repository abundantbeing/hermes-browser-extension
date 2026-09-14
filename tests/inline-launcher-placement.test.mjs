import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineLauncherPlacement } from '../extension/lib/inline-draft-policy.mjs';

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
