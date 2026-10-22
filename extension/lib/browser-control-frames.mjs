// Which child frames of an attached tab Hermes Control may read, and how much of a page view they get.
//
// A page's real controls are often inside a child frame: a live stream's chat, an embedded player, a comment
// box. The main frame's accessibility tree never describes them, so a snapshot reads each readable child frame
// too. Reading a frame is reading the page the person attached, so it follows the same restrictions the main
// frame does: a child on a checkout or banking page is never read, even when the page around it is allowed.
import { isRestrictedUrl } from './browser-context-protocol.mjs';

/** Child frames read per snapshot, so a page with dozens of ad and tracker frames stays cheap. */
export const MAX_SNAPSHOT_FRAMES = 8;
/** Controls kept per child frame, so one heavy frame (a chat with a thousand messages) cannot crowd out the rest. */
export const MAX_FRAME_NODES = 400;
/** Share of the page-text budget held back for child frames when there are any, so a long page cannot starve them. */
export const FRAME_TEXT_SHARE = 0.3;
/** Share of the element list and of the refs held back for child-frame controls when there are any. */
export const FRAME_ELEMENT_SHARE = 0.25;

// A frame with one of these addresses has no page of its own: its document is written by the frame around it
// (`iframe.srcdoc`, or an empty iframe a script fills in), so it is read under that frame's rules.
const INHERITING_FRAME_URLS = new Set(['about:blank', 'about:srcdoc']);

/**
 * Whether a frame whose document is at `url` may be read or acted on. Only ordinary web pages: a browser or
 * extension page, a data: or blob: document and a frame that has not committed an address yet are not part of
 * the page the person is looking at. The same rule applies when a snapshot reads a frame and when a command
 * acts on a control in it, because a frame can move to a restricted address between the two.
 */
export function frameUrlReadable(url, restricted = (value) => isRestrictedUrl(value)) {
  const text = String(url || '').trim();
  if (INHERITING_FRAME_URLS.has(text.toLowerCase())) return true;
  return /^https?:/i.test(text) && !restricted(text);
}

function frameAllowed(frame, restricted) {
  if (!frame?.id) return false;
  return frameUrlReadable(frame.url, restricted);
}

/**
 * The child frames of `frameTree` (the `frameTree` of `Page.getFrameTree`) a snapshot may read, parents before
 * their children, at most `limit` of them. A frame that may not be read hides everything inside it: its
 * children are skipped too, because the page that embeds them is not one Hermes may read.
 */
export function readableChildFrames(frameTree, { limit = MAX_SNAPSHOT_FRAMES, restricted = (url) => isRestrictedUrl(url) } = {}) {
  const frames = [];
  const walk = (node) => {
    for (const child of Array.isArray(node?.childFrames) ? node.childFrames : []) {
      if (frames.length >= limit) return;
      if (!frameAllowed(child?.frame, restricted)) continue;
      frames.push({ id: String(child.frame.id), url: String(child.frame.url || '') });
      walk(child);
    }
  };
  walk(frameTree);
  return frames;
}
