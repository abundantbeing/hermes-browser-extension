import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WS_METHODS } from '../extension/lib/gateway-ws.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function buildAttachHarness() {
  const start = sidepanelSource.indexOf('// Local dashboard turns carry no pixels');
  const end = sidepanelSource.indexOf('\nasync function attachFiles', start);
  assert.ok(start >= 0 && end > start, 'attachDashboardTurnImages source block must exist in sidepanel.js');
  const slice = sidepanelSource.slice(start, end);

  const requests = [];
  const statuses = [];
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'WS_METHODS', 'setStatus', 'console',
    `${slice}\nreturn attachDashboardTurnImages;`,
  );
  return {
    requests,
    statuses,
    attach: (client, sessionId, items) => factory(
      WS_METHODS,
      (...args) => statuses.push(args),
      console,
    )(client, sessionId, items),
  };
}

test('gateway WS client exposes the Desktop image.attach_bytes contract', () => {
  assert.equal(WS_METHODS.imageAttachBytes, 'image.attach_bytes');
});

test('pending screenshots upload to the live session before the prompt submits', async () => {
  const harness = buildAttachHarness();
  const attachment = {
    id: 'image-1',
    kind: 'image',
    label: 'shot.png',
    detail: 'image/png · 51.5 KB',
    dataUrl: 'data:image/png;base64,AAAA',
  };
  const client = {
    request: async (method, params) => {
      harness.requests.push({ method, params });
      return { attached: true, path: 'C:\\session\\images\\upload_20260911.png', count: 1 };
    },
  };

  const items = await harness.attach(client, 'live-1', [attachment]);

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].method, 'image.attach_bytes');
  assert.deepEqual(harness.requests[0].params, {
    session_id: 'live-1',
    content_base64: 'data:image/png;base64,AAAA',
    filename: 'shot.png',
  });
  assert.equal(attachment.dashboardAttachedSessionId, 'live-1');
  assert.equal(attachment.localPath, 'C:\\session\\images\\upload_20260911.png');
  assert.match(attachment.detail, /attached for Hermes vision/);
  assert.deepEqual(harness.statuses[0].slice(0, 2), ['ok', 'Image ready for Hermes vision']);
});

test('image attach is idempotent per session and never blocks non-image turns', async () => {
  const harness = buildAttachHarness();
  const attached = {
    kind: 'image',
    label: 'shot.png',
    dataUrl: 'data:image/png;base64,AAAA',
    dashboardAttachedSessionId: 'live-1',
    localPath: 'C:\\session\\images\\upload_1.png',
  };
  const file = { kind: 'file', label: 'notes.txt', text: 'hello' };
  const client = { request: async () => { harness.requests.push(true); return { attached: true }; } };

  await harness.attach(client, 'live-1', [attached, file]);
  assert.equal(harness.requests.length, 0, 'already-attached images and non-images must not re-upload');

  // A resumed (re-minted) session id re-uploads so the bare submit is not text-only.
  await harness.attach(client, 'live-2', [attached]);
  assert.equal(harness.requests.length, 1);
  assert.equal(attached.dashboardAttachedSessionId, 'live-2');
});

test('failed attaches record an upload error, keep going, and warn once', async () => {
  const harness = buildAttachHarness();
  const bad = { kind: 'image', label: 'bad.png', dataUrl: 'data:image/png;base64,AAAA' };
  const good = { kind: 'image', label: 'good.png', dataUrl: 'data:image/png;base64,BBBB' };
  const client = {
    request: async (method, params) => {
      if (params.filename === 'bad.png') throw new Error('gateway said no');
      return { attached: true, path: 'C:\\session\\images\\upload_2.png', count: 2 };
    },
  };

  await harness.attach(client, 'live-1', [bad, good]);

  assert.equal(bad.uploadError, 'gateway said no');
  assert.equal(bad.dashboardAttachedSessionId, undefined);
  assert.equal(good.dashboardAttachedSessionId, 'live-1');
  const warn = harness.statuses.find((entry) => entry[0] === 'warn');
  assert.ok(warn, 'a warn status must surface the failed attach');
  assert.match(warn[1], /Image stayed inline only/);
});

test('askHermes and the dashboard attempt both stage images before prompt.submit', () => {
  assert.match(sidepanelSource, /let preparedAttachments = await saveImageAttachmentsForTurn\(turnAttachments\);/);
  assert.match(sidepanelSource, /dashboardTransport && preparedAttachments\.some\(\(attachment\) => attachment\.kind === 'image' && attachment\.dataUrl\)/);
  assert.match(sidepanelSource, /preparedAttachments = await attachDashboardTurnImages\(attachConnection\.client, attachSessionId, preparedAttachments\);/);
  assert.match(sidepanelSource, /attachments: turnAttachments = \[\]/);
  assert.match(
    sidepanelSource,
    /if \(submitPrompt\) \{\s*void \(async \(\) => \{\s*try \{\s*await attachDashboardTurnImages\(client, sessionId, turnAttachments\);[\s\S]{0,400}WS_METHODS\.promptSubmit/,
    'the attempt must attach images for the attempt session before submitting',
  );
});

test('full-tab dashboard turns stage images before prompt.submit and stop inlining base64 text', () => {
  const appSource = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /async function attachDashboardPromptImages\(client, sessionId, items = \[\]\)/);
  assert.match(appSource, /WS_METHODS\.imageAttachBytes/);
  assert.match(appSource, /content_base64: attachment\.dataUrl/);
  assert.match(appSource, /function attachmentPrompt\(\{ inlineImageData = !usesDashboardTicketTransport\(\) \} = \{\}\)/);
  assert.match(appSource, /signal: activeAbortController\.signal,\r?\n\s*attachments: turnAttachments,/);
  assert.match(
    appSource,
    /if \(submitPrompt\) \{\s*void \(async \(\) => \{\s*try \{\s*await attachDashboardPromptImages\(connection\.client, sessionId, turnAttachments\);[\s\S]{0,400}WS_METHODS\.promptSubmit/,
    'the full-tab attempt must attach images for the attempt session before submitting',
  );
});
