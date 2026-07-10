import { redactSensitiveText } from './redaction.mjs';

export const BROWSER_ACTION_PROTOCOL = Object.freeze({
  id: 'hermes.browser.actions.v1',
  version: 1,
});

export const BROWSER_ACTION_TYPES = Object.freeze([
  'getSnapshot',
  'screenshot',
  'scroll',
  'click',
  'typeText',
  'select',
  'openUrl',
]);

const ACTION_TYPES = new Set(BROWSER_ACTION_TYPES);
const MUTATING_ACTIONS = new Set(['click', 'typeText', 'select', 'openUrl']);
const TARGETED_ACTIONS = new Set(['click', 'typeText', 'select']);
const RESTRICTED_URL_TOKENS = new Set([
  'bank', 'banking', 'checkout', 'payment', 'password', 'passwd', 'wallet',
  'crypto', 'coinbase', 'metamask', 'health', 'medical', 'tax', 'irs', 'cra',
]);

function cleanString(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function safeUrl(value) {
  const raw = cleanString(value, 2_000);
  if (!raw) return { url: '', error: null };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: '', error: 'restricted_url' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { url: '', error: 'restricted_url' };
  const lowered = raw.toLowerCase();
  if ([...RESTRICTED_URL_TOKENS].some((token) => lowered.includes(token))) {
    return { url: '', error: 'restricted_url' };
  }
  return { url: `${parsed.protocol}//${parsed.host}/`, error: null };
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = {};
  for (const key of ['ref', 'selector', 'text', 'role', 'name']) {
    const cleaned = cleanString(value[key], 240);
    if (cleaned) target[key] = cleaned;
  }
  return Object.keys(target).length ? target : null;
}

export function browserActionApprovalPolicy(action = {}) {
  const type = cleanString(action?.type, 80);
  const mutatesPage = MUTATING_ACTIONS.has(type);
  return Object.freeze({ mutatesPage, requiresApproval: mutatesPage });
}

export function validateBrowserActionRequest(action = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, reason: 'invalid_action' };
  }
  const type = cleanString(action.type, 80);
  if (!ACTION_TYPES.has(type)) return { ok: false, reason: 'unsupported_action' };
  const { url, error } = safeUrl(action.url || action.href);
  if (error) return { ok: false, reason: error };
  const target = normalizeTarget(action.target);
  if (TARGETED_ACTIONS.has(type) && !target) return { ok: false, reason: 'missing_target' };
  if (type === 'openUrl' && !url) return { ok: false, reason: 'restricted_url' };
  return { ok: true };
}

export function normalizeBrowserActionRequest(action = {}) {
  const validation = validateBrowserActionRequest(action);
  if (!validation.ok) return validation;
  const type = cleanString(action.type, 80);
  const policy = browserActionApprovalPolicy({ type });
  const { url } = safeUrl(action.url || action.href);
  const value = cleanString(action.value || action.text, 2_000);
  const normalized = {
    protocol: BROWSER_ACTION_PROTOCOL.id,
    requestId: cleanString(action.requestId || action.request_id, 120),
    type,
    url,
    target: normalizeTarget(action.target),
    value,
    direction: cleanString(action.direction || 'down', 20),
    amount: Number.isFinite(Number(action.amount)) ? Math.max(1, Math.min(Number(action.amount), 10_000)) : undefined,
    mutatesPage: policy.mutatesPage,
    requiresApproval: policy.requiresApproval,
    approvedByUser: action.approvedByUser === true,
  };
  normalized.preview = {
    type,
    url,
    target: normalized.target,
    value: value ? redactSensitiveText(value) : '',
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, item]) => item !== '' && item !== null && item !== undefined));
}

export function browserActionReceiptCopy(action = {}) {
  const normalized = normalizeBrowserActionRequest(action);
  if (normalized.ok === false) return `Hermes browser action blocked: ${normalized.reason}`;
  const target = normalized.target?.name || normalized.target?.text || normalized.target?.selector || normalized.url || 'the current page';
  const verbs = {
    click: 'click',
    typeText: 'type into',
    select: 'select an option in',
    openUrl: 'open',
    scroll: 'scroll',
    screenshot: 'capture a screenshot of',
    getSnapshot: 'read',
  };
  return `Hermes wants to ${verbs[normalized.type] || normalized.type} ${target}`;
}

export function sanitizeBrowserActionResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, reason: 'invalid_result' };
  }
  const summary = { ok: result.ok === true };
  const reason = cleanString(result.reason || result.error, 240);
  const actionType = cleanString(result.actionType, 80);
  const mimeType = cleanString(result.mimeType, 120);
  if (reason) summary.reason = reason;
  if (actionType) summary.actionType = actionType;
  if (mimeType) summary.mimeType = mimeType;
  if (typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:')) summary.hasDataUrl = true;
  return summary;
}

export function isRestrictedBrowserUrl(value) {
  return safeUrl(value).error === 'restricted_url';
}
