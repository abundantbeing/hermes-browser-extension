// Pure scroll helpers for the message list: when the "Jump to latest" pill
// shows, how many new messages it counts, and how long a freshly opened
// transcript stays pinned to its newest message while late layout settles.
// DOM-free so the rules stay testable without a panel.

// How far from the bottom still counts as "at the bottom". The side panel's
// sticky autoscroll and the pill share it, so the pill never shows for a view
// that the stream would still follow.
export const NEAR_BOTTOM_THRESHOLD_PX = 96;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function distanceFromBottom({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {}) {
  return Math.max(0, finite(scrollHeight) - finite(scrollTop) - finite(clientHeight));
}

export function isNearBottom(metrics = {}, threshold = NEAR_BOTTOM_THRESHOLD_PX) {
  return distanceFromBottom(metrics) <= threshold;
}

// The pill belongs to a conversation that has scrolled away from its tail. An
// empty transcript has no tail to jump to, even when the intro cards overflow.
export function shouldShowJumpToLatest({
  scrollHeight = 0, scrollTop = 0, clientHeight = 0, hasMessages = true, threshold = NEAR_BOTTOM_THRESHOLD_PX,
} = {}) {
  if (!hasMessages) return false;
  return !isNearBottom({ scrollHeight, scrollTop, clientHeight }, threshold);
}

// Counts messages that arrived below the visible area. Each message object is
// counted once however often it is reported, so a reply that grows delta by
// delta is one new item, not one per delta.
export function createNewBelowTracker() {
  let counted = new WeakSet();
  let count = 0;
  return {
    get count() { return count; },
    note(item) {
      if (!item || (typeof item !== 'object' && typeof item !== 'function')) return false;
      if (counted.has(item)) return false;
      counted.add(item);
      count += 1;
      return true;
    },
    has(item) {
      return Boolean(item) && counted.has(item);
    },
    // Mark an item as already counted without adding to the count, for a node
    // that replaces a counted one (the live bubble is rebuilt on a re-render).
    adopt(item) {
      if (item && (typeof item === 'object' || typeof item === 'function')) counted.add(item);
    },
    // Messages that appeared with no node to key them on (a history refresh
    // brought them in). Negative and fractional amounts are ignored.
    bump(amount) {
      const extra = Math.floor(finite(amount));
      if (extra > 0) count += extra;
    },
    reset() {
      counted = new WeakSet();
      count = 0;
    },
  };
}

// Label for the pill. `translate(key, params)` is the panel's i18n function;
// with nothing new below, the pill is a plain arrow with the short label.
export function jumpToLatestPresentation(count, translate) {
  const total = Math.max(0, Math.floor(finite(count)));
  if (!total) {
    const label = translate('chat.jump_to_latest');
    return { text: label, ariaLabel: label, title: label, count: 0 };
  }
  const text = translate('chat.jump_to_latest_count', { count: total });
  return {
    text,
    ariaLabel: translate('chat.jump_to_latest_count_aria', { count: total }),
    title: translate('chat.jump_to_latest'),
    count: total,
  };
}
