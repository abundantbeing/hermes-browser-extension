import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COMPANION_EXPECTED_TOOLS,
  COMPANION_EXPECTED_VERSION,
  COMPANION_REASONS,
  COMPANION_STATES,
  COMPANION_STATUS_PATH,
  COMPANION_TOOLSETS_PATH,
  classifyCompanionPlugin,
  companionRecordFields,
  companionReasonText,
  companionRouteRecordFields,
  compareVersions,
  parseCompanionStatusPayload,
  parseCompanionToolsets,
  probeCompanionPlugin,
} from '../extension/lib/companion-plugin-status.mjs';
import {
  capabilityStatusRows,
  deriveCapabilityRecords,
  normalizeGatewayCapabilities,
} from '../extension/lib/capabilities.mjs';
import { capabilityIdentity, createCapabilityLedger } from '../extension/lib/capability-status.mjs';

const BASE = 'http://127.0.0.1:8642';
const TOKEN = 'paired-token-value';
const NOW = 2_000_000;
const manifest = readFileSync('companion-plugin/plugin.yaml', 'utf8');
const ALL_TOOLS = [...COMPANION_EXPECTED_TOOLS];

function statusBody(overrides = {}) {
  return {
    object: 'hermes.browser_companion.status',
    plugin: 'hermes-browser-extension',
    version: COMPANION_EXPECTED_VERSION,
    profile: 'luxord',
    tools: ALL_TOOLS,
    hooks: ['post_tool_call', 'pre_llm_call', 'pre_tool_call'],
    routes: [COMPANION_STATUS_PATH],
    live: false,
    ...overrides,
  };
}

function toolsetsBody({ present = true, enabled = true, tools = ALL_TOOLS } = {}) {
  const data = [{ name: 'web', enabled: true, tools: ['web_search'] }];
  if (present) data.push({ name: 'hermes-browser-extension', label: 'Browser companion', enabled, tools });
  return { object: 'list', platform: 'api_server', data };
}

// A fake gateway: path -> { status, body } | Error | function(request).
function gateway(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const path = String(url).slice(BASE.length);
    const entry = routes[path];
    const resolved = typeof entry === 'function' ? await entry({ url, init }) : entry;
    if (resolved instanceof Error) throw resolved;
    const { status = 404, body = null } = resolved || {};
    return { status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined || body === null) throw new SyntaxError('no body'); return body; } };
  };
  return { fetchImpl, calls };
}

const probe = (routes, extra = {}) => {
  const fake = gateway(routes);
  return probeCompanionPlugin({ baseUrl: BASE, token: TOKEN, fetchImpl: fake.fetchImpl, now: () => NOW, ...extra }).then((result) => ({ result, calls: fake.calls }));
};

test('the extension expects exactly what companion-plugin/plugin.yaml ships', () => {
  assert.equal(manifest.match(/^version:\s*(\S+)/m)[1], COMPANION_EXPECTED_VERSION);
  const tools = [...manifest.matchAll(/^ {2}- ((?:browser|tab)_\w+)$/gm)].map((match) => match[1]);
  // The Hermes Control tools are not expected: they are offered only while a browser is
  // attached, and the extension's readiness does not need them. They are all tab_*.
  const control = tools.filter((name) => !COMPANION_EXPECTED_TOOLS.includes(name));
  assert.equal(control.length, 20);
  assert.ok(control.every((name) => name.startsWith('tab_')), control.join(', '));
  assert.deepEqual(tools.filter((name) => COMPANION_EXPECTED_TOOLS.includes(name)).sort(), [...COMPANION_EXPECTED_TOOLS]);
  assert.equal(COMPANION_STATUS_PATH, '/api/plugins/hermes-browser-extension/status');
});

test('a copy under the plugin\'s old name is an older copy to replace, never a loaded plugin', async () => {
  const legacy = { status: 200, body: statusBody({ plugin: 'hermes-browser-companion', routes: ['/api/plugins/hermes-browser-companion/control/register'] }) };
  const { result, calls } = await probe({ '/api/plugins/hermes-browser-companion/status': legacy });
  assert.equal(result.state, COMPANION_STATES.outdated);
  assert.equal(result.reasonCode, 'companion-renamed');
  assert.match(result.reason, /hermes plugins remove hermes-browser-companion/);
  assert.match(result.reason, /install hermes-browser-extension/);
  // Nothing the old copy serves is taken as available: its control tools carry browser_* names.
  assert.equal(companionRouteRecordFields(result, 'browserControl'), null);
  assert.deepEqual(calls.map((call) => call.url.slice(BASE.length)), [COMPANION_STATUS_PATH, '/api/plugins/hermes-browser-companion/status']);

  // A gateway without a status route at all still tells an old-name toolset apart.
  const listed = { status: 200, body: { object: 'list', platform: 'api_server', data: [{ name: 'hermes-browser-companion', enabled: true, tools: ALL_TOOLS }] } };
  const viaToolsets = await probe({ [COMPANION_TOOLSETS_PATH]: listed });
  assert.equal(viaToolsets.result.reasonCode, 'companion-renamed');
  assert.equal(viaToolsets.result.state, COMPANION_STATES.outdated);

  // And a gateway with neither still reads as not installed.
  const none = await probe({ [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ present: false }) } });
  assert.equal(none.result.reasonCode, 'companion-not-loaded');
});

test('versions compare numerically and refuse what is not a plain version', () => {
  assert.equal(compareVersions('0.3.4', '0.3.4'), 0);
  assert.equal(compareVersions('0.2.0', '0.3.4'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v1.0.0-rc.1', '1.0.0'), 0);
  assert.equal(compareVersions('unknown', '0.3.4'), null);
  assert.equal(compareVersions('', '0.3.4'), null);
});

test('only the plugin\'s own body counts as its status', () => {
  assert.equal(parseCompanionStatusPayload(statusBody()).ok, true);
  assert.deepEqual(parseCompanionStatusPayload(statusBody()).missing, []);
  assert.deepEqual(parseCompanionStatusPayload(statusBody({ tools: ALL_TOOLS.slice(1) })).missing, [ALL_TOOLS[0]]);
  for (const bad of [null, [], 'x', {}, statusBody({ object: 'other' }), statusBody({ plugin: 'someone-else' })]) {
    assert.equal(parseCompanionStatusPayload(bad).ok, false);
  }
  assert.deepEqual(parseCompanionToolsets({ data: 'nope' }), { valid: false, present: false });
  assert.deepEqual(parseCompanionToolsets(toolsetsBody({ present: false })), { valid: true, present: false });
  assert.deepEqual(parseCompanionToolsets(toolsetsBody({ enabled: false })), { valid: true, present: true, enabled: false, tools: ALL_TOOLS });
});

test('ready: the route answers, the version and tools match, and the toolset is on', async () => {
  const { result, calls } = await probe({
    [COMPANION_STATUS_PATH]: { status: 200, body: statusBody() },
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody() },
  });
  assert.equal(result.state, COMPANION_STATES.ready);
  assert.equal(result.reasonCode, 'companion-ready');
  assert.equal(result.version, COMPANION_EXPECTED_VERSION);
  assert.equal(result.profile, 'luxord');
  assert.equal(result.toolsetEnabled, true);
  assert.equal(result.via, 'route');
  assert.equal(result.checkedAt, NOW);
  assert.match(result.reason, /Loaded: version 0.4.0, profile luxord, 7 tools\./);
  // Read-only and credentialed exactly once per request, never with cookies.
  assert.deepEqual(calls.map((call) => call.url), [`${BASE}${COMPANION_STATUS_PATH}`, `${BASE}${COMPANION_TOOLSETS_PATH}`]);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.body, undefined);
  }
  assert.equal(JSON.stringify(result).includes(TOKEN), false, 'the token never appears in the result');
});

test('ready from the route alone when the toolset list cannot be read, and a newer plugin is fine', async () => {
  const { result } = await probe({
    [COMPANION_STATUS_PATH]: { status: 200, body: statusBody({ version: '0.9.0' }) },
    [COMPANION_TOOLSETS_PATH]: { status: 404 },
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.reasonCode, 'companion-ready-route-only');
  assert.equal(result.toolsetEnabled, null);
  assert.match(result.reason, /could not confirm whether its toolset is on/);
});

test('outdated: an older version, or tools the extension expects are missing', async () => {
  const old = (await probe({ [COMPANION_STATUS_PATH]: { status: 200, body: statusBody({ version: '0.3.0' }) } })).result;
  assert.equal(old.state, 'outdated');
  assert.equal(old.reasonCode, 'companion-version-old');
  assert.match(old.reason, /version 0\.3\.0 and this extension expects 0.4.0/);
  const missing = (await probe({ [COMPANION_STATUS_PATH]: { status: 200, body: statusBody({ tools: ALL_TOOLS.filter((name) => name !== 'browser_context_journal') }) } })).result;
  assert.equal(missing.state, 'outdated');
  assert.equal(missing.reasonCode, 'companion-tools-missing');
  assert.match(missing.reason, /missing tools: browser_context_journal/);
});

test('outdated: a loaded copy that has no status route (the v0.2.0 case) is told apart from not installed', async () => {
  const six = ALL_TOOLS.filter((name) => name !== 'browser_context_journal');
  const { result } = await probe({
    [COMPANION_STATUS_PATH]: { status: 404 },
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ tools: six }) },
  });
  assert.equal(result.state, 'outdated');
  assert.equal(result.reasonCode, 'companion-no-route');
  assert.equal(result.via, 'toolsets');
  assert.match(result.reason, /6 of 7 tools/);
  assert.match(result.reason, /older copy/);
});

test('disabled: loaded, but its toolset is switched off for the API server', async () => {
  const { result } = await probe({
    [COMPANION_STATUS_PATH]: { status: 200, body: statusBody() },
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ enabled: false }) },
  });
  assert.equal(result.state, 'disabled');
  assert.equal(result.reasonCode, 'companion-toolset-off');
  assert.equal(result.toolsetEnabled, false);
  assert.match(result.reason, /hermes tools/);
});

test('not installed: no route and no companion toolset, with the three possible causes named', async () => {
  const { result } = await probe({
    [COMPANION_STATUS_PATH]: { status: 404 },
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ present: false }) },
  });
  assert.equal(result.state, 'not-installed');
  assert.equal(result.reasonCode, 'companion-not-loaded');
  assert.match(result.reason, /not installed, not enabled for this profile, or the gateway has not been restarted/);
});

test('a cross-origin 404 that the browser reports as a network error still resolves through the toolset list', async () => {
  const { result } = await probe({
    [COMPANION_STATUS_PATH]: new TypeError('Failed to fetch'),
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ present: false }) },
  });
  assert.equal(result.state, 'not-installed');
});

test('a 200 that is not the plugin\'s body (a proxy, another server) is treated as no route', async () => {
  const { result } = await probe({
    [COMPANION_STATUS_PATH]: { status: 200, body: { hello: 'world' } },
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ present: false }) },
  });
  assert.equal(result.state, 'not-installed');
});

test('unreachable carries the exact reason: no token, refused token, gateway error, network, unreadable', async () => {
  const none = await probeCompanionPlugin({ baseUrl: BASE, token: '', fetchImpl: () => assert.fail('no request without a token'), now: () => NOW });
  assert.equal(none.state, 'unreachable');
  assert.equal(none.reasonCode, 'companion-no-token');

  const refused = (await probe({ [COMPANION_STATUS_PATH]: { status: 401 } })).result;
  assert.equal(refused.state, 'unreachable');
  assert.equal(refused.reasonCode, 'companion-auth-refused');
  assert.match(refused.reason, /HTTP 401/);

  const refusedLater = (await probe({ [COMPANION_STATUS_PATH]: { status: 404 }, [COMPANION_TOOLSETS_PATH]: { status: 403 } })).result;
  assert.equal(refusedLater.reasonCode, 'companion-auth-refused');

  const broken = (await probe({ [COMPANION_STATUS_PATH]: { status: 502 } })).result;
  assert.equal(broken.reasonCode, 'companion-gateway-error');
  assert.match(broken.reason, /HTTP 502/);

  const down = (await probe({
    [COMPANION_STATUS_PATH]: new TypeError('fetch failed'),
    [COMPANION_TOOLSETS_PATH]: new TypeError('fetch failed'),
  })).result;
  assert.equal(down.state, 'unreachable');
  assert.equal(down.reasonCode, 'companion-network');
  assert.match(down.reason, /could not be reached \(fetch failed\)/);

  const noList = (await probe({ [COMPANION_STATUS_PATH]: { status: 404 }, [COMPANION_TOOLSETS_PATH]: { status: 404 } })).result;
  assert.equal(noList.state, 'unreachable');
  assert.equal(noList.reasonCode, 'companion-cannot-tell');
  assert.match(noList.reason, /does not mean it is missing/);

  const garbage = (await probe({ [COMPANION_STATUS_PATH]: { status: 404 }, [COMPANION_TOOLSETS_PATH]: { status: 200, body: { data: 'x' } } })).result;
  assert.equal(garbage.reasonCode, 'companion-cannot-tell');
});

test('a hung gateway times out into unreachable instead of waiting', async () => {
  const hang = ({ init }) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { result } = await probe({ [COMPANION_STATUS_PATH]: hang, [COMPANION_TOOLSETS_PATH]: hang }, { timeoutMs: 20 });
  assert.equal(result.state, 'unreachable');
  assert.equal(result.reasonCode, 'companion-network');
  assert.match(result.reason, /timed out/);
});

test('classify is pure: the same inputs give the same answer, and every state has a reason', () => {
  const states = new Set();
  for (const code of Object.keys(COMPANION_REASONS)) assert.ok(companionReasonText(code, { version: '1.0.0', expected: '2.0.0', missing: ['x'], present: ['y'], status: 500, detail: 'd' }).length > 10, code);
  const cases = [
    classifyCompanionPlugin({ route: { kind: 'ok', parsed: parseCompanionStatusPayload(statusBody()) }, toolsets: null }),
    classifyCompanionPlugin({ route: { kind: 'absent' }, toolsets: parseCompanionToolsets(toolsetsBody({ present: false })) }),
    classifyCompanionPlugin({ route: { kind: 'absent' }, toolsets: parseCompanionToolsets(toolsetsBody()) }),
    classifyCompanionPlugin({ route: { kind: 'ok', parsed: parseCompanionStatusPayload(statusBody()) }, toolsets: parseCompanionToolsets(toolsetsBody({ enabled: false })) }),
    classifyCompanionPlugin({ route: { kind: 'error', reasonCode: 'companion-network', params: {} } }),
  ];
  for (const item of cases) states.add(item.state);
  assert.deepEqual([...states].sort(), Object.values(COMPANION_STATES).sort());
});

// ---- Capability records ------------------------------------------------------

const identity = capabilityIdentity({ endpoint: BASE, principal: 'me', profile: 'default' });
const caps = normalizeGatewayCapabilities({
  object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: { session_chat: true }, endpoints: {},
}, { healthOk: true, hasApiKey: true });

async function readyProbe() {
  return (await probe({
    [COMPANION_STATUS_PATH]: { status: 200, body: statusBody() },
    [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody() },
  })).result;
}

test('a probe replaces "not advertised" in the companion row with its state, source and exact reason', async () => {
  const without = deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: NOW }).find((r) => r.id === 'browserCompanionPlugin');
  assert.equal(without.state, 'unknown');
  assert.equal(without.reasonCode, 'not-advertised-plugin');

  const companionPlugin = await readyProbe();
  const withProbe = deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: NOW, companionPlugin }).find((r) => r.id === 'browserCompanionPlugin');
  assert.equal(withProbe.state, 'available');
  assert.equal(withProbe.source, 'probe');
  assert.equal(withProbe.reasonCode, 'companion-ready');
  assert.equal(withProbe.identityKey, identity.key);
  assert.match(withProbe.reason, /version 0.4.0/);

  const rows = capabilityStatusRows(caps, { identityKey: identity.key, checkedAt: NOW, now: NOW + 5_000, companionPlugin });
  const row = rows.find((item) => item.key === 'browserCompanionPlugin');
  assert.equal(row.status, 'ok');
  assert.equal(row.state, 'available');
  assert.equal(row.source, 'probe');
  assert.equal(row.ageMs, 5_000);
  assert.match(row.detail, /Loaded: version 0.4.0, profile luxord/);
  // Every other row is unchanged by the probe.
  const others = (list) => list.filter((item) => item.key !== 'browserCompanionPlugin');
  assert.deepEqual(others(rows), others(capabilityStatusRows(caps, { identityKey: identity.key, checkedAt: NOW, now: NOW + 5_000 })));
});

test('each probe state maps to one record state, and an unreachable probe never erases an advertisement', async () => {
  const map = {
    ready: 'available', outdated: 'degraded', disabled: 'blocked', 'not-installed': 'unsupported', unreachable: 'unknown',
  };
  const samples = {
    ready: await readyProbe(),
    outdated: (await probe({ [COMPANION_STATUS_PATH]: { status: 200, body: statusBody({ version: '0.1.0' }) } })).result,
    disabled: (await probe({ [COMPANION_STATUS_PATH]: { status: 200, body: statusBody() }, [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ enabled: false }) } })).result,
    'not-installed': (await probe({ [COMPANION_STATUS_PATH]: { status: 404 }, [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ present: false }) } })).result,
    unreachable: (await probe({ [COMPANION_STATUS_PATH]: { status: 500 } })).result,
  };
  for (const [state, expected] of Object.entries(map)) {
    const fields = companionRecordFields(samples[state]);
    assert.equal(fields.state, expected, state);
    assert.equal(fields.params.companionState, state);
    assert.ok(fields.reason.length > 10);
  }
  assert.equal(companionRecordFields(null), null);
  assert.equal(companionRecordFields({ state: 'bogus', reasonCode: 'x' }), null);

  const advertised = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: { browser_companion_plugin: true }, endpoints: {},
  }, { healthOk: true, hasApiKey: true });
  const kept = deriveCapabilityRecords(advertised, { identityKey: identity.key, checkedAt: NOW, companionPlugin: samples.unreachable }).find((r) => r.id === 'browserCompanionPlugin');
  assert.equal(kept.state, 'available');
  assert.equal(kept.source, '/v1/capabilities');
  const overridden = deriveCapabilityRecords(advertised, { identityKey: identity.key, checkedAt: NOW, companionPlugin: samples['not-installed'] }).find((r) => r.id === 'browserCompanionPlugin');
  assert.equal(overridden.state, 'unsupported');
  assert.equal(overridden.source, 'probe');
});

test('the ledger keeps a probe like any observation: negative outranks, positive stops speaking after 60 s, a new identity drops it', async () => {
  let clock = NOW;
  const ledger = createCapabilityLedger({ now: () => clock });
  ledger.rebind(identity);
  ledger.connect('connection-1');
  ledger.ingest(deriveCapabilityRecords(caps, { identityKey: identity.key, checkedAt: clock }));
  assert.equal(ledger.get('browserCompanionPlugin').state, 'unknown');

  const ready = ledger.observeProbe('browserCompanionPlugin', companionRecordFields(await readyProbe()));
  assert.equal(ready.source, 'probe');
  assert.equal(ledger.get('browserCompanionPlugin').state, 'available');
  assert.equal(ledger.get('browserCompanionPlugin').reasonCode, 'companion-ready');

  clock += 61_000;
  // Past its 60 s a positive probe stops speaking; the advertisement (unknown) does.
  const aged = ledger.get('browserCompanionPlugin');
  assert.equal(aged.state, 'unknown');
  assert.equal(aged.source, '/v1/capabilities');
  assert.equal(ledger.canExecute('browserCompanionPlugin').allowed, false);

  const off = (await probe({ [COMPANION_STATUS_PATH]: { status: 404 }, [COMPANION_TOOLSETS_PATH]: { status: 200, body: toolsetsBody({ present: false }) } })).result;
  ledger.observeProbe('browserCompanionPlugin', companionRecordFields({ ...off, checkedAt: clock }));
  assert.equal(ledger.get('browserCompanionPlugin').state, 'unsupported');
  assert.match(ledger.get('browserCompanionPlugin').reason, /Not loaded on this gateway/);

  ledger.connect('connection-2');
  assert.equal(ledger.get('browserCompanionPlugin').state, 'unknown', 'a new connection forgets the probe');

  ledger.observeProbe('browserCompanionPlugin', companionRecordFields(await readyProbe()));
  ledger.rebind(capabilityIdentity({ endpoint: BASE, principal: 'me', profile: 'other' }));
  assert.equal(ledger.get('browserCompanionPlugin'), null, 'another profile does not inherit it');
});
