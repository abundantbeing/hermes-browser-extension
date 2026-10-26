// Panel wiring for the About rows: a pasted image on a REST chat goes through the session socket, and opening About
// asks the gateway again. Real code sliced from extension/sidepanel.js, run in a VM.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { stageImageViaSessionSocket } from '../extension/lib/session-socket-image.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not slice ${from}`);
  return source.slice(start, end);
};
const stageSource = between('async function stageImageViaGatewaySocket(attachment) {', '\n// Local dashboard turns carry no pixels');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function authoritySocket({ attach = { attached: true, path: '/gw/cache/images/upload_1.png', name: 'upload_1.png', mime: 'image/png', bytes: 8 } } = {}) {
  const calls = [];
  return {
    readyState: 1, readyPayload: { session_authority: true }, calls,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === 'session.resume') return { session_id: params.session_id, subscription_id: 'sub' };
      if (method === 'image.attach_bytes') return attach instanceof Error ? Promise.reject(attach) : attach;
      return {};
    },
  };
}

function panel({ client = null, openSocket = null, chatOverSocket = false, remote = false, sessionId = 'rest-1' } = {}) {
  const notes = [];
  let side = client;
  const context = vm.createContext({
    stageImageViaSessionSocket,
    settings: { sessionId },
    isRemoteWsMode: () => remote,
    usesDashboardWsChatTransport: () => chatOverSocket,
    sessionAuthoritySideSocket: () => side,
    refreshGatewaySocket: async () => { if (openSocket) side = openSocket(); return side; },
    capabilityRuntime: { noteOperation: (...args) => notes.push(args) },
    renderCompatibilityPanel: () => {},
  });
  vm.runInContext(stageSource, context);
  return { notes, run: (code) => vm.runInContext(code, context) };
}

const attachment = () => ({ kind: 'image', label: 'shot.png', dataUrl: PNG, detail: 'image/png · 1 KB' });

test('a REST chat stages its pasted image through the open session socket and names the gateway path', async () => {
  const client = authoritySocket();
  const p = panel({ client });
  const staged = await p.run(`stageImageViaGatewaySocket(${JSON.stringify(attachment())})`);
  assert.equal(staged.localPath, '/gw/cache/images/upload_1.png');
  assert.equal(staged.savedFilename, 'upload_1.png');
  assert.equal(staged.uploadError, '');
  assert.equal(client.calls[0][1].session_id, 'rest-1', 'by the chat\'s stored id');
  assert.deepEqual(p.notes.map(([id, outcome, scope]) => [id, outcome.ok, scope.sessionId]), [['imageSessionAttach', true, 'rest-1']]);
});

test('it opens the socket when none is open, and stays inline (null) when none can be opened', async () => {
  const opened = panel({ openSocket: () => authoritySocket() });
  assert.ok(await opened.run(`stageImageViaGatewaySocket(${JSON.stringify(attachment())})`));
  const none = panel();
  assert.equal(await none.run(`stageImageViaGatewaySocket(${JSON.stringify(attachment())})`), null);
  assert.deepEqual(none.notes, [], 'no socket says nothing about whether Hermes can stage images');
});

test('a gateway that does not hold the session refuses for that session only, and the image stays inline', async () => {
  const client = authoritySocket({ attach: Object.assign(new Error('not_found'), { data: { reason: 'not_found' } }) });
  client.request = async (method) => { throw Object.assign(new Error('not_found'), { data: { reason: 'not_found' } }); };
  const p = panel({ client });
  assert.equal(await p.run(`stageImageViaGatewaySocket(${JSON.stringify(attachment())})`), null);
  assert.equal(p.notes.length, 1);
  assert.equal(p.notes[0][1].ok, false);
  assert.equal(p.notes[0][2].sessionId, 'rest-1', 'a per-session refusal, never a connection-wide one');
});

test('a chat that runs over the dashboard socket, a remote dashboard, or no stored session never takes this route', async () => {
  for (const options of [{ chatOverSocket: true }, { remote: true }, { sessionId: '' }]) {
    const client = authoritySocket();
    const p = panel({ client, ...options });
    assert.equal(await p.run(`stageImageViaGatewaySocket(${JSON.stringify(attachment())})`), null);
    assert.equal(client.calls.length, 0);
  }
});

test('the upload tries the gateway route, then the dashboard, then the session socket, then stays inline', () => {
  const start = source.indexOf('async function uploadImageAttachment(attachment) {');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const order = ['apiFetch(BROWSER_IMAGE_UPLOAD_ENDPOINT', 'uploadImageViaDashboard(', 'stageImageViaGatewaySocket(attachment)', 'uploadSkipped: true'];
  // The gateway route sits after the early return of the "no advertised route" branch.
  const positions = [body.indexOf(order[1]), body.indexOf(order[2]), body.indexOf(order[3])];
  assert.ok(positions.every((position) => position > 0), 'all three present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in that order');
  assert.ok(body.includes(order[0]));
});

test('opening About asks /v1/capabilities again, so no row waits on a five-minute-old answer', () => {
  const body = between("if (settingsActivePane === 'about') {", 'renderSettingsEditedMarkers();');
  assert.match(body, /loadGatewayCapabilities\(\{ quiet: true, healthOk: isConnected\(\) \}\)/);
  assert.match(body, /refreshCompanionPluginStatus\(\{ force: true \}\)/);
  assert.match(body, /refreshGatewaySocket\(\{ force: true \}\)/);
});
