// What the side panel says about capabilities, built from evidence records.
//
// Pure helpers over an injected `t(key, params)` (the locale runtime) so the
// wording is localized and testable. Nothing here decides what is available:
// capability-status.mjs and capabilities.mjs do. This turns a row (state, reason
// code, parameters, source, age) into the text a person reads, and turns a
// manual-compaction verdict or outcome into the control's label, explanation and
// result message.

import { COMPANION_EXPECTED_TOOLS } from './companion-plugin-status.mjs';

const SOURCE_KEYS = Object.freeze({
  extension: 'capability.source.extension',
  derived: 'capability.source.derived',
  'operation-result': 'capability.source.operation',
  'method-not-found': 'capability.source.method_not_found',
  revocation: 'capability.source.revocation',
  probe: 'capability.source.probe',
  none: 'capability.source.none',
});

// Protocol names read the same in every language.
const VERBATIM_SOURCES = new Set(['gateway.ready', '/v1/capabilities']);

const RELATIVE_UNITS = Object.freeze([
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
]);

/** "5 seconds ago", localized. Always a number, never "now", so "0 seconds ago" is not hidden. */
export function formatCapabilityAge(ageMs, { locale = 'en' } = {}) {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return '';
  try {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    for (const [unit, size] of RELATIVE_UNITS) {
      if (ms >= size || unit === 'second') return formatter.format(-Math.floor(ms / size), unit);
    }
  } catch {
    // Fall through to nothing: the state and reason still read without an age.
  }
  return '';
}

export function capabilityStateKey(state) {
  return `capability.state.${String(state || 'unknown')}`;
}

export function capabilityFeatureKey(id) {
  return `capability.feature.${String(id || '')}`;
}

export function capabilityReasonKey(code) {
  return `capability.reason.${String(code || 'no-record').replaceAll('-', '_')}`;
}

function sourceLabel(source, t) {
  if (!source) return t('capability.source.none');
  if (VERBATIM_SOURCES.has(source)) return source;
  return t(SOURCE_KEYS[source] || SOURCE_KEYS.none);
}

/**
 * One compatibility row, ready to draw: label, state chip, the exact reason, and
 * where and when it was last confirmed.
 */
export function describeCapabilityRow(row, { t, locale = 'en' } = {}) {
  const params = { ...(row?.params || {}) };
  if (Number.isFinite(params.ageMs)) params.age = formatCapabilityAge(params.ageMs, { locale });
  // Companion probe reasons carry lists and optional parts; hand the strings plain text.
  if (Array.isArray(params.present)) params.presentCount = params.present.length;
  params.expectedCount = COMPANION_EXPECTED_TOOLS.length;
  for (const [name, value] of Object.entries(params)) if (Array.isArray(value)) params[name] = value.join(', ') || '-';
  if ('profile' in params && !params.profile) params.profile = '-';
  if ('detail' in params && row?.reasonCode === 'companion-network') params.detail = params.detail ? ` (${params.detail})` : '';
  const age = formatCapabilityAge(row?.ageMs, { locale });
  const source = sourceLabel(row?.source, t);
  const reason = t(capabilityReasonKey(row?.reasonCode), params);
  const meta = row?.checkedAt === null || row?.checkedAt === undefined
    ? [t('capability.meta.source', { source }), t('capability.meta.never')]
    : [t('capability.meta.source', { source }), t('capability.meta.checked', { age })];
  return {
    key: row?.key || '',
    label: t(capabilityFeatureKey(row?.key)),
    state: row?.state || 'unknown',
    stateLabel: t(capabilityStateKey(row?.state)),
    status: row?.status === 'ok' ? 'ok' : 'warn',
    reason,
    meta: meta.join(' · '),
    title: `${t(capabilityFeatureKey(row?.key))}: ${t(capabilityStateKey(row?.state))}. ${reason} ${meta.join(' · ')}`,
  };
}

export function capabilitySummaryText(rows = [], { t } = {}) {
  const notInUse = rows.filter((row) => row.status !== 'ok').length;
  return notInUse
    ? t('capability.summary.some', { count: notInUse })
    : t('capability.summary.all');
}

// ---- Manual compaction control ------------------------------------------------

/**
 * The compact control's label, whether it can be pressed, and the sentence under
 * it. `verdict` is capabilityLedger.canExecute('sessionCompress'), which is true
 * only for a current available record: a cached or stale one shows its reason and
 * leaves the button off.
 */
export function compactControlState({
  hasSession = false,
  runActive = false,
  working = false,
  recommended = false,
  verdict = null,
  record = null,
} = {}, { t, locale = 'en' } = {}) {
  const label = working
    ? t('compact.working')
    : t(recommended ? 'compact.button_recommended' : 'compact.button');
  const reasonOf = () => {
    const source = record || verdict || {};
    const params = { ...(source.params || {}) };
    if (Number.isFinite(params.ageMs)) params.age = formatCapabilityAge(params.ageMs, { locale });
    return t(capabilityReasonKey(source.reasonCode), params);
  };
  if (working) return { label, disabled: true, status: t('compact.working'), title: t('compact.working'), allowed: false };
  if (!verdict?.allowed) {
    const reason = reasonOf();
    return {
      label,
      disabled: true,
      status: t('compact.status.unavailable', { reason }),
      title: t('compact.status.unavailable', { reason }),
      allowed: false,
      reasonCode: verdict?.reasonCode || record?.reasonCode || 'no-record',
    };
  }
  if (!hasSession) {
    return { label, disabled: true, status: t('compact.status.no_session'), title: t('compact.status.no_session'), allowed: true };
  }
  if (runActive) {
    return { label, disabled: true, status: t('compact.status.running'), title: t('compact.status.running'), allowed: true };
  }
  return { label, disabled: false, status: t('compact.status.ready'), title: t('compact.status.ready'), allowed: true };
}

/**
 * What a finished compaction says. `level` is `ok` only for a compaction that was
 * read back; a no-op is `info`; everything else is a warning and says whether
 * anything was sent or changed.
 */
export function compactResultMessage(result = {}, { t } = {}) {
  const detail = String(result.summary?.headline || result.message || result.detail || '').trim();
  switch (result.status) {
    case 'compacted':
      return {
        level: 'ok',
        title: t('compact.title.ok'),
        detail: [t('compact.result.compacted', { detail }).trim(), result.rotated ? t('compact.result.rotated') : '']
          .filter(Boolean).join(' '),
      };
    case 'noop':
      return { level: 'info', title: t('compact.title.noop'), detail: t('compact.result.noop') };
    case 'busy':
      return {
        level: 'warn',
        title: t('compact.title.failed'),
        detail: t(result.reason === 'turn-running'
          ? 'compact.result.busy_turn'
          : (result.compressing ? 'compact.result.busy_compressing' : 'compact.result.busy')),
      };
    case 'blocked':
      return { level: 'warn', title: t('compact.title.failed'), detail: t('compact.result.blocked', { reason: result.reason || '' }) };
    case 'unavailable':
      return {
        level: 'warn',
        title: t('compact.title.unavailable'),
        detail: t('compact.status.unavailable', { reason: t(capabilityReasonKey(result.reason), { method: result.method || 'session.mutate' }) }),
      };
    case 'stale':
    case 'denied':
    case 'not_sent':
    case 'indeterminate':
    case 'not_committed':
    case 'unconfirmed':
    case 'aborted':
      return { level: 'warn', title: t('compact.title.failed'), detail: t(`compact.result.${result.status}`) };
    default:
      return { level: 'warn', title: t('compact.title.failed'), detail: t('compact.result.failed', { detail }) };
  }
}
