import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEAR_BOTTOM_THRESHOLD_PX,
  createNewBelowTracker,
  createOpenPin,
  distanceFromBottom,
  isNearBottom,
  isTranscriptOpen,
  jumpToLatestPresentation,
  shouldShowJumpToLatest,
  transcriptViewKey,
} from '../extension/lib/scroll-latest.mjs';

const view = (scrollTop, extra = {}) => ({ scrollHeight: 2000, clientHeight: 600, scrollTop, ...extra });

test('near bottom matches the sticky autoscroll threshold', () => {
  assert.equal(NEAR_BOTTOM_THRESHOLD_PX, 96);
  assert.equal(distanceFromBottom(view(1400)), 0);
  assert.equal(isNearBottom(view(1400)), true);
  assert.equal(isNearBottom(view(1304)), true);
  assert.equal(isNearBottom(view(1303)), false);
});

test('the pill shows only when scrolled away from a non-empty transcript', () => {
  assert.equal(shouldShowJumpToLatest(view(0)), true);
  assert.equal(shouldShowJumpToLatest(view(1350)), false);
  assert.equal(shouldShowJumpToLatest(view(0, { hasMessages: false })), false);
  assert.equal(shouldShowJumpToLatest({ scrollHeight: 400, clientHeight: 600, scrollTop: 0 }), false);
});

test('garbage metrics never throw or show the pill', () => {
  assert.equal(shouldShowJumpToLatest({ scrollHeight: NaN, scrollTop: undefined, clientHeight: 'x' }), false);
  assert.equal(distanceFromBottom({}), 0);
});

test('the tracker counts each message once, however often it is reported', () => {
  const tracker = createNewBelowTracker();
  const reply = {};
  assert.equal(tracker.note(reply), true);
  for (let delta = 0; delta < 50; delta += 1) assert.equal(tracker.note(reply), false);
  assert.equal(tracker.count, 1);
  tracker.note({});
  assert.equal(tracker.count, 2);
});

test('the tracker ignores non-objects, bumps whole positive amounts and resets', () => {
  const tracker = createNewBelowTracker();
  assert.equal(tracker.note(null), false);
  assert.equal(tracker.note('text'), false);
  tracker.bump(2);
  tracker.bump(-3);
  tracker.bump(0.5);
  assert.equal(tracker.count, 2);
  const node = {};
  tracker.note(node);
  assert.equal(tracker.has(node), true);
  tracker.reset();
  assert.equal(tracker.count, 0);
  assert.equal(tracker.has(node), false);
  assert.equal(tracker.note(node), true);
});

test('an adopted node replaces a counted one without adding to the count', () => {
  const tracker = createNewBelowTracker();
  const first = {};
  const rebuilt = {};
  tracker.note(first);
  tracker.adopt(rebuilt);
  assert.equal(tracker.count, 1);
  assert.equal(tracker.note(rebuilt), false);
});

test('the pill is a plain label with nothing new and a count otherwise', () => {
  const calls = [];
  const translate = (key, params) => { calls.push([key, params]); return params ? `${key}:${params.count}` : key; };
  assert.deepEqual(jumpToLatestPresentation(0, translate), {
    text: 'chat.jump_to_latest', ariaLabel: 'chat.jump_to_latest', title: 'chat.jump_to_latest', count: 0,
  });
  assert.deepEqual(jumpToLatestPresentation(4, translate), {
    text: 'chat.jump_to_latest_count:4',
    ariaLabel: 'chat.jump_to_latest_count_aria:4',
    title: 'chat.jump_to_latest',
    count: 4,
  });
  assert.equal(jumpToLatestPresentation(-2, translate).count, 0);
});

test('the open pin holds until the person takes over or layout is quiet', () => {
  const pin = createOpenPin({ settleMs: 1000 });
  assert.equal(pin.isActive(0), false);
  pin.arm(0, true);
  assert.equal(pin.isActive(900), true);
  pin.noteLayout(900, true);
  assert.equal(pin.isActive(1800), true);
  assert.equal(pin.isActive(2000), false);
  pin.noteLayout(2100, true);
  assert.equal(pin.isActive(2100), false, 'an expired pin does not come back');

  pin.arm(5000, true);
  pin.release();
  assert.equal(pin.isActive(5001), false);
});

test('the open pin holds while the list is not laid out yet', () => {
  const pin = createOpenPin({ settleMs: 1000 });
  pin.arm(0, false);
  assert.equal(pin.isActive(60_000), true, 'the quiet clock has not started');
  pin.noteLayout(60_000, false);
  assert.equal(pin.isActive(90_000), true);
  pin.noteLayout(90_000, true);
  assert.equal(pin.isActive(90_500), true);
  assert.equal(pin.isActive(92_000), false);
});

test('only a different session, room, thread or scope is an open', () => {
  const session = transcriptViewKey({ storageKey: 'hermesBrowserMessages', sessionId: 'a' });
  assert.equal(isTranscriptOpen(null, session), true);
  assert.equal(isTranscriptOpen(session, transcriptViewKey({ storageKey: 'hermesBrowserMessages', sessionId: 'a' })), false);
  assert.equal(isTranscriptOpen(session, transcriptViewKey({ storageKey: 'hermesBrowserMessages', sessionId: 'b' })), true);
  const room = transcriptViewKey({ storageKey: 'k', roomId: 'r1', sessionId: 'a' });
  assert.equal(isTranscriptOpen(session, room), true);
  assert.equal(isTranscriptOpen(room, transcriptViewKey({ storageKey: 'k', roomId: 'r1', threadId: 't', sessionId: 'a' })), true);
  assert.equal(isTranscriptOpen(room, transcriptViewKey({ storageKey: 'k', roomId: 'r1', sessionId: 'changed-while-in-room' })), false);
});
