import { isRestrictedUrl } from './browser-context-protocol.mjs';

export const BROWSER_CONTROL_RISKS = Object.freeze({
  SAFE: 'safe',
  APPROVAL: 'approval-required',
  BLOCKED: 'blocked',
});

const SAFE_ACTIONS = new Set([
  'browser_snapshot',
  'browser_scroll',
  'browser_scroll_to',
  'browser_hover',
  'browser_back',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_select',
  'browser_screenshot',
  'browser_tab_activate',
  'browser_tab_create',
  'browser_tab_group',
  'browser_tab_ungroup',
  'browser_tabs',
]);

const SUBMISSION_KEY_RE = /^(?:enter|return)$/i;
const APPROVAL_LABEL_RE = /\b(?:submit|send|post|publish|delete|remove|revoke|reset|buy|pay|checkout|transfer|subscribe|invite|approve|merge|deploy|download|upload|overwrite)\b/i;
const PAYMENT_RE = /\b(?:credit.?card|card.?number|cvv|cvc|expiry|payment|billing|bank|banking|crypto|wallet|checkout)\b/i;
const CREDENTIAL_RE = /\b(?:password|passwd|passcode|api.?(?:key|token)|access.?token|auth.?token|session.?token|private.?key|seed.?phrase|recovery.?phrase|secret)\b/i;
const MFA_RE = /\b(?:one.?time|otp|mfa|2fa|verification.?code|security.?code)\b/i;
const SECRET_TEXT_RE = /(?:\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*\S+|\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const DIALOG_CONSEQUENTIAL_RE = /\b(?:delete|remove|reset|overwrite|submit|send|post|publish|approve|confirm|pay|checkout|buy|purchase|transfer|subscribe|sign.?out|log.?out|discard|close)\b/i;

/** Phase 8 privileged actions that are never safe by default. */
export const BROWSER_CONTROL_PRIVILEGED_ACTIONS = Object.freeze([
  'browser_console',
  'browser_network_requests',
  'browser_response_body',
  'browser_pdf',
  'browser_upload',
  'browser_evaluate',
  'browser_cdp',
  'browser_dialog',
]);

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function targetDescriptor(target = {}) {
  return [
    target.role,
    target.name,
    target.label,
    target.inputType,
    target.type,
    target.autocomplete,
    target.placeholder,
  ].map(compact).filter(Boolean).join(' ');
}

function decision(risk, reason = '') {
  return Object.freeze({ risk, reason });
}

export function validateBrowserControlUrl(value = '', { allowLocalFiles = false } = {}) {
  const raw = compact(value);
  if (!raw || isRestrictedUrl(raw, { allowLocalDocuments: allowLocalFiles })) return { ok: false, error: 'restricted_url' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'restricted_url' };
  }
  if (parsed.protocol === 'file:') {
    if (!allowLocalFiles) return { ok: false, error: 'restricted_url' };
    return { ok: true, url: parsed.href, origin: 'file://' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { ok: false, error: 'restricted_url' };
  }
  return { ok: true, url: parsed.href, origin: parsed.origin };
}

export function classifyBrowserControlAction({
  action = '',
  arguments: args = {},
  target = {},
  currentUrl = '',
  hasUnsavedContent = false,
  developerMode = false,
  allowLocalDocuments = false,
} = {}) {
  const normalizedAction = compact(action);
  if (normalizedAction === 'browser_drag') {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'drag-action');
  }
  if (normalizedAction === 'browser_tab_close') {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'tab-close');
  }
  if (normalizedAction !== 'browser_navigate' && currentUrl && isRestrictedUrl(currentUrl, { allowLocalDocuments })) {
    return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'restricted_current_page');
  }

  // Phase 8 privileged actions: never safe by default. Reads pause for an
  // approval; evaluate, response bodies, and raw CDP additionally require
  // developer mode and/or a pre-approved artifact/request binding.
  if (normalizedAction === 'browser_console') {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'console-metadata');
  }
  if (normalizedAction === 'browser_network_requests') {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'network-metadata');
  }
  if (normalizedAction === 'browser_response_body') {
    if (!compact(args?.request_id)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'request-id-required');
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'response-body');
  }
  if (normalizedAction === 'browser_pdf') {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'pdf-generation');
  }
  if (normalizedAction === 'browser_upload') {
    if (!compact(args?.artifact_id)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'artifact-id-required');
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'file-upload');
  }
  if (normalizedAction === 'browser_evaluate') {
    if (developerMode !== true) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'developer-mode-required');
    if (!compact(args?.code ?? args?.expression)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'code-required');
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'evaluate-code');
  }
  if (normalizedAction === 'browser_cdp') {
    if (developerMode !== true) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'developer-mode-required');
    if (!compact(args?.method)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'method-required');
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'cdp-command');
  }
  if (normalizedAction === 'browser_dialog') {
    const message = compact(args?.message ?? args?.text ?? args?.prompt);
    if (DIALOG_CONSEQUENTIAL_RE.test(message)) {
      return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'dialog-consequence');
    }
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'dialog-action');
  }
  if (!SAFE_ACTIONS.has(normalizedAction) && normalizedAction !== 'browser_press') {
    return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'unsupported-action');
  }

  const descriptor = targetDescriptor(target);
  if (normalizedAction === 'browser_type' || normalizedAction === 'browser_fill') {
    if (target?.sensitive === true) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-field');
    if (PAYMENT_RE.test(descriptor)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-payment-field');
    if (MFA_RE.test(descriptor)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-mfa-field');
    if (CREDENTIAL_RE.test(descriptor)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-credential-field');
    const textToCheck = String(args?.text ?? args?.value ?? '');
    if (SECRET_TEXT_RE.test(textToCheck)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'secret-text');
  }

  if (normalizedAction === 'browser_select') {
    if (target?.sensitive === true) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-field');
    if (PAYMENT_RE.test(descriptor)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-payment-field');
    if (CREDENTIAL_RE.test(descriptor)) return decision(BROWSER_CONTROL_RISKS.BLOCKED, 'sensitive-credential-field');
  }

  if (normalizedAction === 'browser_click' && Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y))) {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'coordinate-click');
  }

  if (normalizedAction === 'browser_navigate') {
    const destination = validateBrowserControlUrl(args?.url);
    if (!destination.ok) return decision(BROWSER_CONTROL_RISKS.BLOCKED, destination.error);
    if (hasUnsavedContent) {
      const current = validateBrowserControlUrl(currentUrl);
      if (current.ok && current.origin !== destination.origin) {
        return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'cross-origin-unsaved-content');
      }
    }
    return decision(BROWSER_CONTROL_RISKS.SAFE);
  }

  if (normalizedAction === 'browser_tab_create') {
    const destination = validateBrowserControlUrl(args?.url);
    if (!destination.ok) return decision(BROWSER_CONTROL_RISKS.BLOCKED, destination.error);
    return decision(BROWSER_CONTROL_RISKS.SAFE);
  }

  if (normalizedAction === 'browser_press' && SUBMISSION_KEY_RE.test(compact(args?.key))) {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'submission-key');
  }
  if ((normalizedAction === 'browser_click' || normalizedAction === 'browser_press') && APPROVAL_LABEL_RE.test(descriptor)) {
    return decision(BROWSER_CONTROL_RISKS.APPROVAL, 'consequential-action');
  }
  return decision(BROWSER_CONTROL_RISKS.SAFE);
}

function approvalKey(value = {}) {
  return [
    compact(value.approvalId),
    compact(value.approvalNonce),
    compact(value.commandId),
    compact(value.controllerId),
    compact(value.leaseId),
    Number(value.leaseGeneration) || 0,
    Number(value.tabId),
    Number(value.documentGeneration),
    compact(value.action),
    compact(value.state),
    compact(value.binding),
  ].join('\u0000');
}

export function createBrowserControlApprovalStore({
  now = Date.now,
  ttlMs = 30_000,
  maxEntries = 64,
} = {}) {
  const entries = new Map();
  const requests = new Map();
  const consumedNonces = new Set();
  const boundedTtl = Math.max(1, Number(ttlMs) || 1);
  const boundedEntries = Math.max(1, Number(maxEntries) || 1);

  function normalize(value = {}) {
    const approvalId = compact(value.approvalId);
    const approvalNonce = compact(value.approvalNonce);
    const commandId = compact(value.commandId);
    const controllerId = compact(value.controllerId);
    const leaseId = compact(value.leaseId);
    const leaseGeneration = Number(value.leaseGeneration);
    const action = compact(value.action);
    const state = compact(value.state);
    const binding = compact(value.binding).slice(0, 200);
    const tabId = Number(value.tabId);
    const documentGeneration = Number(value.documentGeneration);
    if (!approvalId || !commandId || !action || !Number.isInteger(tabId) || tabId <= 0
      || !Number.isInteger(documentGeneration) || documentGeneration < 1) return null;
    return {
      approvalId,
      approvalNonce,
      commandId,
      controllerId,
      leaseId,
      leaseGeneration: Number.isInteger(leaseGeneration) && leaseGeneration >= 1 ? leaseGeneration : 0,
      action,
      tabId,
      documentGeneration,
      state,
      ...(binding ? { binding } : {}),
      key: approvalKey({
        approvalId, approvalNonce, commandId, controllerId, leaseId,
        leaseGeneration, action, tabId, documentGeneration, state, binding,
      }),
    };
  }

  function grant(value = {}) {
    const normalized = normalize(value);
    if (!normalized) return { ok: false, error: 'invalid_approval' };
    if (normalized.approvalNonce && consumedNonces.has(normalized.approvalNonce)) {
      return { ok: false, error: 'approval_replayed' };
    }
    const request = requests.get(normalized.approvalId);
    if (request && request.key !== normalized.key) return { ok: false, error: 'approval_mismatch' };
    entries.delete(normalized.approvalId);
    entries.set(normalized.approvalId, {
      ...normalized,
      expiresAt: Number(now()) + boundedTtl,
    });
    while (entries.size > boundedEntries) entries.delete(entries.keys().next().value);
    if (request) request.resolve({ ok: true, approvalId: normalized.approvalId });
    return { ok: true, approvalId: normalized.approvalId, expiresAt: entries.get(normalized.approvalId).expiresAt };
  }

  function consume(value = {}) {
    const approvalId = compact(value.approvalId);
    const entry = entries.get(approvalId);
    if (!entry) return { ok: false, error: 'approval_missing' };
    if (Number(now()) >= entry.expiresAt) {
      entries.delete(approvalId);
      return { ok: false, error: 'approval_expired' };
    }
    if (entry.key !== approvalKey(value)) return { ok: false, error: 'approval_mismatch' };
    entries.delete(approvalId);
    requests.delete(approvalId);
    if (entry.approvalNonce) {
      consumedNonces.add(entry.approvalNonce);
      while (consumedNonces.size > boundedEntries) consumedNonces.delete(consumedNonces.values().next().value);
    }
    return {
      ok: true,
      approvalId,
      ...(entry.binding ? { binding: entry.binding } : {}),
    };
  }

  function request(value = {}) {
    const normalized = normalize(value);
    if (!normalized) return Promise.resolve({ ok: false, error: 'invalid_approval' });
    if (normalized.approvalNonce && consumedNonces.has(normalized.approvalNonce)) {
      return Promise.resolve({ ok: false, error: 'approval_replayed' });
    }
    const existing = requests.get(normalized.approvalId);
    if (existing) {
      return existing.key === normalized.key
        ? existing.promise
        : Promise.resolve({ ok: false, error: 'approval_mismatch' });
    }
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    requests.set(normalized.approvalId, {
      ...normalized,
      reason: compact(value.reason).slice(0, 300),
      ...(compact(value.detail) ? { detail: compact(value.detail).slice(0, 1_000) } : {}),
      createdAt: Number(now()),
      promise,
      resolve,
    });
    while (requests.size > boundedEntries) {
      const oldestId = requests.keys().next().value;
      const oldest = requests.get(oldestId);
      requests.delete(oldestId);
      oldest?.resolve({ ok: false, error: 'approval_cancelled' });
    }
    return promise;
  }

  function pending() {
    return [...requests.values()].map(({
      approvalId, approvalNonce, commandId, controllerId, leaseId, leaseGeneration,
      tabId, documentGeneration, action, state, reason, binding, detail,
    }) => ({
      approvalId,
      ...(approvalNonce ? { approvalNonce } : {}),
      commandId,
      ...(controllerId ? { controllerId } : {}),
      ...(leaseId ? { leaseId } : {}),
      ...(leaseGeneration ? { leaseGeneration } : {}),
      tabId,
      documentGeneration,
      action,
      ...(state ? { state } : {}),
      reason,
      ...(binding ? { binding } : {}),
      ...(detail ? { detail } : {}),
    }));
  }

  function cancelRequest(approvalId, error = 'approval_cancelled') {
    const id = compact(approvalId);
    const requestEntry = requests.get(id);
    if (!requestEntry) return false;
    requests.delete(id);
    entries.delete(id);
    requestEntry.resolve({ ok: false, error });
    return true;
  }

  function revoke(approvalId) {
    const id = compact(approvalId);
    const revoked = entries.delete(id);
    return cancelRequest(id) || revoked;
  }

  function count() {
    return requests.size || entries.size;
  }

  function clear() {
    const cleared = new Set([...entries.keys(), ...requests.keys()]).size;
    entries.clear();
    for (const requestEntry of requests.values()) requestEntry.resolve({ ok: false, error: 'approval_cancelled' });
    requests.clear();
    return cleared;
  }

  return { grant, consume, request, pending, cancelRequest, revoke, count, clear };
}
