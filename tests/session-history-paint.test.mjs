import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as history from '../extension/lib/session-history-normalization.mjs';
import { messageDisplayText } from '../extension/lib/common.mjs';
import { preserveAssistantResponseStyles, responsePresentationFromSettings } from '../extension/lib/response-presentation.mjs';
import { preserveUserImageAttachments, extractHistoryMediaAttachments, normalizeUserImageAttachments } from '../extension/lib/image-render.mjs';
import { bindRowIdsFromHistory } from '../extension/lib/message-rewind.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function commitFetchedSessionMessages('), source.indexOf('let completionRevealSequence'));
const IMAGE = 'data:image/png;base64,AA==';
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The real history commit, with only storage, the media reads and the paint stubbed.
function build({ save, hydrate }) {
  const painted = [];
  const deps = {
    reconcileBrowserUserHistory: history.reconcileBrowserUserHistory,
    preserveAssistantResponseStyles, responsePresentationFromSettings,
    preserveUserImageAttachments, extractHistoryMediaAttachments, normalizeUserImageAttachments,
    bindRowIdsFromHistory, messageDisplayText,
    scopeRevision: { current: () => 1, isCurrent: (id) => id === 1 },
    settings: { sessionId: 'test-session', responseStyle: 'rich' },
    sessionLoadRequestId: 1,
    sessionAssistantStylesBySession: new Map(),
    applySessionRuntimeSnapshot: () => {},
    estimateLocalSessionContextTokens: () => 0,
    browserDisplayMessages: (rows) => rows,
    saveMessagesForActiveScope: save,
    hydrateSessionMedia: hydrate,
    renderMessagesFromStorage: () => painted.push(true),
    noteLongSharedSessionIfDue: () => {},
  };
  // eslint-disable-next-line no-new-func
  const make = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps;
    let messages = [], pendingSteerText = '', loadedSessionContextEstimate = null;
    ${body}
    return { commitFetchedSessionMessages };
  `);
  return { panel: make(deps), painted };
}

const withImage = () => [
  { role: 'user', content: 'Show me.', ts: 100 },
  { role: 'assistant', content: 'Here.', attachments: [{ pathRef: '/tmp/a.png' }] },
];
const setImages = (rows) => {
  for (const row of rows) for (const attachment of row.attachments || []) attachment.dataUrl = IMAGE;
};

test('opening a session paints its history without waiting on slow media or the history write, then repaints late images', async () => {
  let releaseMedia;
  const mediaGate = new Promise((resolve) => { releaseMedia = resolve; });
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const { panel, painted } = build({
    save: () => saveGate,
    hydrate: async (rows) => { await mediaGate; setImages(rows); },
  });
  const rows = withImage();
  let settled = false;
  const commit = panel.commitFetchedSessionMessages({ messages: rows, contextMessages: rows }, { sessionId: 'test-session' })
    .then((value) => { settled = true; return value; });
  await tick(400);
  assert.equal(painted.length, 1, 'the transcript painted while the media read and the write were still pending');
  assert.equal(settled, false, 'the commit still reports the write');
  releaseMedia();
  await tick(20);
  assert.equal(painted.length, 2, 'a late image repaints the transcript once');
  releaseSave();
  assert.equal(await commit, true);
});

test('a fast media read still lands in the first paint, and a failed history write is still reported', async () => {
  const { panel, painted } = build({
    save: async () => { throw new Error('quota'); },
    hydrate: async (rows) => setImages(rows),
  });
  const rows = withImage();
  await assert.rejects(panel.commitFetchedSessionMessages({ messages: rows, contextMessages: rows }, { sessionId: 'test-session' }), /quota/);
  assert.equal(painted.length, 1, 'one paint, with the image already on the record');
});

test('a media read that finds nothing does not repaint, and a failed read never blocks the transcript', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { panel, painted } = build({
    save: async () => undefined,
    hydrate: async () => { await gate; throw new Error('dashboard unreachable'); },
  });
  const rows = withImage();
  assert.equal(await panel.commitFetchedSessionMessages({ messages: rows, contextMessages: rows }, { sessionId: 'test-session' }), true);
  assert.equal(painted.length, 1);
  release();
  await tick(20);
  assert.equal(painted.length, 1, 'nothing was hydrated, so nothing repaints');
});
