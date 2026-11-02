// Continue current chat and Start new Assist session run as visible turns in the side panel. The browser opens
// the side panel only inside the click that asked for it, and that click is spent at the first await, so the
// open call starts before anything else; the request then waits in session storage for the panel to take it.
// Never a full tab: with no panel open and no way to open one, the page is told what to do instead.

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
