// Pure appearance-preference contract shared by the side panel and Hermes Web.
//
// This module owns migration from legacy named text sizes, bounded percent
// zoom normalization, per-surface storage key mapping, local font-family
// sanitization, and CSSOM application. It must stay pure: no chrome.storage,
// no DOM queries, and no browser global beyond the root object explicitly
// passed to applyAppearancePreferences().

export const ZOOM_PRESETS = Object.freeze([90, 100, 110, 125, 150, 175]);
export const ZOOM_MIN_PERCENT = 75;
export const ZOOM_MAX_PERCENT = 200;
export const ZOOM_STEP_PERCENT = 5;
export const ZOOM_DEFAULT_PERCENT = 100;

export const FONT_PROFILES = Object.freeze([
  'signature',
  'collapse',
  'system-sans',
  'times-new-roman',
  'georgia',
  'palatino',
  'garamond',
  'cambria',
  'calibri',
  'trebuchet',
  'high-legibility',
  'montserrat',
  'source-sans-3',
  'ibm-plex-sans',
  'outfit',
  'space-grotesk',
  'playfair-display',
  'libre-baskerville',
  'fraunces',
  'cinzel',
  'mono',
  'custom-local',
]);

export const FONT_PROFILE_DEFAULT = 'signature';

const SYSTEM_SANS_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
const HIGH_LEGIBILITY_STACK = 'Verdana, Tahoma, Arial, sans-serif';
const MONO_STACK = 'var(--hermes-font-mono)';
const PROFILE_STACKS = Object.freeze({
  collapse: '"Collapse", "Segoe UI", system-ui, sans-serif',
  'system-sans': SYSTEM_SANS_STACK,
  'times-new-roman': '"Times New Roman", Times, "Liberation Serif", serif',
  georgia: 'Georgia, "Times New Roman", serif',
  palatino: 'Palatino, "Palatino Linotype", "Book Antiqua", Palatino, serif',
  garamond: 'Garamond, "EB Garamond", "Times New Roman", serif',
  cambria: 'Cambria, Georgia, serif',
  calibri: 'Calibri, "Segoe UI", sans-serif',
  trebuchet: '"Trebuchet MS", "Segoe UI", sans-serif',
  'high-legibility': HIGH_LEGIBILITY_STACK,
  montserrat: '"Montserrat", "Segoe UI", sans-serif',
  'source-sans-3': '"Source Sans 3", "Segoe UI", sans-serif',
  'ibm-plex-sans': '"IBM Plex Sans", "Segoe UI", sans-serif',
  outfit: '"Outfit", "Segoe UI", sans-serif',
  'space-grotesk': '"Space Grotesk", "Segoe UI", sans-serif',
  'playfair-display': '"Playfair Display", Georgia, serif',
  'libre-baskerville': '"Libre Baskerville", Georgia, serif',
  fraunces: '"Fraunces", Georgia, serif',
  cinzel: '"Cinzel", Georgia, serif',
  mono: MONO_STACK,
});

const LEGACY_TEXT_SIZE_ZOOM = Object.freeze({
  default: 100,
  large: 110,
  'extra-large': 125,
});

// Only Unicode letters, Unicode numbers, spaces, period, underscore, and
// hyphen. No comma, quote, backslash, parenthesis, colon, semicolon, brace,
// control character, or newline can survive sanitization.
// Keep the escaped terminal hyphen aligned with the documented allowlist contract.
// eslint-disable-next-line no-useless-escape
const FONT_FAMILY_ALLOWLIST = /^[\p{L}\p{N} ._\-]+$/u;
// eslint-disable-next-line no-control-regex
const FONT_FAMILY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Each surface owns a separate set of storage keys. The generic preference
// shape never changes; the surface argument only selects the keys to read
// and write. Unknown surfaces throw instead of silently writing wrong keys.
const SURFACE_KEYS = Object.freeze({
  panel: {
    zoomKey: 'textZoomPercent',
    fontKey: 'fontProfile',
    customFontKey: 'customFontFamily',
    legacySizeKey: 'textSize',
  },
  web: {
    zoomKey: 'webTextZoomPercent',
    fontKey: 'webFontProfile',
    customFontKey: 'webCustomFontFamily',
    legacySizeKey: 'webTextSize',
  },
});

function surfaceKeys(surface) {
  const keys = SURFACE_KEYS[surface];
  if (!keys) throw new Error(`unknown surface: ${String(surface)}`);
  return keys;
}

// A zoom value is usable only when it is a finite number or a non-empty
// string that parses to a finite number. null, undefined, empty strings,
// non-finite numbers, and objects are invalid rather than Number(null) === 0.
function zoomNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  }
  return Number.NaN;
}

function clampZoomPercent(value) {
  return Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, value));
}

export function legacyTextSizeToZoomPercent(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return LEGACY_TEXT_SIZE_ZOOM[normalized] ?? ZOOM_DEFAULT_PERCENT;
}

export function normalizeTextZoomPercent(value, fallback = ZOOM_DEFAULT_PERCENT) {
  const numeric = zoomNumericValue(value);
  if (!Number.isFinite(numeric)) {
    const fallbackNumeric = zoomNumericValue(fallback);
    if (!Number.isFinite(fallbackNumeric)) return ZOOM_DEFAULT_PERCENT;
    return clampZoomPercent(Math.round(fallbackNumeric));
  }
  return clampZoomPercent(Math.round(numeric));
}

export function stepTextZoomPercent(value, direction) {
  const current = normalizeTextZoomPercent(value);
  if (direction === 'up') return normalizeTextZoomPercent(current + ZOOM_STEP_PERCENT);
  if (direction === 'down') return normalizeTextZoomPercent(current - ZOOM_STEP_PERCENT);
  return current;
}

export function fontFamilyPreview(profile, customFontFamily = '') {
  if (profile === 'signature') return '"Rules Gothic Compressed", "Rules Variable", sans-serif';
  if (profile === 'custom-local') {
    const family = sanitizeLocalFontFamily(customFontFamily);
    return family ? `"${family}", ${SYSTEM_SANS_STACK}` : SYSTEM_SANS_STACK;
  }
  return PROFILE_STACKS[profile] || SYSTEM_SANS_STACK;
}

export const THEME_OWNED_FONTS = Object.freeze(['cyberpunk']);

export function themeOwnsFont(themeId) {
  return THEME_OWNED_FONTS.includes(String(themeId || ''));
}

export function appearancePreferencesForTheme(preferences, themeId, { pinThemeFont = false } = {}) {
  const normalized = normalizedPreferences(preferences);
  if (!pinThemeFont && themeOwnsFont(themeId)) {
    return { ...normalized, fontProfile: 'signature' };
  }
  return normalized;
}

export function sanitizeLocalFontFamily(value) {
  if (typeof value !== 'string') return '';
  // Control characters are rejected before trimming so a value that only
  // "looks" clean after trim (e.g. "Arial\n") cannot slip through.
  if (FONT_FAMILY_CONTROL_CHARS.test(value)) return '';
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  // Count Unicode code points, not UTF-16 units, so astral characters count
  // as a single character.
  if ([...trimmed].length > 80) return '';
  if (!FONT_FAMILY_ALLOWLIST.test(trimmed)) return '';
  return trimmed;
}

export function normalizeFontProfile(value, customFontFamily = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'custom-local') {
    return sanitizeLocalFontFamily(customFontFamily) ? 'custom-local' : 'system-sans';
  }
  return FONT_PROFILES.includes(normalized) ? normalized : FONT_PROFILE_DEFAULT;
}

function normalizedPreferences(preferences = {}) {
  const textZoomPercent = normalizeTextZoomPercent(preferences?.textZoomPercent);
  const customFontFamily = sanitizeLocalFontFamily(preferences?.customFontFamily);
  const fontProfile = normalizeFontProfile(preferences?.fontProfile, customFontFamily);
  return { textZoomPercent, fontProfile, customFontFamily };
}

export function appearancePreferencesForSurface(settings, surface) {
  const keys = surfaceKeys(surface);
  const stored = settings && typeof settings === 'object' ? settings : {};
  const numeric = zoomNumericValue(stored[keys.zoomKey]);
  const textZoomPercent = Number.isFinite(numeric)
    ? clampZoomPercent(Math.round(numeric))
    : legacyTextSizeToZoomPercent(stored[keys.legacySizeKey]);
  const customFontFamily = sanitizeLocalFontFamily(stored[keys.customFontKey]);
  const fontProfile = normalizeFontProfile(stored[keys.fontKey], customFontFamily);
  return { textZoomPercent, fontProfile, customFontFamily };
}

export function withAppearancePreferenceUpdate(settings, surface, patch) {
  const keys = surfaceKeys(surface);
  const next = { ...(settings && typeof settings === 'object' ? settings : {}) };
  // A successful surface save removes only that surface's legacy named-size
  // key. Every unknown key and every other-surface key is preserved.
  delete next[keys.legacySizeKey];

  const changes = patch && typeof patch === 'object' ? patch : {};
  // Only generic patch keys are honored; injected legacy, cross-surface, or
  // unknown keys are ignored entirely.
  if (Object.prototype.hasOwnProperty.call(changes, 'textZoomPercent')) {
    next[keys.zoomKey] = normalizeTextZoomPercent(changes.textZoomPercent);
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'customFontFamily')) {
    next[keys.customFontKey] = sanitizeLocalFontFamily(changes.customFontFamily);
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'fontProfile')) {
    const family = sanitizeLocalFontFamily(changes.customFontFamily);
    next[keys.fontKey] = normalizeFontProfile(changes.fontProfile, family);
  }
  return next;
}

function fontStackForProfile(profile, customFontFamily) {
  if (profile === 'custom-local') {
    return `"${customFontFamily}", ${SYSTEM_SANS_STACK}`;
  }
  return PROFILE_STACKS[profile] || SYSTEM_SANS_STACK;
}

export function applyAppearancePreferences(root, preferences) {
  const normalized = normalizedPreferences(preferences);
  root.dataset.hermesTextZoom = String(normalized.textZoomPercent);
  root.dataset.hermesFontProfile = normalized.fontProfile;
  root.style.setProperty('--hermes-text-zoom', String(normalized.textZoomPercent / 100));

  if (normalized.fontProfile === 'signature') {
    // Signature restores the site pair: Rules Variable for UI, Rules Gothic
    // Compressed for headlines. Removing the inline overrides makes those
    // tokens authoritative again.
    root.style.removeProperty('--hermes-font-ui');
    root.style.removeProperty('--hermes-font-display');
    // Rules Gothic Compressed is a much narrower face than the UI families, so
    // a headline printed in it reads smaller at the same px than the same
    // headline in Georgia or Calibri. Scale the display headlines up for this
    // profile only, so section titles keep reading as titles.
    root.style.setProperty('--hermes-display-scale', '1.3');
  } else {
    const stack = fontStackForProfile(normalized.fontProfile, normalized.customFontFamily);
    root.style.setProperty('--hermes-font-ui', stack);
    root.style.setProperty('--hermes-font-display', stack);
    root.style.removeProperty('--hermes-display-scale');
  }
  // --hermes-font-mono is intentionally never touched.
  return normalized;
}
