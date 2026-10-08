import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as effort from '../extension/lib/effort-control.mjs';
import { MODEL_REASONING_EFFORTS } from '../extension/lib/model-runtime-options.mjs';

function setup(value) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const committed = [];
  const root = effort.createEffortControl({ documentRef: dom.window.document, value, onCommit: (next) => committed.push(next) });
  dom.window.document.body.append(root);
  return { dom, root, committed };
}

test('every effort omits the removed incremental release particle field', () => {
  for (const option of MODEL_REASONING_EFFORTS) {
    const { root } = setup(option.value);
    assert.equal(root.querySelector('.effort-control-release, .effort-control-release-particle'), null);
    assert.equal(root.dataset.effortCharge, ['max', 'ultra'].includes(option.value) ? option.value : 'standard');
    assert.equal(root.querySelectorAll('.effort-control-spark').length, 48, 'keep the existing continuous Max/Ultra particle field');
  }
});

test('preview and release still commit effort without generating a burst', () => {
  const { dom, root, committed } = setup('medium');
  const range = root.querySelector('input[type="range"]');
  range.value = '3';
  range.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(committed, []);
  range.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(committed, ['high']);
  assert.equal(root.querySelector('.effort-control-release, .effort-control-release-particle'), null);
  assert.equal(root.dataset.effortCharge, 'standard');
});

test('release emitter API, CSS and picker hookups are removed rather than disabled', () => {
  assert.equal(effort.playEffortRelease, undefined);
  assert.equal(effort.effortReleaseParticleCount, undefined);
  for (const file of ['extension/lib/effort-control.mjs', 'extension/lib/effort-control.css', 'extension/sidepanel.js', 'extension/app.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /playEffortRelease|effortReleaseParticleCount|effort-control-release|effort-release-particle/, file);
  }
});

