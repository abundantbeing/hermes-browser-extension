import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVERTISED_FLAG_SPECS,
  DEFAULT_GATEWAY_CAPABILITIES,
  capabilityStatusRows,
  dashboardWsGatewayCapabilities,
  deriveCapabilityRecords,
  normalizeGatewayCapabilities,
} from '../extension/lib/capabilities.mjs';
import {
  CAPABILITY_SOURCES,
  capabilityIdentity,
  createCapabilityLedger,
} from '../extension/lib/capability-status.mjs';

const identity = capabilityIdentity({ endpoint: 'http://127.0.0.1:9119', principal: 'me', profile: 'default' });
const NOW = 1_000_000;

// Routes Hermes v0.22.5 neither advertises nor serves anywhere (audited against api_server.py).
const NO_SUCH_ROUTE = ['browserContextUpload', 'browserContextStatus', 'pluginActions'];

function restCaps(features = {}, endpoints = {}) {
  return normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities',
    platform: 'hermes-agent',
    features,
    endpoints,
  }, { healthOk: true, hasApiKey: true });
}

function recordsOf(caps, extra = {}) {
  const list = deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: NOW, ...extra });
  return Object.fromEntries(list.map((record) => [record.id, record]));
}

test('every advertised flag derives the same answer the boolean carries, for each name it is known by', () => {
  for (const spec of ADVERTISED_FLAG_SPECS) {
    for (const name of spec.features) {
      const on = restCaps({ [name]: true });
      assert.equal(on[spec.key], true, `${spec.id} on via feature ${name}`);
      const onRecord = recordsOf(on)[spec.id];
      assert.equal(onRecord.state, 'available', `${spec.id}/${name}`);
      assert.equal(onRecord.source, CAPABILITY_SOURCES.capabilities);
      assert.equal(onRecord.reasonCode, 'advertised');

      const off = restCaps({ [name]: false });
      assert.equal(off[spec.key], false, `${spec.id} off via feature ${name}`);
      const offRecord = recordsOf(off)[spec.id];
      assert.equal(offRecord.state, 'unsupported', `${spec.id}/${name}`);
      assert.equal(offRecord.reasonCode, 'advertised-off');
    }
    for (const name of spec.endpoints) {
      const caps = restCaps({}, { [name]: { method: 'GET', path: '/x' } });
      assert.equal(caps[spec.key], true, `${spec.id} on via endpoint ${name}`);
      assert.equal(recordsOf(caps)[spec.id].state, 'available');
    }
    const absent = restCaps({}, {});
    assert.equal(absent[spec.key], false, `${spec.id} absent`);
    const record = recordsOf(absent)[spec.id];
    if (NO_SUCH_ROUTE.includes(spec.id)) {
      assert.equal(record.state, 'unsupported', `${spec.id} absent on a Hermes gateway has no route anywhere`);
      assert.equal(record.reasonCode, 'not-in-hermes');
      continue;
    }
    // One row has an exact answer on a Hermes gateway that listed everything it serves: context status needs
    // the session socket.
    const exact = { sessionContext: 'no-context-socket' }[spec.id];
    if (exact) {
      assert.equal(record.state, 'unsupported', `${spec.id} absent has an exact reason`);
      assert.equal(record.reasonCode, exact);
      continue;
    }
    assert.equal(record.state, 'unknown', `${spec.id} absent is unknown, not unsupported`);
    assert.match(record.reasonCode, /^not-advertised/);
  }
});

test('the companion flag no gateway advertises reads "not advertised by this gateway", never "unavailable"', () => {
  const records = recordsOf(restCaps({ session_chat: true }, { sessions: { method: 'GET', path: '/api/sessions' } }));
  for (const id of ['browserCompanionPlugin']) {
    assert.equal(records[id].state, 'unknown', id);
    assert.match(records[id].reason, /^Not advertised by this gateway\./, id);
    assert.doesNotMatch(records[id].reason, /unavailable|not installed/i, id);
  }
  assert.match(records.browserCompanionPlugin.reason, /cannot tell whether its Hermes plugin is loaded/);
  assert.match(records.browserCompanionPlugin.reason, /does not mean it is missing/);
});

test('the companion plugin row never says the plugin is missing', () => {
  for (const caps of [
    restCaps({}, {}),
    normalizeGatewayCapabilities(null, { healthOk: true, hasApiKey: true }),
    dashboardWsGatewayCapabilities({ health: true, readyPayload: { session_authority: true } }),
  ]) {
    const row = capabilityStatusRows(caps, { readyPayload: { session_authority: true }, now: NOW }).find((item) => item.key === 'browserCompanionPlugin');
    assert.equal(row.status, 'warn');
    assert.notEqual(row.state, 'unsupported');
    assert.notEqual(row.state, 'blocked');
    assert.doesNotMatch(`${row.detail} ${row.reason}`, /unavailable|not installed|plugin is missing/i);
    assert.match(row.detail, /cannot tell whether it is loaded/);
  }
});

test('browserContextProvider is an extension-side fact unless the gateway says otherwise', () => {
  const rest = recordsOf(restCaps({ session_chat: true }));
  assert.equal(rest.browserContextProvider.state, 'available');
  assert.equal(rest.browserContextProvider.source, CAPABILITY_SOURCES.extension);
  assert.equal(rest.browserContextProvider.reasonCode, 'extension-side');
  assert.match(rest.browserContextProvider.reason, /does not depend on a gateway route/);

  const advertised = restCaps({ browser_context_provider: true });
  assert.equal(recordsOf(advertised).browserContextProvider.source, CAPABILITY_SOURCES.capabilities);

  const off = restCaps({ browser_context_provider: false });
  assert.equal(off.browserContextProvider, false, 'a gateway that turns it off is believed');
  assert.equal(recordsOf(off).browserContextProvider.state, 'unsupported');

  // The boolean is what the gateway said, not a made-up true: null when it said nothing.
  assert.equal(rest.browserContextProvider.state, 'available');
  assert.equal(restCaps({ session_chat: true }).browserContextProvider, null);
  assert.equal(DEFAULT_GATEWAY_CAPABILITIES.browserContextProvider, null);
  const legacy = normalizeGatewayCapabilities(null, { healthOk: true, hasApiKey: true });
  assert.equal(legacy.browserContextProvider, null);
  assert.equal(recordsOf(legacy).browserContextProvider.reasonCode, 'extension-side');
});

test('profile_roster, the flag Hermes 0.22.5 advertises, turns the roster on', () => {
  assert.equal(restCaps({ profile_roster: true }).profiles, true);
  assert.equal(restCaps({ profile_roster: false }, { profiles: { method: 'GET', path: '/v1/profiles' } }).profiles, false);
});

test('over the dashboard WebSocket, approval prompts and session.usage context are contract, not "not reported"', () => {
  const caps = dashboardWsGatewayCapabilities({ health: true, readyPayload: { session_authority: true } });
  const records = recordsOf(caps, { readyPayload: { session_authority: true } });
  for (const id of ['approvalEvents', 'sessionContext']) {
    assert.equal(records[id].state, 'available', id);
    assert.equal(records[id].reasonCode, 'ws-contract', id);
  }
  // No handshake yet: nothing is claimed.
  const early = recordsOf(caps);
  assert.notEqual(early.approvalEvents.state, 'available');
});

test('a REST gateway that advertises approval_events keeps its own record', () => {
  const records = recordsOf(restCaps({ approval_events: true, session_context: true }));
  assert.equal(records.approvalEvents.reasonCode, 'advertised');
  assert.equal(records.sessionContext.reasonCode, 'advertised');
});

test('approval_events stays exactly what the gateway sets', () => {
  assert.equal(restCaps({ approval_events: true }).approvalEvents, true);
  assert.equal(recordsOf(restCaps({ approval_events: true })).approvalEvents.state, 'available');
  assert.equal(restCaps({ approval_events: false }).approvalEvents, false);
  assert.equal(recordsOf(restCaps({ approval_events: false })).approvalEvents.state, 'unsupported');
});

test('a session-authority dashboard serves manual compaction as session.mutate, not the legacy verb', () => {
  const ready = { session_authority: true, heartbeat: true };
  const caps = dashboardWsGatewayCapabilities({ health: true, readyPayload: ready });
  assert.equal(caps.sessionCompress, false, 'the legacy flag stays suppressed');
  assert.equal(caps.sessionCompactCanonical, true);
  assert.equal(caps.sessionAuthority, true);
  const records = recordsOf(caps, { readyPayload: ready });
  assert.equal(records.sessionCompress.state, 'available');
  assert.equal(records.sessionCompress.source, CAPABILITY_SOURCES.ready);
  assert.equal(records.sessionCompress.reasonCode, 'authority-compress');
  assert.equal(records.sessionAuthority.state, 'available');
  assert.equal(records.projects.state, 'available');
});

test('a dashboard without session authority keeps the legacy session.compress and no projects', () => {
  const ready = { heartbeat: true };
  const caps = dashboardWsGatewayCapabilities({ health: true, readyPayload: ready });
  assert.equal(caps.sessionCompress, true);
  assert.equal(caps.sessionCompactCanonical, false);
  const records = recordsOf(caps, { readyPayload: ready });
  assert.equal(records.sessionCompress.reasonCode, 'legacy-ws-compress');
  assert.equal(records.sessionAuthority.state, 'unsupported');
  assert.equal(records.sessionAuthority.reasonCode, 'no-session-authority');
  assert.equal(records.projects.state, 'unsupported');
});

test('before gateway.ready arrives nothing about the dashboard is claimed', () => {
  const caps = dashboardWsGatewayCapabilities({ health: false, readyPayload: null });
  const records = recordsOf(caps, { readyPayload: null });
  for (const id of ['sessionCompress', 'sessionAuthority', 'projects', 'sessions', 'models']) {
    assert.equal(records[id].state, 'unknown', id);
    assert.equal(records[id].reasonCode, 'not-connected', id);
  }
});

test('an observed -32601 for session.mutate turns compaction unsupported, with the method named', () => {
  const ready = { session_authority: true };
  const caps = dashboardWsGatewayCapabilities({ health: true, readyPayload: ready });
  const records = recordsOf(caps, { readyPayload: ready, unsupportedMethods: new Set(['session.mutate']) });
  assert.equal(records.sessionCompress.state, 'unsupported');
  assert.equal(records.sessionCompress.source, CAPABILITY_SOURCES.methodNotFound);
  assert.match(records.sessionCompress.reason, /"method not found" \(-32601\) for session\.mutate/);
});

test('a REST-only connection says compaction needs the dashboard WebSocket', () => {
  const records = recordsOf(restCaps({ session_chat: true, session_context: true }, { sessions: { method: 'GET', path: '/api/sessions' } }));
  assert.equal(records.sessionCompress.state, 'unsupported');
  assert.equal(records.sessionCompress.reasonCode, 'rest-no-compress');
  assert.match(records.sessionCompress.reason, /only reaches the REST API/);
  assert.match(records.sessionCompress.reason, /dashboard WebSocket with session authority/);
  assert.equal(records.sessionAuthority.reasonCode, 'rest-only');
  assert.equal(records.projects.reasonCode, 'rest-only');
  const withRoute = restCaps({}, { session_compress: { method: 'POST', path: '/api/sessions/{session_id}/compress' } });
  assert.equal(recordsOf(withRoute).sessionCompress.state, 'available');
});

test('a legacy gateway is degraded where the extension assumed a feature, and unknown elsewhere', () => {
  const caps = normalizeGatewayCapabilities(null, { healthOk: true, hasApiKey: true });
  const records = recordsOf(caps);
  assert.equal(records.health.state, 'available');
  assert.equal(records.sessions.state, 'degraded');
  assert.equal(records.sessions.reasonCode, 'legacy-assumed');
  assert.equal(records.profiles.state, 'unknown');
  assert.equal(records.profiles.reasonCode, 'legacy-gateway');
  assert.equal(records.sessionCompress.state, 'unknown');
});

test('a connection that was never read claims nothing but what the extension itself does', () => {
  const records = recordsOf({ ...DEFAULT_GATEWAY_CAPABILITIES });
  const claimed = Object.values(records).filter((record) => record.state !== 'unknown').map((record) => record.id);
  assert.deepEqual(claimed, ['browserContextProvider']);
  assert.equal(records.browserContextProvider.source, CAPABILITY_SOURCES.extension);
});

test('images are three separate claims: HTTP upload, session attach, stored-image read', () => {
  const ready = { session_authority: true };
  const ws = dashboardWsGatewayCapabilities({ health: true, readyPayload: ready });
  const wsRecords = recordsOf(ws, { readyPayload: ready });
  assert.equal(ws.imageUpload, false);
  assert.equal(wsRecords.imageUpload.state, 'unknown', 'no HTTP upload route is claimed on the WebSocket');
  assert.equal(wsRecords.imageSessionAttach.state, 'available');
  assert.equal(wsRecords.imageSessionAttach.reasonCode, 'ws-contract');
  assert.doesNotMatch(ws.warnings.join('\n'), /stay inline only/i, 'pasted images do attach on the WebSocket');

  const rest = restCaps({ media_api: true }, { media_read: { method: 'GET', path: '/api/media' } });
  const restRecords = recordsOf(rest);
  assert.equal(restRecords.mediaRead.state, 'available');
  assert.equal(restRecords.imageUpload.state, 'unknown');
  assert.equal(restRecords.imageSessionAttach.state, 'unsupported');
  assert.equal(restRecords.imageSessionAttach.reasonCode, 'rest-chat-no-socket');

  const rows = Object.fromEntries(capabilityStatusRows(rest, { now: NOW }).map((row) => [row.key, row]));
  assert.match(rows.mediaRead.detail, /not video|\(not video\)/);
  assert.equal(rows.imageUpload.status, 'warn');
  assert.equal(rows.mediaRead.status, 'ok');
});

test('model lock is claimed only when the gateway offers it', () => {
  assert.equal(recordsOf(restCaps({ session_model_lock: true })).sessionModelLock.state, 'available');
  const absent = recordsOf(restCaps({}, {})).sessionModelLock;
  assert.equal(absent.state, 'unknown');
  const row = capabilityStatusRows(restCaps({}, {}), { now: NOW }).find((item) => item.key === 'sessionModelLock');
  assert.match(row.detail, /not locked/);
});

test('rows carry state, exact reason, source, reason code and age next to the older status and detail', () => {
  const rows = capabilityStatusRows(restCaps({ session_chat: true }), { identityKey: identity.key, now: NOW + 5_000, checkedAt: NOW });
  const row = rows.find((item) => item.key === 'sessionCompress');
  assert.equal(row.state, 'unsupported');
  assert.equal(row.status, 'warn');
  assert.equal(row.reasonCode, 'rest-no-compress');
  assert.match(row.reason, /REST API/);
  assert.equal(row.source, '/v1/capabilities');
  assert.equal(row.ageMs, 5_000);
  assert.ok(row.detail.length > 10);
  assert.deepEqual(rows.map((item) => item.key).slice(0, 3), ['health', 'auth', 'models']);
  assert.equal(rows.find((item) => item.key === 'browserControl'), undefined, 'the compatibility panel still does not list browser control');
});

test('rows built from a ledger show a closed connection as cached, with its age', () => {
  let clock = NOW;
  const ledger = createCapabilityLedger({ now: () => clock });
  ledger.rebind(identity);
  const ready = { session_authority: true };
  const caps = dashboardWsGatewayCapabilities({ health: true, readyPayload: ready });
  ledger.ingest(deriveCapabilityRecords(caps, { identityKey: identity.key, readyPayload: ready, checkedAt: NOW }));
  clock = NOW + 90_000;
  ledger.setConnected(false);
  const rows = capabilityStatusRows(caps, { records: ledger.all(), now: clock });
  const row = rows.find((item) => item.key === 'sessionCompress');
  assert.equal(row.state, 'cached');
  assert.equal(row.status, 'warn');
  assert.equal(row.reasonCode, 'connection-closed');
  assert.match(row.reason, /Last confirmed 2 min ago/);
  assert.equal(ledger.canExecute('sessionCompress').allowed, false);
  assert.equal(row.ageMs, 90_000);
});

test('records for a different identity are rejected by the ledger instead of being shown', () => {
  const ledger = createCapabilityLedger({ now: () => NOW });
  ledger.rebind(capabilityIdentity({ endpoint: 'http://127.0.0.1:9119', principal: 'me', profile: 'work' }));
  const caps = dashboardWsGatewayCapabilities({ health: true, readyPayload: { session_authority: true } });
  const result = ledger.ingest(deriveCapabilityRecords(caps, { identityKey: identity.key, readyPayload: { session_authority: true }, checkedAt: NOW }));
  assert.equal(result.accepted, 0);
  assert.ok(result.rejected > 5);
  assert.deepEqual(ledger.all(), []);
});

test('REST capability flags plus a live authority dashboard socket: compaction follows the socket the panel talks over', () => {
  const rest = restCaps({ session_chat: true }, { sessions: { method: 'GET', path: '/api/sessions' } });
  const ready = { session_authority: true };
  const talkingOverWs = recordsOf(rest, { readyPayload: ready, dashboardWsActive: true });
  assert.equal(talkingOverWs.sessionCompress.state, 'available');
  assert.equal(talkingOverWs.sessionCompress.reasonCode, 'authority-compress');
  assert.equal(talkingOverWs.sessionCompress.params.route, 'canonical');
  assert.equal(talkingOverWs.sessionAuthority.state, 'available');
  assert.equal(talkingOverWs.imageSessionAttach.state, 'available');
  assert.equal(talkingOverWs.profiles.state, 'unknown', 'REST flags keep their REST meaning');

  const socketOnlyForProjects = recordsOf(rest, { readyPayload: ready, dashboardWsActive: false });
  assert.equal(socketOnlyForProjects.sessionCompress.reasonCode, 'rest-no-compress', 'chat is on REST, so compaction is a REST question');
  assert.equal(socketOnlyForProjects.sessionAuthority.reasonCode, 'rest-only');

  const legacy = recordsOf(rest, { readyPayload: { heartbeat: true }, dashboardWsActive: true });
  assert.equal(legacy.sessionCompress.params.route, 'legacy-ws');
  assert.equal(legacy.sessionCompress.reasonCode, 'legacy-ws-compress');
});
