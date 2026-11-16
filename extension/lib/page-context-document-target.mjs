/**
 * Document-scoped page-context install targets.
 *
 * Chromium binds inject, restart and tab messages to a specific documentId so a
 * frame navigation cannot land scripts on the next document. Firefox lacks
 * scripting documentIds; the documented frame fallback re-checks policy in-page
 * before inject and before capture (see PAGE_CONTEXT_FRAME_TARGET_FALLBACK).
 */

export const PAGE_CONTEXT_FRAME_TARGET_FALLBACK = 'scripting-document-ids-unavailable';

export class PageContextMissingGateError extends Error {
  constructor(message = 'page-context bundle gate is missing from manifest files') {
    super(message);
    this.name = 'PageContextMissingGateError';
  }
}

export function pageContextSupportsScriptingDocumentIds(scripting) {
  return Boolean(scripting && typeof scripting.executeScript === 'function');
}

export function pageContextUsesFrameTargetFallback({ webNavigation, scripting } = {}) {
  if (!pageContextSupportsScriptingDocumentIds(scripting)) return true;
  return typeof webNavigation?.getFrame !== 'function';
}

export async function resolvePageContextFrameDocumentId(webNavigation, tabId, frameId = 0) {
  if (typeof webNavigation?.getFrame !== 'function') return null;
  const frame = Math.max(0, Number(frameId) || 0);
  try {
    const details = await webNavigation.getFrame({ tabId, frameId: frame });
    return details?.documentId ? String(details.documentId) : null;
  } catch {
    return null;
  }
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

/**
 * @param {object} binding
 * @param {() => Promise<string|null>} binding.lookupDocumentId
 */
export async function pageContextInstallBindingStillLive(binding, lookupDocumentId) {
  if (!binding) return false;
  if (binding.documentId && typeof lookupDocumentId === 'function') {
    const current = await lookupDocumentId(binding.tabId, binding.frameId);
    if (!current || current !== binding.documentId) return false;
  }
  return true;
}