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

// Frames that carry a card or a sign-in whatever their path says (a card field's address is an opaque id, with no
// "checkout" in it). A frame on one of these hosts is never read, shown in a screenshot or acted in, so a page's
// own address being ordinary does not let its payment or sign-in frame through.
const SENSITIVE_FRAME_HOSTS = Object.freeze([
  'stripe.com', 'stripe.network', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com', 'adyen.com',
  'squareup.com', 'squarecdn.com', 'checkout.com', 'klarna.com', 'afterpay.com', 'authorize.net', 'worldpay.com',
  'cardinalcommerce.com', 'pay.google.com', 'payments.google.com', 'accounts.google.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com',
]);

function sensitiveFrameHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return SENSITIVE_FRAME_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
  } catch {
    return false;
  }
}

/**
 * Whether a frame whose document is at `url` may be read or acted on. Only ordinary web pages: a browser or
 * extension page, a data: or blob: document and a frame that has not committed an address yet are not part of
 * the page the person is looking at. The same rule applies when a snapshot reads a frame and when a command
 * acts on a control in it, because a frame can move to a restricted address between the two.
 */
export function frameUrlReadable(url, restricted = (value) => isRestrictedUrl(value)) {
  const text = String(url || '').trim();
  if (INHERITING_FRAME_URLS.has(text.toLowerCase())) return true;
  return /^https?:/i.test(text) && !restricted(text) && !sensitiveFrameHost(text);
}

/**
 * Whether every frame between the page and a control may be acted on. `urls` are the addresses of the
 * documents from the outermost child frame to the one the control is in (the page itself is checked by the
 * executor). An inline frame (`about:blank`, `about:srcdoc`) has no page of its own and counts as the frame
 * around it, which is already in the list; every other frame must be an ordinary readable web page, so one
 * restricted frame anywhere above a control makes it unreadable.
 */
export function frameChainReadable(urls, restricted = (value) => isRestrictedUrl(value)) {
  return Array.isArray(urls) && urls.every((url) => frameUrlReadable(url, restricted));
}

// The browser reports a frame's address without its fragment (`urlFragment` carries it), and a single-page app
// keeps its route there, so the restriction judges both, as it does when a command acts on a control in the frame.
function frameAllowed(frame, restricted) {
  if (!frame?.id) return false;
  return frameUrlReadable(`${frame.url || ''}${frame.urlFragment || ''}`, restricted);
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
