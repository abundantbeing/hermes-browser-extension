import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ZOOM_PRESETS,
  ZOOM_MIN_PERCENT,
  ZOOM_MAX_PERCENT,
  ZOOM_STEP_PERCENT,
  FONT_PROFILES,
  legacyTextSizeToZoomPercent,
  normalizeTextZoomPercent,
  stepTextZoomPercent,
  sanitizeLocalFontFamily,
  normalizeFontProfile,
  appearancePreferencesForSurface,
  withAppearancePreferenceUpdate,
  applyAppearancePreferences,
} from '../extension/lib/appearance-preferences.mjs';

// ---------------------------------------------------------------------------
// Minimal fake DOM root: the module must stay pure (no browser globals), so
// applyAppearancePreferences is exercised against a plain object whose
// dataset behaves like a DOMStringMap and whose style records
// setProperty/removeProperty/getPropertyValue like CSSStyleDeclaration.
// ---------------------------------------------------------------------------
class FakeStyle {
  constructor() {
    this.props = new Map();
    this.calls = [];
  }

  setProperty(name, value) {
    this.calls.push(['setProperty', name, String(value)]);
    this.props.set(name, String(value));
  }

  removeProperty(name) {
    this.calls.push(['removeProperty', name]);
    this.props.delete(name);
  }

  getPropertyValue(name) {
    return this.props.get(name) ?? '';
  }

  touched(name) {
    return this.calls.some(([, n]) => n === name);
  }
}

function fakeRoot() {
  return { dataset: {}, style: new FakeStyle() };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
test('zoom constants encode the canonical presets, bounds, and step', () => {
  assert.deepEqual(ZOOM_PRESETS, [90, 100, 110, 125, 150, 175]);
  assert.equal(ZOOM_MIN_PERCENT, 75);
  assert.equal(ZOOM_MAX_PERCENT, 200);
  assert.equal(ZOOM_STEP_PERCENT, 5);
});

test('FONT_PROFILES lists every supported profile in canonical order', () => {
  assert.deepEqual(FONT_PROFILES, [
    'signature',
    'system-sans',
    'high-legibility',
    'mono',
    'custom-local',
  ]);
});

// ---------------------------------------------------------------------------
// legacyTextSizeToZoomPercent
// ---------------------------------------------------------------------------
test('legacy named text sizes map to canonical zoom percents', () => {
  assert.equal(legacyTextSizeToZoomPercent('default'), 100);
  assert.equal(legacyTextSizeToZoomPercent('large'), 110);
  assert.equal(legacyTextSizeToZoomPercent('extra-large'), 125);
});

test('legacy text size mapping accepts case and whitespace variants', () => {
  assert.equal(legacyTextSizeToZoomPercent('DEFAULT'), 100);
  assert.equal(legacyTextSizeToZoomPercent('  Large  '), 110);
  assert.equal(legacyTextSizeToZoomPercent('Extra-Large'), 125);
  assert.equal(legacyTextSizeToZoomPercent(' extra-large '), 125);
});

test('unknown legacy text sizes fall back to the default zoom', () => {
  assert.equal(legacyTextSizeToZoomPercent('huge'), 100);
  assert.equal(legacyTextSizeToZoomPercent('tiny'), 100);
  assert.equal(legacyTextSizeToZoomPercent(''), 100);
  assert.equal(legacyTextSizeToZoomPercent(undefined), 100);
  assert.equal(legacyTextSizeToZoomPercent(null), 100);
});

// ---------------------------------------------------------------------------
// normalizeTextZoomPercent
// ---------------------------------------------------------------------------
test('normalizeTextZoomPercent accepts numbers and numeric strings', () => {
  assert.equal(normalizeTextZoomPercent(113), 113);
  assert.equal(normalizeTextZoomPercent('113'), 113);
  assert.equal(normalizeTextZoomPercent('  113  '), 113);
  for (const preset of ZOOM_PRESETS) {
    assert.equal(normalizeTextZoomPercent(preset), preset);
  }
});

test('normalizeTextZoomPercent coerces fractional input to an integer', () => {
  const result = normalizeTextZoomPercent(113.6);
  assert.equal(Number.isInteger(result), true);
  assert.equal([113, 114].includes(result), true, `expected truncation or rounding, got ${result}`);
});

test('normalizeTextZoomPercent clamps to the canonical bounds', () => {
  assert.equal(normalizeTextZoomPercent(50), 75);
  assert.equal(normalizeTextZoomPercent(-10), 75);
  assert.equal(normalizeTextZoomPercent(201), 200);
  assert.equal(normalizeTextZoomPercent(999), 200);
  assert.equal(normalizeTextZoomPercent(75), 75);
  assert.equal(normalizeTextZoomPercent(200), 200);
});

test('normalizeTextZoomPercent falls back on invalid input', () => {
  assert.equal(normalizeTextZoomPercent('abc'), 100);
  assert.equal(normalizeTextZoomPercent(undefined), 100);
  assert.equal(normalizeTextZoomPercent(null), 100);
  assert.equal(normalizeTextZoomPercent(NaN), 100);
  assert.equal(normalizeTextZoomPercent({}), 100);
});

test('normalizeTextZoomPercent honors the explicit fallback argument', () => {
  assert.equal(normalizeTextZoomPercent(undefined, 110), 110);
  assert.equal(normalizeTextZoomPercent('nope', 110), 110);
  assert.equal(normalizeTextZoomPercent(125, 110), 125);
});

// ---------------------------------------------------------------------------
// stepTextZoomPercent
// ---------------------------------------------------------------------------
test('stepping moves the normalized value by the zoom step', () => {
  assert.equal(stepTextZoomPercent(113, 'up'), 118);
  assert.equal(stepTextZoomPercent(113, 'down'), 108);
  assert.equal(stepTextZoomPercent('113', 'up'), 118);
  assert.equal(stepTextZoomPercent(undefined, 'up'), 105);
});

test('stepping clamps at the canonical bounds', () => {
  assert.equal(stepTextZoomPercent(200, 'up'), 200);
  assert.equal(stepTextZoomPercent(75, 'down'), 75);
  assert.equal(stepTextZoomPercent(196, 'up'), 200);
  assert.equal(stepTextZoomPercent(79, 'down'), 75);
});

test('an unknown step direction leaves the normalized value unchanged', () => {
  assert.equal(stepTextZoomPercent(113, 'sideways'), 113);
  assert.equal(stepTextZoomPercent('nope', 'up'), 105);
});

// ---------------------------------------------------------------------------
// sanitizeLocalFontFamily
// ---------------------------------------------------------------------------
test('sanitizeLocalFontFamily trims and accepts valid families', () => {
  assert.equal(sanitizeLocalFontFamily('Inter'), 'Inter');
  assert.equal(sanitizeLocalFontFamily('  Atkinson Hyperlegible  '), 'Atkinson Hyperlegible');
  assert.equal(sanitizeLocalFontFamily('Open-Sans'), 'Open-Sans');
  assert.equal(sanitizeLocalFontFamily('Open_Sans'), 'Open_Sans');
  assert.equal(sanitizeLocalFontFamily('Open.Sans'), 'Open.Sans');
});

test('sanitizeLocalFontFamily accepts Unicode letters and digits', () => {
  assert.equal(sanitizeLocalFontFamily('Noto Sans CJK 简体中文'), 'Noto Sans CJK 简体中文');
  assert.equal(sanitizeLocalFontFamily('ヒラギノ角ゴ'), 'ヒラギノ角ゴ');
  assert.equal(sanitizeLocalFontFamily('Alegreya Sans SC 300'), 'Alegreya Sans SC 300');
  assert.equal(sanitizeLocalFontFamily('עברית חדשה'), 'עברית חדשה');
});

test('sanitizeLocalFontFamily rejects separators, CSS syntax, and non-whitelisted punctuation', () => {
  assert.equal(sanitizeLocalFontFamily('Arial, Helvetica'), '');
  assert.equal(sanitizeLocalFontFamily('"Arial"'), '');
  assert.equal(sanitizeLocalFontFamily("'Arial'"), '');
  assert.equal(sanitizeLocalFontFamily('C:\\fonts\\Arial'), '');
  assert.equal(sanitizeLocalFontFamily('Arial (sans)'), '');
  assert.equal(sanitizeLocalFontFamily('Arial:400'), '');
  assert.equal(sanitizeLocalFontFamily('Arial;'), '');
  assert.equal(sanitizeLocalFontFamily('{Arial}'), '');
  for (const value of ['Arial/Helvetica', 'Arial@Home', 'Arial!', 'Arial+Sans', 'Arial<Sans']) {
    assert.equal(sanitizeLocalFontFamily(value), '', `${value} must fail the allowlist`);
  }
});

test('sanitizeLocalFontFamily rejects control characters before trimming', () => {
  for (const value of [
    'Arial\u0000',
    'Arial\n',
    'Arial\r',
    'Arial\t',
    `Arial${String.fromCharCode(27)}`,
    `Arial${String.fromCharCode(127)}`,
  ]) {
    assert.equal(sanitizeLocalFontFamily(value), '');
  }
});

test('sanitizeLocalFontFamily rejects empty and overlength families', () => {
  assert.equal(sanitizeLocalFontFamily(''), '');
  assert.equal(sanitizeLocalFontFamily('   '), '');
  assert.equal(sanitizeLocalFontFamily(undefined), '');
  assert.equal(sanitizeLocalFontFamily('A'.repeat(80)), 'A'.repeat(80));
  assert.equal(sanitizeLocalFontFamily('A'.repeat(81)), '');
  // 80 Unicode code points (astral chars are surrogate pairs in UTF-16)
  assert.equal(sanitizeLocalFontFamily('𐐀'.repeat(80)), '𐐀'.repeat(80));
  assert.equal(sanitizeLocalFontFamily('𐐀'.repeat(81)), '');
});

// ---------------------------------------------------------------------------
// normalizeFontProfile
// ---------------------------------------------------------------------------
test('normalizeFontProfile passes through canonical profiles', () => {
  assert.equal(normalizeFontProfile('signature'), 'signature');
  assert.equal(normalizeFontProfile('system-sans'), 'system-sans');
  assert.equal(normalizeFontProfile('high-legibility'), 'high-legibility');
  assert.equal(normalizeFontProfile('mono'), 'mono');
  assert.equal(normalizeFontProfile('custom-local', 'Inter'), 'custom-local');
});

test('normalizeFontProfile accepts case and whitespace variants', () => {
  assert.equal(normalizeFontProfile('SIGNATURE'), 'signature');
  assert.equal(normalizeFontProfile(' System-Sans '), 'system-sans');
  assert.equal(normalizeFontProfile('Custom-Local', 'Inter'), 'custom-local');
});

test('normalizeFontProfile rejects unknown profiles with the signature default', () => {
  assert.equal(normalizeFontProfile('serif'), 'signature');
  assert.equal(normalizeFontProfile('comic-sans'), 'signature');
  assert.equal(normalizeFontProfile(undefined), 'signature');
  assert.equal(normalizeFontProfile(''), 'signature');
});

test('custom-local falls back to system-sans without a valid local family', () => {
  assert.equal(normalizeFontProfile('custom-local'), 'system-sans');
  assert.equal(normalizeFontProfile('custom-local', ''), 'system-sans');
  assert.equal(normalizeFontProfile('custom-local', '   '), 'system-sans');
  assert.equal(normalizeFontProfile('custom-local', 'Arial, Helvetica'), 'system-sans');
  assert.equal(normalizeFontProfile('custom-local', 'Inter'), 'custom-local');
});

// ---------------------------------------------------------------------------
// appearancePreferencesForSurface
// ---------------------------------------------------------------------------
const PREFERENCE_DEFAULTS = {
  textZoomPercent: 100,
  fontProfile: 'signature',
  customFontFamily: '',
};

test('panel surface resolves normalized preferences with defaults', () => {
  assert.deepEqual(appearancePreferencesForSurface({}, 'panel'), PREFERENCE_DEFAULTS);
  assert.deepEqual(
    appearancePreferencesForSurface({ textZoomPercent: 113 }, 'panel'),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 113 },
  );
  assert.deepEqual(
    appearancePreferencesForSurface({ fontProfile: 'mono' }, 'panel'),
    { ...PREFERENCE_DEFAULTS, fontProfile: 'mono' },
  );
});

test('panel surface falls back to legacy textSize unless a valid numeric value exists', () => {
  assert.deepEqual(
    appearancePreferencesForSurface({ textSize: 'large' }, 'panel'),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 110 },
  );
  assert.deepEqual(
    appearancePreferencesForSurface({ textSize: 'extra-large' }, 'panel'),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 125 },
  );
  assert.deepEqual(
    appearancePreferencesForSurface({ textZoomPercent: 113, textSize: 'extra-large' }, 'panel'),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 113 },
  );
});

test('panel custom-local profile carries only a sanitized local family', () => {
  assert.deepEqual(
    appearancePreferencesForSurface(
      { fontProfile: 'custom-local', customFontFamily: 'Inter' },
      'panel',
    ),
    { ...PREFERENCE_DEFAULTS, fontProfile: 'custom-local', customFontFamily: 'Inter' },
  );
  assert.deepEqual(
    appearancePreferencesForSurface(
      { fontProfile: 'custom-local', customFontFamily: 'Arial, Helvetica' },
      'panel',
    ),
    { ...PREFERENCE_DEFAULTS, fontProfile: 'system-sans' },
  );
});

test('web surface resolves its storage keys into the same generic preference shape', () => {
  assert.deepEqual(appearancePreferencesForSurface({}, 'web'), PREFERENCE_DEFAULTS);
  assert.deepEqual(
    appearancePreferencesForSurface({ webTextZoomPercent: 150 }, 'web'),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 150 },
  );
  assert.deepEqual(
    appearancePreferencesForSurface({ webTextSize: 'extra-large' }, 'web'),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 125 },
  );
  assert.deepEqual(
    appearancePreferencesForSurface(
      { webTextZoomPercent: 113, webTextSize: 'extra-large' },
      'web',
    ),
    { ...PREFERENCE_DEFAULTS, textZoomPercent: 113 },
  );
});

test('surface extraction ignores the other surface and returns only generic keys', () => {
  const panel = appearancePreferencesForSurface(
    { textZoomPercent: 113, webTextZoomPercent: 150 },
    'panel',
  );
  assert.deepEqual(panel, { ...PREFERENCE_DEFAULTS, textZoomPercent: 113 });

  const web = appearancePreferencesForSurface(
    { textZoomPercent: 113, webTextZoomPercent: 150 },
    'web',
  );
  assert.deepEqual(web, { ...PREFERENCE_DEFAULTS, textZoomPercent: 150 });
  assert.deepEqual(Object.keys(web).sort(), ['customFontFamily', 'fontProfile', 'textZoomPercent']);
});

test('unknown surfaces throw', () => {
  assert.throws(() => appearancePreferencesForSurface({}, 'settings'), /unknown surface/i);
  assert.throws(() => appearancePreferencesForSurface({}, 'popup'), /unknown surface/i);
  assert.throws(() => appearancePreferencesForSurface({}, undefined), /unknown surface/i);
});

// ---------------------------------------------------------------------------
// withAppearancePreferenceUpdate
// ---------------------------------------------------------------------------
test('panel updates normalize the patch and keep web keys untouched', () => {
  const settings = { textZoomPercent: 100, webTextZoomPercent: 150 };
  const result = withAppearancePreferenceUpdate(settings, 'panel', { textZoomPercent: 125 });
  assert.equal(result.textZoomPercent, 125);
  assert.equal(result.webTextZoomPercent, 150);
  assert.equal('webFontProfile' in result, false);
});

test('web updates normalize a generic patch and keep panel keys untouched', () => {
  const settings = { textZoomPercent: 100, webTextZoomPercent: 150 };
  const result = withAppearancePreferenceUpdate(settings, 'web', { textZoomPercent: 125 });
  assert.equal(result.webTextZoomPercent, 125);
  assert.equal(result.textZoomPercent, 100);
  assert.equal('fontProfile' in result, false);
});

test('updates remove only the matching surface legacy named-size key', () => {
  const panelResult = withAppearancePreferenceUpdate(
    { textSize: 'large', webTextSize: 'extra-large' },
    'panel',
    { textZoomPercent: 113 },
  );
  assert.equal('textSize' in panelResult, false);
  assert.equal(panelResult.webTextSize, 'extra-large');

  const webResult = withAppearancePreferenceUpdate(
    { textSize: 'large', webTextSize: 'extra-large' },
    'web',
    { textZoomPercent: 113 },
  );
  assert.equal('webTextSize' in webResult, false);
  assert.equal(webResult.textSize, 'large');
});

test('updates clamp patch values and never mutate the input settings', () => {
  const settings = { textZoomPercent: 100 };
  const result = withAppearancePreferenceUpdate(settings, 'panel', { textZoomPercent: 999 });
  assert.equal(result.textZoomPercent, 200);
  assert.equal(settings.textZoomPercent, 100);
  assert.notEqual(result, settings);
});

test('updates normalize font patches and preserve unrelated settings', () => {
  const settings = {
    appearanceTheme: 'nous',
    textZoomPercent: 100,
    webTextZoomPercent: 150,
    webFontProfile: 'mono',
  };
  const panelResult = withAppearancePreferenceUpdate(settings, 'panel', {
    fontProfile: 'custom-local',
    customFontFamily: '  Atkinson Hyperlegible  ',
  });
  assert.equal(panelResult.fontProfile, 'custom-local');
  assert.equal(panelResult.customFontFamily, 'Atkinson Hyperlegible');
  assert.equal(panelResult.webFontProfile, 'mono');
  assert.equal(panelResult.appearanceTheme, 'nous');

  const webResult = withAppearancePreferenceUpdate(settings, 'web', {
    fontProfile: 'custom-local',
    customFontFamily: 'Arial, Helvetica',
  });
  assert.equal(webResult.webFontProfile, 'system-sans');
  assert.equal(webResult.webCustomFontFamily, '');
  assert.equal(webResult.textZoomPercent, 100);
  assert.equal(webResult.appearanceTheme, 'nous');
});

test('updates ignore cross-surface and legacy keys injected through a generic patch', () => {
  const settings = {
    textSize: 'large',
    textZoomPercent: 100,
    webTextZoomPercent: 150,
    futureAppearanceKey: 'preserve-me',
  };
  const result = withAppearancePreferenceUpdate(settings, 'panel', {
    webTextZoomPercent: 999,
    webFontProfile: 'mono',
    textSize: 'extra-large',
  });
  assert.equal(result.textZoomPercent, 100);
  assert.equal(result.webTextZoomPercent, 150);
  assert.equal('webFontProfile' in result, false);
  assert.equal('textSize' in result, false);
  assert.equal(result.futureAppearanceKey, 'preserve-me');
});

test('updates reject unknown surfaces', () => {
  assert.throws(
    () => withAppearancePreferenceUpdate({}, 'toolbar', { textZoomPercent: 100 }),
    /unknown surface/i,
  );
});

// ---------------------------------------------------------------------------
// applyAppearancePreferences
// ---------------------------------------------------------------------------
test('apply sets the normalized data-hermes-text-zoom and stable multiplier', () => {
  const root = fakeRoot();
  applyAppearancePreferences(root, { textZoomPercent: 125, fontProfile: 'mono' });
  assert.equal(root.dataset.hermesTextZoom, '125');
  assert.equal(root.style.getPropertyValue('--hermes-text-zoom'), '1.25');

  const second = fakeRoot();
  applyAppearancePreferences(second, { textZoomPercent: 113, fontProfile: 'mono' });
  assert.equal(second.dataset.hermesTextZoom, '113');
  assert.equal(second.style.getPropertyValue('--hermes-text-zoom'), '1.13');

  const bounds = fakeRoot();
  applyAppearancePreferences(bounds, { textZoomPercent: 100, fontProfile: 'mono' });
  assert.equal(bounds.style.getPropertyValue('--hermes-text-zoom'), '1');
  applyAppearancePreferences(bounds, { textZoomPercent: 200, fontProfile: 'mono' });
  assert.equal(bounds.style.getPropertyValue('--hermes-text-zoom'), '2');
});

test('apply sets ui/display font variables for non-signature profiles', () => {
  for (const profile of ['system-sans', 'high-legibility', 'mono']) {
    const root = fakeRoot();
    applyAppearancePreferences(root, { textZoomPercent: 100, fontProfile: profile });
    assert.equal(root.style.touched('--hermes-font-ui'), true, `${profile} sets --hermes-font-ui`);
    assert.equal(root.style.touched('--hermes-font-display'), true, `${profile} sets --hermes-font-display`);
    assert.notEqual(root.style.getPropertyValue('--hermes-font-ui'), '');
    assert.notEqual(root.style.getPropertyValue('--hermes-font-display'), '');
  }
});

test('surface extraction composes with custom-local CSSOM application', () => {
  const root = fakeRoot();
  const preferences = appearancePreferencesForSurface({
    webTextZoomPercent: 125,
    webFontProfile: 'custom-local',
    webCustomFontFamily: 'Atkinson Hyperlegible',
  }, 'web');
  assert.deepEqual(applyAppearancePreferences(root, preferences), preferences);
  assert.equal(
    root.style.getPropertyValue('--hermes-font-ui'),
    '"Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
  );
  assert.equal(
    root.style.getPropertyValue('--hermes-font-display'),
    root.style.getPropertyValue('--hermes-font-ui'),
  );
});

test('apply removes inline font variables for the signature profile', () => {
  const root = fakeRoot();
  root.style.setProperty('--hermes-font-ui', '#font-ui');
  root.style.setProperty('--hermes-font-display', '#font-display');
  applyAppearancePreferences(root, { textZoomPercent: 100, fontProfile: 'signature' });
  assert.equal(root.style.getPropertyValue('--hermes-font-ui'), '');
  assert.equal(root.style.getPropertyValue('--hermes-font-display'), '');
  assert.equal(root.style.calls.some(([op, n]) => op === 'removeProperty' && n === '--hermes-font-ui'), true);
  assert.equal(root.style.calls.some(([op, n]) => op === 'removeProperty' && n === '--hermes-font-display'), true);
});

test('apply never touches the mono font variable', () => {
  for (const profile of FONT_PROFILES) {
    const root = fakeRoot();
    applyAppearancePreferences(root, { textZoomPercent: 100, fontProfile: profile });
    assert.equal(root.style.touched('--hermes-font-mono'), false, `${profile} must not touch --hermes-font-mono`);
  }
});

test('apply returns the normalized preferences it applied', () => {
  const root = fakeRoot();
  assert.deepEqual(
    applyAppearancePreferences(root, { textZoomPercent: 999, fontProfile: 'high-legibility' }),
    { textZoomPercent: 200, fontProfile: 'high-legibility', customFontFamily: '' },
  );
});
