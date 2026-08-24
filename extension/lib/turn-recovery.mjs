import { redactSensitiveText } from './redaction.mjs';

export function classifyTurnRecovery(error = {}) {
  if (error?.requestAccepted) return 'recover';
  if (error?.fallbackSafe) return 'fallback';
  if (error?.requestRejected) return 'reject';
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

export function turnRequestFailureState(error = {}) {
  const status = Number(error?.httpStatus || 0);
  if (!error?.requestRejected || error?.fallbackSafe || [401, 403].includes(status)) return null;
  const detail = recoveryErrorText(error).replace(/^Error:\s*/, '').trim();
  const modelOptionRejected = /reasoning[_ -]?effort|thinking.{0,60}(?:unsupported|must be one of)|unsupported.{0,60}reasoning/i.test(detail);
  return {
    kind: modelOptionRejected ? 'model-option-rejected' : 'request-rejected',
    title: modelOptionRejected ? 'Model option rejected' : 'Hermes request rejected',
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

export function latestAssistantAfterUser(rows = [], userContent = '') {
  const target = String(userContent || '');
  if (!target || !Array.isArray(rows)) return '';

  let latestUserIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role === 'user' && String(row.content || '') === target) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return '';

  for (let index = latestUserIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.role !== 'assistant') continue;
    const content = String(row.content || '').trim();
    if (content) return content;
  }
  return '';
}
