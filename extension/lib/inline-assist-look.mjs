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

export const INLINE_ASSIST_LOOK_API = Object.freeze({
  icons: INLINE_ASSIST_ICONS,
  openModes: INLINE_ASSIST_OPEN_MODES,
  normalizeInlineAssistIcon,
  normalizeInlineAssistOpenMode,
  parseCssColor,
  circleToneForBackground,
  inlineAssistIconAsset,
});
