// Approving a pairing without leaving the panel.
//
// The gateway's approval page can be framed by exactly one origin: the
// extension that asked to pair (it names it in the pairing request, and says
// `embeddable` when it will allow that). A gateway that predates this says
// nothing, so the approval page opens in a tab as before. Only a local
// gateway's approval page is ever framed (manifest frame-src is the same two
// hosts), and the frame is sandboxed to what a form needs.

const APPROVE_PATH = /^(?:\/p\/[A-Za-z0-9_.-]+)?\/api\/browser-extension\/pair\/approve\/[A-Za-z0-9_-]+$/;
const FRAME_HOSTS = new Set(['127.0.0.1', 'localhost']);

// The exact origin of this install. Firefox gives each install a random
// moz-extension address, so it is read from the runtime, never assumed.
export function extensionOrigin(runtime) {
  try {
    const url = new URL(String(runtime?.getURL?.('/') || ''));
    return url.host ? `${url.protocol}//${url.host}` : '';
  } catch {
    return '';
  }
}

export function pairingStartBody(runtime, { name = 'Hermes Browser Extension' } = {}) {
  return {
    name,
    extensionId: runtime?.id || '',
    extensionOrigin: extensionOrigin(runtime),
  };
}

// The address to show in the panel, or '' when the approval has to open in a
// tab: the gateway did not say it can be framed, or the link is not the
// approval page of the local gateway this panel is talking to.
export function approvalFrameUrl(payload, gatewayUrl) {
  if (payload?.embeddable !== true) return '';
  try {
    const approval = new URL(String(payload.approval_url || ''));
    const gateway = new URL(String(gatewayUrl || ''));
    if (approval.protocol !== 'http:' || !FRAME_HOSTS.has(approval.hostname)) return '';
    if (approval.username || approval.password || approval.search || approval.hash) return '';
    if (!APPROVE_PATH.test(approval.pathname)) return '';
    if (approval.host !== gateway.host) return '';
    return approval.href;
  } catch {
    return '';
  }
}

// One element, kept alive for the whole approval: moving or rebuilding an
// iframe reloads it, and the page must not reload while someone is reading it.
export function createApprovalFrame({ doc = globalThis.document, translate = (text) => text, onOpenTab = () => {} } = {}) {
  const node = doc.createElement('div');
  node.className = 'pairing-approval';
  node.hidden = true;

  const frame = doc.createElement('iframe');
  frame.className = 'pairing-approval-frame';
  frame.setAttribute('title', translate('pairing.frame_title'));
  // A form needs to submit and to keep the gateway's own origin; nothing in
  // the page runs script, and it may not navigate this panel.
  frame.setAttribute('sandbox', 'allow-forms allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'eager');

  const tab = doc.createElement('button');
  tab.type = 'button';
  tab.className = 'pairing-approval-tab secondary';
  tab.textContent = translate('pairing.open_tab');
  tab.addEventListener('click', () => onOpenTab());

  node.append(frame, tab);

  return {
    node,
    frame,
    get showing() { return !node.hidden; },
    show(url) {
      node.hidden = false;
      frame.setAttribute('src', url);
    },
    hide() {
      node.hidden = true;
      frame.removeAttribute('src');
      node.remove();
    },
  };
}
