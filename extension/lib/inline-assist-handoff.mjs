// Where Assist chats run and what they are called.
//
// Continue current chat and Start new Assist session run as visible turns in the side panel. The browser opens
// the side panel only inside the click that asked for it, and that click is spent at the first await, so the
// open call starts before anything else; the request then waits in session storage for the panel to take it.
// Never a full tab: with no panel open and no way to open one, the page is told what to do instead.

import { inlineSiteForHost, inlineSiteLabel } from './site-adapters.mjs';

// "Hermes Assist · YouTube · Nov 02, 4:13:21 AM · abcd", for background runs and side-panel chats alike. The
// suffix keeps two titles made in the same second apart, since the gateway refuses a title it already has.
export function assistSessionTitle(request = {}, { date = new Date(), suffix = '' } = {}) {
  let site = inlineSiteLabel(request.adapterId);
  if (!site || site === 'generic') {
    try {
      site = inlineSiteForHost(new URL(request.pageUrl).hostname).label;
    } catch {
      site = '';
    }
  }
  const stamp = date.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return [`Hermes Assist · ${site || 'Browser'} · ${stamp}`, suffix].filter(Boolean).join(' · ');
}

// The browser's own side panel, opened inside the click. A resolved open is the answer: Comet shows the panel
// without sending sidePanel.onOpened, and waiting for that event is what used to put a full tab beside it.
export function openSidePanelInClick(sidePanelApi, openOptions) {
  try {
    if (typeof sidePanelApi?.open !== 'function') return Promise.resolve(false);
    return Promise.resolve(sidePanelApi.open(openOptions)).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export const SIDE_PANEL_REFUSED_REASON = 'The Hermes side panel did not open. Open it, then choose your Assist action again. Or pick Run in background.';

export function handOffInlineDraftToSidePanel({ queued, storageKey, sessionStorage, openSidePanel, sidePanelIsOpen }) {
  let opening;
  try {
    opening = Promise.resolve(openSidePanel()).catch(() => false);
  } catch {
    opening = Promise.resolve(false);
  }
  return (async () => {
    await sessionStorage.set({ [storageKey]: queued });
    const opened = await opening;
    if (opened === true || await sidePanelIsOpen()) return { ok: true, requestId: queued.requestId, sidePanel: true };
    await sessionStorage.remove(storageKey);
    return { ok: false, requestId: queued.requestId, reason: SIDE_PANEL_REFUSED_REASON };
  })();
}
