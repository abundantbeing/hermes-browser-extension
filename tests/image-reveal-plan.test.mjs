import test from 'node:test';
import assert from 'node:assert/strict';
import { pickImageGenerationCard, planImageReveals } from '../extension/lib/image-reveal-plan.mjs';

test('pictures pair with the waiting generations in the order they started', () => {
  const plan = planImageReveals({ pendingCount: 3, inline: ['a.png', 'b.png', 'c.png'] });
  assert.deepEqual(plan.reveals, [
    { placeholderIndex: 0, source: 'a.png' },
    { placeholderIndex: 1, source: 'b.png' },
    { placeholderIndex: 2, source: 'c.png' },
  ]);
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(plan.idle, []);
  assert.deepEqual(plan.replaced, ['a.png', 'b.png', 'c.png']);
});

test('a recovered picture the reply does not name keeps its card', () => {
  // Recovery found A and B; the reply names only A. A gives way to the reply, B stays.
  const plan = planImageReveals({ pendingCount: 2, inline: ['a.png'], recovered: ['a.png', 'b.png'] });
  assert.deepEqual(plan.reveals, [
    { placeholderIndex: 0, source: 'a.png' },
    { placeholderIndex: 1, source: 'b.png' },
  ]);
  assert.deepEqual(plan.replaced, ['a.png']);
  assert.deepEqual(plan.cards, []);
});

test('a recovered picture beyond the waiting generations becomes its own card', () => {
  const plan = planImageReveals({ pendingCount: 1, inline: ['a.png'], recovered: ['a.png', 'b.png', 'c.png'] });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'a.png' }]);
  assert.deepEqual(plan.cards, ['b.png', 'c.png']);
});

test('the recovered order is the turn order, ahead of the reply order', () => {
  const plan = planImageReveals({ pendingCount: 2, inline: ['b.png'], recovered: ['a.png', 'b.png'] });
  assert.deepEqual(plan.reveals.map((item) => item.source), ['a.png', 'b.png']);
});

test('pictures the reply shows inline never become extra cards', () => {
  const plan = planImageReveals({ pendingCount: 1, inline: ['a.png', 'b.png'] });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'a.png' }]);
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(plan.replaced, ['a.png', 'b.png']);
});

test('a picture already in a card is not revealed again', () => {
  // A tool result already revealed A in the first card; B is still waiting.
  const plan = planImageReveals({ pendingCount: 1, inline: ['a.png', 'b.png'], shown: ['a.png'] });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'b.png' }]);
  assert.deepEqual(plan.replaced, ['a.png', 'b.png']);
});

test('a generation without a picture is reported idle so it can be dropped', () => {
  const plan = planImageReveals({ pendingCount: 3, inline: ['a.png'] });
  assert.deepEqual(plan.reveals, [{ placeholderIndex: 0, source: 'a.png' }]);
  assert.deepEqual(plan.idle, [1, 2]);
});

test('duplicate and blank pictures are ignored', () => {
  const plan = planImageReveals({ pendingCount: 2, recovered: ['a.png', '', '  ', 'a.png', null, 'b.png'] });
  assert.deepEqual(plan.reveals, [
    { placeholderIndex: 0, source: 'a.png' },
    { placeholderIndex: 1, source: 'b.png' },
  ]);
  assert.deepEqual(plan.cards, []);
  assert.deepEqual(plan.replaced, []);
});

test('with no waiting generation, pictures become cards unless the reply shows them', () => {
  assert.deepEqual(planImageReveals({ pendingCount: 0, recovered: ['a.png'] }).cards, ['a.png']);
  const inline = planImageReveals({ pendingCount: 0, inline: ['a.png'] });
  assert.deepEqual(inline.reveals, []);
  assert.deepEqual(inline.cards, []);
});

test('bad counts and missing input stay empty instead of throwing', () => {
  const empty = { reveals: [], cards: [], idle: [], replaced: [] };
  assert.deepEqual(planImageReveals(), empty);
  assert.deepEqual(planImageReveals({ pendingCount: -2, inline: 'a.png', recovered: 7 }), empty);
});

test('an event with a call id updates its own card, or starts a new one', () => {
  const cards = [{ key: 'call-a', status: 'started' }, { key: 'call-b', status: 'started' }];
  assert.equal(pickImageGenerationCard(cards, { activityId: 'call-b', status: 'completed' }), 1);
  assert.equal(pickImageGenerationCard(cards, { activityId: 'call-c', status: 'started' }), -1);
});

test('events without a call id keep updating the same card until it finishes', () => {
  const cards = [{ key: '', status: 'started' }];
  assert.equal(pickImageGenerationCard(cards, { status: 'progress' }), 0);
  assert.equal(pickImageGenerationCard(cards, { status: 'completed' }), 0);
  // A start after that card finished is a new generation.
  assert.equal(pickImageGenerationCard([{ key: '', status: 'completed' }], { status: 'started' }), -1);
});

test('an event without a call id skips cards that already have their picture', () => {
  const cards = [{ key: '', status: 'progress' }, { key: '', status: 'completed', claimed: true }];
  assert.equal(pickImageGenerationCard(cards, { status: 'completed' }), 0);
  assert.equal(pickImageGenerationCard([{ key: '', status: 'completed', claimed: true }], { status: 'progress' }), -1);
  assert.equal(pickImageGenerationCard([], { status: 'progress' }), -1);
});
