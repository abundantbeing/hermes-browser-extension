import test from 'node:test';
import assert from 'node:assert/strict';
import { planImageReveals } from '../extension/lib/image-reveal-plan.mjs';

test('pictures pair with the waiting generations in the order they started', () => {
  const plan = planImageReveals({ pendingCount: 3, sources: ['a.png', 'b.png', 'c.png'] });
  assert.deepEqual(plan.reveals, [
    { placeholderIndex: 0, source: 'a.png' },
    { placeholderIndex: 1, source: 'b.png' },
    { placeholderIndex: 2, source: 'c.png' },
  ]);
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(plan.idle, []);
});

test('without a handoff, a picture beyond the waiting generations becomes its own card', () => {
  const plan = planImageReveals({ pendingCount: 1, sources: ['a.png', 'b.png', 'c.png'] });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'a.png' }]);
  assert.deepEqual(plan.cards, ['b.png', 'c.png']);
});

test('a handoff adds no cards, because the reply shows its pictures inline', () => {
  const plan = planImageReveals({ pendingCount: 1, sources: ['a.png', 'b.png'], handoff: true });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'a.png' }]);
  assert.deepEqual(plan.cards, []);
  assert.equal(plan.handoff, true);
});

test('a generation without a picture is reported idle so it can be dropped', () => {
  const plan = planImageReveals({ pendingCount: 3, sources: ['a.png'] });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'a.png' }]);
  assert.deepEqual(plan.idle, [1, 2]);
});

test('duplicate and blank pictures are ignored', () => {
  const plan = planImageReveals({ pendingCount: 2, sources: ['a.png', '', '  ', 'a.png', null, 'b.png'] });
  assert.deepEqual(plan.reveals, [
    { placeholderIndex: 0, source: 'a.png' },
    { placeholderIndex: 1, source: 'b.png' },
  ]);
  assert.deepEqual(plan.cards, []);
});

test('with no waiting generation, pictures become cards unless the reply shows them', () => {
  assert.deepEqual(planImageReveals({ pendingCount: 0, sources: ['a.png'] }).cards, ['a.png']);
  const handoff = planImageReveals({ pendingCount: 0, sources: ['a.png'], handoff: true });
  assert.deepEqual(handoff.reveals, []);
  assert.deepEqual(handoff.cards, []);
});

test('bad counts and missing input stay empty instead of throwing', () => {
  assert.deepEqual(planImageReveals(), { reveals: [], cards: [], idle: [], handoff: false });
  assert.deepEqual(planImageReveals({ pendingCount: -2, sources: 'a.png' }), { reveals: [], cards: [], idle: [], handoff: false });
});
