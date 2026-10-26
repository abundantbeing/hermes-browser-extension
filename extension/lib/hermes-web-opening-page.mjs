// The "Opening Hermes Web" page's logic (hermes-web-opening.html). It asks the background worker what it is waiting
// for, shows the "Show it anyway" choice once the wait runs long, and sends that choice back. It never sees the launch
// URL or the ticket: the background worker owns them.

import { HERMES_WEB_OPENING_MESSAGES, HERMES_WEB_OPENING_TIMEOUT_MS } from './hermes-web-opening.mjs';

/**
 * @param {object} options
 * @param {(message: object) => Promise<object>} options.sendMessage runtime.sendMessage
 * @param {() => void} options.onSlow the wait has run past the limit: offer "Show it anyway"
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 * @returns {Promise<{ show: () => Promise<void>, stop: () => void, status: string }>}
 */
export async function startOpeningPage({
  sendMessage,
  onSlow,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let slow = false;
  const showSlow = () => {
    if (slow) return;
    slow = true;
    onSlow?.();
  };
  let state = null;
  try {
    state = await sendMessage({ type: HERMES_WEB_OPENING_MESSAGES.state });
  } catch {
    state = null;
  }
  let status = state?.ok && state.status === 'waiting' ? 'waiting' : state?.ok ? 'none' : 'unreachable';
  if (status === 'waiting') {
    const limit = Number.isFinite(state.timeoutMs) && state.timeoutMs > 0 ? state.timeoutMs : HERMES_WEB_OPENING_TIMEOUT_MS;
    // Both times come from the worker's clock, so a skewed page clock cannot shorten or stretch the wait.
    const elapsed = Number.isFinite(state.now) && Number.isFinite(state.startedAt) ? Math.max(0, state.now - state.startedAt) : 0;
    const remaining = Math.max(0, limit - elapsed);
    if (remaining === 0) showSlow();
    else timer = setTimer(showSlow, remaining);
  } else if (status === 'none') {
    // Nothing is being opened for this page (a restored tab, or the Webapp already showed): close it.
    try {
      await sendMessage({ type: HERMES_WEB_OPENING_MESSAGES.show });
    } catch {
      /* the page stays; there is nothing more to do */
    }
  } else {
    // The worker did not answer. Do not leave the person waiting on a page that cannot finish by itself.
    showSlow();
  }
  return {
    status,
    async show() {
      try {
        await sendMessage({ type: HERMES_WEB_OPENING_MESSAGES.show });
      } catch {
        /* the worker could not show it; the page stays */
      }
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
