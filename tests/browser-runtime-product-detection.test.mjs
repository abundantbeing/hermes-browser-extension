import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { detectBrowserProduct } from '../extension/lib/browser-runtime.mjs';

test('Headless Chrome remains a truthful generic Chromium product when extension scheme is ambiguous', () => {
  const product = detectBrowserProduct({
    userAgent: 'Mozilla/5.0 HeadlessChrome/151.0.7922.76 Safari/537.36',
    brands: [{ brand: 'Chromium', version: '151' }],
    extensionUrl: 'chrome-extension://fixture/',
  });
  assert.deepEqual(product, {
    id: 'chromium',
    label: 'Chromium browser',
    engine: 'chromium',
    confidence: 'masked',
    source: 'engine-only',
  });
});

test('background passes live runtime identity hints into browser product detection', () => {
  const source = readFileSync('extension/background.js', 'utf8');
  const call = source.match(/const browserProduct = detectBrowserProduct\([\s\S]*?\);/)?.[0] || '';
  assert.match(call, /userAgent:/);
  assert.match(call, /brands:/);
  assert.match(call, /extensionUrl:/);
});
