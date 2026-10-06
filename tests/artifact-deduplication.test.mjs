import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { artifactActionPlan } from '../extension/lib/artifact-actions.mjs';
import { hydrateArtifactCards } from '../extension/lib/artifact-card.mjs';
import { probeArtifactFileSource } from '../extension/lib/media-source.mjs';

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = window;
const { renderMarkdownSafe } = await import('../extension/lib/sanitizer.mjs');
const filePath = 'C:/Reports/review.md';
const buildPlan = async (source) => ({ plan: artifactActionPlan(source, { readable: true }), size: 128 });
function root(html) {
  const element = window.document.createElement('div');
  element.innerHTML = html;
  return element;
}

test('MEDIA tag plus a plain-text mention yields one file card per message', async () => {
  const element = root(renderMarkdownSafe(`Saved to ${filePath}\n\nMEDIA: ${filePath}\n\nThe file is at ${filePath}`));
  await hydrateArtifactCards(element, { buildPlan });
  assert.equal(element.querySelectorAll('.artifact-card').length, 1);
});

test('repeated MEDIA tags and Windows path aliases yield one file card', async () => {
  const element = root(renderMarkdownSafe(`MEDIA: ${filePath}\n\nMEDIA: C:\\Reports\\review.md\n\nMEDIA: c:/reports/REVIEW.md`));
  await hydrateArtifactCards(element, { buildPlan });
  assert.equal(element.querySelectorAll('.artifact-card').length, 1);
});

test('deduplication preserves the same file in separate messages', async () => {
  const element = root(`<article class="message assistant">${renderMarkdownSafe(`MEDIA: ${filePath}\n\nMEDIA: ${filePath}`)}</article>`
    + `<article class="message assistant">${renderMarkdownSafe(`MEDIA: ${filePath}`)}</article>`);
  await hydrateArtifactCards(element, { buildPlan });
  assert.deepEqual([...element.children].map((message) => message.querySelectorAll('.artifact-card').length), [1, 1]);
});

test('overlapping async hydrations do not insert duplicate text-path cards', async () => {
  const element = root(`<p>${filePath}</p><p>${filePath}</p>`);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const delayed = async (source) => { await pending; return buildPlan(source); };
  const first = hydrateArtifactCards(element, { buildPlan: delayed });
  const second = hydrateArtifactCards(element, { buildPlan: delayed });
  release();
  await Promise.all([first, second]);
  assert.equal(element.querySelectorAll('.artifact-card').length, 1);
});

test('successive hydration passes cannot exceed the per-message card limit', async () => {
  const element = root(Array.from({ length: 9 }, (_, i) => `<p>C:/Reports/file-${i}.md</p>`).join(''));
  await hydrateArtifactCards(element, { buildPlan, limit: 6 });
  await hydrateArtifactCards(element, { buildPlan, limit: 6 });
  assert.equal(element.querySelectorAll('.artifact-card').length, 6);
});

test('POSIX paths with distinct case are not merged', async () => {
  const element = root('<p>/reports/Review.md</p><p>/reports/review.md</p>');
  await hydrateArtifactCards(element, { buildPlan });
  assert.equal(element.querySelectorAll('.artifact-card').length, 2);
});

test('ranged readability probe reports total file size, not the one-byte response size', async () => {
  const result = await probeArtifactFileSource(filePath, {
    baseUrl: 'http://127.0.0.1:9119',
    fetchImpl: async (_url, options) => options.method === 'HEAD'
      ? { ok: false, status: 405 }
      : { ok: true, status: 206, headers: { get: (name) => ({ 'content-length': '1', 'content-range': 'bytes 0-0/14484' })[name] ?? null }, body: { cancel: async () => {} } },
  });
  assert.equal(result.size, 14484);
});
