import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FONT_CHECK_CSS_FILES,
  checkReferencedFonts,
  collectReferencedFontPaths,
  referencedFontsInCss,
  resolveFontReference,
} from '../scripts/check-referenced-fonts.mjs';

test('resolveFontReference resolves paths relative to the CSS file', () => {
  const css = path.join('/tmp/ext/lib/design-tokens.css');
  assert.equal(
    resolveFontReference(css, '../assets/fonts/RulesVariable.woff2'),
    path.normalize('/tmp/ext/assets/fonts/RulesVariable.woff2'),
  );
});

test('referencedFontsInCss ignores remote and data urls', () => {
  const cssPath = path.join('/tmp/ext/sidepanel.css');
  const source = '@font-face { src: url("assets/fonts/local.woff2"); } @font-face { src: url(https://evil.example/x.woff2); }';
  const rows = referencedFontsInCss(source, cssPath);
  assert.equal(rows.length, 1);
  assert.match(rows[0].absolutePath, /local\.woff2$/);
});

test('collectReferencedFontPaths lists every Rules face referenced in CSS', () => {
  const rows = collectReferencedFontPaths({ root: path.resolve(import.meta.dirname, '..') });
  const rules = rows
    .map((row) => path.basename(row.absolutePath))
    .filter((name) => name.startsWith('Rules'))
    .sort();
  assert.deepEqual(rules, [
    'RulesCompressed-Medium.woff2',
    'RulesGothicCmp-Medium.woff2',
    'RulesGothicCmp-Medium.woff2',
    'RulesVariable.woff2',
    'RulesVariable.woff2',
    'RulesVariable.woff2',
  ]);
  for (const relativeCss of FONT_CHECK_CSS_FILES) {
    assert.ok(rows.some((row) => row.cssFile === relativeCss), `${relativeCss} is scanned`);
  }
});

test('checkReferencedFonts passes on the real tree', () => {
  const result = checkReferencedFonts({ root: path.resolve(import.meta.dirname, '..') });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

test('checkReferencedFonts fails when a referenced file is missing', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-font-check-'));
  const extensionDir = path.join(tempRoot, 'extension');
  fs.mkdirSync(path.join(extensionDir, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(extensionDir, 'sidepanel.css'), '@font-face { src: url("assets/fonts/Missing.woff2"); }');
  assert.throws(
    () => checkReferencedFonts({ root: tempRoot, cssFiles: ['extension/sidepanel.css'] }),
    /Missing\.woff2/,
  );
});

test('checkReferencedFonts honors HERMES_SKIP_FONT_CHECK', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-font-check-skip-'));
  const extensionDir = path.join(tempRoot, 'extension');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, 'sidepanel.css'), '@font-face { src: url("assets/fonts/Missing.woff2"); }');
  const previous = process.env.HERMES_SKIP_FONT_CHECK;
  process.env.HERMES_SKIP_FONT_CHECK = '1';
  try {
    const result = checkReferencedFonts({ root: tempRoot, cssFiles: ['extension/sidepanel.css'] });
    assert.equal(result.skipped, true);
  } finally {
    if (previous === undefined) delete process.env.HERMES_SKIP_FONT_CHECK;
    else process.env.HERMES_SKIP_FONT_CHECK = previous;
  }
});
