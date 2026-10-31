import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { escapeHtml } from '../extension/lib/common.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is not balanced`);
}

test('the bot settings status line is escaped before it reaches innerHTML', () => {
  assert.match(sidepanelSource, /<p class="model-options-note" role="status">\$\{escapeHtml\(roomStatusText\)\}<\/p>/);
  assert.doesNotMatch(sidepanelSource, /role="status">\$\{roomStatusText\}/);
});

test('context breakdown rows never reach innerHTML', () => {
  // Labels and values are set as text, so a gateway or page string cannot inject markup.
  const rows = sidepanelSource.slice(sidepanelSource.indexOf('function renderContextDefinitionRows('), sidepanelSource.indexOf('function contextUsageNode('));
  assert.match(rows, /term\.textContent = label;/);
  assert.match(rows, /detail\.textContent = value;/);
  assert.doesNotMatch(rows, /innerHTML/);
  const card = sidepanelSource.slice(sidepanelSource.indexOf('function renderContextUsageCard('), sidepanelSource.indexOf('\nobserveComposerPopovers();'));
  assert.doesNotMatch(card, /innerHTML/, 'the context card is built with textContent');
  assert.doesNotMatch(sidepanelSource, /<dt>\$\{label\}<\/dt>/);
});

test('custom theme card templates escape the stored theme id in every attribute', () => {
  for (const attribute of ['data-custom-theme-id', 'data-theme', 'data-custom-theme-export', 'data-custom-theme-delete']) {
    assert.doesNotMatch(sidepanelSource, new RegExp(`${attribute}="\\$\\{record\\.id\\}"`), attribute);
  }
  assert.match(sidepanelSource, /data-custom-theme-id="\$\{escapeHtml\(record\.id\)\}"/);
});

test('the classic avatar colour only admits plain CSS colour syntax', () => {
  // The default is declared next to the function; give the sandbox the same one.
  const fallback = /const CLASSIC_SHAPE_DEFAULT_COLOR = '([^']+)'/.exec(sidepanelSource)[1];
  const sandbox = vm.createContext({});
  vm.runInContext(`const CLASSIC_SHAPE_DEFAULT_COLOR = ${JSON.stringify(fallback)};\n${extractFunction(sidepanelSource, 'classicShapeSafeColor')}\nthis.safe = classicShapeSafeColor;`, sandbox);

  for (const ok of ['#ff8800', '#abc', 'hsl(180 68% 58%)', 'rgb(1, 2, 3)', 'rgba(0,0,0,.5)', 'teal']) {
    assert.equal(sandbox.safe(ok), ok);
  }
  for (const bad of ['red" onload="alert(1)', '#fff"/><script>x</script>', 'url(javascript:alert(1))', 'hsl(1 2% 3%)"><circle', '', null]) {
    assert.equal(sandbox.safe(bad), fallback, String(bad));
  }
  assert.equal(escapeHtml('"><x>'), '&quot;&gt;&lt;x&gt;');
});
