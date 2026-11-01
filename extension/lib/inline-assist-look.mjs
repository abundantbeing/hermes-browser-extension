// How Hermes Assist looks on a page: which icon the trigger circle carries, which tone the circle takes
// against the page behind it, and what clicking it opens. Import-free: scripts/build-content-runtime.mjs
// bundles it into the content script as globalThis.HermesInlineAssistLook.

export const INLINE_ASSIST_ICONS = Object.freeze(['wing', 'staff', 'girl']);
export const INLINE_ASSIST_OPEN_MODES = Object.freeze(['panel', 'quick']);

export function normalizeInlineAssistIcon(value) {
  return INLINE_ASSIST_ICONS.includes(value) ? value : 'wing';
}

export function normalizeInlineAssistOpenMode(value) {
  return value === 'quick' ? 'quick' : 'panel';
}

// A computed colour as getComputedStyle reports it (rgb()/rgba()), or a hex value.
export function parseCssColor(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join('') : hex;
    return { r: Number.parseInt(full.slice(0, 2), 16), g: Number.parseInt(full.slice(2, 4), 16), b: Number.parseInt(full.slice(4, 6), 16), a: 1 };
  }
  const match = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : (match[4].endsWith('%') ? Number.parseFloat(match[4]) / 100 : Number(match[4]));
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

function channel(value) {
  const unit = Math.min(255, Math.max(0, Number(value) || 0)) / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

// WCAG relative luminance of the page behind the circle. A dark page gets a light circle; a light page,
// or one whose background could not be found (treated as a white page), gets a dark circle.
export function circleToneForBackground(color) {
  if (!color) return 'dark';
  const luminance = 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  return luminance < 0.5 ? 'light' : 'dark';
}

// The packaged image the circle masks. The girl has two drawings: the outline art reads as light lines on
// the dark circle, and the solid art reads on the light circle, the same split as the startup screen.
export function inlineAssistIconAsset(icon, tone) {
  const chosen = normalizeInlineAssistIcon(icon);
  if (chosen === 'staff') return 'assets/img/assist-staff.svg';
  if (chosen === 'girl') return tone === 'dark' ? 'assets/img/assist-girl-outline.png' : 'assets/img/assist-girl-solid.png';
  return 'assets/img/assist-wing.png';
}

// Every bundled face a font profile can name, as sidepanel.css and lib/fonts.css declare it. The
// background serves these as bytes (font files are never web-accessible); the panel registers them
// under INLINE_ASSIST_FONT_PREFIX so a page's own fonts with the same name can not clash.
const face = (file, weight = '400', style = 'normal') => Object.freeze({ file, weight, style });
const google = (name, weights) => Object.freeze(weights.map((weight) => face(`assets/fonts/google/${name}-${weight}.woff2`, String(weight))));
export const INLINE_ASSIST_FONT_FILES = Object.freeze({
  'Rules Variable': Object.freeze([face('assets/fonts/RulesVariable.woff2', '100 900')]),
  'Rules Gothic Compressed': Object.freeze([face('assets/fonts/RulesGothicCmp-Medium.woff2', '100 900')]),
  Collapse: Object.freeze([face('assets/fonts/Collapse-Light.woff2', '300'), face('assets/fonts/Collapse-Regular.woff2', '400'), face('assets/fonts/Collapse-Bold.woff2', '700')]),
  HermesDisplay: Object.freeze([face('assets/fonts/Sigurd-Variable.woff2', '300 800')]),
  HermesMono: Object.freeze([face('assets/fonts/CourierPrime-Regular.woff2')]),
  Montserrat: google('Montserrat', [400, 600, 700]),
  'Source Sans 3': google('SourceSans3', [400, 600]),
  'IBM Plex Sans': google('IBMPlexSans', [400, 600]),
  Outfit: google('Outfit', [400, 600]),
  'Space Grotesk': google('SpaceGrotesk', [400, 600]),
  'Playfair Display': google('PlayfairDisplay', [400, 700]),
  'Libre Baskerville': google('LibreBaskerville', [400, 700]),
  Fraunces: google('Fraunces', [400, 700]),
  Cinzel: google('Cinzel', [400, 700]),
});
export const INLINE_ASSIST_FONT_PREFIX = 'HermesAssist ';

export function namespaceFontStack(stack) {
  const families = [];
  const renamed = String(stack || '').replace(/"([^"]+)"/g, (whole, family) => {
    if (!Object.hasOwn(INLINE_ASSIST_FONT_FILES, family)) return whole;
    if (!families.includes(family)) families.push(family);
    return `"${INLINE_ASSIST_FONT_PREFIX}${family}"`;
  });
  return { stack: renamed, families };
}

// The panel's text, heading and code stacks for a font profile. The caller passes the profile's own
// stack (HermesAppearancePreferences.fontFamilyPreview), since this module stays import-free. Signature
// mirrors the side panel's own tokens: Rules Variable for text, Rules Gothic Compressed for headings,
// with the bundled Space Grotesk and HermesDisplay standing in when the licensed faces are absent.
const SIGNATURE_UI_STACK = '"Rules Variable", "Space Grotesk", "Segoe UI", system-ui, sans-serif';
const SIGNATURE_DISPLAY_STACK = '"Rules Gothic Compressed", "HermesDisplay", "Rules Variable", "Space Grotesk", sans-serif';
const MONO_STACK = '"HermesMono", ui-monospace, Consolas, monospace';
export function inlineAssistFontStacks(fontProfile, profileStack) {
  const signature = fontProfile === 'signature';
  const ui = namespaceFontStack(signature ? SIGNATURE_UI_STACK : profileStack);
  const display = signature ? namespaceFontStack(SIGNATURE_DISPLAY_STACK) : ui;
  const mono = namespaceFontStack(MONO_STACK);
  return {
    ui: ui.stack,
    display: display.stack,
    mono: mono.stack,
    families: [...new Set([...ui.families, ...display.families, ...mono.families])],
  };
}

export const INLINE_ASSIST_LOOK_API = Object.freeze({
  icons: INLINE_ASSIST_ICONS,
  openModes: INLINE_ASSIST_OPEN_MODES,
  fontFiles: INLINE_ASSIST_FONT_FILES,
  fontPrefix: INLINE_ASSIST_FONT_PREFIX,
  normalizeInlineAssistIcon,
  normalizeInlineAssistOpenMode,
  parseCssColor,
  circleToneForBackground,
  inlineAssistIconAsset,
  namespaceFontStack,
  inlineAssistFontStacks,
});
