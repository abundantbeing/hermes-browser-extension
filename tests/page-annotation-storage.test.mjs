import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_ANNOTATION_STORAGE_KEY,
  clearPageAnnotationSession,
  loadPageAnnotationSession,
  persistPageAnnotationSession,
  pruneExpiredPageAnnotationSessions,
  restorePageAnnotationSession,
} from '../extension/lib/page-annotation-storage.mjs';

function memorySessionStore(initial = {}) {
  const data = { ...initial };
  return {
    async get(key) {
      const name = typeof key === 'string' ? key : Object.keys(key || {})[0];
      return { [name]: data[name] };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      delete data[key];
    },
    snapshot: data,
  };
}

function memoryImages() {
  const blobs = new Map();
  return {
    async put(id, blob) {
      blobs.set(id, blob);
    },
    async get(id) {
      return blobs.get(id) || null;
    },
    async delete(id) {
      blobs.delete(id);
    },
    size: () => blobs.size,
  };
}

const session = {
  schemaVersion: 1,
  sessionId: 'session-a',
  tabId: 7,
  safeUrl: 'https://example.test/page',
  documentKey: 'doc-1',
  nextNumber: 2,
  updatedAt: Date.now(),
  expiresAt: Date.now() + 86_400_000,
  pins: [{
    id: 'annotation-1',
    number: 1,
    kind: 'element',
    note: 'Fix this',
    page: { tabId: 7, safeUrl: 'https://example.test/page', documentKey: 'doc-1', title: 'Page', frameId: 0 },
    target: { selector: 'button', tag: 'button', text: 'Save', html: '<button>Save</button>', css: {} },
    rect: { x: 1, y: 1, width: 10, height: 10 },
    imageRef: 'session-a/annotation-1',
  }],
};

test('storage key is versioned', () => {
  assert.equal(PAGE_ANNOTATION_STORAGE_KEY, 'hermes:pageAnnotationSessions:v1');
});

test('persist and load metadata through session storage', async () => {
  const storageArea = memorySessionStore();
  const images = memoryImages();
  await persistPageAnnotationSession({ storageArea, images, session, imageBlobs: { 'session-a/annotation-1': { type: 'image/png', bytes: [1, 2, 3] } } });
  const loaded = await loadPageAnnotationSession({ storageArea, images, tabId: 7, safeUrl: 'https://example.test/page', documentKey: 'doc-1' });
  assert.equal(loaded.session.sessionId, 'session-a');
  assert.equal(loaded.session.pins[0].note, 'Fix this');
  assert.deepEqual(loaded.images['session-a/annotation-1'].bytes, [1, 2, 3]);
});

test('restore rejects a changed document key as stale', async () => {
  const storageArea = memorySessionStore();
  await persistPageAnnotationSession({ storageArea, images: memoryImages(), session, imageBlobs: {} });
  const restored = await restorePageAnnotationSession({
    storageArea,
    images: memoryImages(),
    tabId: 7,
    safeUrl: 'https://example.test/page',
    documentKey: 'doc-after-reload',
  });
  assert.equal(restored.status, 'stale');
  assert.equal(restored.session.sessionId, 'session-a');
});

test('tab close and TTL prune records', async () => {
  const storageArea = memorySessionStore();
  const images = memoryImages();
  await persistPageAnnotationSession({ storageArea, images, session, imageBlobs: { 'session-a/annotation-1': { bytes: [9] } } });
  await clearPageAnnotationSession({ storageArea, images, tabId: 7 });
  const loaded = await loadPageAnnotationSession({ storageArea, images, tabId: 7, safeUrl: session.safeUrl, documentKey: 'doc-1' });
  assert.equal(loaded.session, null);

  await persistPageAnnotationSession({
    storageArea,
    images,
    session: { ...session, expiresAt: Date.now() - 10 },
    imageBlobs: {},
  });
  const pruned = await pruneExpiredPageAnnotationSessions({ storageArea, images, now: Date.now() });
  assert.equal(pruned, 1);
});

test('malformed metadata does not throw away an in-memory queue', async () => {
  const storageArea = memorySessionStore({ [PAGE_ANNOTATION_STORAGE_KEY]: 'nope' });
  const loaded = await loadPageAnnotationSession({
    storageArea,
    images: memoryImages(),
    tabId: 7,
    safeUrl: session.safeUrl,
    documentKey: 'doc-1',
    fallback: session,
  });
  assert.equal(loaded.session.sessionId, 'session-a');
});
