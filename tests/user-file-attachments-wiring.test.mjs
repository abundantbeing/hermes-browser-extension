import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const [panel, panelHtml, draft, image] = await Promise.all([
  'extension/sidepanel.js', 'extension/sidepanel.html',
  'extension/lib/composer-draft.mjs', 'extension/lib/image-render.mjs',
].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')));

test('the side panel retains original files and render Open/Download alongside existing images', () => {
  for (const source of [panel]) {
    assert.match(source, /createUserFileAttachment\(file\)/);
    assert.match(source, /appendUserFileAttachments\(/);
    assert.match(source, /appendUserImageAttachments\(/);
    assert.match(source, /openUserFileAttachment\(/);
    assert.match(source, /downloadUserFileAttachment\(/);
    assert.match(source, /restoreUserFileAttachments\(/);
    assert.match(source, /fileHistoryRestoreGeneration/);
  }
  assert.doesNotMatch(panel, /attached as metadata only/);
});

test('generic staging precedes WS submission and failure preserves the draft without sending metadata', () => {
  for (const source of [panel]) {
    assert.match(source, /stageUserFiles\(/);
    assert.match(source, /rememberUserFileAttachments\(/);
    assert.match(source, /error\?\.attachmentFailure/);
    assert.match(source, /attachments = \[\.\.\.turnAttachments\]/);
    assert.match(source, /attachments\.upload_unavailable/);
  }
});

test('draft and history reconciliation retain generic blob refs without removing image support', () => {
  assert.match(draft, /blobId: String\(attachment\.blobId/);
  assert.match(image, /normalizeUserFileAttachments\(message\.attachments\)/);
  assert.match(image, /normalizeUserImageAttachments\(message\.attachments\)/);
});

test('shared file styling loads in the side panel and local media is permitted without remote scripts', () => {
  assert.match(panelHtml, /lib\/user-file-attachments\.css/);
  assert.match(panelHtml, /media-src 'self' blob:/);
  assert.doesNotMatch(panelHtml, /script-src[^;]*blob:/);
});
