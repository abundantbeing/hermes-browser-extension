import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

test('production side panel exposes one explicit Gmail thread-capture action', () => {
  const html = read('extension/sidepanel.html');
  const source = read('extension/sidepanel.js');
  const css = read('extension/sidepanel.css');

  assert.match(html, /id="explicitSiteCaptureButton"[\s\S]*?hidden[\s\S]*?Capture visible Gmail thread/);
  assert.match(source, /import \{ explicitSiteCaptureAction \} from '\.\/lib\/site-adapters\.mjs';/);
  assert.match(source, /function getPageContext\(tab, options = \{\}\)/);
  assert.match(source, /explicitSiteCapture:\s*Boolean\(options\.explicitSiteCapture\)/);
  assert.match(source, /function refreshContext\(options = \{\}\)/);
  assert.match(source, /getPageContext\(tab, options\)/);
  assert.match(source, /function refreshContextWithSpin\(options = \{\}\)/);
  assert.match(source, /await refreshContext\(options\)/);
  assert.match(
    source,
    /els\.explicitSiteCaptureButton\?\.addEventListener\('click',[\s\S]*?refreshContextWithSpin\(\{ explicitSiteCapture: true \}\)/,
  );
  assert.match(css, /\.context-explicit-capture/);
});

test('normal context refresh remains metadata-only', () => {
  const source = read('extension/sidepanel.js');
  const handler = source.match(/els\.refreshButton\.addEventListener\('click', \(\) => \{[\s\S]*?\n\x20{2}\}\);/)?.[0] || '';
  assert.match(handler, /refreshContextWithSpin\(\)/);
  assert.doesNotMatch(handler, /explicitSiteCapture/);
});
