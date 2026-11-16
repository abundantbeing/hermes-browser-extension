/**
 * Document-scoped page-context install targets.
 *
 * Chromium binds inject, restart and tab messages to a specific documentId (from
 * scripting.executeScript injection results) so a frame navigation cannot land
 * scripts on the next document. When a frame has no documentId (Firefox), the
 * documented frame fallback re-checks policy in-page before inject and capture.
 */

export const PAGE_CONTEXT_FRAME_TARGET_FALLBACK = 'scripting-document-ids-unavailable';

export class PageContextMissingGateError extends Error {
  constructor(message = 'page-context bundle gate is missing from manifest files') {
    super(message);
    this.name = 'PageContextMissingGateError';
  }
}

/** Probe whether this frame exposes a Chromium documentId (per frame, not per browser). */
export async function probePageContextFrameDocumentId(executeScript, tabId, frameId = 0) {
  const frame = Math.max(0, Number(frameId) || 0);
  try {
    const [row] = await executeScript({
      target: { tabId, frameIds: [frame] },
      func: () => String(location.href || ''),
    });
    return row?.documentId ? String(row.documentId) : null;
  } catch {
    return null;
  }
}

export function pageContextBindingUsesFrameFallback(documentId) {
  return !documentId;
}

export function pageContextScriptInjectionTarget(binding) {
  if (!binding?.tabId) return null;
  if (binding.documentId) {
    return { tabId: binding.tabId, documentIds: [binding.documentId] };
  }
  if (binding.allowFrameFallback) {
    const frame = Math.max(0, Number(binding.frameId) || 0);
    return { tabId: binding.tabId, frameIds: [frame] };
  }
  return null;
}

export function pageContextTabMessageOptions(binding) {
  if (binding?.documentId) return { documentId: binding.documentId };
  if (binding?.allowFrameFallback) {
    return { frameId: Math.max(0, Number(binding.frameId) || 0) };
  }
  return null;
}

export function pageContextInstallBindingKey(binding) {
  if (!binding?.tabId) return '';
  if (binding.documentId) return `${binding.tabId}\u0000d${binding.documentId}`;
  const frame = Math.max(0, Number(binding.frameId) || 0);
  return `${binding.tabId}\u0000f${frame}`;
}

export async function pageContextInstallBindingStillLive(binding, probeDocumentId) {
  if (!binding) return false;
  if (binding.documentId && typeof probeDocumentId === 'function') {
    const current = await probeDocumentId(binding.tabId, binding.frameId);
    if (!current || current !== binding.documentId) return false;
  }
  return true;
}