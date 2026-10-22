/**
 * Hermes Browser Extension — composer context preview refresh policy.
 *
 * Tab, window and session events only refresh the preview's metadata: the
 * active tab and the tab list. No content script runs on that path, so no page
 * text is captured. Send still performs the full capture.
 *
 * @module lib/context-preview-refresh
 */

import { CONTEXT_SCOPE_MODES } from './context-scope.mjs';

export const CONTEXT_PREVIEW_DELAY_MS = 400;
export const CONTEXT_PREVIEW_STREAMING_RETRY_MS = 1000;
export const WINDOW_ID_NONE = -1;

/**
 * Whether one scheduled event should refresh the preview under the current scope.
 *
 * Follow-active scope tracks the window's own active tab. Pinned scope only
 * cares about the pinned tab's own updates, as `shouldRefreshForTabEvent` does.
 * Chat-only scope never reads browser context.
 *
 * @param {{kind: string, tabId?: number|null}} event
 * @param {{scopeMode: string, pinnedTabId?: number|null, activeTabId?: number|null}} state
 * @returns {boolean}
 */
export function contextPreviewEventApplies(event = {}, { scopeMode, pinnedTabId = null, activeTabId = null } = {}) {
  if (scopeMode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return false;
  if (event.kind === 'session') return true;
  if (event.kind === 'focus') return scopeMode !== CONTEXT_SCOPE_MODES.PINNED_TAB;
  const eventTabId = Number(event.tabId);
  if (scopeMode === CONTEXT_SCOPE_MODES.PINNED_TAB) {
    return event.kind === 'updated' && eventTabId === Number(pinnedTabId);
  }
  return activeTabId !== null && eventTabId === Number(activeTabId);
}

/**
 * The preview keeps the captured page text only while the tab and its URL are
 * unchanged. Anything else would show the previous page's text under the new tab.
 */
export function previewKeepsPageContext(previousTab, nextTab) {
  if (!previousTab || !nextTab) return false;
  return Number(previousTab.id) === Number(nextTab.id)
    && String(previousTab.url || '') === String(nextTab.url || '');
}

/** True when a settings write changes the active durable session. */
export function sessionSwitchedFromSettings(previous = {}, next = {}) {
  const nextSessionId = String(next?.sessionId || '');
  return Boolean(nextSessionId) && nextSessionId !== String(previous?.sessionId || '');
}

/**
 * Debounces preview events. Events that arrive within the delay run once, as a
 * batch. While a turn is streaming the run waits and retries, so the preview
 * never moves under a live turn.
 *
 * @param {object} options
 * @param {(events: object[]) => unknown} options.run
 * @param {() => boolean} [options.isStreaming]
 * @returns {{schedule: (event?: object) => void}}
 */
export function createContextPreviewScheduler({
  run,
  isStreaming = () => false,
  delayMs = CONTEXT_PREVIEW_DELAY_MS,
  streamingRetryMs = CONTEXT_PREVIEW_STREAMING_RETRY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let pending = [];
  const fire = () => {
    timer = null;
    if (isStreaming()) {
      timer = setTimer(fire, streamingRetryMs);
      return;
    }
    const events = pending;
    pending = [];
    if (events.length) Promise.resolve().then(() => run(events)).catch(() => {});
  };
  return {
    schedule(event = {}) {
      pending.push({ ...event });
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, delayMs);
    },
  };
}
