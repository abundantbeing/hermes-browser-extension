import { APPEARANCE_THEMES } from './appearance-themes.mjs';

export const CUSTOM_THEME_SCHEMA_VERSION = 1;
export const CUSTOM_THEME_STORAGE_KEY = 'hermesBrowserCustomThemesV1';
export const CUSTOM_THEME_MAX_COUNT = 32;
export const CUSTOM_THEME_MAX_INPUT_BYTES = 32 * 1024;
export const CUSTOM_THEME_MAX_RECORD_BYTES = 16 * 1024;
export const CUSTOM_THEME_MAX_STORE_BYTES = 512 * 1024;

const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'name', 'description', 'colors', 'darkColors']);
const PALETTE_KEYS = Object.freeze([
  'canvas',
  'paper',
  'ink',
  'muted',
  'primary',
  'primaryDeep',
  'onPrimary',
  'accent',
  'onAccent',
  'line',
  'input',
  'danger',
  'onDanger',
  'shellForeground',
]);
const BUILT_IN_THEME_IDS = new Set(APPEARANCE_THEMES.map((theme) => theme.value));
const CUSTOM_THEME_ID_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function ownKeys(value) {
  return isPlainObject(value) ? Object.keys(value) : [];
}

function validationError(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function unicodeLength(value) {
  return [...value].length;
}

export function normalizeHexColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) return null;
  return value.toLowerCase();
}

export function hexToRgb(value) {
  const normalized = normalizeHexColor(value);
  if (!normalized) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function channelToHex(value) {
  return Math.round(value).toString(16).padStart(2, '0');
}

export function mixHexColors(from, to, amount) {
  const fromRgb = hexToRgb(from);
  const toRgb = hexToRgb(to);
  if (!fromRgb || !toRgb || !Number.isFinite(amount)) return null;
  const ratio = Math.min(1, Math.max(0, amount));
  return `#${channelToHex(fromRgb.r + ((toRgb.r - fromRgb.r) * ratio))}${channelToHex(fromRgb.g + ((toRgb.g - fromRgb.g) * ratio))}${channelToHex(fromRgb.b + ((toRgb.b - fromRgb.b) * ratio))}`;
}

function relativeLuminance(value) {
  const color = hexToRgb(value);
  if (!color) return Number.NaN;
  const channels = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

export function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (!Number.isFinite(foregroundLuminance) || !Number.isFinite(backgroundLuminance)) return Number.NaN;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbChannels(value) {
  const color = hexToRgb(value);
  return color ? `${color.r}, ${color.g}, ${color.b}` : null;
}

function derivedPaletteValues(palette) {
  return Object.freeze({
    canvasSoft: mixHexColors(palette.canvas, palette.paper, 0.35),
    paperSoft: mixHexColors(palette.paper, palette.canvas, 0.2),
    accentSoft: mixHexColors(palette.accent, palette.canvas, 0.82),
    canvasRgb: rgbChannels(palette.canvas),
    paperRgb: rgbChannels(palette.paper),
    inkRgb: rgbChannels(palette.ink),
    mutedRgb: rgbChannels(palette.muted),
    primaryRgb: rgbChannels(palette.primary),
    primaryDeepRgb: rgbChannels(palette.primaryDeep),
    onPrimaryRgb: rgbChannels(palette.onPrimary),
    accentRgb: rgbChannels(palette.accent),
    onAccentRgb: rgbChannels(palette.onAccent),
    lineRgb: rgbChannels(palette.line),
    inputRgb: rgbChannels(palette.input),
    dangerRgb: rgbChannels(palette.danger),
    onDangerRgb: rgbChannels(palette.onDanger),
    shellForegroundRgb: rgbChannels(palette.shellForeground),
  });
}

function inspectPalette(candidate, prefix, errors) {
  if (!isPlainObject(candidate)) {
    errors.push(validationError('invalid-type', prefix, `${prefix} must be a plain object`));
    return null;
  }
  const normalized = {};
  const known = new Set(PALETTE_KEYS);
  for (const key of ownKeys(candidate)) {
    if (!known.has(key)) {
      errors.push(validationError('unknown-key', `${prefix}.${key}`, `Unknown palette key: ${key}`));
    }
  }
  for (const key of PALETTE_KEYS) {
    if (!Object.hasOwn(candidate, key)) {
      errors.push(validationError('required', `${prefix}.${key}`, `${key} is required`));
      continue;
    }
    const color = normalizeHexColor(candidate[key]);
    if (!color) {
      errors.push(validationError('invalid-color', `${prefix}.${key}`, `${key} must be an exact six-digit hexadecimal color`));
      continue;
    }
    normalized[key] = color;
  }
  return Object.keys(normalized).length === PALETTE_KEYS.length ? normalized : null;
}

function inspectContrast(palette, prefix, errors) {
  const pairs = [
    ['ink', 'canvas', 4.5],
    ['ink', 'paper', 4.5],
    ['muted', 'canvas', 4.5],
    ['onPrimary', 'primary', 4.5],
    ['onAccent', 'accent', 4.5],
    ['onDanger', 'danger', 4.5],
    ['shellForeground', 'primaryDeep', 4.5],
    ['line', 'canvas', 3],
    ['line', 'paper', 3],
    ['danger', 'canvas', 4.5],
  ];
  for (const [foreground, background, minimum] of pairs) {
    const ratio = contrastRatio(palette[foreground], palette[background]);
    if (ratio + Number.EPSILON < minimum) {
      errors.push(validationError(
        'contrast',
        `${prefix}.${foreground}`,
        `${foreground} on ${background} must reach ${minimum}:1`,
        { foreground, background, ratio, minimum },
      ));
    }
  }
}

function normalizedDocument(name, description, colors, darkColors) {
  const document = {
    schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
    name,
    ...(description === undefined ? {} : { description }),
    colors: Object.freeze({ ...colors }),
    ...(darkColors ? { darkColors: Object.freeze({ ...darkColors }) } : {}),
    derived: derivedPaletteValues(colors),
    ...(darkColors ? { darkDerived: derivedPaletteValues(darkColors) } : {}),
  };
  return Object.freeze(document);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function publicDocumentShape(document) {
  if (!isPlainObject(document)) return document;
  const allowedKeys = new Set([...TOP_LEVEL_KEYS, 'derived', 'darkDerived']);
  if (Object.keys(document).some((key) => !allowedKeys.has(key))) return document;
  const publicDocument = {
    schemaVersion: document.schemaVersion,
    name: document.name,
    ...(Object.hasOwn(document, 'description') ? { description: document.description } : {}),
    colors: document.colors,
    ...(Object.hasOwn(document, 'darkColors') ? { darkColors: document.darkColors } : {}),
  };
  if (!Object.hasOwn(document, 'derived') && !Object.hasOwn(document, 'darkDerived')) return publicDocument;
  const validation = validateThemeDocument(publicDocument);
  if (!validation.valid) return document;
  if (canonicalJson(document.derived) !== canonicalJson(validation.document.derived)) return document;
  if (Object.hasOwn(document, 'darkColors')) {
    if (canonicalJson(document.darkDerived) !== canonicalJson(validation.document.darkDerived)) return document;
  } else if (Object.hasOwn(document, 'darkDerived')) {
    return document;
  }
  return publicDocument;
}

export function validateThemeDocument(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return {
      valid: false,
      errors: [validationError('invalid-type', '$', 'Theme document must be a plain object')],
    };
  }

  const knownTopLevel = new Set(TOP_LEVEL_KEYS);
  for (const key of ownKeys(candidate)) {
    if (!knownTopLevel.has(key)) {
      errors.push(validationError('unknown-key', key, `Unknown theme document key: ${key}`));
    }
  }

  if (candidate.schemaVersion !== CUSTOM_THEME_SCHEMA_VERSION) {
    errors.push(validationError('schema-version', 'schemaVersion', `schemaVersion must equal ${CUSTOM_THEME_SCHEMA_VERSION}`));
  }

  let name = null;
  if (typeof candidate.name !== 'string') {
    errors.push(validationError('invalid-type', 'name', 'name must be plain text'));
  } else {
    name = candidate.name.trim();
    if (!name || unicodeLength(name) > 80) {
      errors.push(validationError('length', 'name', 'name must contain 1 to 80 Unicode characters'));
    }
  }

  let description;
  if (Object.hasOwn(candidate, 'description')) {
    if (typeof candidate.description !== 'string') {
      errors.push(validationError('invalid-type', 'description', 'description must be plain text'));
    } else {
      description = candidate.description.trim();
      if (unicodeLength(description) > 240) {
        errors.push(validationError('length', 'description', 'description must contain at most 240 Unicode characters'));
      }
    }
  }

  const colors = inspectPalette(candidate.colors, 'colors', errors);
  let darkColors = null;
  if (Object.hasOwn(candidate, 'darkColors')) {
    darkColors = inspectPalette(candidate.darkColors, 'darkColors', errors);
  }

  if (colors) inspectContrast(colors, 'colors', errors);
  if (darkColors) inspectContrast(darkColors, 'darkColors', errors);

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    document: normalizedDocument(name, description, colors, darkColors),
  };
}

export function normalizeThemeDocument(candidate) {
  const result = validateThemeDocument(candidate);
  if (result.valid) return result.document;
  const error = new TypeError('Invalid Hermes Browser theme document');
  error.code = 'invalid-theme-document';
  error.validationErrors = result.errors;
  throw error;
}

export function themeCssVariables(palette) {
  if (!isPlainObject(palette) || Object.keys(palette).length !== PALETTE_KEYS.length) {
    throw new TypeError('themeCssVariables requires a normalized palette');
  }
  const normalizedPalette = {};
  for (const key of PALETTE_KEYS) {
    const color = normalizeHexColor(palette[key]);
    if (!color || color !== palette[key]) throw new TypeError('themeCssVariables requires a normalized palette');
    normalizedPalette[key] = color;
  }
  const derived = derivedPaletteValues(normalizedPalette);
  return Object.freeze({
    '--hermes-canvas': normalizedPalette.canvas,
    '--hermes-canvas-rgb': derived.canvasRgb,
    '--hermes-canvas-soft': derived.canvasSoft,
    '--hermes-paper': normalizedPalette.paper,
    '--hermes-paper-rgb': derived.paperRgb,
    '--hermes-paper-soft': derived.paperSoft,
    '--hermes-ink': normalizedPalette.ink,
    '--hermes-ink-rgb': derived.inkRgb,
    '--hermes-muted': normalizedPalette.muted,
    '--hermes-muted-rgb': derived.mutedRgb,
    '--hermes-blue': normalizedPalette.primary,
    '--hermes-blue-rgb': derived.primaryRgb,
    '--hermes-blue-deep': normalizedPalette.primaryDeep,
    '--hermes-blue-deep-rgb': derived.primaryDeepRgb,
    '--hermes-primary': normalizedPalette.primary,
    '--hermes-primary-rgb': derived.primaryRgb,
    '--hermes-on-primary': normalizedPalette.onPrimary,
    '--hermes-on-primary-rgb': derived.onPrimaryRgb,
    '--hermes-yellow': normalizedPalette.accent,
    '--hermes-yellow-rgb': derived.accentRgb,
    '--hermes-on-accent': normalizedPalette.onAccent,
    '--hermes-on-accent-rgb': derived.onAccentRgb,
    '--hermes-accent': normalizedPalette.accent,
    '--hermes-accent-rgb': derived.accentRgb,
    '--hermes-accent-soft': derived.accentSoft,
    '--hermes-line': normalizedPalette.line,
    '--hermes-line-rgb': derived.lineRgb,
    '--hermes-input-bg': normalizedPalette.input,
    '--hermes-input-bg-rgb': derived.inputRgb,
    '--hermes-red': normalizedPalette.danger,
    '--hermes-danger': normalizedPalette.danger,
    '--hermes-danger-rgb': derived.dangerRgb,
    '--hermes-on-danger': normalizedPalette.onDanger,
    '--hermes-on-danger-rgb': derived.onDangerRgb,
    '--hermes-shell-fg': normalizedPalette.shellForeground,
    '--hermes-shell-fg-rgb': derived.shellForegroundRgb,
  });
}

export function customThemePaletteForMode(document, resolvedMode) {
  if (!document || typeof document !== 'object') return null;
  return resolvedMode === 'dark' && document.darkColors ? document.darkColors : document.colors;
}

export function customThemeSelection(id, records = []) {
  if (typeof id !== 'string') return { kind: 'invalid', id: null };
  if (BUILT_IN_THEME_IDS.has(id)) return { kind: 'builtin', id };
  if (!CUSTOM_THEME_ID_RE.test(id)) return { kind: 'invalid', id };
  const record = Array.isArray(records) ? records.find((candidate) => candidate?.id === id) : null;
  if (!record) return { kind: 'missing', id };
  const result = validateThemeDocument(publicDocumentShape(record.document));
  if (!result.valid) return { kind: 'invalid', id, reason: 'invalid-record', errors: result.errors };
  return { kind: 'custom', id, record, document: result.document };
}

export function serializeThemeDocument(document) {
  const normalized = normalizeThemeDocument(publicDocumentShape(document));
  const exported = {
    schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
    name: normalized.name,
    ...(normalized.description === undefined ? {} : { description: normalized.description }),
    colors: { ...normalized.colors },
    ...(normalized.darkColors ? { darkColors: { ...normalized.darkColors } } : {}),
  };
  return `${JSON.stringify(exported, null, 2)}\n`;
}
