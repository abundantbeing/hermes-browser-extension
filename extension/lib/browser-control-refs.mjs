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

function publicNode(node = {}, index) {
  const sensitive = sensitiveNode(node);
  const backendDOMNodeId = Number(node.backendDOMNodeId);
  const frameId = node.frameId === undefined || node.frameId === null ? null : compact(node.frameId, 160);
  const prefix = frameId && frameId !== '0' && frameId !== 0
    ? `@f${String(frameId).replace(/^f/i, '')}e`
    : '@e';
  return {
    ref: `${prefix}${index + 1}`,
    role: compact(node.role || 'generic', 80),
    name: sensitive ? 'Sensitive field' : compact(node.name || node.label, 300),
    sensitive,
    ...(Number.isInteger(backendDOMNodeId) && backendDOMNodeId > 0 ? { backendDOMNodeId } : {}),
    ...(frameId ? { frameId } : {}),
  };
}

export function createBrowserControlRefStore({
  maxRefsPerDocument = 500,
  maxDocuments = 32,
} = {}) {
  const documents = new Map();
  const refLimit = Math.max(1, Number(maxRefsPerDocument) || 1);
  const documentLimit = Math.max(1, Number(maxDocuments) || 1);

  function replace(value = {}) {
    const scope = normalizedScope(value);
    if (!scope) return { ok: false, error: 'invalid_ref_scope' };
    const input = Array.isArray(value.nodes) ? value.nodes : [];
    const visible = input.slice(0, refLimit).map(publicNode);
    const byRef = new Map(visible.map((node) => [node.ref, node]));
    const key = scopeKey(scope);
    documents.delete(key);
    documents.set(key, { scope, byRef });
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
