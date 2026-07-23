import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('generated images open in an accessible lightbox with a download action', () => {
  assert.match(sidepanelSource, /function openGeneratedImageLightbox/);
  assert.match(sidepanelSource, /generated-image-lightbox/);
  assert.match(sidepanelSource, /download/);
  assert.match(sidepanelSource, /download\.target = '_blank'/);
  assert.match(sidepanelSource, /download\.rel = 'noopener noreferrer'/);
  assert.match(sidepanelSource, /els\.messages\.addEventListener\('click'/);
});

test('side-panel user image attachments render inside the sent user message', () => {
  assert.match(sidepanelSource, /appendUserImageAttachments/);
  assert.match(sidepanelSource, /appendUserImageAttachments\([\s\S]{0,240}preparedAttachments/);
  assert.match(cssSource, /\.user-message-images\s*\{/);
  assert.match(cssSource, /\.user-message-image-open\s*\{/);
});

test('generated image result is handed to the existing animation before final inline rendering', () => {
  assert.match(sidepanelSource, /revealGeneratedImageFromContent/);
  assert.match(sidepanelSource, /activeImageGenerationPlaceholder/);
  assert.match(sidepanelSource, /extractRenderableImageSource/);
  assert.match(sidepanelSource, /placeholder\._reveal/);
  assert.match(sidepanelSource, /generated-image-revealing/);
  assert.match(sidepanelSource, /naturalWidth\s*\/\s*image\.naturalHeight/);
  assert.match(cssSource, /\.generated-image-reveal-source/);
  assert.match(cssSource, /\.image-gen-placeholder\.generated-image-revealing/);
});

test('follow-up non-image tool events preserve an active image placeholder until its final reveal', () => {
  assert.match(
    sidepanelSource,
    /if \(existingImage && !isImageGeneration\) \{\s*return;\s*\}/s,
  );
  assert.match(sidepanelSource, /existingImage\?\._dispose\?\.\(\);/);
  assert.match(sidepanelSource, /await revealPromise;/);
});

test('placeholder and final image support landscape square portrait and natural dimensions', () => {
  assert.match(cssSource, /\.image-gen-placeholder-square\s*\{[^}]*aspect-ratio:\s*1/s);
  assert.match(cssSource, /\.image-gen-placeholder-portrait\s*\{[^}]*aspect-ratio:\s*9\s*\/\s*16/s);
  assert.match(sidepanelSource, /style\.aspectRatio\s*=\s*String\(naturalRatio\)/);
  assert.match(sidepanelSource, /--image-gen-natural-ratio/);
});

test('generated-image and seeded VHS diffusion styles are responsive and motion-safe', () => {
  assert.match(cssSource, /\.generated-image\s*\{/);
  assert.match(cssSource, /\.generated-image img\s*\{/);
  assert.match(cssSource, /\.image-gen-placeholder\s*\{/);
  assert.match(cssSource, /\.image-gen-diffusion-canvas\s*\{/);
  assert.match(cssSource, /\.image-gen-vhs\s*\{/);
  assert.match(cssSource, /\.image-gen-vhs::before/);
  assert.match(cssSource, /\.image-gen-vhs::after/);
  assert.match(cssSource, /repeating-linear-gradient/);
  assert.match(cssSource, /steps\(/);
  assert.match(cssSource, /imageGenVhsTracking/);
  assert.match(cssSource, /imageGenVhsDropout/);
  assert.doesNotMatch(cssSource, /image-gen-reticle|image-gen-scanline/);
  assert.match(cssSource, /\.generated-image-lightbox\s*\{/);
  assert.match(cssSource, /prefers-reduced-motion: reduce/);
});
