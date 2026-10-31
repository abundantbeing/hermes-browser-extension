import { FRAME_ELEMENT_SHARE } from './browser-control-frames.mjs';

const SENSITIVE_DESCRIPTOR_RE = /(?:password|passwd|passcode|one.?time|otp|verification.?code|security.?code|two.?factor|2fa|credit.?card|card.?number|cvv|cvc|expiry|payment|billing|api.?(?:key|token)|access.?token|auth.?token|session.?token|secret|private.?key|seed.?phrase|recovery.?phrase|wallet)/i;

function compact(value, limit = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizedScope(value = {}) {
  const controllerId = compact(value.controllerId, 160);
  const leaseOwnerId = compact(value.leaseOwnerId, 160);
  const leaseId = compact(value.leaseId, 160);
  const tabId = Number(value.tabId);
  const frameId = Math.max(0, Number(value.frameId) || 0);
  const documentGeneration = Number(value.documentGeneration);
  if (!controllerId || !leaseOwnerId || !leaseId || !Number.isInteger(tabId) || tabId <= 0
    || !Number.isInteger(documentGeneration) || documentGeneration < 1) return null;
  return { controllerId, leaseOwnerId, leaseId, tabId, frameId, documentGeneration };
}

function scopeKey(scope) {
  return [
    scope.controllerId,
    scope.leaseOwnerId,
    scope.leaseId,
    scope.tabId,
    scope.frameId,
    scope.documentGeneration,
  ].join('\u0000');
}

function sensitiveNode(node = {}) {
  return SENSITIVE_DESCRIPTOR_RE.test([
    node.role,
    node.name,
    node.label,
    node.inputType,
    node.type,
    node.autocomplete,
    node.placeholder,
  ].map((value) => compact(value)).join(' '));
}

// The frame a node came from, as the snapshot named it (the CDP id of the child frame), or '' for the main
// frame. A frame id of 0 also means the main frame.
function frameKeyFor(node = {}) {
  const frame = node.frameId === undefined || node.frameId === null ? '' : compact(node.frameId, 160);
  return frame === '0' ? '' : frame;
}

// Child frames named per document. A frame keeps its short key for as long as the document lives, whatever
// frames come and go around it, so the ref of a control in it does not change when an unrelated ad frame leaves.
const MAX_FRAME_KEYS = 64;

// Which nodes get a ref when there are more than the limit allows. The page's own controls come first, but
// when child frames contribute controls a share of the refs is held back for them, so a long page cannot leave
// a chat composer in a child frame without one. Input order is kept.
function selectNodes(input, limit) {
  if (input.length <= limit) return input;
  const framed = input.filter((node) => frameKeyFor(node)).length;
  if (!framed) return input.slice(0, limit);
  const own = input.length - framed;
  const framedKept = Math.min(framed, Math.max(Math.min(framed, Math.floor(limit * FRAME_ELEMENT_SHARE)), limit - own));
  const ownKept = Math.min(own, limit - framedKept);
  let ownSeen = 0;
  let framedSeen = 0;
  return input.filter((node) => (frameKeyFor(node) ? framedSeen++ < framedKept : ownSeen++ < ownKept));
}

// Identity of a node across re-snapshots of the same document: its backend DOM
// node id when it has one, otherwise role + name + occurrence among look-alikes.
function nodeIdentity(node = {}, seen = new Map()) {
  const backendDOMNodeId = Number(node.backendDOMNodeId);
  const frame = frameKeyFor(node);
  if (Number.isInteger(backendDOMNodeId) && backendDOMNodeId > 0) return `b:${frame}:${backendDOMNodeId}`;
  const base = `n:${frame}:${compact(node.role, 80)}\u0000${compact(node.name || node.label, 300)}`;
  const occurrence = seen.get(base) || 0;
  seen.set(base, occurrence + 1);
  return `${base}\u0000${occurrence}`;
}

function publicNode(node = {}, number, frameKey = '') {
  const sensitive = sensitiveNode(node);
  const backendDOMNodeId = Number(node.backendDOMNodeId);
  const frameId = frameKey || null;
  const prefix = frameId ? `@f${frameId}e` : '@e';
  return {
    ref: `${prefix}${number}`,
    role: compact(node.role || 'generic', 80),
    name: sensitive ? 'Sensitive field' : compact(node.name || node.label, 300),
    sensitive,
    ...(Number.isInteger(backendDOMNodeId) && backendDOMNodeId > 0 ? { backendDOMNodeId } : {}),
    ...(frameId ? { frameId } : {}),
    // State flags only; field values never pass through the ref store.
    ...(node.disabled === true ? { disabled: true } : {}),
    ...(node.focused === true ? { focused: true } : {}),
    ...(node.editable === true ? { editable: true } : {}),
    ...(node.hasValue === true ? { hasValue: true } : {}),
    ...(node.checked === true || node.checked === false || node.checked === 'mixed' ? { checked: node.checked } : {}),
    ...(node.expanded === true || node.expanded === false ? { expanded: node.expanded } : {}),
    ...(node.selected === true || node.selected === false ? { selected: node.selected } : {}),
  };
}

export function createBrowserControlRefStore({
  maxRefsPerDocument = 500,
  maxDocuments = 32,
} = {}) {
  const documents = new Map();
  const refLimit = Math.max(1, Number(maxRefsPerDocument) || 1);
  const documentLimit = Math.max(1, Number(maxDocuments) || 1);

  // Re-snapshotting the same tab + frame + document generation keeps the ref of
  // every node that is still there, gives new nodes a number that was never
  // handed out in this document, and drops refs of vanished nodes.
  function replace(value = {}) {
    const scope = normalizedScope(value);
    if (!scope) return { ok: false, error: 'invalid_ref_scope' };
    const input = Array.isArray(value.nodes) ? value.nodes : [];
    const key = scopeKey(scope);
    const previous = documents.get(key);
    const known = previous?.numbers || new Map();
    let next = previous?.next || 1;
    const frameKeys = new Map(previous?.frameKeys || []);
    let nextFrame = previous?.nextFrame || 1;
    const seen = new Map();
    const numbers = new Map();
    const visible = selectNodes(input, refLimit).map((node) => {
      const frame = frameKeyFor(node);
      let frameKey = '';
      if (frame) {
        frameKey = frameKeys.get(frame) || '';
        if (!frameKey) {
          frameKey = String(nextFrame);
          nextFrame += 1;
          frameKeys.set(frame, frameKey);
          if (frameKeys.size > MAX_FRAME_KEYS) frameKeys.delete(frameKeys.keys().next().value);
        }
      }
      const identity = nodeIdentity(node, seen);
      let number = known.get(identity);
      if (number === undefined || numbers.has(identity)) {
        number = next;
        next += 1;
      }
      if (!numbers.has(identity)) numbers.set(identity, number);
      return publicNode(node, number, frameKey);
    });
    const byRef = new Map(visible.map((node) => [node.ref, node]));
    documents.delete(key);
    documents.set(key, { scope, byRef, numbers, next, frameKeys, nextFrame });
    while (documents.size > documentLimit) documents.delete(documents.keys().next().value);
    return {
      ok: true,
      refs: visible.map((node) => ({ ...node })),
      truncated: input.length > refLimit,
    };
  }

  function resolve(value = {}) {
    const scope = normalizedScope(value);
    if (!scope) return { ok: false, error: 'stale_ref_scope' };
    const document = documents.get(scopeKey(scope));
    if (!document) return { ok: false, error: 'stale_ref_scope' };
    const ref = compact(value.ref, 32);
    const target = document.byRef.get(ref);
    if (!target) return { ok: false, error: 'unknown_ref' };
    return { ok: true, target: { ...target } };
  }

  function invalidateTab(tabId) {
    const normalizedTabId = Number(tabId);
    let removed = 0;
    for (const [key, document] of documents) {
      if (document.scope.tabId !== normalizedTabId) continue;
      documents.delete(key);
      removed += 1;
    }
    return removed;
  }

  function invalidateScope(value = {}) {
    const scope = normalizedScope(value);
    if (!scope) return false;
    return documents.delete(scopeKey(scope));
  }

  function clear() {
    documents.clear();
  }

  function documentCount() {
    return documents.size;
  }

  return { replace, resolve, invalidateTab, invalidateScope, clear, documentCount };
}
