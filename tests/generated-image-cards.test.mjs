import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rawGeneratedImageCandidatesFromResult,
  resolvedGeneratedImageSourcesFromResult,
} from '../extension/lib/image-render.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('raw image_generate candidates keep local paths so the panel can resolve them', () => {
  const result = {
    success: true,
    host_image: 'C:\\Users\\Jaybo\\.hermes\\cache\\images\\openai_codex_gpt-image-2-medium_20260912_013049_73cd7a08.png',
    agent_visible_image: 'C:\\Users\\Jaybo\\.hermes\\cache\\images\\openai_codex_gpt-image-2-medium_20260912_012924_5a8fa171.png',
  };
  assert.deepEqual(rawGeneratedImageCandidatesFromResult(result), [
    'C:\\Users\\Jaybo\\.hermes\\cache\\images\\openai_codex_gpt-image-2-medium_20260912_013049_73cd7a08.png',
    'C:\\Users\\Jaybo\\.hermes\\cache\\images\\openai_codex_gpt-image-2-medium_20260912_012924_5a8fa171.png',
  ]);
  // The browser-safe resolver still refuses local paths — that is why the panel
  // needs the raw candidate list plus the dashboard media route.
  assert.deepEqual(resolvedGeneratedImageSourcesFromResult(result), []);
});

test('raw image_generate candidates drop non-images, duplicates, and failures', () => {
  assert.deepEqual(rawGeneratedImageCandidatesFromResult({ success: true, host_image: 'C:\\tmp\\notes.txt' }), []);
  assert.deepEqual(rawGeneratedImageCandidatesFromResult({ success: false, host_image: 'C:\\tmp\\a.png' }), []);
  assert.deepEqual(
    rawGeneratedImageCandidatesFromResult({ success: true, host_image: 'https://cdn.example/a.png', image: 'https://cdn.example/a.png' }),
    ['https://cdn.example/a.png'],
  );
  assert.deepEqual(rawGeneratedImageCandidatesFromResult(null), []);
});

test('a finished generation dissolves into the real picture via the dashboard media route', () => {
  assert.match(sidepanelSource, /async function resolveGeneratedImageSource\(source = ''\)/);
  assert.match(sidepanelSource, /const plan = mediaSourcePlan\(text\);/);
  assert.match(sidepanelSource, /if \(plan\.transport !== 'dashboard-media'\) return '';/);
  assert.match(sidepanelSource, /await fetchDashboardMediaDataUrl\(\{ baseUrl, filePath: text, token \}\)/);
  // The reveal resolves first, so a local cache path can actually decode.
  assert.match(
    sidepanelSource,
    /async function revealGeneratedImage\(placeholder, source = ''\) \{[\s\S]{0,200}?const displayable = await resolveGeneratedImageSource\(source\);\s*if \(!displayable\) return false;\s*const image = await loadGeneratedImageForReveal\(displayable\);/,
  );
});

test('every picture from one tool call gets a card, not just the first', () => {
  assert.match(sidepanelSource, /async function revealGeneratedImages\(node, placeholder, sources = \[\]\)/);
  assert.match(sidepanelSource, /function appendGeneratedImageCards\(node, sources = \[\]\)/);
  assert.match(sidepanelSource, /const \[first, \.\.\.rest\] = queue;/);
  assert.match(sidepanelSource, /if \(rest\.length\) appendGeneratedImageCards\(node, rest\);/);
  // Every live tool-activity path now hands over every candidate: the two
  // setToolActivity reveal sites plus the streaming tool callback.
  assert.equal(
    (sidepanelSource.match(/rawGeneratedImageCandidatesFromResult\(activity\.result\)/g) || []).length,
    3,
  );
  assert.doesNotMatch(sidepanelSource, /resolvedGeneratedImageSourcesFromResult\(activity\.result\)\[0\]/);
  // A recovered multi-image turn appends the extras too.
  assert.match(sidepanelSource, /if \(imageSources\.length > 1\) appendGeneratedImageCards\(node, imageSources\.slice\(1\)\);/);
});

test('hydrated and generated pictures share the same inspect affordance', () => {
  assert.match(sidepanelSource, /function wrapGeneratedImagesForInspection\(root\)/);
  assert.match(sidepanelSource, /wrapGeneratedImagesForInspection\(element\);\s*\n\s*void hydrateSessionMediaInElement\(element\);/);
  assert.match(sidepanelSource, /node\.replaceWith\(figure\);\s*\n\s*wrapGeneratedImagesForInspection\(figure\.parentElement \|\| figure\);/);
});

test('extra generated-image cards dissolve in and respect reduced motion', () => {
  assert.match(cssSource, /\.generated-image-card \{/);
  assert.match(cssSource, /\.generated-image-card \.generated-image-card-name \{/);
  assert.match(cssSource, /\.generated-image-card\.generated-image-card-revealed \{/);
  assert.match(cssSource, /@keyframes generated-image-card-dissolve \{/);
  assert.match(cssSource, /@keyframes generated-image-card-scan \{/);
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.generated-image-card img,\s*\.generated-image-card\.generated-image-card-revealed::after \{ animation: none; \}/,
  );
});
