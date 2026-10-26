import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPANION_ACTIONS_PATH,
  COMPANION_CONTEXT_STATUS_PATH,
  COMPANION_CONTEXT_UPLOAD_PATH,
  COMPANION_ROUTE_CAPABILITIES,
  COMPANION_STATES,
  COMPANION_STATUS_PATH,
  classifyCompanionPlugin,
  companionRouteRecordFields,
  isCompanionReasonCode,
  parseCompanionStatusPayload,
} from '../extension/lib/companion-plugin-status.mjs';
import {
  COMPANION_MAX_ENVELOPE_CHARS,
  COMPANION_PROBE_MAX_AGE_MS,
  companionContextSummary,
  companionUploadPlan,
  readCompanionActions,
  readCompanionContextStatus,
  uploadCompanionContext,
} from '../extension/lib/companion-context-client.mjs';
import { capabilityStatusRows, deriveCapabilityRecords, normalizeGatewayCapabilities } from '../extension/lib/capabilities.mjs';
import { capabilityIdentity, createCapabilityLedger } from '../extension/lib/capability-status.mjs';

const NOW = 5_000_000;
const ROW_IDS = ['browserContextUpload', 'browserContextStatus', 'pluginActions'];
const ALL_TOOLS = [
  'browser_clear_context', 'browser_context_journal', 'browser_context_status', 'browser_control_status',
  'browser_event_log', 'browser_get_context', 'browser_text_utility',
];
const ALL_ROUTES = [COMPANION_ACTIONS_PATH, COMPANION_CONTEXT_UPLOAD_PATH, COMPANION_CONTEXT_STATUS_PATH, COMPANION_STATUS_PATH];

function probe({ routes = ALL_ROUTES, version = '0.4.0', state = 'ready' } = {}) {
  const parsed = parseCompanionStatusPayload({
    object: 'hermes.browser_companion.status', plugin: 'hermes-browser-companion', version, profile: 'default',
    tools: ALL_TOOLS, hooks: [], routes, live: false,
  });
  const result = classifyCompanionPlugin({ route: { kind: 'ok', parsed }, toolsets: null, checkedAt: NOW });
  return state === 'ready' ? result : classifyCompanionPlugin({ route: { kind: 'absent' }, toolsets: { valid: true, present: false }, checkedAt: NOW });
}

const restCaps = () => normalizeGatewayCapabilities({
  platform: 'hermes-agent', features: { run_submission: true }, endpoints: {},
}, { healthOk: true, hasApiKey: true });

test('the status payload parser keeps the listed routes and the probe result carries them', () => {
  const parsed = parseCompanionStatusPayload({ object: 'hermes.browser_companion.status', plugin: 'hermes-browser-companion', tools: ALL_TOOLS, routes: [COMPANION_STATUS_PATH, 7, ''] });
  assert.deepEqual(parsed.routes, [COMPANION_STATUS_PATH]);
  const result = probe();
  assert.deepEqual([...result.routes].sort(), [...ALL_ROUTES].sort());
  assert.equal(result.state, COMPANION_STATES.ready);
  // An older copy lists only the status route (or nothing at all).
  assert.deepEqual([...probe({ routes: [COMPANION_STATUS_PATH] }).routes], [COMPANION_STATUS_PATH]);
  assert.deepEqual(parseCompanionStatusPayload({ object: 'hermes.browser_companion.status', plugin: 'hermes-browser-companion', tools: [] }).routes, []);
});

test('each of the three rows is "available via the companion plugin" only when the ready plugin lists its route', () => {
  for (const id of ROW_IDS) {
    const fields = companionRouteRecordFields(probe(), id);
    assert.equal(fields.state, 'available', id);
    assert.equal(fields.reasonCode, 'companion-route');
    assert.equal(fields.params.route, COMPANION_ROUTE_CAPABILITIES[id]);
    assert.match(fields.reason, /Available through the companion plugin \(version 0\.4\.0\)/);
    assert.equal(fields.checkedAt, NOW);
    assert.ok(isCompanionReasonCode(fields.reasonCode));
    // Not listed (an older copy), or the plugin is not ready: nothing to claim.
    assert.equal(companionRouteRecordFields(probe({ routes: [COMPANION_STATUS_PATH] }), id), null);
    assert.equal(companionRouteRecordFields(probe({ state: 'not-installed' }), id), null);
  }
  assert.equal(companionRouteRecordFields(probe(), 'models'), null);
  assert.equal(companionRouteRecordFields(null, 'pluginActions'), null);
  // Only the one row a route serves flips.
  const partial = probe({ routes: [COMPANION_STATUS_PATH, COMPANION_ACTIONS_PATH] });
  assert.equal(companionRouteRecordFields(partial, 'pluginActions').state, 'available');
  assert.equal(companionRouteRecordFields(partial, 'browserContextUpload'), null);
});

test('deriveCapabilityRecords flips the three rows with a listing probe and keeps the honest reason otherwise', () => {
  const identity = capabilityIdentity({ endpoint: 'http://127.0.0.1:8642', principal: 'p', profile: 'default' });
  const caps = restCaps();
  const byId = (records) => Object.fromEntries(records.map((record) => [record.id, record]));
  const without = byId(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: NOW }));
  for (const id of ROW_IDS) {
    assert.equal(without[id].state, 'unsupported', id);
    assert.equal(without[id].reasonCode, 'not-in-hermes');
  }
  const withProbe = byId(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: NOW, companionPlugin: probe() }));
  for (const id of ROW_IDS) {
    assert.equal(withProbe[id].state, 'available', id);
    assert.equal(withProbe[id].source, 'probe');
    assert.equal(withProbe[id].reasonCode, 'companion-route');
    assert.equal(withProbe[id].params.route, COMPANION_ROUTE_CAPABILITIES[id]);
  }
  const older = byId(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: NOW, companionPlugin: probe({ routes: [COMPANION_STATUS_PATH] }) }));
  for (const id of ROW_IDS) assert.equal(older[id].reasonCode, 'not-in-hermes', id);
  // A gateway that advertises a row itself keeps its own answer.
  const advertised = normalizeGatewayCapabilities({
    platform: 'hermes-agent', features: { browser_context_upload: true }, endpoints: {},
  }, { healthOk: true, hasApiKey: true });
  const kept = byId(deriveCapabilityRecords(advertised, { identityKey: identity.key, checkedAt: NOW, companionPlugin: probe() }));
  assert.equal(kept.browserContextUpload.source, '/v1/capabilities');
  assert.equal(kept.browserContextStatus.reasonCode, 'companion-route');
  // The panel rows read the plugin's own English reason.
  const rows = capabilityStatusRows(caps, { identityKey: identity.key, checkedAt: NOW, now: NOW + 1000, companionPlugin: probe() });
  for (const id of ROW_IDS) {
    const row = rows.find((item) => item.key === id);
    assert.equal(row.status, 'ok', id);
    assert.match(row.detail, /Available through the companion plugin/);
  }
});

test('the ledger takes the probe rows, ages them, and forgets them when a re-probe stops proving them', () => {
  const identity = capabilityIdentity({ endpoint: 'http://127.0.0.1:8642', principal: 'p', profile: 'default' });
  let now = NOW;
  const ledger = createCapabilityLedger({ now: () => now });
  ledger.rebind(identity);
  ledger.ingest(deriveCapabilityRecords(restCaps(), { identityKey: identity.key, checkedAt: now }));
  assert.equal(ledger.get('browserContextUpload').reasonCode, 'not-in-hermes');
  ledger.observeProbe('browserContextUpload', companionRouteRecordFields(probe(), 'browserContextUpload'));
  assert.equal(ledger.get('browserContextUpload').state, 'available');
  assert.equal(ledger.canExecute('browserContextUpload').allowed, true);
  now += 61_000; // a probe answer ages out after 60 s: it stops speaking for the row and is never permission
  assert.equal(ledger.get('browserContextUpload').reasonCode, 'not-in-hermes');
  assert.equal(ledger.canExecute('browserContextUpload').allowed, false);
  ledger.observeProbe('browserContextUpload', { ...companionRouteRecordFields(probe(), 'browserContextUpload'), checkedAt: now });
  assert.equal(ledger.get('browserContextUpload').state, 'available');
  assert.equal(ledger.forgetProbe('browserContextUpload'), true);
  assert.equal(ledger.get('browserContextUpload').reasonCode, 'not-in-hermes');
  assert.equal(ledger.forgetProbe('browserContextUpload'), false);
  // A refusal learned another way is not a probe and is not forgotten here.
  ledger.observeOperation('browserContextUpload', { ok: false, detail: 'no' });
  assert.equal(ledger.forgetProbe('browserContextUpload'), false);
});

function fakeFetch(handler) {
  const calls = [];
  const fetchFn = async (path, init = {}) => {
    calls.push({ path, init });
    const out = await handler(path, init);
    if (out instanceof Error) throw out;
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  return { fetchFn, calls };
}

test('upload posts the envelope with the session header and reads only the plugin answer', async () => {
  const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { object: 'hermes.browser_companion.context_upload', stored: true, payload_hash: 'abc123def4567890', scope: 'follow-active' } }));
  const result = await uploadCompanionContext({ fetchFn, sessionId: 'sess-1', envelope: '{"protocol":"hermes.browser.turn.v2"}' });
  assert.deepEqual(result, { ok: true, status: 200, hash: 'abc123def4567890', scope: 'follow-active' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, COMPANION_CONTEXT_UPLOAD_PATH);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Hermes-Session-Id'], 'sess-1');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"protocol":"hermes.browser.turn.v2"}');
});

test('upload refuses what the plugin would refuse and never throws', async () => {
  const ok = fakeFetch(() => ({ status: 200, body: { object: 'hermes.browser_companion.context_upload', stored: true } }));
  assert.equal((await uploadCompanionContext({ fetchFn: ok.fetchFn, sessionId: '', envelope: '{}' })).reason, 'no session');
  assert.equal((await uploadCompanionContext({ fetchFn: ok.fetchFn, sessionId: 's', envelope: '' })).ok, false);
  assert.equal((await uploadCompanionContext({ fetchFn: ok.fetchFn, sessionId: 's', envelope: 'x'.repeat(COMPANION_MAX_ENVELOPE_CHARS + 1) })).ok, false);
  assert.equal(ok.calls.length, 0, 'nothing reached the gateway');
  for (const [status, body] of [[401, null], [404, null], [413, null], [422, { error: {} }], [500, null], [200, { object: 'other' }], [200, null]]) {
    const gw = fakeFetch(() => ({ status, body }));
    const result = await uploadCompanionContext({ fetchFn: gw.fetchFn, sessionId: 's', envelope: '{"a":1}' });
    assert.equal(result.ok, false, String(status));
  }
  const boom = fakeFetch(() => new Error('network down'));
  assert.equal((await uploadCompanionContext({ fetchFn: boom.fetchFn, sessionId: 's', envelope: '{}' })).ok, false);
  assert.equal((await uploadCompanionContext({ fetchFn: undefined, sessionId: 's', envelope: '{}' })).ok, false);
});

test('status reads counts, ages and hashes for the session and is never live', async () => {
  const body = {
    object: 'hermes.browser_companion.context_status', plugin: 'hermes-browser-companion',
    held: 2, consumed: 1, payload_hash: 'abc123def4567890', scope: 'follow-active', newest_age_ms: 4000,
    oldest_age_ms: 15000, expires_in_ms: 296000, pending_upload: { present: true, payload_hash: 'ffff', age_ms: 10, expires_in_ms: 20 }, live: true,
  };
  const gw = fakeFetch(() => ({ status: 200, body }));
  const status = await readCompanionContextStatus({ fetchFn: gw.fetchFn, sessionId: 'sess-1' });
  assert.equal(gw.calls[0].path, COMPANION_CONTEXT_STATUS_PATH);
  assert.equal(gw.calls[0].init.method, 'GET');
  assert.equal(gw.calls[0].init.headers['X-Hermes-Session-Id'], 'sess-1');
  assert.equal(status.ok, true);
  assert.equal(status.held, 2);
  assert.equal(status.hash, 'abc123def4567890');
  assert.equal(status.live, false, 'a stored context is history whatever the plugin says');
  assert.deepEqual(status.pendingUpload, { present: true, hash: 'ffff', ageMs: 10, expiresInMs: 20 });
  assert.equal(companionContextSummary(status), '2 held, newest 4 s old, hash abc123def4567890, 1 already read, an upload is waiting (hash ffff), not live control');
  assert.equal((await readCompanionContextStatus({ fetchFn: gw.fetchFn, sessionId: '' })).ok, false);
  const bad = fakeFetch(() => ({ status: 200, body: { object: 'nope' } }));
  assert.equal((await readCompanionContextStatus({ fetchFn: bad.fetchFn, sessionId: 's' })).ok, false);
  assert.equal(companionContextSummary({ ok: false }), '');
  assert.equal(companionContextSummary({ ok: true, held: 0, consumed: 0, pendingUpload: { present: false } }), '0 held, no upload waiting, not live control');
});

test('actions are read as descriptors only and keep nothing but names and flags', async () => {
  const body = {
    object: 'hermes.browser_companion.actions', execution: 'none',
    actions: [{ name: 'browser_text_utility', kind: 'agent-tool', safe: true, uses_model: false, uses_network: false, parameters: { huge: 'schema' }, description: 'x' }, { name: '' }, null],
  };
  const gw = fakeFetch(() => ({ status: 200, body }));
  const result = await readCompanionActions({ fetchFn: gw.fetchFn });
  assert.equal(gw.calls[0].path, COMPANION_ACTIONS_PATH);
  assert.equal(gw.calls[0].init.method, 'GET');
  assert.equal(result.execution, 'none');
  assert.deepEqual(result.actions, [{ name: 'browser_text_utility', kind: 'agent-tool', safe: true, usesModel: false, usesNetwork: false }]);
  const bad = fakeFetch(() => ({ status: 404, body: null }));
  assert.equal((await readCompanionActions({ fetchFn: bad.fetchFn })).ok, false);
});

test('the upload plan uploads only for a reference turn on a proven route, and re-probes an old proof', () => {
  const plan = (candidate, extra = {}) => companionUploadPlan(candidate, { deliveryMode: 'reference', sessionId: 's', now: NOW + 1000, ...extra });
  assert.equal(plan(probe()), 'upload');
  assert.equal(plan(probe(), { now: NOW + COMPANION_PROBE_MAX_AGE_MS + 1 }), 'reprobe');
  assert.equal(plan(probe(), { now: NOW - 1 }), 'reprobe', 'a proof from the future is not trusted');
  // Everything else behaves exactly as without the plugin.
  assert.equal(plan(probe(), { deliveryMode: 'full' }), 'skip');
  assert.equal(plan(probe(), { deliveryMode: 'none' }), 'skip');
  assert.equal(plan(probe(), { dashboardTransport: true }), 'skip');
  assert.equal(plan(probe(), { sessionId: '' }), 'skip');
  assert.equal(plan(null), 'skip');
  assert.equal(plan(probe({ routes: [COMPANION_STATUS_PATH, COMPANION_CONTEXT_STATUS_PATH, COMPANION_ACTIONS_PATH] })), 'skip', 'an older copy without the upload route');
  assert.equal(plan(probe({ state: 'not-installed' })), 'skip');
});
