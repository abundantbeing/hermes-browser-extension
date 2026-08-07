import assert from 'node:assert/strict';
import test from 'node:test';

import { APPEARANCE_THEMES } from '../extension/lib/appearance-themes.mjs';

const MODULE_PATH = '../extension/lib/custom-themes.mjs';

const missingContract = {
  CUSTOM_THEME_SCHEMA_VERSION: undefined,
  CUSTOM_THEME_STORAGE_KEY: undefined,
  CUSTOM_THEME_MAX_COUNT: undefined,
  CUSTOM_THEME_MAX_INPUT_BYTES: undefined,
  CUSTOM_THEME_MAX_RECORD_BYTES: undefined,
  CUSTOM_THEME_MAX_STORE_BYTES: undefined,
  normalizeHexColor: () => undefined,
  hexToRgb: () => undefined,
  mixHexColors: () => undefined,
  contrastRatio: () => undefined,
  validateThemeDocument: () => ({ valid: false, errors: [{ code: 'module-missing', path: '$' }] }),
  normalizeThemeDocument: () => undefined,
  themeCssVariables: () => ({}),
  customThemePaletteForMode: () => undefined,
  customThemeSelection: () => ({ kind: 'module-missing' }),
  serializeThemeDocument: () => undefined,
};

async function loadContract() {
  try {
    return await import(MODULE_PATH);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.url || '').endsWith('/extension/lib/custom-themes.mjs')) {
      return missingContract;
    }
    throw error;
  }
}

const themes = await loadContract();

const {
  CUSTOM_THEME_SCHEMA_VERSION,
  CUSTOM_THEME_STORAGE_KEY,
  CUSTOM_THEME_MAX_COUNT,
  CUSTOM_THEME_MAX_INPUT_BYTES,
  CUSTOM_THEME_MAX_RECORD_BYTES,
  CUSTOM_THEME_MAX_STORE_BYTES,
  normalizeHexColor,
  hexToRgb,
  mixHexColors,
  contrastRatio,
  validateThemeDocument,
  normalizeThemeDocument,
  themeCssVariables,
  customThemePaletteForMode,
  customThemeSelection,
  serializeThemeDocument,
} = themes;

const LIGHT_COLORS = Object.freeze({
  canvas: '#FFFFFF',
  paper: '#F5F5F5',
  ink: '#111111',
  muted: '#595959',
  primary: '#0505E8',
  primaryDeep: '#03039B',
  onPrimary: '#FFFFFF',
  accent: '#FFD400',
  onAccent: '#111111',
  line: '#767676',
  input: '#FFFFFF',
  danger: '#B00020',
  onDanger: '#FFFFFF',
  shellForeground: '#FFFFFF',
});

const DARK_COLORS = Object.freeze({
  canvas: '#101114',
  paper: '#181A20',
  ink: '#F4F5F7',
  muted: '#B5BAC4',
  primary: '#3F48CC',
  primaryDeep: '#252B82',
  onPrimary: '#FFFFFF',
  accent: '#E6FF57',
  onAccent: '#101114',
  line: '#777D8A',
  input: '#0C0D10',
  danger: '#FF6B78',
  onDanger: '#101114',
  shellForeground: '#FFFFFF',
});

function validDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'Focus Forge',
    description: 'A strict high-contrast theme.',
    colors: { ...LIGHT_COLORS },
    ...overrides,
  };
}

function errorPaths(result) {
  return (result?.errors || []).map((entry) => entry.path);
}

function errorCodes(result) {
  return (result?.errors || []).map((entry) => entry.code);
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeys(nested)]));
}

test('exports the fixed schema, storage, and byte-limit constants', () => {
  assert.equal(CUSTOM_THEME_SCHEMA_VERSION, 1, 'custom theme schema version must be 1');
  assert.equal(CUSTOM_THEME_STORAGE_KEY, 'hermesBrowserCustomThemesV1', 'storage key must remain versioned');
  assert.equal(CUSTOM_THEME_MAX_COUNT, 32, 'custom theme count must be capped at 32');
  assert.equal(CUSTOM_THEME_MAX_INPUT_BYTES, 32 * 1024, 'input must be capped at 32 KiB');
  assert.equal(CUSTOM_THEME_MAX_RECORD_BYTES, 16 * 1024, 'records must be capped at 16 KiB');
  assert.equal(CUSTOM_THEME_MAX_STORE_BYTES, 512 * 1024, 'store must be capped at 512 KiB');
});

test('accepts and normalizes a valid light-only document', () => {
  const result = validateThemeDocument(validDocument());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.document.name, 'Focus Forge');
  assert.equal(result.document.colors.canvas, '#ffffff');
  assert.equal(result.document.darkColors, undefined);
  assert.deepEqual(customThemePaletteForMode(result.document, 'dark'), result.document.colors);
});

test('accepts and independently normalizes a valid light and dark document', () => {
  const result = validateThemeDocument(validDocument({ darkColors: { ...DARK_COLORS } }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.document.darkColors.canvas, '#101114');
  assert.equal(customThemePaletteForMode(result.document, 'light').canvas, '#ffffff');
  assert.equal(customThemePaletteForMode(result.document, 'dark').canvas, '#101114');
});

test('rejects missing required palette keys and reports their paths', () => {
  const candidate = validDocument();
  delete candidate.colors.onDanger;
  const result = validateThemeDocument(candidate);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('colors.onDanger'));
});

test('rejects wrong schema versions and unknown top-level or palette keys', () => {
  const wrongVersion = validateThemeDocument(validDocument({ schemaVersion: 2 }));
  assert.equal(wrongVersion.valid, false);
  assert.ok(errorPaths(wrongVersion).includes('schemaVersion'));

  const unknownTop = validateThemeDocument(validDocument({ css: 'body { display:none }' }));
  assert.equal(unknownTop.valid, false);
  assert.ok(errorPaths(unknownTop).includes('css'));

  const candidate = validDocument();
  candidate.colors.fontUrl = 'https://example.invalid/font.woff2';
  const unknownPalette = validateThemeDocument(candidate);
  assert.equal(unknownPalette.valid, false);
  assert.ok(errorPaths(unknownPalette).includes('colors.fontUrl'));
});

test('accepts only exact six-digit opaque hexadecimal colors', () => {
  assert.equal(normalizeHexColor('#AABBCC'), '#aabbcc');
  for (const unsafe of ['#abc', '#abcd', '#aabbccdd', 'aabbcc', 'rgb(0,0,0)', 'url(https://example.invalid/x)']) {
    assert.equal(normalizeHexColor(unsafe), null, unsafe);
    const candidate = validDocument();
    candidate.colors.canvas = unsafe;
    assert.equal(validateThemeDocument(candidate).valid, false, unsafe);
  }
});

test('enforces Unicode code-point name and description limits after trimming', () => {
  const accepted = validateThemeDocument(validDocument({ name: `  ${'😀'.repeat(80)}  `, description: 'ø'.repeat(240) }));
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));
  assert.equal([...accepted.document.name].length, 80);

  const longName = validateThemeDocument(validDocument({ name: '😀'.repeat(81) }));
  assert.equal(longName.valid, false);
  assert.ok(errorPaths(longName).includes('name'));

  const longDescription = validateThemeDocument(validDocument({ description: 'ø'.repeat(241) }));
  assert.equal(longDescription.valid, false);
  assert.ok(errorPaths(longDescription).includes('description'));

  const emptyName = validateThemeDocument(validDocument({ name: '   ' }));
  assert.equal(emptyName.valid, false);
  assert.ok(errorPaths(emptyName).includes('name'));

  const nonTextDescription = validateThemeDocument(validDocument({ description: { html: '<b>unsafe</b>' } }));
  assert.equal(nonTextDescription.valid, false);
  assert.ok(errorPaths(nonTextDescription).includes('description'));
});

test('rejects non-objects, arrays, functions, inherited properties, and prototype-pollution-shaped input', () => {
  for (const candidate of [null, 'theme', [], () => validDocument(), Object.assign(Object.create({ inherited: true }), validDocument())]) {
    const result = validateThemeDocument(candidate);
    assert.equal(result.valid, false);
  }
  const polluted = JSON.parse(`{"schemaVersion":1,"name":"x","colors":${JSON.stringify(LIGHT_COLORS)},"__proto__":{"polluted":true}}`);
  const result = validateThemeDocument(polluted);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('__proto__'));
  assert.equal({}.polluted, undefined);
});

test('derives deterministic opaque sRGB mixes and RGB channels', () => {
  assert.deepEqual(hexToRgb('#0505e8'), { r: 5, g: 5, b: 232 });
  assert.equal(mixHexColors('#000000', '#ffffff', 0.35), '#595959');
  assert.equal(mixHexColors('#ffffff', '#000000', 0.2), '#cccccc');
  assert.equal(Math.round(contrastRatio('#767676', '#ffffff') * 1000) / 1000, 4.542);

  const normalized = normalizeThemeDocument(validDocument());
  assert.equal(normalized.derived.canvasSoft, '#fcfcfc');
  assert.equal(normalized.derived.paperSoft, '#f7f7f7');
  assert.equal(normalized.derived.accentSoft, '#fff7d1');
  assert.equal(normalized.derived.canvasRgb, '255, 255, 255');
  assert.equal(normalized.derived.primaryRgb, '5, 5, 232');
});

test('accepts the 4.5 contrast boundary and rejects the immediately lower pair', () => {
  const passing = validDocument();
  passing.colors.primary = '#ffffff';
  passing.colors.onPrimary = '#767676';
  assert.equal(validateThemeDocument(passing).valid, true);

  const failing = validDocument();
  failing.colors.primary = '#ffffff';
  failing.colors.onPrimary = '#777777';
  const result = validateThemeDocument(failing);
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).includes('contrast'));
  assert.ok(errorPaths(result).includes('colors.onPrimary'));
});

test('rejects every hard light-palette contrast pair with its semantic path', () => {
  const cases = [
    ['ink on canvas', { ink: '#777777' }, 'colors.ink'],
    ['ink on paper', { paper: '#ffffff', ink: '#777777' }, 'colors.ink'],
    ['muted on canvas', { muted: '#777777' }, 'colors.muted'],
    ['onPrimary on primary', { primary: '#ffffff', onPrimary: '#777777' }, 'colors.onPrimary'],
    ['onAccent on accent', { accent: '#ffffff', onAccent: '#777777' }, 'colors.onAccent'],
    ['onDanger on danger', { danger: '#ffffff', onDanger: '#777777' }, 'colors.onDanger'],
    ['shellForeground on primaryDeep', { primaryDeep: '#ffffff', shellForeground: '#777777' }, 'colors.shellForeground'],
    ['line against canvas and paper', { line: '#dddddd' }, 'colors.line'],
    ['danger inline on canvas', { danger: '#777777', onDanger: '#ffffff' }, 'colors.danger'],
  ];
  for (const [label, patch, path] of cases) {
    const candidate = validDocument();
    Object.assign(candidate.colors, patch);
    const result = validateThemeDocument(candidate);
    assert.equal(result.valid, false, label);
    assert.ok(errorPaths(result).includes(path), `${label}: ${JSON.stringify(result.errors)}`);
  }
});

test('returns every hard contrast failure and labels dark palette failures separately', () => {
  const candidate = validDocument({ darkColors: Object.fromEntries(Object.keys(DARK_COLORS).map((key) => [key, '#777777'])) });
  const result = validateThemeDocument(candidate);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 8, JSON.stringify(result.errors));
  assert.ok(result.errors.every((entry) => entry.path.startsWith('darkColors.')), JSON.stringify(result.errors));
});

test('maps the complete semantic contract to normalized CSS variables only', () => {
  const normalized = normalizeThemeDocument(validDocument());
  assert.ok(normalized, 'normalizeThemeDocument must return a normalized document');
  const variables = themeCssVariables(normalized.colors);
  const required = [
    '--hermes-canvas', '--hermes-canvas-rgb', '--hermes-canvas-soft', '--hermes-paper',
    '--hermes-paper-rgb', '--hermes-paper-soft', '--hermes-ink', '--hermes-ink-rgb',
    '--hermes-muted', '--hermes-muted-rgb', '--hermes-blue', '--hermes-blue-rgb', '--hermes-blue-deep', '--hermes-blue-deep-rgb',
    '--hermes-primary', '--hermes-primary-rgb', '--hermes-on-primary', '--hermes-on-primary-rgb',
    '--hermes-yellow', '--hermes-yellow-rgb', '--hermes-on-accent', '--hermes-on-accent-rgb',
    '--hermes-accent', '--hermes-accent-rgb', '--hermes-accent-soft', '--hermes-line', '--hermes-line-rgb',
    '--hermes-input-bg', '--hermes-input-bg-rgb', '--hermes-red', '--hermes-danger', '--hermes-danger-rgb',
    '--hermes-on-danger', '--hermes-on-danger-rgb', '--hermes-shell-fg', '--hermes-shell-fg-rgb',
  ];
  assert.deepEqual(Object.keys(variables).sort(), required.sort());
  for (const [key, value] of Object.entries(variables)) {
    assert.match(key, /^--hermes-[a-z0-9-]+$/);
    assert.match(value, /^(#[0-9a-f]{6}|\d{1,3}, \d{1,3}, \d{1,3})$/);
    assert.doesNotMatch(value, /[;{}]|url\(|var\(/i);
  }
  assert.equal(Object.hasOwn(variables, 'fontUrl'), false);
  assert.equal(Object.hasOwn(variables, '--hermes-font-ui'), false);

  const unsafePalette = { ...normalized.colors, primary: '#000000; background:url(https://example.invalid)' };
  assert.throws(() => themeCssVariables(unsafePalette), /normalized palette/i);
});

test('resolves built-in, valid custom, missing custom, and invalid selection states', () => {
  const document = normalizeThemeDocument(validDocument());
  const records = [{ id: 'custom:11111111-1111-4111-8111-111111111111', document }];
  for (const { value: id } of APPEARANCE_THEMES) {
    assert.deepEqual(customThemeSelection(id, records), { kind: 'builtin', id });
  }
  assert.equal(customThemeSelection(records[0].id, records).kind, 'custom');
  assert.equal(customThemeSelection('custom:22222222-2222-4222-8222-222222222222', records).kind, 'missing');
  assert.equal(customThemeSelection('javascript:alert(1)', records).kind, 'invalid');

  const injectedRecord = {
    ...records[0],
    document: { ...document, css: 'body { display: none }' },
  };
  assert.equal(customThemeSelection(injectedRecord.id, [injectedRecord]).kind, 'invalid');
});

test('serializes normalized documents stably and produces re-importable JSON', () => {
  const normalized = normalizeThemeDocument(validDocument({ darkColors: { ...DARK_COLORS } }));
  const first = serializeThemeDocument(normalized);
  const second = serializeThemeDocument(normalized);
  assert.equal(first, second);
  assert.equal(typeof first, 'string', 'serializeThemeDocument must return JSON text');
  assert.equal(first.endsWith('\n'), true);
  const reparsed = JSON.parse(first);
  assert.equal(Object.hasOwn(reparsed, 'derived'), false);
  assert.deepEqual(normalizeThemeDocument(reparsed), normalized);
  assert.throws(
    () => serializeThemeDocument({ ...normalized, css: 'body { display: none }' }),
    /invalid Hermes Browser theme document/i,
  );
  const reordered = reverseObjectKeys(normalized);
  assert.deepEqual(JSON.parse(serializeThemeDocument(reordered)), reparsed, 'storage key ordering must not affect canonical serialization');
});
