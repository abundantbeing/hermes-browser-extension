// D12: the discovered local Desktop dashboard (desktopDashboardUrl) and the socket opened to it belong to
// the local gateway only. After a switch to any remote mode no reader may reach 127.0.0.1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeGatewayMode } from '../extension/lib/common.mjs';
import {
  isLocalGatewayMode, localDashboardResetPlan, localDashboardUrlFor,
} from '../extension/lib/local-dashboard-scope.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');

function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}\\(`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

// ---------- pure decisions ----------

test('only the local-api mode may hold a discovered dashboard URL', () => {
  assert.equal(localDashboardUrlFor('local-api', 'http://127.0.0.1:9119'), 'http://127.0.0.1:9119');
  assert.equal(localDashboardUrlFor('remote-dashboard', 'http://127.0.0.1:9119'), '');
  assert.equal(localDashboardUrlFor('remote-api', 'http://127.0.0.1:9119'), '');
  assert.equal(isLocalGatewayMode('local-api'), true);
  assert.equal(isLocalGatewayMode('remote-api'), false);
});

test('a remote mode drops the URL, the local socket and the roster; a local mode drops nothing', () => {
  const profile = { client: {} };
  const local = localDashboardResetPlan({
    gatewayMode: 'local-api', discoveredUrl: 'http://127.0.0.1:9119', profileConnection: profile, activeConnection: profile,
  });
  assert.equal(local.reset, false);
  assert.equal(local.closeProfileConnection, false);
  const remote = localDashboardResetPlan({
    gatewayMode: 'remote-dashboard', discoveredUrl: 'http://127.0.0.1:9119', profileConnection: profile, activeConnection: profile,
    conversationTransport: 'dashboard-ws',
  });
  assert.equal(remote.reset, true);
  assert.equal(remote.clearUrl, true);
  assert.equal(remote.closeProfileConnection, true);
  assert.equal(remote.clearActiveConnection, true);
  assert.equal(remote.clearRoster, true);
  assert.equal(remote.conversationTransport, 'dashboard-ws', 'a remote dashboard keeps the socket transport');
  const remoteApi = localDashboardResetPlan({
    gatewayMode: 'remote-api', discoveredUrl: 'http://127.0.0.1:9119', profileConnection: profile, activeConnection: profile,
    conversationTransport: 'dashboard-ws',
  });
  assert.equal(remoteApi.conversationTransport, 'rest', 'a remote API connection has no dashboard socket to keep');
});

test('a remote connection that holds nothing local has nothing to reset', () => {
  const plan = localDashboardResetPlan({ gatewayMode: 'remote-dashboard', activeConnection: { client: {} } });
  assert.equal(plan.reset, false);
  assert.equal(plan.clearActiveConnection, false, "another (remote) socket is not the local profile socket");
});

// ---------- the panel's accessor and reset ----------

function panel({ gatewayMode, url = 'http://127.0.0.1:9119' }) {
  const closed = [];
  const profile = { client: { close: () => closed.push('profile') }, baseUrl: url };
  const context = vm.createContext({
    settings: { gatewayMode },
    normalizeGatewayMode,
    desktopDashboardUrl: url,
    desktopDashboardDiscoveryPromise: Promise.resolve(''),
    profileWsConnection: profile,
    activeDashboardWsConnection: profile,
    activeConversationTransport: 'dashboard-ws',
    liveSessionRows: new Map([['A', { live: true }]]),
    liveDiscoveredSessions: [{ id: 'X' }],
    liveSessionRosterScope: 'scope',
    isLocalApiMode: () => normalizeGatewayMode(gatewayMode) === 'local-api',
    localDashboardUrlFor, localDashboardResetPlan,
  });
  vm.runInContext(`${functionSource('localDashboardUrl')}\n${functionSource('resetLocalDashboardState')}`, context);
  return { context, closed, profile };
}

test('localDashboardUrl() is empty unless the connection is the local one', () => {
  assert.equal(vm.runInContext('localDashboardUrl()', panel({ gatewayMode: 'local-api' }).context), 'http://127.0.0.1:9119');
  assert.equal(vm.runInContext('localDashboardUrl()', panel({ gatewayMode: 'remote-dashboard' }).context), '');
  assert.equal(vm.runInContext('localDashboardUrl()', panel({ gatewayMode: 'remote-api' }).context), '');
});

test('resetLocalDashboardState() on a remote connection clears the URL, closes the local socket and the roster', () => {
  const { context, closed } = panel({ gatewayMode: 'remote-dashboard' });
  vm.runInContext('resetLocalDashboardState()', context);
  assert.equal(vm.runInContext('desktopDashboardUrl', context), '');
  assert.equal(vm.runInContext('profileWsConnection', context), null);
  assert.equal(vm.runInContext('activeDashboardWsConnection', context), null);
  assert.equal(vm.runInContext('liveSessionRows.size', context), 0);
  assert.equal(vm.runInContext('liveDiscoveredSessions.length', context), 0);
  assert.deepEqual(closed, ['profile']);
});

test('resetLocalDashboardState() keeps everything on a local connection', () => {
  const { context, closed } = panel({ gatewayMode: 'local-api' });
  vm.runInContext('resetLocalDashboardState()', context);
  assert.equal(vm.runInContext('desktopDashboardUrl', context), 'http://127.0.0.1:9119');
  assert.notEqual(vm.runInContext('profileWsConnection', context), null);
  assert.deepEqual(closed, []);
});

// ---------- every reader ----------

// The raw variable may be touched only here: the accessor, the reset, and the guarded discovery.
const RAW_ALLOWED = new Set(['localDashboardUrl', 'setLocalDashboardUrl', 'resetLocalDashboardState', 'ensureDesktopDashboardUrl']);

function rawOccurrences() {
  const found = [];
  lines.forEach((line, index) => {
    if (!/\bdesktopDashboardUrl\b/.test(line)) return;
    if (/^\s*\/\//.test(line)) return;
    // An object key (desktopDashboardUrl: value) is not a read of the variable.
    const stripped = line.replace(/\bdesktopDashboardUrl\s*:/g, '');
    if (!/\bdesktopDashboardUrl\b/.test(stripped)) return;
    let owner = '(top level)';
    for (let i = index; i >= 0; i -= 1) {
      const match = /^(?:async )?function ([A-Za-z0-9_$]+)\(/.exec(lines[i]);
      if (match) { owner = match[1]; break; }
    }
    found.push({ line: index + 1, owner, text: line.trim() });
  });
  return found;
}

test('no function outside the accessor, the reset and the guarded discovery touches desktopDashboardUrl', () => {
  const offenders = rawOccurrences().filter((hit) => !RAW_ALLOWED.has(hit.owner) && !/^let desktopDashboardUrl = '';$/.test(hit.text));
  assert.deepEqual(offenders.map((hit) => `${hit.owner}:${hit.line}`), [], 'use localDashboardUrl() instead');
});

test('ensureDesktopDashboardUrl() refuses a non-local connection before it reads anything', () => {
  const body = functionSource('ensureDesktopDashboardUrl');
  assert.match(body, /if \(!isLocalApiMode\(\)\) \{\s*desktopDashboardUrl = '';\s*return '';\s*\}/);
});

// The readers that must go through the accessor (the audit counted about ten).
const READERS = [
  'dashboardApiRequest', 'loadDashboardSessionsForProfile', 'loadSessions', 'renameSessionViaDashboardRest',
  'projectsConnectionSnapshot', 'prepareProjectsConnection', 'applySessionMenuTabOnOpen', 'liveSessionScopeKey',
  'refreshLiveSessionRoster', 'profileConnectionKey', 'ensureProfileWsConnection', 'activateLocalDashboardTransport',
  'voiceLiveDashboardBaseUrl', 'resolveDashboardMediaBaseUrl', 'attachGatewayRestartAction', 'fetchBotModeRemoteAvatar',
  'streamSessionChat', 'testConnection', 'loadGatewayCapabilities', 'dashboardVoiceTranscriptionReachable',
  'transcribeVoiceRecording', 'syncProfileModelSelection', 'loadModels', 'loadProfiles', 'leaveBotModeForRegularSession',
];

test('each known reader goes through localDashboardUrl()', () => {
  const missing = [];
  for (const name of READERS) {
    const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}\\(`).test(line));
    if (start < 0) { missing.push(`${name}: not found`); continue; }
    let end = start + 1;
    while (end < lines.length && !/^(async )?function /.test(lines[end])) end += 1;
    const body = lines.slice(start, end).join('\n');
    if (!/\blocalDashboardUrl\(\)/.test(body)) missing.push(`${name}: no accessor call`);
  }
  assert.deepEqual(missing, []);
});

// ---------- every place the mode changes ----------

test('every place the connection mode changes resets the local dashboard state', () => {
  for (const name of ['connectTicketTransport', 'saveSettingsFromForm', 'clearStoredToken', 'adoptUnsavedGatewayUrlForConnect']) {
    const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}\\(`).test(line));
    let end = start + 1;
    while (end < lines.length && !/^(async )?function /.test(lines[end])) end += 1;
    assert.match(lines.slice(start, end).join('\n'), /resetLocalDashboardState\(\)/, `${name} resets the local dashboard state`);
  }
});

test('connectTicketTransport resets right after the remote settings are adopted, before readiness runs', () => {
  const body = functionSource('connectTicketTransport');
  const adopted = body.indexOf("gatewayMode: 'remote-dashboard'");
  const reset = body.indexOf('resetLocalDashboardState()');
  const readiness = body.indexOf('runPanelConnectionReadiness');
  assert.ok(adopted > 0 && reset > adopted && readiness > reset, 'adopt settings, reset, then readiness');
});

test('a mode change written by another panel resets this panel as well', () => {
  const at = source.indexOf("Object.hasOwn(changes, 'hermesBrowserSettings')");
  const block = source.slice(at, at + 2600);
  assert.match(block, /resetLocalDashboardState\(\)/);
});
