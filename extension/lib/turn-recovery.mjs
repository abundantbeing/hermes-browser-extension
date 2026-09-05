import { redactSensitiveText } from './redaction.mjs';

export const ACCEPTED_TURN_RECOVERY_MAX_MS = 180_000;
export const ACCEPTED_TURN_RECOVERY_MAX_DELAY_MS = 4_000;

export function acceptedTurnRecoveryPolicy({ attempt = 0, elapsedMs = 0, maxDurationMs = ACCEPTED_TURN_RECOVERY_MAX_MS } = {}) {
  const duration = Math.max(30_000, Number(maxDurationMs) || ACCEPTED_TURN_RECOVERY_MAX_MS);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const index = Math.max(0, Math.floor(Number(attempt) || 0));
  return {
    maxDurationMs: duration,
    delayMs: Math.min(ACCEPTED_TURN_RECOVERY_MAX_DELAY_MS, 750 * (2 ** Math.min(index, 3))),
    shouldContinue: elapsed < duration,
  };
}

export function classifyTurnRecovery(error = {}) {
  if (error?.requestAccepted) return 'recover';
  if (error?.fallbackSafe) return 'fallback';
  if (error?.requestRejected || error?.turnFailureLayer === 'provider') return 'reject';
  return 'recover';
}

function recoveryErrorText(value = '') {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    return String(value?.error?.message || value?.error || value?.message || '');
  }
  return String(value || '');
}

function responseErrorDetail(body = '') {
  const text = String(body || '').trim();
  if (!text) return '';
  try {
    const payload = JSON.parse(text);
    const detail = payload?.error?.message
      || payload?.error
      || payload?.detail
      || payload?.message;
    if (detail && typeof detail === 'object') return redactSensitiveText(JSON.stringify(detail)).slice(0, 900);
    if (detail != null && String(detail).trim()) return redactSensitiveText(String(detail).replace(/\s+/g, ' ').trim()).slice(0, 900);
  } catch {
    // Non-JSON provider bodies still carry useful validation details.
  }
  return redactSensitiveText(text.replace(/\s+/g, ' ')).slice(0, 900);
}

function modelOptionRejectionText(value = '') {
  return /reasoning[_ -]?effort|thinking.{0,60}(?:unsupported|must be one of)|unsupported.{0,60}reasoning/i.test(String(value || ''));
}

function normalizedErrorSurface(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const layer = String(value.layer || '').trim().toLowerCase().slice(0, 40);
  const code = String(value.code || '').trim().slice(0, 120);
  const retryable = typeof value.retryable === 'boolean' ? value.retryable : null;
  if (!layer && !code && retryable == null) return null;
  return { layer, code, retryable };
}

export function hermesRequestError({ status = 0, body = '', operation = 'Hermes request' } = {}) {
  const statusCode = Number.isFinite(Number(status)) ? Math.trunc(Number(status)) : 0;
  const label = String(operation || 'Hermes request').trim() || 'Hermes request';
  const detail = responseErrorDetail(body);
  const error = new Error(`${label} failed${statusCode ? ` (${statusCode})` : ''}${detail ? `: ${detail}` : ''}`);
  error.httpStatus = statusCode;
  error.fallbackSafe = [404, 405, 501].includes(statusCode);
  error.requestRejected = statusCode >= 400 && statusCode < 500;
  return error;
}

export function hermesGatewayTurnError({ payload = {}, operation = 'Hermes dashboard stream' } = {}) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const surface = normalizedErrorSurface(record.error_surface || record.errorSurface);
  const statusLabel = String(record.status || '').trim().toLowerCase();
  const detail = record.error ?? record.message ?? '';
  if (statusLabel !== 'error' && !String(detail || '').trim() && !surface) return null;

  const rawStatus = record.http_status ?? record.status_code ?? record.httpStatus ?? 0;
  const error = hermesRequestError({
    status: rawStatus,
    body: JSON.stringify({ error: detail || 'Dashboard turn failed.' }),
    operation,
  });
  error.errorSurface = surface;
  error.turnFailureLayer = surface?.layer || '';

  if (surface?.layer === 'provider' || modelOptionRejectionText(error.message)) {
    error.turnFailureLayer = 'provider';
    error.requestRejected = true;
    error.fallbackSafe = false;
  }
  return error;
}

export function turnRequestFailureState(error = {}) {
  const status = Number(error?.httpStatus || 0);
  const providerFailure = error?.turnFailureLayer === 'provider';
  if ((!error?.requestRejected && !providerFailure) || error?.fallbackSafe || [401, 403].includes(status)) return null;
  const detail = recoveryErrorText(error).replace(/^Error:\s*/, '').trim();
  const modelOptionRejected = modelOptionRejectionText(detail);
  const providerTitle = error?.errorSurface?.retryable === false
    ? 'Provider request rejected'
    : 'Provider turn failed';
  return {
    kind: modelOptionRejected ? 'model-option-rejected' : providerFailure ? 'provider-turn-failed' : 'request-rejected',
    title: modelOptionRejected ? 'Model option rejected' : providerFailure ? providerTitle : 'Hermes request rejected',
    detail,
    preserveDraft: true,
    gatewayStatus: 'connected',
  };
}

export function sessionContextFailureRecovery(error = {}, capabilities = {}) {
  const text = recoveryErrorText(error).replace(/\s+/g, ' ').trim().toLowerCase();
  const contextExceeded = /context length exceeded|request payload too large|context window exceeded/.test(text);
  const compressionExhausted = /max(?:imum)? compression attempts|compression failed after/.test(text);
  if (!contextExceeded || !compressionExhausted) return null;
  return {
    kind: 'compression-exhausted',
    action: capabilities?.sessionCompress ? 'compact' : 'new-session',
    preserveDraft: true,
    retryTurn: false,
    gatewayStatus: 'degraded',
  };
}

function comparablePartText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(comparablePartText).filter(Boolean).join('');
  if (value && typeof value === 'object') {
    const text = value.text ?? value.content ?? value.output_text ?? value.message ?? '';
    return comparablePartText(text);
  }
  return '';
}

function comparableTurnContent(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Some runtimes persist multimodal turns as a JSON-serialized parts array
    // instead of a structured content field. Decode it so the text component
    // still matches; if it is not JSON (or carries no text), keep the raw text.
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const derived = comparableTurnContent(parsed);
        if (derived) return derived;
      } catch {
        // Plain user text that merely looks like JSON — compare verbatim.
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value.map(comparablePartText).filter(Boolean).join('').trim();
  }
  if (value && typeof value === 'object') return comparablePartText(value).trim();
  return '';
}

function turnContentMatches(actual, expected) {
  const actualText = comparableTurnContent(actual);
  const expectedText = comparableTurnContent(expected);
  if (!actualText || !expectedText) return false;
  return actualText === expectedText
    || actualText.startsWith(`${expectedText}\n\n[ATTACHMENTS]`)
    || expectedText.startsWith(`${actualText}\n\n[ATTACHMENTS]`);
}

export function latestAssistantAfterUser(rows = [], userContent = '') {
  const target = comparableTurnContent(userContent);
  if (!target || !Array.isArray(rows)) return '';

  let latestUserIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role === 'user' && turnContentMatches(row.content, userContent)) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return '';

  for (let index = latestUserIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.role !== 'assistant') continue;
    const content = comparableTurnContent(row.content);
    if (content) return content;
  }
  return '';
}
