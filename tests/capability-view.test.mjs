import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import english from '../extension/lib/locales/en.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import {
  CAPABILITY_REASONS,
  CAPABILITY_STATES,
} from '../extension/lib/capability-status.mjs';
import {
  capabilityFeatureKey,
  capabilityReasonKey,
  capabilityStateKey,
  capabilitySummaryText,
  compactControlState,
  compactResultMessage,
  describeCapabilityRow,
  formatCapabilityAge,
} from '../extension/lib/capability-view.mjs';
import {
  capabilityStatusRows,
  dashboardWsGatewayCapabilities,
  normalizeGatewayCapabilities,
} from '../extension/lib/capabilities.mjs';
import { describeCompactOutcome } from '../extension/lib/session-compact.mjs';

const t = (key, params = {}) => {
  assert.ok(Object.hasOwn(english, key), `missing English string ${key}`);
  return formatMessage(english[key], params, 'en');
};

test('every string the capability view and rows ask for exists in English, and none is orphaned', () => {
  const needed = new Set();
  for (const state of Object.values(CAPABILITY_STATES)) needed.add(capabilityStateKey(state));
  for (const code of Object.keys(CAPABILITY_REASONS)) needed.add(capabilityReasonKey(code));
  const rows = capabilityStatusRows(normalizeGatewayCapabilities(null, {}), {});
  for (const row of rows) needed.add(capabilityFeatureKey(row.key));
  const source = fs.readFileSync(new URL('../extension/lib/capability-view.mjs', import.meta.url), 'utf8');
  for (const match of source.matchAll(/'((?:capability|compact)\.[a-z_.]+)'/g)) needed.add(match[1]);
  for (const key of ['compact.result.stale', 'compact.result.denied', 'compact.result.not_sent', 'compact.result.indeterminate',
    'compact.result.not_committed', 'compact.result.unconfirmed', 'compact.result.aborted']) needed.add(key);
  const missing = [...needed].filter((key) => !Object.hasOwn(english, key));
  assert.deepEqual(missing, []);
  const present = Object.keys(english).filter((key) => /^(capability|compact)\./.test(key));
  const orphaned = present.filter((key) => !needed.has(key));
  assert.deepEqual(orphaned, []);
});

test('ages read as localized relative phrases and a row shows state, exact reason, source and age', () => {
  assert.equal(formatCapabilityAge(5_000), '5 seconds ago');
  assert.equal(formatCapabilityAge(0), '0 seconds ago');
  assert.equal(formatCapabilityAge(125_000), '2 minutes ago');
  assert.equal(formatCapabilityAge(NaN), '');
  assert.match(formatCapabilityAge(125_000, { locale: 'de' }), /Minuten/);
  const rows = capabilityStatusRows(
    dashboardWsGatewayCapabilities({ health: true, readyPayload: { session_authority: true } }),
    { readyPayload: { session_authority: true }, now: 70_000, checkedAt: 10_000 },
  );
  const described = describeCapabilityRow(rows.find((row) => row.key === 'sessionCompress'), { t });
  assert.equal(described.label, 'Context compaction');
  assert.equal(described.stateLabel, 'Available');
  assert.equal(described.status, 'ok');
  assert.match(described.reason, /session\.mutate operation compress/);
  assert.equal(described.meta, 'Source: gateway.ready · Checked 1 minute ago');
});

test('the plugin row says not advertised, never unavailable, and the stale case carries its age', () => {
  const rows = capabilityStatusRows(normalizeGatewayCapabilities({ features: { session_chat: true }, endpoints: {} }, {}), { now: 5_000, checkedAt: 5_000 });
  const plugin = describeCapabilityRow(rows.find((row) => row.key === 'browserCompanionPlugin'), { t });
  assert.equal(plugin.stateLabel, 'Unknown');
  assert.match(plugin.reason, /^Not advertised by this gateway\./);
  assert.match(plugin.reason, /does not mean it is missing/);
  assert.doesNotMatch(plugin.reason, /unavailable/i);
  const stale = describeCapabilityRow({ key: 'sessionCompress', state: 'cached', status: 'warn', reasonCode: 'stale', params: { ageMs: 400_000 }, source: '/v1/capabilities', checkedAt: 1, ageMs: 400_000 }, { t });
  assert.equal(stale.stateLabel, 'Cached');
  assert.equal(stale.reason, 'Last confirmed 6 minutes ago. An old answer is shown, not used to run anything.');
});

test('the summary counts features not in use', () => {
  assert.equal(capabilitySummaryText([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }], { t }), 'Features not in use on this connection: 2');
  assert.equal(capabilitySummaryText([{ status: 'ok' }], { t }), 'Every feature checked here is in use.');
});

test('the compact control is enabled only for a current verdict with a session and no active run', () => {
  const allowed = { allowed: true, state: 'available' };
  const ready = compactControlState({ hasSession: true, verdict: allowed }, { t });
  assert.equal(ready.disabled, false);
  assert.equal(ready.label, 'Compact context');
  assert.equal(compactControlState({ hasSession: true, recommended: true, verdict: allowed }, { t }).label, 'Compact recommended');
  assert.equal(compactControlState({ hasSession: false, verdict: allowed }, { t }).disabled, true);
  assert.match(compactControlState({ hasSession: false, verdict: allowed }, { t }).status, /Open or create a session/);
  assert.match(compactControlState({ hasSession: true, runActive: true, verdict: allowed }, { t }).status, /Stop the active run/);
  assert.equal(compactControlState({ hasSession: true, working: true, verdict: allowed }, { t }).label, 'Compacting…');
});

test('an unavailable compact control states the exact reason from the record', () => {
  const rest = compactControlState({
    hasSession: true,
    verdict: { allowed: false, state: 'unsupported', reasonCode: 'rest-no-compress' },
    record: { reasonCode: 'rest-no-compress', params: {} },
  }, { t });
  assert.equal(rest.disabled, true);
  assert.match(rest.status, /^Compaction unavailable: This connection only reaches the REST API, which does not advertise a compact route/);
  const stale = compactControlState({
    hasSession: true,
    verdict: { allowed: false, state: 'cached', reasonCode: 'connection-closed', params: { ageMs: 90_000 } },
  }, { t });
  assert.match(stale.status, /The connection closed\. Last confirmed 1 minute ago./);
  assert.equal(stale.disabled, true);
  const none = compactControlState({ hasSession: true, verdict: null }, { t });
  assert.match(none.status, /Not checked yet/);
});

test('every compaction outcome has a message, and only a read-back compaction is ok', () => {
  const cases = {
    compacted: { status: 'compacted', summary: { headline: 'Compressed: 40 → 9 messages' }, rotated: false },
    noop: { status: 'noop' },
    busy_turn: { status: 'busy', reason: 'turn-running' },
    busy_compressing: { status: 'busy', reason: 'session_busy', compressing: true },
    busy: { status: 'busy', reason: 'session_busy' },
    blocked: { status: 'blocked', reason: 'compression_checkpoint_required' },
    stale: { status: 'stale' },
    denied: { status: 'denied' },
    unavailable: { status: 'unavailable', reason: 'rest-only' },
    not_sent: { status: 'not_sent' },
    indeterminate: { status: 'indeterminate' },
    not_committed: { status: 'not_committed' },
    unconfirmed: { status: 'unconfirmed' },
    aborted: { status: 'aborted' },
    failed: { status: 'failed', message: 'boom' },
  };
  for (const [name, result] of Object.entries(cases)) {
    const message = compactResultMessage(result, { t });
    assert.ok(message.title && message.detail, name);
    assert.equal(message.level === 'ok', name === 'compacted', name);
  }
  assert.match(compactResultMessage(cases.compacted, { t }).detail, /read-back agrees\. Compressed: 40 → 9 messages/);
  assert.match(compactResultMessage({ ...cases.compacted, rotated: true }, { t }).detail, /keeps its id/);
  assert.match(compactResultMessage(cases.blocked, { t }).detail, /compression_checkpoint_required/);
  assert.match(compactResultMessage(cases.unavailable, { t }).detail, /^Compaction unavailable: This connection only reaches the REST API/);
  assert.match(compactResultMessage(cases.busy_turn, { t }).detail, /Nothing was sent/);
  assert.equal(compactResultMessage(cases.noop, { t }).level, 'info');
  // The English fallbacks in session-compact.mjs say the same thing.
  assert.match(describeCompactOutcome(cases.busy_turn), /Nothing was sent/);
});
