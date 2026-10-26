import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { buildSupportDiagnostics } from '../extension/lib/support-diagnostics.mjs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function body(name) {
  const start = panel.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const open = panel.indexOf('{', panel.indexOf(')', start));
  let depth = 0;
  for (let at = open; at < panel.length; at += 1) {
    if (panel[at] === '{') depth += 1;
    if (panel[at] === '}' && --depth === 0) return panel.slice(start, at + 1);
  }
  throw new Error(`${name} does not close`);
}

test('the probe feeds the three plugin-served rows, believes only a non-unreachable answer, and remembers it for uploads', () => {
  const fn = body('refreshCompanionPluginStatus');
  assert.match(fn, /for \(const id of Object\.keys\(COMPANION_ROUTE_CAPABILITIES\)\)/);
  assert.match(fn, /companionRouteRecordFields\(result, id\)/);
  assert.match(fn, /ledger\.observeProbe\(id, via\)/);
  assert.match(fn, /result\.state !== COMPANION_STATES\.unreachable\) capabilityRuntime\.ledger\.forgetProbe\(id\)/);
  assert.match(fn, /companionProbe = \{ result, identityKey \}/);
  // Still bounded and still not for a remote dashboard (the existing guards are untouched).
  assert.match(fn, /normalizeGatewayMode\(settings\.gatewayMode\) === 'remote-dashboard'/);
  assert.match(fn, /Date\.now\(\) - companionProbeAt < 30_000/);
});

test('a reference turn on a proven route uploads its envelope first, a full or chat-only turn never does', () => {
  const send = panel.slice(panel.indexOf('const contextDelivery = (turnOptions.forceFullContext'), panel.indexOf('const receipt = buildContextReceipt({'));
  const call = send.indexOf('uploadReferenceContextToCompanion(');
  assert.ok(call > 0, 'the send path starts the upload');
  assert.ok(call > send.indexOf('const prompt = serializeBrowserTurnEnvelope('), 'after the prompt is built');
  assert.match(send, /const companionContextUpload = contextDelivery === CONTEXT_DELIVERY_MODES\.REFERENCE && !dashboardTransport\s*\? uploadReferenceContextToCompanion\(/);
  // Never waited on between the final consent read and the send: the REST transport joins the promise.
  assert.doesNotMatch(send, /await uploadReferenceContextToCompanion/);
  assert.match(panel, /beforeSend: companionContextUpload,/);
  const transport = body('streamSessionChat');
  assert.match(transport, /beforeSend = null/);
  assert.match(transport, /if \(beforeSend\) await beforeSend\.catch\(\(\) => undefined\);/);
  assert.ok(transport.indexOf('beforeSend.catch') < transport.indexOf('streamChatCompletions('), 'joined before either REST route sends');
  assert.ok(transport.indexOf('streamDashboardWsChat(') < transport.indexOf('beforeSend.catch'), 'a dashboard chat never waits on it');
  const fn = body('uploadReferenceContextToCompanion');
  // Plan first (skip, reprobe, upload), same hash as the turn, full delivery, no human text, no control snapshot.
  assert.match(fn, /companionUploadPlan\(current, \{ deliveryMode: CONTEXT_DELIVERY_MODES\.REFERENCE, dashboardTransport, sessionId \}\)/);
  assert.match(fn, /companionProbe\.identityKey === capabilityRuntime\.ledger\.identityKey/);
  assert.match(fn, /plan === 'reprobe'[\s\S]*refreshCompanionPluginStatus\(\{ force: true \}\)/);
  assert.match(fn, /if \(plan !== 'upload'\) return false/);
  assert.match(fn, /humanInput: ''/);
  assert.match(fn, /contextDelivery: CONTEXT_DELIVERY_MODES\.FULL/);
  assert.match(fn, /browserControl: \{\}/);
  assert.match(fn, /contextHash,/);
  assert.match(fn, /uploadCompanionContext\(\{ fetchFn: \(path, init\) => apiFetch\(path, init\), sessionId, envelope \}\)/);
  // Fail-soft: it never throws into the turn, and a vanished route stops further attempts.
  assert.match(fn, /\} catch \{\s*return false;/);
  assert.match(fn, /\[401, 403, 404, 405\]\.includes\(result\.status\)\) companionProbe = null/);
  // The turn itself is built before the upload and not touched by it.
  assert.ok(send.indexOf('responseStyle: currentResponseStyleTurnContract()') < call);
});

test('the support report asks the plugin for its context counts and action names only when its routes were listed', () => {
  const fn = body('readCompanionDiagnostics');
  assert.match(fn, /proven\('browserContextStatus'\) && sessionId/);
  assert.match(fn, /proven\('pluginActions'\)/);
  assert.match(fn, /readCompanionContextStatus\(\{ fetchFn, sessionId \}\)/);
  assert.match(fn, /readCompanionActions\(\{ fetchFn \}\)/);
  const copy = body('copySupportDiagnostics');
  assert.match(copy, /await readCompanionDiagnostics\(\)\.catch\(\(\) => \(\{\}\)\)/);
  assert.match(copy, /companionContext: companionDetails\.context \|\| ''/);
  assert.match(copy, /companionActions: companionDetails\.actions \|\| ''/);
});

test('the diagnostics prints the plugin lines only when given, and they carry no page data', () => {
  const base = { extensionVersion: '0.4.0', settings: {}, connection: {}, health: {}, capabilities: {} };
  const without = buildSupportDiagnostics(base).markdown;
  assert.doesNotMatch(without, /Companion plugin context|Companion plugin actions/);
  const given = buildSupportDiagnostics({
    ...base,
    companionContext: '1 held, newest 4 s old, hash a1b2c3d4e5f60789, no upload waiting, not live control',
    companionActions: 'browser_text_utility (descriptors only, run by the agent)',
  }).markdown;
  assert.match(given, /- Companion plugin context \(this session\): 1 held, newest 4 s old, hash a1b2c3d4e5f60789/);
  assert.match(given, /- Companion plugin actions listed: browser_text_utility/);
});

// ---- Behaviour of the panel's upload helper, run from the real source with stubs ----

async function loadUploadHelper(stubs) {
  const { companionUploadPlan, uploadCompanionContext } = await import('../extension/lib/companion-context-client.mjs');
  const { serializeBrowserTurnEnvelope } = await import('../extension/lib/browser-context-protocol.mjs');
  const start = panel.indexOf('async function uploadReferenceContextToCompanion(');
  assert.ok(start > 0);
  const signature = '} = {}) {';
  const open = panel.indexOf(signature, start) + signature.length - 1;
  let depth = 0;
  let end = open;
  for (; end < panel.length; end += 1) {
    if (panel[end] === '{') depth += 1;
    if (panel[end] === '}' && --depth === 0) break;
  }
  const source = panel.slice(start, end + 1);
  // A data: module keeps the helper in this realm, so the protocol module's plain-object checks see ordinary objects.
  const code = `export default function make(stubs, companionUploadPlan, uploadCompanionContext, serializeBrowserTurnEnvelope) {
    const { settings, syncCapabilityRuntime, capabilityRuntime, CONTEXT_DELIVERY_MODES, refreshCompanionPluginStatus, apiFetch } = stubs;
    let companionProbe = stubs.companionProbe;
    ${source}
    return { run: uploadReferenceContextToCompanion, probe: () => companionProbe };
  }`;
  const { default: factory } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return factory(stubs, companionUploadPlan, uploadCompanionContext, serializeBrowserTurnEnvelope);
}

const TURN = () => ({
  context: { activeTab: { id: 1, active: true, title: 'Docs', url: 'https://example.com/docs' }, pageContext: { restricted: false, text: 'page body', meta: { headings: [] } } },
  promptTabs: [],
  selectedPromptTabs: [],
  scope: { mode: 'follow-active' },
  protocolSettings: { contextDepth: 'normal', includeTabs: false, includePageText: true, includeSelectedText: true, maxTabs: 12 },
  contextHash: 'a1b2c3d4e5f60789',
});

function stubs({ probe, identityKey = 'conn-1', status = 200, throwFetch = false, sessionId = 'sess-9' } = {}) {
  const calls = [];
  const state = {
    calls,
    reprobes: 0,
    settings: { sessionId },
    syncCapabilityRuntime: () => true,
    capabilityRuntime: { ledger: { identityKey } },
    CONTEXT_DELIVERY_MODES: { REFERENCE: 'reference', FULL: 'full', NONE: 'none' },
    companionProbe: probe === undefined ? null : probe,
    refreshCompanionPluginStatus: async () => { state.reprobes += 1; },
    apiFetch: async (path, init) => {
      calls.push({ path, init });
      if (throwFetch) throw new Error('network down');
      return { ok: status === 200, status, json: async () => ({ object: 'hermes.browser_companion.context_upload', stored: true, payload_hash: 'a1b2c3d4e5f60789', scope: 'follow-active' }) };
    },
  };
  return state;
}

const ROUTES = [
  '/api/plugins/hermes-browser-companion/context',
  '/api/plugins/hermes-browser-companion/context/status',
  '/api/plugins/hermes-browser-companion/actions',
  '/api/plugins/hermes-browser-companion/status',
];

function readyProbe(checkedAt = Date.now(), routes = ROUTES) {
  return { state: 'ready', via: 'route', version: '0.4.0', routes, checkedAt };
}

test('with a proven route the helper uploads the same full envelope once, with the session, and returns true', async () => {
  const s = stubs({ probe: { identityKey: 'conn-1', result: readyProbe() } });
  const helper = await loadUploadHelper(s);
  assert.equal(await helper.run(TURN()), true);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].path, '/api/plugins/hermes-browser-companion/context');
  assert.equal(s.calls[0].init.method, 'POST');
  assert.equal(s.calls[0].init.headers['X-Hermes-Session-Id'], 'sess-9');
  const envelope = JSON.parse(s.calls[0].init.body);
  assert.equal(envelope.protocol, 'hermes.browser.turn.v2');
  assert.equal(envelope.browser_context.delivery, 'full');
  assert.equal(envelope.source_receipt.context_hash, 'a1b2c3d4e5f60789');
  assert.equal(envelope.human_input.text, 'Attachment-only turn.', 'no user words ride the upload');
});

test('without a proof, for another connection, or without a session the helper sends nothing', async () => {
  for (const options of [
    { probe: null },
    { probe: { identityKey: 'other-conn', result: readyProbe() } },
    { probe: { identityKey: 'conn-1', result: readyProbe(Date.now(), [ROUTES[3]]) } },
    { probe: { identityKey: 'conn-1', result: readyProbe() }, sessionId: '' },
  ]) {
    const s = stubs(options);
    const helper = await loadUploadHelper(s);
    assert.equal(await helper.run(TURN()), false);
    assert.equal(s.calls.length, 0);
    assert.equal(s.reprobes, 0, 'no probe is started for a gateway that never listed the route');
  }
});

test('an old proof is re-probed first, and nothing is sent unless the re-probe proves the route again', async () => {
  const old = Date.now() - 10 * 60_000;
  const gone = stubs({ probe: { identityKey: 'conn-1', result: readyProbe(old) } });
  const goneHelper = await loadUploadHelper(gone);
  assert.equal(await goneHelper.run(TURN()), false);
  assert.equal(gone.reprobes, 1);
  assert.equal(gone.calls.length, 0, 'the re-probe did not refresh it, so nothing is sent');
});

test('a refused or failing upload never throws, and a vanished route stops later attempts', async () => {
  const missing = stubs({ probe: { identityKey: 'conn-1', result: readyProbe() }, status: 404 });
  const helperA = await loadUploadHelper(missing);
  assert.equal(await helperA.run(TURN()), false);
  assert.equal(helperA.probe(), null, 'a 404 drops the proof');
  const busy = stubs({ probe: { identityKey: 'conn-1', result: readyProbe() }, status: 422 });
  const helperB = await loadUploadHelper(busy);
  assert.equal(await helperB.run(TURN()), false);
  assert.notEqual(helperB.probe(), null, 'a refused envelope does not mean the route is gone');
  const down = stubs({ probe: { identityKey: 'conn-1', result: readyProbe() }, throwFetch: true });
  const helperC = await loadUploadHelper(down);
  assert.equal(await helperC.run(TURN()), false);
  const broken = stubs({ probe: { identityKey: 'conn-1', result: readyProbe() } });
  const helperD = await loadUploadHelper(broken);
  assert.equal(await helperD.run({ ...TURN(), context: null }), false, 'a malformed turn is swallowed');
});
