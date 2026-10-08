import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync('extension/sidepanel.css', 'utf8');
const source = readFileSync('extension/sidepanel.js', 'utf8');

test('only the prompt reserves enough bottom padding for the overlaid controls', () => {
  const block = css.match(/#promptInput\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(block, /padding-bottom:\s*44px;/);
  assert.match(css, /textarea\s*\{[^}]*resize:\s*vertical;[^}]*max-height:\s*28vh;/);
  assert.match(css, /\.composer-input-wrap::before\s*\{[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.composer-input-wrap::before\s*\{[^}]*background:\s*var\(--hermes-input-bg, var\(--hermes-paper\)\);/, 'the strip is solid when nothing is scrolled under it');
  const glass = css.match(/\.composer-input-wrap\.composer-text-below::before\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(glass, /backdrop-filter:\s*blur\(var\(--composer-glass-blur\)\)/, 'scrolled-up drafts frost under the controls');
  assert.match(glass, /var\(--composer-glass-tint\)/);
  assert.match(css, /prefers-reduced-transparency: reduce[^{]*\{\s*\.composer-input-wrap\.composer-text-below::before\s*\{[^}]*backdrop-filter:\s*none;/);
});

test('the composer input handler synchronizes height and caret after a user edit', () => {
  const handler = source.match(/els\.input\.addEventListener\('input',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/)?.[1] || '';
  assert.match(handler, /syncComposerFrame\(/);
});

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.slice(start + 1).search(/\n(?:async )?function |\n\/\* ─|\nclass /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

test('both voice transcript paths move the selection to the transcript end and synchronize', () => {
  for (const name of ['insertExternalVoiceTranscript', 'applyDictationTranscript']) {
    const body = functionBody(name);
    assert.match(body, /setSelectionRange\(els\.input\.value\.length, els\.input\.value\.length\)/, name);
    assert.match(body, /syncComposerFrame\(/, name);
  }
});

test('the prompt is synchronized after boot, and value changes in render paths are covered', () => {
  assert.match(source.slice(source.indexOf('await initI18n();')), /syncComposerFrame\(/);
  for (const name of ['updateComposerBusyState', 'renderContextWindow']) {
    assert.match(functionBody(name), /syncComposerFrame\(/, name);
  }
});
