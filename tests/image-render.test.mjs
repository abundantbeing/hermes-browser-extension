import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderMarkdown } from '../extension/lib/common.mjs';
import * as imageRender from '../extension/lib/image-render.mjs';

const {
  extractMediaTags,
  resolveImageSource,
  stripGeneratedImageEchoes,
} = imageRender;

const TRANSPARENT_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';

test('image rendering helpers exist as a dedicated safe module', () => {
  assert.ok(existsSync(new URL('../extension/lib/image-render.mjs', import.meta.url)));
});

test('image helpers accept only safe remote or raster data image sources', () => {
  assert.equal(resolveImageSource(TRANSPARENT_PNG_DATA_URL), TRANSPARENT_PNG_DATA_URL);
  assert.equal(resolveImageSource('https://example.com/image.webp'), 'https://example.com/image.webp');
  assert.equal(resolveImageSource('http://example.com/image.webp'), null);
  assert.equal(resolveImageSource('file:///C:/Users/Jaybo/image.png'), null);
  assert.equal(resolveImageSource('data:image/svg+xml;base64,PHN2Zy8+'), null);
  assert.equal(resolveImageSource('javascript:alert(1)'), null);
});

test('user image attachments normalize into safe renderable message previews', () => {
  assert.equal(typeof imageRender.normalizeUserImageAttachments, 'function');
  assert.deepEqual(imageRender.normalizeUserImageAttachments([
    { kind: 'image', name: 'image.png', dataUrl: TRANSPARENT_PNG_DATA_URL },
    { kind: 'image', name: 'unsafe.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { kind: 'file', name: 'notes.txt', text: 'hello' },
  ]), [{
    name: 'image.png',
    source: TRANSPARENT_PNG_DATA_URL,
  }]);
});

test('refreshed user messages retain matching live image previews without serializing them into transcript text', () => {
  assert.equal(typeof imageRender.preserveUserImageAttachments, 'function');
  const local = [
    { role: 'user', content: 'What is in this image?', attachments: [{ kind: 'image', name: 'image.png', dataUrl: TRANSPARENT_PNG_DATA_URL }] },
    { role: 'assistant', content: 'A blue square' },
  ];
  const refreshed = [
    { id: 10, role: 'user', content: 'What is in this image?' },
    { id: 11, role: 'assistant', content: 'A blue square' },
  ];

  const merged = imageRender.preserveUserImageAttachments(refreshed, local);

  assert.equal(merged[0].id, 10);
  assert.deepEqual(merged[0].attachments, local[0].attachments);
  assert.doesNotMatch(merged[0].content, /data:image/);
  assert.notEqual(merged[0], refreshed[0]);
  assert.equal(merged[1], refreshed[1]);
});

test('repeated identical user prompts retain image previews in chronological order', () => {
  const newerSource = 'https://example.com/newer.png';
  const local = [
    { role: 'user', content: 'Describe this', attachments: [{ kind: 'image', name: 'older.png', dataUrl: TRANSPARENT_PNG_DATA_URL }] },
    { role: 'assistant', content: 'Older answer' },
    { role: 'user', content: 'Describe this', attachments: [{ kind: 'image', name: 'newer.png', dataUrl: newerSource }] },
  ];
  const refreshed = [
    { id: 20, role: 'user', content: 'Describe this' },
    { id: 21, role: 'assistant', content: 'Older answer' },
    { id: 22, role: 'user', content: 'Describe this' },
  ];

  const merged = imageRender.preserveUserImageAttachments(refreshed, local);

  assert.equal(merged[0].attachments[0].name, 'older.png');
  assert.equal(merged[2].attachments[0].name, 'newer.png');
});

test('image helpers extract standalone MEDIA tags and remove only image echoes', () => {
  const source = 'https://example.com/generated.png';
  const extracted = extractMediaTags(`Image complete\nMEDIA:${source}\nKeep this caption.`);
  assert.deepEqual(extracted.media, [{ source, raw: `MEDIA:${source}` }]);
  assert.equal(extracted.text, 'Image complete\nKeep this caption.');
  assert.equal(stripGeneratedImageEchoes(`![Image](${source})\nMEDIA:${source}\nCaption`, [source]), 'Caption');
});

test('image echo stripping handles persisted multi-megabyte data URLs without constructing an oversized regular expression', () => {
  const source = `data:image/png;base64,${'A'.repeat(3_200_000)}`;
  const message = `Generated successfully.\n\n![image](${source})`;

  assert.doesNotThrow(() => stripGeneratedImageEchoes(message, [source]));
  assert.equal(stripGeneratedImageEchoes(message, [source]), 'Generated successfully.');
});

test('renderMarkdown renders an API-delivered generated image data URL inline', () => {
  const html = renderMarkdown(`![Generated image](${TRANSPARENT_PNG_DATA_URL})`);

  assert.match(html, /<figure class="generated-image"/);
  assert.match(html, /data-slot="aui_generated-image"/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,/);
  assert.match(html, /alt="Generated image"/);
});

test('renderMarkdown renders a standalone remote MEDIA tag as a generated image', () => {
  const html = renderMarkdown('MEDIA:https://example.com/generated-image.webp');

  assert.match(html, /<figure class="generated-image"/);
  assert.match(html, /src="https:\/\/example\.com\/generated-image\.webp"/);
});

test('renderMarkdown hides an unresolved local MEDIA path instead of emitting a broken image or file path', () => {
  const html = renderMarkdown('MEDIA:C:\\Users\\Jaybo\\.hermes\\cache\\images\\generated.png');

  assert.match(html, /generated-image-unavailable/);
  assert.doesNotMatch(html, /C:\\Users\\Jaybo/);
  assert.doesNotMatch(html, /<img/);
});
