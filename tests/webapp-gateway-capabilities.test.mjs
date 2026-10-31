import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { deriveCapabilityRecords, normalizeGatewayCapabilities } from '../extension/lib/capabilities.mjs';
import { capabilityIdentity } from '../extension/lib/capability-status.mjs';
import { createCapabilityRuntime } from '../extension/lib/capability-runtime.mjs';
import english from '../extension/lib/locales/en.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const identity = capabilityIdentity({ endpoint: 'http://127.0.0.1:8642', principal: 'me', profile: 'default' });

const restCaps = () => normalizeGatewayCapabilities({
  object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: {}, endpoints: {},
}, { healthOk: true, hasApiKey: true });

const AUTHORITY = { session_authority: true };
const byId = (records) => Object.fromEntries(records.map((record) => [record.id, record]));
const derive = (extra) => byId(deriveCapabilityRecords(restCaps(), { identityKey: identity.key, checkedAt: 1, ...extra }));

// --- the derivation -------------------------------------------------------------------------------

test('a REST chat with no socket still reads rest-only for authority, Projects and compaction, and says no socket is open for context and images', () => {
  const records = derive({});
  for (const id of ['sessionAuthority', 'projects']) {
    assert.equal(records[id].state, 'unsupported', id);
    assert.equal(records[id].reasonCode, 'rest-only', id);
  }
  assert.deepEqual([records.imageSessionAttach.state, records.imageSessionAttach.reasonCode], ['unsupported', 'rest-chat-no-socket']);
  assert.deepEqual([records.sessionContext.state, records.sessionContext.reasonCode], ['unsupported', 'no-context-socket']);
  assert.equal(records.sessionCompress.reasonCode, 'rest-no-compress');
});

test('beside a REST chat, an open session-authority socket makes authority, Projects and compaction available from its own gateway.ready', () => {
  const records = derive({ sideSocket: true, readyPayload: AUTHORITY });
  assert.deepEqual(['sessionAuthority', 'projects'].map((id) => [records[id].state, records[id].source, records[id].reasonCode]), [
    ['available', 'gateway.ready', 'authority-ready'],
    ['available', 'gateway.ready', 'authority-ready'],
  ]);
  assert.equal(records.sessionCompress.state, 'available');
  assert.equal(records.sessionCompress.reasonCode, 'authority-compress');
  assert.deepEqual({ route: records.sessionCompress.params.route, sideSocket: records.sessionCompress.params.sideSocket }, { route: 'canonical', sideSocket: true });
});

test('beside a REST chat, an authority socket serves image attach and context status by the stored session id', () => {
  const records = derive({ sideSocket: true, readyPayload: AUTHORITY });
  assert.deepEqual([records.imageSessionAttach.state, records.imageSessionAttach.reasonCode, records.imageSessionAttach.source], ['available', 'image-via-socket', 'gateway.ready']);
  assert.deepEqual([records.sessionContext.state, records.sessionContext.reasonCode, records.sessionContext.source], ['available', 'context-socket', 'gateway.ready']);
  for (const key of ['image_via_socket', 'context_socket', 'no_context_socket', 'rest_chat_no_socket']) assert.ok(english[`capability.reason.${key}`], `${key} localized`);
});

test('a socket that answered -32601 for image.attach_bytes or the context reads says so instead of claiming them', () => {
  const methods = new Set(['image.attach_bytes', 'session.context_breakdown', 'session.stats']);
  const records = derive({ sideSocket: true, readyPayload: AUTHORITY, unsupportedMethods: methods });
  assert.deepEqual([records.imageSessionAttach.state, records.imageSessionAttach.reasonCode], ['unsupported', 'method-not-found']);
  assert.deepEqual([records.sessionContext.state, records.sessionContext.reasonCode], ['unsupported', 'method-not-found']);
});

test('a side socket that is not session authority keeps the old REST-chat image reason', () => {
  const records = derive({ sideSocket: true, readyPayload: { session_authority: false } });
  assert.equal(records.imageSessionAttach.reasonCode, 'rest-chat');
  assert.ok(english['capability.reason.rest_chat'], 'localized');
});

test('a side socket whose gateway.ready reports no session authority says so, and does not claim compaction', () => {
  const records = derive({ sideSocket: true, readyPayload: { session_authority: false } });
  assert.equal(records.sessionAuthority.state, 'unsupported');
  assert.equal(records.sessionAuthority.reasonCode, 'no-session-authority');
  assert.equal(records.projects.state, 'unsupported');
  assert.notEqual(records.sessionCompress.state, 'available');
});

test('a side socket before its handshake claims nothing; a closed one changes nothing the REST connection said', () => {
  assert.equal(derive({ sideSocket: true, readyPayload: null }).projects.reasonCode, 'rest-only');
  assert.equal(derive({ sideSocket: false, readyPayload: AUTHORITY }).projects.reasonCode, 'rest-only');
});

test('a REST gateway that advertises its own compact route keeps it over the side socket', () => {
  const caps = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: {}, endpoints: { session_compress: { method: 'POST', path: '/api/sessions/{session_id}/compress' } },
  }, { healthOk: true, hasApiKey: true });
  const records = byId(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: 1, sideSocket: true, readyPayload: AUTHORITY }));
  assert.equal(records.sessionCompress.reasonCode, 'advertised');
  assert.equal(records.sessionCompress.params.sideSocket, undefined);
});

test('a method-not-found for session.mutate on the side socket turns compaction off', () => {
  const records = derive({ sideSocket: true, readyPayload: AUTHORITY, unsupportedMethods: ['session.mutate'] });
  assert.equal(records.sessionCompress.state, 'unsupported');
  assert.equal(records.sessionCompress.reasonCode, 'method-not-found');
});

test('the dashboard-WebSocket chat transport still reads from its own socket, as before', () => {
  const records = derive({ dashboardWsActive: true, readyPayload: AUTHORITY });
  assert.equal(records.imageSessionAttach.state, 'available');
  assert.equal(records.sessionCompress.params.route, 'canonical');
  assert.equal(records.sessionCompress.params.sideSocket, undefined);
});

// --- the runtime ----------------------------------------------------------------------------------

test('the runtime redraws when a side socket opens and when it closes', () => {
  const runtime = createCapabilityRuntime();
  const caps = restCaps();
  const sync = (extra) => runtime.sync({ caps, identity, connected: true, ...extra });
  sync({});
  assert.equal(runtime.record('projects').reasonCode, 'rest-only');
  assert.equal(sync({ sideSocket: true, readyPayload: AUTHORITY }), true);
  assert.equal(runtime.record('projects').state, 'available');
  assert.equal(runtime.verdict('sessionCompress').allowed, true);
  assert.equal(sync({ sideSocket: true, readyPayload: AUTHORITY }), false, 'nothing changed');
  assert.equal(sync({ sideSocket: false }), true);
  assert.equal(runtime.record('projects').reasonCode, 'rest-only', 'closed: back to what REST says');
  assert.equal(runtime.verdict('sessionCompress').allowed, false);
});

// --- the panel ------------------------------------------------------------------------------------

function sliceBetween(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
}

function panel({ chatTransport = false, profileClient = null, activeClient = null, accountOffered = false } = {}) {
  const runtime = createCapabilityRuntime();
  const context = {
    // The panel's snapshot of whether this gateway asks for a Hermes account sign-in that none is held for.
    accountSignInOffered: () => accountOffered,
    isRemoteWsMode: () => false,
    usesDashboardWsChatTransport: () => chatTransport,
    remoteWsConnection: null,
    activeDashboardWsConnection: activeClient ? { client: activeClient, baseUrl: 'http://127.0.0.1:9120' } : null,
    profileWsConnection: profileClient ? { client: profileClient, baseUrl: 'http://127.0.0.1:9120' } : null,
    capabilityLastWsClient: null,
    capabilityClientTokens: new WeakMap(),
    capabilityClientCounter: 0,
    gatewayCapabilities: restCaps(),
    capabilityRuntime: runtime,
    capabilityIdentity,
    settings: { gatewayUrl: 'http://127.0.0.1:8642' },
    contextConsentBindingMatches: () => false,
    contextConsentPrincipalBinding: { principal: '' },
    safeActiveProfile: () => 'default',
    browserControlStatus: null,
    isConnected: () => true,
  };
  vm.createContext(context);
  vm.runInContext(sliceBetween('function syncCapabilityRuntime() {', '\nfunction refreshCapabilityViews'), context);
  vm.runInContext(sliceBetween('function sessionAuthoritySideSocket() {', '\nfunction refreshCapabilityViews'), context);
  return { context, runtime, sync: () => vm.runInContext('syncCapabilityRuntime()', context) };
}

test('the panel feeds the Hermes Web socket to the ledger while chat stays on REST', () => {
  const client = { readyState: 1, readyPayload: AUTHORITY };
  const p = panel({ profileClient: client });
  p.sync();
  assert.equal(p.runtime.record('sessionAuthority').state, 'available');
  assert.equal(p.runtime.record('projects').state, 'available');
  assert.equal(p.runtime.record('sessionCompress').params.sideSocket, true);
  assert.equal(p.runtime.record('imageSessionAttach').reasonCode, 'image-via-socket');
  assert.equal(p.runtime.record('sessionContext').reasonCode, 'context-socket');
  assert.equal(p.runtime.record('health').state, 'available', 'the REST rows are not demoted by a socket');
});

test('with no socket, or one that has not delivered gateway.ready, the panel reports REST only', () => {
  for (const profileClient of [null, { readyState: 1, readyPayload: null }, { readyState: 0, readyPayload: AUTHORITY }]) {
    const p = panel({ profileClient });
    p.sync();
    assert.equal(p.runtime.record('projects').reasonCode, 'rest-only');
  }
});

test('a chat that runs over the dashboard socket still reads from that socket, not from a side one', () => {
  const chat = { readyState: 1, readyPayload: AUTHORITY };
  const side = { readyState: 1, readyPayload: { session_authority: false } };
  const p = panel({ chatTransport: true, activeClient: chat, profileClient: side });
  p.sync();
  assert.equal(p.runtime.record('sessionAuthority').state, 'available');
  assert.equal(p.runtime.record('imageSessionAttach').state, 'available');
});

test('compaction beside a REST chat runs on the socket without adopting or creating a live session', () => {
  const start = source.indexOf('async function compactCanonicalSessionContext(');
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end);
  assert.match(body, /sideSocket \? await ensureProfileWsConnection\(\) : await ensureActiveDashboardWsConnection\(\)/);
  assert.match(body, /if \(!sideSocket\) await ensureRemoteWsSession\(connection\)/, 'the panel session is left as it is');
  assert.match(body, /const durableId = viewedId/, 'the captured session is the mutation target');
  const caller = sliceBetween('async function compactCurrentSessionContext(', '\n// Session-authority dashboard: session.mutate');
  assert.match(caller, /compressRecord\.params\.sideSocket === true/);
});

// --- the Hermes account sign-in --------------------------------------------------------------------

test('a gateway that asks for a Hermes account sign-in says so on every row that needs its socket', () => {
  const records = derive({ accountSignIn: true });
  for (const id of ['sessionAuthority', 'projects']) {
    assert.equal(records[id].state, 'blocked', id);
    assert.equal(records[id].reasonCode, 'account-sign-in', id);
  }
  assert.equal(records.sessionCompress.state, 'blocked');
  assert.equal(records.sessionCompress.reasonCode, 'account-sign-in');
  for (const id of ['sessionContext', 'imageSessionAttach']) assert.deepEqual([records[id].state, records[id].reasonCode], ['blocked', 'account-sign-in'], id);
  assert.ok(english['capability.reason.account_sign_in'], 'localized');
  assert.ok(english['projects.unavailable.account_sign_in'], 'localized');
});

test('a REST compaction route the gateway advertised itself still reads as it said', () => {
  const caps = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: {}, endpoints: { session_compress: { path: '/v1/sessions/{id}/compress', method: 'POST' } },
  }, { healthOk: true, hasApiKey: true });
  const records = byId(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: 1, accountSignIn: true }));
  assert.equal(records.sessionCompress.state, 'available');
  assert.equal(records.projects.reasonCode, 'account-sign-in');
});

test('with a socket open, or a chat over the socket, the sign-in reason never overrides what the socket said', () => {
  assert.equal(derive({ accountSignIn: true, sideSocket: true, readyPayload: AUTHORITY }).projects.state, 'available');
  assert.equal(derive({ accountSignIn: true, dashboardWsActive: true, readyPayload: AUTHORITY }).sessionAuthority.state, 'available');
});

test('the panel passes the sign-in offer to the ledger, and an offer that is withdrawn restores the REST-only reading', () => {
  const offered = panel({ accountOffered: true });
  offered.sync();
  assert.equal(offered.runtime.record('projects').reasonCode, 'account-sign-in');
  const none = panel({ accountOffered: false });
  none.sync();
  assert.equal(none.runtime.record('projects').reasonCode, 'rest-only');
});
