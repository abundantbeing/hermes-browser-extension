import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVscodeThemeFamily,
  convertVscodeColorTheme,
  parseVscodeTheme,
  vscodeThemeSlug,
} from '../extension/lib/vscode-theme-convert.mjs';
import { contrastRatio, validateThemeDocument } from '../extension/lib/custom-themes.mjs';

const REQUIRED_KEYS = [
  'canvas', 'paper', 'ink', 'muted', 'primary', 'primaryDeep', 'onPrimary',
  'accent', 'onAccent', 'line', 'input', 'danger', 'onDanger', 'shellForeground',
];

const sparseDark = {
  name: 'Sparse Dark',
  type: 'dark',
  colors: {
    'editor.background': '#101218',
    'editor.foreground': '#f4f5f7',
    'button.background': '#4f5bd5',
  },
};

function assertValidPalette(palette) {
  assert.deepEqual(Object.keys(palette).sort(), [...REQUIRED_KEYS].sort());
  for (const value of Object.values(palette)) assert.match(value, /^#[0-9a-f]{6}$/);
}

test('vscodeThemeSlug normalizes labels and falls back safely', () => {
  assert.equal(vscodeThemeSlug('  One Dark Pro!! '), 'vsc-one-dark-pro');
  assert.equal(vscodeThemeSlug('—'), 'vsc-theme');
  assert.ok(vscodeThemeSlug('x'.repeat(100)).length <= 52);
});

test('stateful JSONC parsing removes comments and trailing commas', () => {
  const parsed = parseVscodeTheme(`{
    // line comment
    "name": "Demo",
    /* block comment */
    "type": "dark",
    "colors": { "editor.background": "#101010", },
  }`);
  assert.equal(parsed.name, 'Demo');
  assert.equal(parsed.colors['editor.background'], '#101010');
});

test('JSONC parsing preserves comment-like text, escaped quotes, and backslashes inside strings', () => {
  const parsed = parseVscodeTheme(String.raw`{
    "name": "https://example.com/a/*literal*/?q=//keep",
    "description": "quote: \" and path C:\\themes\\demo",
    "colors": {"editor.background":"#ffffff"}
  }`);
  assert.equal(parsed.name, 'https://example.com/a/*literal*/?q=//keep');
  assert.equal(parsed.description, 'quote: " and path C:\\themes\\demo');
});

test('JSONC parsing rejects unterminated strings and comments with stable codes', () => {
  assert.throws(() => parseVscodeTheme('{"name":"oops}'), (error) => error.code === 'jsonc-unterminated-string');
  assert.throws(() => parseVscodeTheme('{/* nope'), (error) => error.code === 'jsonc-unterminated-block-comment');
  assert.throws(() => parseVscodeTheme('{// nope'), (error) => error.code === 'jsonc-unterminated-line-comment');
});

test('JSONC parsing requires a plain object', () => {
  assert.throws(() => parseVscodeTheme('42'), (error) => error.code === 'invalid-theme-json');
  assert.throws(() => parseVscodeTheme('[]'), (error) => error.code === 'invalid-theme-json');
});

test('conversion maps dark source tokens into a complete Phase 2-valid palette', () => {
  const result = convertVscodeColorTheme({
    name: 'Dracula',
    type: 'dark',
    colors: {
      'editor.background': '#282a36',
      'editor.foreground': '#f8f8f2',
      'button.background': '#bd93f9',
      'editorWidget.background': '#21222c',
      'sideBar.background': '#21222c',
      'panel.border': '#6272a4',
      'input.background': '#343746',
      'editorError.foreground': '#ff5555',
    },
  }, { sourceId: 'dracula-theme.theme-dracula' });

  assert.equal(result.mode, 'dark');
  assert.equal(result.document.name, 'Dracula');
  assert.match(result.document.description, /dracula-theme\.theme-dracula/);
  assertValidPalette(result.palette);
  assert.equal(validateThemeDocument(result.document).valid, true);
});

test('conversion derives light or dark mode from explicit type before luminance', () => {
  assert.equal(convertVscodeColorTheme({ ...sparseDark, type: 'light' }).mode, 'light');
  assert.equal(convertVscodeColorTheme({ ...sparseDark, type: 'hc-black' }).mode, 'dark');
  assert.equal(convertVscodeColorTheme({ ...sparseDark, type: undefined }).mode, 'dark');
  assert.equal(convertVscodeColorTheme({ name: 'Bright', colors: { 'editor.background': '#ffffff' } }).mode, 'light');
});

test('conversion deterministically derives sparse colors and discloses every derived semantic key', () => {
  const first = convertVscodeColorTheme(sparseDark);
  const second = convertVscodeColorTheme(structuredClone(sparseDark));
  assert.deepEqual(first, second);
  assertValidPalette(first.palette);
  for (const key of ['paper', 'muted', 'primaryDeep', 'accent', 'line', 'input', 'danger']) {
    assert.ok(first.derived.includes(key), `expected ${key} to be disclosed as derived`);
  }
});

test('conversion flattens supported alpha colors over the source canvas', () => {
  const result = convertVscodeColorTheme({
    name: 'Alpha',
    type: 'dark',
    colors: {
      'editor.background': '#202020',
      'editor.foreground': '#ffffff',
      'panel.border': '#ff000080',
    },
  });
  assert.match(result.palette.line, /^#[0-9a-f]{6}$/);
  assert.notEqual(result.palette.line, '#ff000080');
});

test('contrast repair meets all Phase 2 hard pairs and discloses adjusted tokens', () => {
  const result = convertVscodeColorTheme({
    name: 'Low Contrast',
    type: 'light',
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#eeeeee',
      'button.background': '#f5f5f5',
      'panel.border': '#fafafa',
      'editorError.foreground': '#ffdddd',
    },
  });
  const p = result.palette;
  assert.ok(contrastRatio(p.ink, p.canvas) >= 4.5);
  assert.ok(contrastRatio(p.muted, p.canvas) >= 4.5);
  assert.ok(contrastRatio(p.onPrimary, p.primary) >= 4.5);
  assert.ok(contrastRatio(p.line, p.canvas) >= 3);
  assert.ok(contrastRatio(p.danger, p.canvas) >= 4.5);
  assert.ok(result.adjusted.length > 0);
  assert.equal(validateThemeDocument(result.document).valid, true);
});

test('single variant fills both Phase 2 palettes', () => {
  const result = buildVscodeThemeFamily([{ label: 'Only', uiTheme: 'vs-dark', contents: JSON.stringify(sparseDark) }], {
    displayName: 'Only Family', sourceId: 'demo.only',
  });
  assert.deepEqual(result.document.darkColors, result.document.colors);
  assert.equal(result.variantCount, 1);
});

test('family combines the first light and first dark variants regardless of contribution order', () => {
  const dark = { ...sparseDark, name: 'Dark' };
  const light = { name: 'Light', type: 'light', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#111111' } };
  const result = buildVscodeThemeFamily([
    { label: 'Dark', uiTheme: 'vs-dark', contents: JSON.stringify(dark) },
    { label: 'Light', uiTheme: 'vs', contents: JSON.stringify(light) },
    { label: 'Ignored second dark', uiTheme: 'vs-dark', contents: JSON.stringify(dark) },
  ], { displayName: 'Paired', sourceId: 'demo.paired' });
  assert.equal(result.variantCount, 2);
  assert.equal(result.document.colors.canvas, '#ffffff');
  assert.equal(result.document.darkColors.canvas, '#101218');
  assert.equal(validateThemeDocument(result.document).valid, true);
});

test('unsupported include is disclosed without following archive paths', () => {
  const result = convertVscodeColorTheme({ ...sparseDark, include: '../base.json' });
  assert.deepEqual(result.unsupported, ['include']);
});

test('conversion rejects missing colors maps', () => {
  assert.throws(() => convertVscodeColorTheme({ name: 'Empty' }), (error) => error.code === 'missing-colors');
});

test('token colors and terminal values never enter the public document', () => {
  const result = convertVscodeColorTheme({
    ...sparseDark,
    tokenColors: [{ scope: 'comment', settings: { foreground: '#00ff00' } }],
    colors: { ...sparseDark.colors, 'terminal.ansiRed': '#ff0000' },
  });
  const serialized = JSON.stringify(result.document);
  assert.doesNotMatch(serialized, /tokenColors|terminal|ansiRed/);
});
