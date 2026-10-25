import assert from 'node:assert/strict';
import test from 'node:test';
import { firstResolvedImageSource, resolvedGeneratedImageSources } from '../extension/lib/image-render.mjs';

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
