import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { firstResolvedImageSource, resolvedGeneratedImageSources } from '../extension/lib/image-render.mjs';

const root = path.resolve(import.meta.dirname, '..');
const html = readFileSync(path.join(root, 'extension', 'app.html'), 'utf8');
const app = readFileSync(path.join(root, 'extension', 'app.js'), 'utf8');
const css = readFileSync(path.join(root, 'extension', 'app.css'), 'utf8');

test('Hermes Web exposes an accessible themed image lightbox and preserves the final image reveal', () => {
  assert.match(html, /<dialog[^>]+id="imageLightbox"/, 'generated images should have an accessible dialog');
  assert.match(html, /data-action="close-image-lightbox"/, 'the dialog should have an explicit close affordance');
  assert.match(html, /data-action="zoom-image-in"/, 'the dialog should expose zoom-in');
  assert.match(html, /data-action="zoom-image-out"/, 'the dialog should expose zoom-out');
  assert.match(html, /data-action="reset-image-zoom"/, 'the dialog should expose reset');
  assert.match(app, /openImageLightbox\(/, 'rendered images should be able to open the dialog');
  assert.match(app, /createImageViewerState/, 'zoom behavior should use the shared bounded viewer state');
  assert.match(app, /animation\.reveal\(/, 'the final generated image must drive the existing diffusion canvas');
  assert.match(app, /await\s+.*reveal/, 'the live run must wait for the reveal before tearing down');
  assert.match(css, /\.image-lightbox/, 'lightbox should receive Hermes theme styling');
  assert.match(css, /\.generated-image-inspect/, 'generated images should expose an inspect affordance');
  assert.match(css, /\.image-lightbox\s*\{[^}]*width:\s*fit-content/s, 'the lightbox should fit portrait media instead of forcing a wide empty canvas');
});

test('Hermes Web renders sent user images and retains them through the immediate history refresh', () => {
  assert.match(app, /appendUserImageAttachments/);
  assert.match(app, /preserveUserImageAttachments/);
  assert.match(app, /appendUserImageAttachments\([\s\S]{0,240}message\.attachments/);
  assert.match(css, /\.user-message-images\s*\{/);
  assert.match(css, /\.user-message-image-open\s*\{/);
});

test('only a safe first generated image source is chosen for the canvas reveal', () => {
  assert.equal(firstResolvedImageSource('Done.\nMEDIA:https://cdn.example.com/final.webp'), 'https://cdn.example.com/final.webp');
  assert.equal(firstResolvedImageSource('MEDIA:javascript:alert(1)'), '');
});

test('generated-image completion keeps every safe MEDIA or Markdown image in one ordered result group', () => {
  const first = 'https://cdn.example.com/first.webp';
  const second = 'https://cdn.example.com/second.png';
  assert.deepEqual(
    resolvedGeneratedImageSources(`Done.\nMEDIA:${first}\n![Second result](${second})\nMEDIA:${first}\nMEDIA:javascript:alert(1)`),
    [first, second],
  );
});
