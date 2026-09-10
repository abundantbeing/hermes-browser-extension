import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COMPOSER_DRAFT_MAX_BYTES,
  clearComposerDraft,
  composerDraftIsEmpty,
  composerDraftStorageKey,
  loadComposerDraft,
  persistComposerDraft,
  serializeComposerAttachment,
  serializeComposerDraft,
} from '../extension/lib/composer-draft.mjs';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
    dump() {
      return { ...data };
    },
  };
}

test('composer draft storage key is namespaced per panel instance', () => {
  assert.equal(composerDraftStorageKey('abc'), 'hermesBrowserComposerDraft:abc');
  assert.equal(composerDraftStorageKey(''), 'hermesBrowserComposerDraft:default');
});

test('serializeComposerAttachment keeps path metadata and drops dataUrl when a local path exists', () => {
  const saved = serializeComposerAttachment({
    id: 'image:shot.png',
    kind: 'image',
    label: 'Gregorio.png',
    detail: 'image/png · 1.6 MB',
    dataUrl: `data:image/png;base64,${'A'.repeat(80)}`,
    localPath: 'C:/Users/Jaybo/AppData/Roaming/Hermes/composer-images/Gregorio_9f5f04.png',
    savedFilename: 'Gregorio_9f5f04.png',
  });
  assert.equal(saved.localPath.endsWith('Gregorio_9f5f04.png'), true);
  assert.equal(saved.label, 'Gregorio.png');
  assert.equal(saved.dataUrl, undefined);
});

test('serializeComposerDraft stores composer text and file text, not giant image blobs by default', () => {
  const draft = serializeComposerDraft({
    text: 'look at this',
    attachments: [
      { id: 'file:notes.txt', kind: 'file', label: 'notes.txt', text: 'hello' },
      { id: 'image:shot.png', kind: 'image', label: 'shot.png', dataUrl: `data:image/png;base64,${'B'.repeat(COMPOSER_DRAFT_MAX_BYTES)}` },
    ],
  });
  assert.equal(draft.version, 1);
  assert.equal(draft.text, 'look at this');
  assert.equal(draft.attachments[0].text, 'hello');
  assert.equal(draft.attachments[1].dataUrl, undefined);
  assert.equal(composerDraftIsEmpty(draft), false);
  assert.equal(composerDraftIsEmpty({ text: '  ', attachments: [] }), true);
});

test('persistComposerDraft writes a restorable snapshot and clears storage when the composer is empty', () => {
  const storage = memoryStorage();
  const result = persistComposerDraft(storage, {
    instanceId: 'panel-1',
    text: 'draft me',
    attachments: [{
      id: 'image:shot.png',
      kind: 'image',
      label: 'shot.png',
      localPath: 'C:/tmp/shot.png',
      dataUrl: 'data:image/png;base64,AAAA',
    }],
  });
  assert.equal(result.ok, true);
  const loaded = loadComposerDraft(storage, { instanceId: 'panel-1' });
  assert.equal(loaded.text, 'draft me');
  assert.equal(loaded.attachments.length, 1);
  assert.equal(loaded.attachments[0].localPath, 'C:/tmp/shot.png');
  assert.equal(loaded.attachments[0].dataUrl, undefined);

  const cleared = persistComposerDraft(storage, { instanceId: 'panel-1', text: '', attachments: [] });
  assert.equal(cleared.cleared, true);
  assert.equal(loadComposerDraft(storage, { instanceId: 'panel-1' }), null);
  assert.equal(clearComposerDraft(storage, { instanceId: 'panel-1' }), true);
});

test('persistComposerDraft slims oversized payloads instead of throwing', () => {
  const storage = memoryStorage();
  const huge = `data:image/png;base64,${'C'.repeat(COMPOSER_DRAFT_MAX_BYTES)}`;
  const result = persistComposerDraft(storage, {
    instanceId: 'panel-1',
    text: 'keep me',
    attachments: [{
      id: 'image:huge.png',
      kind: 'image',
      label: 'huge.png',
      localPath: 'C:/tmp/huge.png',
      dataUrl: huge,
    }],
  });
  assert.equal(result.ok, true);
  const raw = storage.getItem(composerDraftStorageKey('panel-1'));
  assert.ok(raw.length < COMPOSER_DRAFT_MAX_BYTES);
  assert.equal(loadComposerDraft(storage, { instanceId: 'panel-1' }).text, 'keep me');
});

test('loadComposerDraft returns null for missing or corrupt storage', () => {
  const storage = memoryStorage({ [composerDraftStorageKey('panel-1')]: '{not-json' });
  assert.equal(loadComposerDraft(storage, { instanceId: 'panel-1' }), null);
  assert.equal(loadComposerDraft(storage, { instanceId: 'missing' }), null);
  assert.equal(loadComposerDraft(null, { instanceId: 'panel-1' }), null);
});

test('sidepanel restores and persists composer drafts through sessionStorage', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/lib\/composer-draft\.mjs'/);
  assert.match(source, /function persistCurrentComposerDraft\(/);
  assert.match(source, /function restoreComposerDraft\(/);
  assert.match(source, /persistCurrentComposerDraft\(/);
  assert.match(source, /restoreComposerDraft\(/);
  assert.match(source, /clearComposerDraft\(/);
  assert.match(source, /ensureImageAttachmentsSaved\(\)/);
  assert.match(source, /els\.input\.addEventListener\('input', \(\) => \{[\s\S]*persistCurrentComposerDraft\(/);
});

test('web composer persists drafts the same way as the side panel', async () => {
  const source = await readFile(new URL('../extension/app.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/lib\/composer-draft\.mjs'/);
  assert.match(source, /function persistCurrentComposerDraft\(/);
  assert.match(source, /function restoreComposerDraft\(/);
  assert.match(source, /restoreComposerDraft\(/);
  assert.match(source, /clearComposerDraft\(/);
});
