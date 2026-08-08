import {
  contrastRatio,
  mixHexColors,
  normalizeHexColor,
  validateThemeDocument,
} from './custom-themes.mjs';

const HEX_SOURCE_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const PALETTE_KEYS = Object.freeze([
  'canvas', 'paper', 'ink', 'muted', 'primary', 'primaryDeep', 'onPrimary',
  'accent', 'onAccent', 'line', 'input', 'danger', 'onDanger', 'shellForeground',
]);

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function vscodeThemeSlug(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `vsc-${base || 'theme'}`;
}

function cleanJsonc(text) {
  if (typeof text !== 'string') throw codedError('invalid-theme-json', 'Theme source must be text');
  let output = '';
  let state = 'normal';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === 'string') {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') state = 'normal';
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') {
        output += char;
        state = 'normal';
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'normal';
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
      }
      continue;
    }
    if (char === '"') {
      output += char;
      state = 'string';
    } else if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else {
      output += char;
    }
  }
  if (state === 'string') throw codedError('jsonc-unterminated-string', 'Theme JSONC contains an unterminated string');
  if (state === 'block-comment') throw codedError('jsonc-unterminated-block-comment', 'Theme JSONC contains an unterminated block comment');
  if (state === 'line-comment') throw codedError('jsonc-unterminated-line-comment', 'Theme JSONC contains an unterminated line comment');

  let cleaned = '';
  state = 'normal';
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (state === 'string') {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') state = 'normal';
      continue;
    }
    if (char === '"') {
      cleaned += char;
      state = 'string';
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (/\s/.test(output[lookahead] || '')) lookahead += 1;
      if (output[lookahead] === '}' || output[lookahead] === ']') continue;
    }
    cleaned += char;
  }
  return cleaned;
}

export function parseVscodeTheme(text) {
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonc(text));
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('invalid-theme-json', 'Theme file is not valid JSON or JSONC', error);
  }
  if (!isPlainObject(parsed)) throw codedError('invalid-theme-json', 'Theme file must contain a plain JSON object');
  return parsed;
}

function rgb(value) {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function hexByte(value) {
  return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
}

function sourceColor(value, backdrop) {
  if (typeof value !== 'string' || !HEX_SOURCE_RE.test(value.trim())) return null;
  const raw = value.trim().toLowerCase();
  const digits = raw.slice(1);
  const expanded = digits.length <= 4 ? [...digits].map((char) => `${char}${char}`).join('') : digits;
  const opaque = `#${expanded.slice(0, 6)}`;
  if (expanded.length === 6) return normalizeHexColor(opaque);
  const alpha = Number.parseInt(expanded.slice(6, 8), 16) / 255;
  const foreground = rgb(opaque);
  const background = rgb(backdrop);
  return `#${hexByte((foreground.r * alpha) + (background.r * (1 - alpha)))}${hexByte((foreground.g * alpha) + (background.g * (1 - alpha)))}${hexByte((foreground.b * alpha) + (background.b * (1 - alpha)))}`;
}

function luminance(value) {
  const color = rgb(value);
  const channels = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function readableOn(background) {
  return contrastRatio('#ffffff', background) >= contrastRatio('#000000', background) ? '#ffffff' : '#000000';
}

function repairAgainst(color, backgrounds, minimum) {
  const targets = ['#000000', '#ffffff'];
  const score = (candidate) => Math.min(...backgrounds.map((background) => contrastRatio(candidate, background)));
  if (score(color) >= minimum) return color;
  const target = targets.sort((a, b) => score(b) - score(a))[0];
  if (score(target) < minimum) return target;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = mixHexColors(color, target, middle);
    if (score(candidate) >= minimum) high = middle;
    else low = middle;
  }
  return mixHexColors(color, target, high);
}

function unique(values) {
  return [...new Set(values)];
}

function modeFor(raw, canvas) {
  const type = String(raw.type || '').toLowerCase();
  if (type.includes('light') || type === 'vs') return 'light';
  if (type === 'dark' || type === 'hc' || type === 'hc-black' || type.includes('dark') || type === 'vs-dark') return 'dark';
  return luminance(canvas) < 0.4 ? 'dark' : 'light';
}

function publicDocument(name, description, colors, darkColors = colors) {
  const candidate = { schemaVersion: 1, name, description, colors, darkColors };
  const validation = validateThemeDocument(candidate);
  if (!validation.valid) {
    const error = codedError('conversion-invalid', 'Converted theme failed Hermes Browser validation');
    error.validationErrors = validation.errors;
    throw error;
  }
  return {
    schemaVersion: 1,
    name: validation.document.name,
    description: validation.document.description,
    colors: { ...validation.document.colors },
    darkColors: { ...validation.document.darkColors },
  };
}

export function convertVscodeColorTheme(raw, options = {}) {
  if (!isPlainObject(raw.colors)) throw codedError('missing-colors', 'Theme has no colors map');
  const colors = raw.colors;
  const derived = [];
  const adjusted = [];
  const unsupported = raw.include ? ['include'] : [];

  const provisionalCanvas = sourceColor(colors['editor.background'], '#000000')
    || sourceColor(colors['editorPane.background'], '#000000')
    || sourceColor(colors['editorGroup.background'], '#000000');
  const provisionalMode = modeFor(raw, provisionalCanvas || '#1e1e1e');
  const canvas = provisionalCanvas || (provisionalMode === 'dark' ? '#1e1e1e' : '#ffffff');
  if (!provisionalCanvas) derived.push('canvas');
  const mode = modeFor(raw, canvas);

  const take = (semanticKey, keys, fallback) => {
    for (const key of keys) {
      const value = sourceColor(colors[key], canvas);
      if (value) return value;
    }
    derived.push(semanticKey);
    return fallback;
  };

  const baseInk = take('ink', ['editor.foreground', 'foreground'], mode === 'dark' ? '#f1f1f1' : '#171717');
  const basePaper = take('paper', ['editorWidget.background', 'dropdown.background', 'menu.background', 'quickInput.background', 'editorSuggestWidget.background'], mixHexColors(canvas, baseInk, mode === 'dark' ? 0.08 : 0.05));
  const basePrimary = take('primary', ['button.background', 'textLink.activeForeground', 'textLink.foreground', 'activityBarBadge.background', 'badge.background', 'progressBar.background', 'pickerGroup.foreground', 'focusBorder', 'tab.activeBorder'], mixHexColors(baseInk, canvas, 0.45));
  const baseMuted = take('muted', ['descriptionForeground', 'editorLineNumber.foreground', 'tab.inactiveForeground', 'disabledForeground'], mixHexColors(baseInk, canvas, 0.38));
  const baseLine = take('line', ['panel.border', 'editorGroup.border', 'sideBar.border', 'contrastBorder', 'widget.border', 'input.border'], mixHexColors(baseInk, canvas, 0.55));
  const input = take('input', ['input.background', 'dropdown.background', 'quickInput.background'], mixHexColors(canvas, baseInk, mode === 'dark' ? 0.1 : 0.06));
  const baseDanger = take('danger', ['editorError.foreground', 'errorForeground', 'editorOverviewRuler.errorForeground', 'notificationsErrorIcon.foreground'], '#b00020');

  const ink = repairAgainst(baseInk, [canvas, basePaper], 4.5);
  const paper = basePaper;
  const muted = repairAgainst(baseMuted, [canvas], 4.5);
  const primary = basePrimary;
  derived.push('primaryDeep');
  const primaryDeepBase = mixHexColors(primary, mode === 'dark' ? '#000000' : '#ffffff', 0.36);
  const onPrimary = readableOn(primary);
  derived.push('onPrimary');
  derived.push('accent');
  const accent = mixHexColors(primary, readableOn(primary), 0.28);
  const onAccent = readableOn(accent);
  derived.push('onAccent');
  const line = repairAgainst(baseLine, [canvas, paper], 3);
  const danger = repairAgainst(baseDanger, [canvas], 4.5);
  const onDanger = readableOn(danger);
  derived.push('onDanger');
  const shellForeground = readableOn(primaryDeepBase);
  derived.push('shellForeground');
  const primaryDeep = repairAgainst(primaryDeepBase, [shellForeground], 4.5);

  const comparisons = {
    ink: [baseInk, ink], muted: [baseMuted, muted], line: [baseLine, line],
    danger: [baseDanger, danger], primaryDeep: [primaryDeepBase, primaryDeep],
  };
  for (const [key, [before, after]] of Object.entries(comparisons)) {
    if (before !== after) adjusted.push(key);
  }

  const palette = {
    canvas, paper, ink, muted, primary, primaryDeep, onPrimary,
    accent, onAccent, line, input, danger, onDanger, shellForeground,
  };
  if (Object.keys(palette).length !== PALETTE_KEYS.length) throw codedError('conversion-invalid', 'Converted palette is incomplete');

  const label = String(options.label || raw.name || 'VS Code Theme').trim().slice(0, 80) || 'VS Code Theme';
  const sourceId = typeof options.sourceId === 'string' ? options.sourceId.trim() : '';
  const description = `VS Code${sourceId ? ` · ${sourceId}` : ''}`;
  const document = publicDocument(label, description, palette, palette);
  return {
    document,
    palette: document.colors,
    mode,
    derived: unique(derived),
    adjusted: unique(adjusted),
    unsupported,
    slug: vscodeThemeSlug(label),
  };
}

export function buildVscodeThemeFamily(contributions, options = {}) {
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw codedError('no-color-themes', 'Package does not contribute any color themes');
  }
  let light = null;
  let dark = null;
  for (const contribution of contributions) {
    if (!isPlainObject(contribution) || typeof contribution.contents !== 'string') continue;
    const raw = parseVscodeTheme(contribution.contents);
    if (!raw.name && contribution.label) raw.name = contribution.label;
    if (!raw.type && contribution.uiTheme) raw.type = contribution.uiTheme;
    const converted = convertVscodeColorTheme(raw, {
      label: contribution.label || raw.name,
      sourceId: options.sourceId,
    });
    if (converted.mode === 'light' && !light) light = converted;
    if (converted.mode === 'dark' && !dark) dark = converted;
    if (light && dark) break;
  }
  const selected = [light, dark].filter(Boolean);
  if (selected.length === 0) throw codedError('no-color-themes', 'Package has no readable color-theme contributions');
  const fallback = selected[0];
  const lightPalette = light?.palette || fallback.palette;
  const darkPalette = dark?.palette || fallback.palette;
  const displayName = String(options.displayName || fallback.document.name || 'VS Code Theme').trim().slice(0, 80) || 'VS Code Theme';
  const sourceId = typeof options.sourceId === 'string' ? options.sourceId.trim() : '';
  const document = publicDocument(displayName, `VS Code${sourceId ? ` · ${sourceId}` : ''}`, lightPalette, darkPalette);
  return {
    document,
    variantCount: selected.length,
    derived: unique(selected.flatMap((item) => item.derived)),
    adjusted: unique(selected.flatMap((item) => item.adjusted)),
    unsupported: unique(selected.flatMap((item) => item.unsupported)),
  };
}
