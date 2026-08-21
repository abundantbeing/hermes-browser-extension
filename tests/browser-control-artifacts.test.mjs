import assert from 'node:assert/strict';
import test from 'node:test';

import {
  base64ToBytes,
  buildArtifactReceipt,
  classifyArtifact,
  createBrowserControlArtifactClient,
  createBrowserControlArtifactHttpTransport,
  normalizeArtifactName,
  sha256Hex,
} from '../extension/lib/browser-control-artifacts.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';

const SCOPE = Object.freeze({
  controllerId: 'controller-artifacts',
  leaseOwnerId: 'controller-artifacts',
  leaseId: 'lease-artifacts-1',
  tabId: 9,
  frameId: 0,
  documentGeneration: 2,
});

function frame(action, args = {}, overrides = {}) {
  return {
    command_id: `command-${action}`,
    action,
    arguments: args,
    tab_id: SCOPE.tabId,
    frame_id: SCOPE.frameId,
    document_generation: SCOPE.documentGeneration,
    deadline_at: Date.now() + 5_000,
    ...overrides,
  };
}

const ALL_ACTIONS = Object.freeze([
  'browser_back', 'browser_click', 'browser_navigate', 'browser_press',
  'browser_screenshot', 'browser_scroll', 'browser_snapshot',
  'browser_tab_activate', 'browser_tabs', 'browser_type',
  'browser_console', 'browser_network_requests', 'browser_response_body',
  'browser_pdf', 'browser_upload', 'browser_evaluate', 'browser_cdp', 'browser_dialog',
]);

function adapterFixture(execute) {
  return {
    contract: { enabled: true, actions: [...ALL_ACTIONS] },
    inspect: async () => ({ currentUrl: 'https://example.test/page', hasUnsavedContent: false }),
    execute,
  };
}

function memoryTransport() {
  const store = new Map();
  return {
    store,
    uploads: [],
    downloads: [],
    async upload({ name, mimeType, bytes, checksum }) {
      this.uploads.push({ name, mimeType, size: bytes.length, checksum });
      const artifactId = `artifact-${this.uploads.length}`;
      store.set(artifactId, { name, mimeType, bytes, checksum });
      return { artifactId, url: `https://gateway.test/artifacts/${artifactId}`, expiresAt: 99_999 };
    },
    async download({ artifactId }) {
      this.downloads.push(artifactId);
      const entry = store.get(artifactId);
      if (!entry) throw new Error('artifact not found');
      return { name: entry.name, mimeType: entry.mimeType, bytes: entry.bytes, checksum: entry.checksum };
    },
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function pendingApproval(approvals) {
  await tick();
  const pending = approvals.pending();
  assert.equal(pending.length, 1);
  return pending[0];
}

test('Phase 8 HTTP artifact transport maps authenticated Gateway upload and download contracts', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      return new Response(JSON.stringify({
        artifact_id: 'artifact-http-1',
        download_path: '/v1/artifacts/download/artifact-http-1',
        expires_at: 1_800_000_000,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="report.pdf"',
        'X-Artifact-Sha256': 'checksum-1',
      },
    });
  };
  const transport = createBrowserControlArtifactHttpTransport({
    fetchImpl,
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'neutral-browser-key',
  });
  const uploaded = await transport.upload({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(uploaded, {
    artifactId: 'artifact-http-1',
    url: '/v1/artifacts/download/artifact-http-1',
    expiresAt: 1_800_000_000_000,
  });
  const downloaded = await transport.download({ artifactId: 'artifact-http-1' });
  assert.equal(downloaded.name, 'report.pdf');
  assert.equal(downloaded.mimeType, 'application/pdf');
  assert.equal(downloaded.checksum, 'checksum-1');
  assert.deepEqual([...downloaded.bytes], [1, 2, 3]);
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/artifacts/upload');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer neutral-browser-key');
  assert.equal(calls[0].options.headers['X-Artifact-Filename'], 'report.pdf');
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/v1/artifacts/download/artifact-http-1');
  assert.equal(calls[1].options.redirect, 'error');
});

test('Phase 8 HTTP artifact transport rejects missing credentials and unsafe base URLs', () => {
  assert.throws(
    () => createBrowserControlArtifactHttpTransport({ fetchImpl: async () => {}, baseUrl: 'https://gateway.test' }),
    /API key is required/,
  );
  const transport = createBrowserControlArtifactHttpTransport({
    fetchImpl: async () => new Response('', { status: 500 }),
    baseUrl: 'https://user:password@gateway.test',
    apiKey: 'neutral-browser-key',
  });
  assert.rejects(
    () => transport.download({ artifactId: 'artifact-1' }),
    /credential-free HTTP\(S\)/,
  );
});

test('Phase 8 SHA-256 computes known vectors and round-trips bytes', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    await sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  );
  const bytes = new Uint8Array([104, 101, 108, 108, 111]);
  assert.equal(await sha256Hex(bytes), await sha256Hex('hello'));
});

test('Phase 8 artifact names are reduced to a safe basename and reject junk', () => {
  assert.deepEqual(normalizeArtifactName('report.pdf'), { ok: true, name: 'report.pdf' });
  assert.deepEqual(normalizeArtifactName('../../etc/passwd'), { ok: true, name: 'passwd' });
  assert.deepEqual(normalizeArtifactName('C:\\Users\\Jaybo\\secret.txt'), { ok: true, name: 'secret.txt' });
  assert.equal(normalizeArtifactName('').error, 'empty_name');
  assert.equal(normalizeArtifactName('..').error, 'invalid_name');
  assert.equal(normalizeArtifactName('a\u0000b.pdf').error, 'invalid_name');
  assert.equal(normalizeArtifactName('x'.repeat(300)).error, 'name_too_long');
});

test('Phase 8 MIME and size caps fail closed on unknown types and oversized payloads', () => {
  assert.deepEqual(classifyArtifact({ mimeType: 'application/pdf', sizeBytes: 1_000 }), {
    ok: true, mimeType: 'application/pdf', kind: 'document', maxBytes: 25_000_000, size: 1_000,
  });
  assert.equal(classifyArtifact({ mimeType: 'application/x-evil', sizeBytes: 10 }).error, 'unsupported_mime');
  assert.equal(classifyArtifact({ mimeType: 'application/pdf', sizeBytes: 26_000_000 }).error, 'artifact_too_large');
  assert.equal(classifyArtifact({ mimeType: 'image/png', sizeBytes: 11_000_000 }).error, 'artifact_too_large');
  assert.equal(classifyArtifact({ mimeType: 'image/png', sizeBytes: -1 }).error, 'invalid_size');
});

test('Phase 8 upload computes a local SHA-256 and returns a provenance receipt without content', async () => {
  const transport = memoryTransport();
  const client = createBrowserControlArtifactClient({
    transport,
    now: () => 5_000,
    ttlMs: 60_000,
  });
  const bytes = new TextEncoder().encode('phase 8 pdf fixture');
  const uploaded = await client.upload({
    name: '../../docs/page.pdf',
    mimeType: 'application/pdf',
    bytes,
    scope: SCOPE,
    action: 'browser_pdf',
  });
  assert.equal(uploaded.ok, true);
  const receipt = uploaded.receipt;
  assert.equal(receipt.artifact.name, 'page.pdf');
  assert.equal(receipt.artifact.mimeType, 'application/pdf');
  assert.equal(receipt.artifact.size, bytes.length);
  assert.equal(receipt.artifact.checksum, await sha256Hex(bytes));
  assert.equal(receipt.artifact.artifactId, 'artifact-1');
  assert.equal(receipt.artifact.expiresAt, 99_999);
  assert.deepEqual(receipt.provenance, {
    controllerId: 'controller-artifacts',
    tabId: 9,
    action: 'browser_pdf',
    createdAt: 5_000,
  });
  assert.equal(transport.uploads[0].checksum, await sha256Hex(bytes));
  assert.doesNotMatch(JSON.stringify(receipt), /base64|bytes|phase 8 pdf fixture/i);
});

test('Phase 8 upload rejects unsupported MIME, oversized payloads, and missing ids', async () => {
  const transport = memoryTransport();
  const client = createBrowserControlArtifactClient({ transport, now: () => 5_000 });
  assert.equal((await client.upload({ name: 'x.bin', mimeType: 'application/x-evil', bytes: 'a' })).error, 'unsupported_mime');
  assert.equal((await client.upload({ name: 'x.pdf', mimeType: 'application/pdf', bytes: 'a'.repeat(26_000_000) })).error, 'artifact_too_large');
  assert.equal((await client.upload({ name: '', mimeType: 'application/pdf', bytes: 'a' })).error, 'empty_name');
  transport.upload = async () => ({ url: 'https://gateway.test/artifacts/1' });
  assert.equal((await client.upload({ name: 'x.pdf', mimeType: 'application/pdf', bytes: 'a' })).error, 'artifact_id_missing');
});

test('Phase 8 download verifies checksum, MIME, and size before releasing bytes', async () => {
  const transport = memoryTransport();
  const client = createBrowserControlArtifactClient({ transport, now: () => 5_000 });
  const bytes = new TextEncoder().encode('uploaded payload');
  await client.upload({ name: 'notes.txt', mimeType: 'text/plain', bytes, scope: SCOPE, action: 'browser_upload' });

  const downloaded = await client.download({ artifactId: 'artifact-1' });
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.artifact.name, 'notes.txt');
  assert.equal(downloaded.artifact.mimeType, 'text/plain');
  assert.equal(downloaded.artifact.checksum, await sha256Hex(bytes));
  assert.deepEqual([...downloaded.artifact.bytes], [...bytes]);

  const tampered = await client.download({ artifactId: 'artifact-2' });
  assert.equal(tampered.error, 'artifact_download_failed');

  transport.store.set('artifact-1', {
    name: 'notes.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('tampered!'), checksum: await sha256Hex(bytes),
  });
  assert.equal((await client.download({ artifactId: 'artifact-1' })).error, 'checksum_mismatch');
});

test('Phase 8 receipts are bounded metadata with no content and base64 decodes round-trip', () => {
  const receipt = buildArtifactReceipt({
    artifactId: 'artifact-9',
    name: 'page.pdf',
    mimeType: 'application/pdf',
    size: 123,
    checksum: 'AB12'.toLowerCase(),
    url: 'https://gateway.test/artifacts/artifact-9',
    expiresAt: 1_000,
    scope: { controllerId: 'c-1', tabId: 3 },
    action: 'browser_pdf',
  });
  assert.deepEqual(receipt.artifact, {
    artifactId: 'artifact-9', name: 'page.pdf', mimeType: 'application/pdf',
    size: 123, checksum: 'ab12', url: 'https://gateway.test/artifacts/artifact-9', expiresAt: 1_000,
  });
  assert.deepEqual(receipt.provenance, { controllerId: 'c-1', tabId: 3, action: 'browser_pdf', createdAt: 0 });
  assert.doesNotMatch(JSON.stringify(receipt), /base64|bytes/i);

  const bytes = base64ToBytes('aGVsbG8=');
  assert.deepEqual([...bytes], [104, 101, 108, 108, 111]);
  assert.equal(base64ToBytes(''), null);
});

test('Phase 8 evaluate stays blocked without developer mode and returns redacted output with it', async () => {
  let calls = 0;
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async () => { calls += 1; return { value: { ok: true, api_key: 'supersecret' } }; }),
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    developerMode: false,
  });
  const blocked = await executor.execute(frame('browser_evaluate', { expression: '1 + 1' }), { scope: SCOPE });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'sensitive_action_blocked');
  assert.equal(calls, 0);

  const approvals = createBrowserControlApprovalStore();
  const devExecutor = createBrowserControlExecutor({
    adapter: adapterFixture(async () => { calls += 1; return { value: { ok: true, api_key: 'supersecret' } }; }),
    approvals,
    refs: createBrowserControlRefStore(),
    developerMode: true,
  });
  const running = devExecutor.execute(frame('browser_evaluate', { code: 'document.title = "x"' }), { scope: SCOPE });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.action, 'browser_evaluate');
  assert.match(pending.reason, /document\.title/);
  assert.equal(pending.detail, 'document.title = "x"');
  approvals.grant(pending);
  const result = await running;
  assert.equal(result.ok, true);
  assert.match(result.result.value, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.result.value, /supersecret/);
  assert.equal(calls, 1);
});

test('Phase 8 raw CDP requires developer mode plus approval and enforces a method policy', async () => {
  const approvals = createBrowserControlApprovalStore();
  const calls = [];
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async (action, args) => { calls.push(args.method); return { result: { ok: true } }; }),
    approvals,
    refs: createBrowserControlRefStore(),
    developerMode: true,
  });

  const running = executor.execute(frame('browser_cdp', { method: 'Runtime.getHeapUsage' }), { scope: SCOPE });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.action, 'browser_cdp');
  approvals.grant(pending);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'cdp-command-sent');
  assert.deepEqual(calls, ['Runtime.getHeapUsage']);

  const denied = executor.execute(frame('browser_cdp', { method: 'Browser.close' }, { command_id: 'command-cdp-denied' }), { scope: SCOPE });
  const deniedPending = await pendingApproval(approvals);
  approvals.grant(deniedPending);
  assert.equal((await denied).error.code, 'cdp_method_denied');
  assert.deepEqual(calls, ['Runtime.getHeapUsage']);

  const noDev = createBrowserControlExecutor({
    adapter: adapterFixture(async () => ({ result: {} })),
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    developerMode: false,
  });
  assert.equal((await noDev.execute(frame('browser_cdp', { method: 'Runtime.evaluate' }), { scope: SCOPE })).error.code, 'sensitive_action_blocked');
});

test('Phase 8 PDF generation uploads through the artifact client and returns a receipt, never base64', async () => {
  const transport = memoryTransport();
  const approvals = createBrowserControlApprovalStore();
  const bytes = new TextEncoder().encode('%PDF-1.4 fixture');
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async () => ({ bytes })),
    approvals,
    refs: createBrowserControlRefStore(),
    artifacts: createBrowserControlArtifactClient({ transport, now: () => 5_000 }),
  });

  const running = executor.execute(frame('browser_pdf', { filename: 'summary.pdf' }), { scope: SCOPE });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.action, 'browser_pdf');
  approvals.grant(pending);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.artifact.name, 'summary.pdf');
  assert.equal(result.result.artifact.mimeType, 'application/pdf');
  assert.equal(result.result.artifact.checksum, await sha256Hex(bytes));
  assert.equal(result.result.provenance.action, 'browser_pdf');
  assert.doesNotMatch(JSON.stringify(result.result), /base64|%PDF/i);
  assert.equal(transport.uploads.length, 1);

  const noTransportApprovals = createBrowserControlApprovalStore();
  const noTransport = createBrowserControlExecutor({
    adapter: adapterFixture(async () => ({ bytes })),
    approvals: noTransportApprovals,
    refs: createBrowserControlRefStore(),
  });
  const blocked = noTransport.execute(frame('browser_pdf'), { scope: SCOPE });
  const pendingNoTransport = await pendingApproval(noTransportApprovals);
  noTransportApprovals.grant(pendingNoTransport);
  assert.equal((await blocked).error.code, 'artifact_transport_unavailable');
});

test('Phase 8 upload requires an artifact id, binds it to the approval, and downloads before the adapter', async () => {
  const transport = memoryTransport();
  const approvals = createBrowserControlApprovalStore();
  const calls = [];
  const uploadedBytes = new TextEncoder().encode('approved upload payload');
  await createBrowserControlArtifactClient({ transport }).upload({
    name: 'payload.bin', mimeType: 'application/octet-stream', bytes: uploadedBytes, scope: SCOPE, action: 'browser_upload',
  });

  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async (action, args, context) => {
      calls.push({ action, artifact: context.artifact });
      return { status: 'uploaded' };
    }),
    approvals,
    refs: createBrowserControlRefStore(),
    artifacts: createBrowserControlArtifactClient({ transport }),
  });

  const missingId = await executor.execute(frame('browser_upload', {}), { scope: SCOPE });
  assert.equal(missingId.error.code, 'sensitive_action_blocked');
  assert.equal(calls.length, 0);

  const running = executor.execute(frame('browser_upload', { artifact_id: 'artifact-1' }), { scope: SCOPE });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.action, 'browser_upload');
  assert.equal(pending.binding, 'artifact-1');
  assert.equal(approvals.grant({ ...pending, binding: 'artifact-other' }).ok, false);
  assert.equal(approvals.grant(pending).ok, true);
  const result = await running;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, {
    status: 'uploaded',
    name: 'payload.bin',
    mimeType: 'application/octet-stream',
    size: uploadedBytes.length,
    checksum: await sha256Hex(uploadedBytes),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'browser_upload');
  assert.equal(calls[0].artifact.name, 'payload.bin');
  assert.deepEqual([...calls[0].artifact.bytes], [...uploadedBytes]);
});

test('Phase 8 console reads pause for approval, redact entries, and stay bounded', async () => {
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async () => ({
      entries: [
        { type: 'log', text: 'user logged in with api_key=topsecret' },
        ...Array.from({ length: 250 }, (_value, index) => ({ type: 'warn', text: `entry ${index}` })),
      ],
    })),
    approvals,
    refs: createBrowserControlRefStore(),
  });
  const running = executor.execute(frame('browser_console'), { scope: SCOPE });
  const pending = await pendingApproval(approvals);
  assert.equal(pending.action, 'browser_console');
  approvals.grant(pending);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.entries.length, 200);
  assert.equal(result.result.truncated, true);
  assert.match(result.result.entries[0].text, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.result.entries[0].text, /topsecret/);
});

test('Phase 8 network reads are metadata-only and reject body requests', async () => {
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async () => ({
      requests: [
        { requestId: 'req-1', method: 'GET', status: 200, mimeType: 'text/html', resourceType: 'document', size: 100, url: 'https://example.test/page?token=abc' },
        { requestId: 'req-2', method: 'POST', status: 201, mimeType: 'application/json', resourceType: 'fetch', size: 50, url: 'https://api.test/v1', body: 'should-never-leak' },
      ],
    })),
    approvals,
    refs: createBrowserControlRefStore(),
  });
  const running = executor.execute(frame('browser_network_requests'), { scope: SCOPE });
  const pending = await pendingApproval(approvals);
  approvals.grant(pending);
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.requests.length, 2);
  assert.equal(result.result.bodiesIncluded, false);
  assert.doesNotMatch(JSON.stringify(result.result), /should-never-leak/);
  assert.doesNotMatch(JSON.stringify(result.result), /token=abc/);

  const bodyRequest = executor.execute(frame('browser_network_requests', { include_bodies: true }, { command_id: 'command-network-bodies' }), { scope: SCOPE });
  const bodyPending = await pendingApproval(approvals);
  approvals.grant(bodyPending);
  assert.equal((await bodyRequest).error.code, 'network_bodies_blocked');
});

test('Phase 8 bounded response bodies pass MIME and secret scans or fail closed', async () => {
  const approvals = createBrowserControlApprovalStore();
  let mode = 'clean';
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async () => {
      if (mode === 'clean') return { mimeType: 'text/html', body: '<p>public body</p>' };
      if (mode === 'secret') return { mimeType: 'application/json', body: '{"token":"abc123"}' };
      return { mimeType: 'application/octet-stream', body: 'binary-ish' };
    }),
    approvals,
    refs: createBrowserControlRefStore(),
  });

  let running = executor.execute(frame('browser_response_body', { request_id: 'req-1' }), { scope: SCOPE });
  let pending = await pendingApproval(approvals);
  approvals.grant(pending);
  const clean = await running;
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.result, { mimeType: 'text/html', size: 18, body: '<p>public body</p>', truncated: false });

  mode = 'secret';
  running = executor.execute(frame('browser_response_body', { request_id: 'req-1' }, { command_id: 'command-body-secret' }), { scope: SCOPE });
  pending = await pendingApproval(approvals);
  approvals.grant(pending);
  assert.equal((await running).error.code, 'body_contains_secrets');

  mode = 'binary';
  running = executor.execute(frame('browser_response_body', { request_id: 'req-1' }, { command_id: 'command-body-binary' }), { scope: SCOPE });
  pending = await pendingApproval(approvals);
  approvals.grant(pending);
  assert.equal((await running).error.code, 'body_mime_not_allowed');

  const missingId = await executor.execute(frame('browser_response_body', {}), { scope: SCOPE });
  assert.equal(missingId.error.code, 'sensitive_action_blocked');
});

test('Phase 8 dialog handling pauses with a consequence-aware reason and maps the result', async () => {
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({
    adapter: adapterFixture(async (_action, args) => ({ status: args.accept === true ? 'dialog-accepted' : 'dialog-dismissed' })),
    approvals,
    refs: createBrowserControlRefStore(),
  });

  let running = executor.execute(frame('browser_dialog', { accept: true, message: 'Delete this account permanently?' }), { scope: SCOPE });
  let pending = await pendingApproval(approvals);
  assert.equal(pending.action, 'browser_dialog');
  assert.equal(pending.reason, 'Approve this page dialog?');
  approvals.grant(pending);
  assert.equal((await running).ok, true);

  running = executor.execute(frame('browser_dialog', { accept: true, message: 'Are you sure you want to delete this?' }, { command_id: 'command-dialog-2' }), { scope: SCOPE });
  pending = await pendingApproval(approvals);
  assert.equal(pending.reason, 'Approve this page dialog?');
  approvals.grant(pending);
  const accepted = await running;
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result.status, 'dialog-accepted');
});
