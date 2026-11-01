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
  if (match) return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alphaOf(match[4]) };
  // Chrome reports these as written: oklch()/oklab() (Tailwind v4, shadcn), lab()/lch(), and color()
  // for color-mix() results and wide-gamut colours.
  const modern = /^(oklab|oklch|lab|lch|color)\(\s*(?:(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\s+)?([-\d.e]+%?)\s+([-\d.e]+%?)\s+([-\d.e]+%?)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (!modern) return null;
  const [, kind, space, first, second, third, alphaText] = modern;
  const number = (part, percentScale = 1) => (part.endsWith('%') ? Number.parseFloat(part) / 100 * percentScale : Number(part));
  const alpha = alphaOf(alphaText);
  if (kind === 'color') return { ...colorSpaceToRgb(space || 'srgb', [number(first), number(second), number(third)]), a: alpha };
  if (kind === 'oklab' || kind === 'oklch') {
    const lightness = number(first);
    const chroma = number(second, 0.4);
    const hue = kind === 'oklch' ? (number(third) * Math.PI) / 180 : 0;
    const a = kind === 'oklch' ? chroma * Math.cos(hue) : chroma;
    const b = kind === 'oklch' ? chroma * Math.sin(hue) : number(third, 0.4);
    return { ...oklabToRgb(lightness, a, b), a: alpha };
  }
  // CIE Lab and LCH: relative luminance Y depends on lightness alone, which is all the tone needs.
  const lightness = number(first, 100);
  const y = lightness > 8 ? ((lightness + 16) / 116) ** 3 : lightness / 903.3;
  const gray = Math.round(255 * Math.min(1, Math.max(0, encodeChannel(y))));
  return { r: gray, g: gray, b: gray, a: alpha };
}

function alphaOf(text) {
  if (text === undefined) return 1;
  return text.endsWith('%') ? Number.parseFloat(text) / 100 : Number(text);
}

function encodeChannel(linear) {
  const value = Math.min(1, Math.max(0, linear));
  return value <= 0.0031308 ? value * 12.92 : 1.055 * (value ** (1 / 2.4)) - 0.055;
}

// color(<space> …) to sRGB bytes, through CIE XYZ (D65) with the CSS Color 4 matrices. Out-of-gamut
// channels are clipped, which is close enough for choosing a light or dark circle.
const multiply = (matrix, [x, y, z]) => matrix.map(([a, b, c]) => a * x + b * y + c * z);
const XYZ_D65_TO_LINEAR_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const signed = (decode) => (value) => Math.sign(value) * decode(Math.abs(value));
const srgbDecode = signed((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
const REC2020_ALPHA = 1.09929682680944;
const REC2020_BETA = 0.018053968510807;
const RGB_SPACES = {
  'display-p3': {
    decode: srgbDecode,
    toXyz: [[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]],
  },
  'a98-rgb': {
    decode: signed((value) => value ** (563 / 256)),
    toXyz: [[0.5766690429101305, 0.1855582379065463, 0.1882286462349947], [0.29734497525053605, 0.6273635662554661, 0.07529145849399788], [0.02703136138641234, 0.07068885253582723, 0.9913375368376388]],
  },
  rec2020: {
    decode: signed((value) => (value < REC2020_BETA * 4.5 ? value / 4.5 : ((value + REC2020_ALPHA - 1) / REC2020_ALPHA) ** (1 / 0.45))),
    toXyz: [[0.6369580483012914, 0.14461690358620832, 0.1688809751641721], [0.2627002120112671, 0.6779980715188708, 0.05930171646986196], [0, 0.028072693049087428, 1.060985057710791]],
  },
  'prophoto-rgb': {
    decode: signed((value) => (value <= 16 / 512 ? value / 16 : value ** 1.8)),
    toXyz: [[0.7977604896723027, 0.13518583717574031, 0.0313493495815248], [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902], [0, 0, 0.8251046025104601]],
    d50: true,
  },
};

function colorSpaceToRgb(space, channels) {
  let linear;
  if (space === 'srgb') linear = channels.map(srgbDecode);
  else if (space === 'srgb-linear') linear = channels;
  else if (space === 'xyz' || space === 'xyz-d65') linear = multiply(XYZ_D65_TO_LINEAR_SRGB, channels);
  else if (space === 'xyz-d50') linear = multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(D50_TO_D65, channels));
  else {
    const { decode, toXyz, d50 } = RGB_SPACES[space];
    const xyz = multiply(toXyz, channels.map(decode));
    linear = multiply(XYZ_D65_TO_LINEAR_SRGB, d50 ? multiply(D50_TO_D65, xyz) : xyz);
  }
  const [r, g, b] = linear.map((value) => Math.round(255 * encodeChannel(value)));
  return { r, g, b };
}

function oklabToRgb(lightness, a, b) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const toByte = (linear) => Math.round(255 * encodeChannel(linear));
  return {
    r: toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function channel(value) {
  const unit = Math.min(255, Math.max(0, Number(value) || 0)) / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

// WCAG relative luminance of the page behind the circle. A dark page gets a light circle; a light page,
// or one whose background could not be found, gets a dark circle, unless the page declares a dark-only
// colour-scheme, whose default canvas is dark.
export function circleToneForBackground(color, { colorScheme = '' } = {}) {
  if (!color) {
    const scheme = String(colorScheme || '').toLowerCase();
    return /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme) ? 'light' : 'dark';
  }
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
  'Rules Gothic Compressed': Object.freeze([face('assets/fonts/RulesGothicCmp-Medium.woff2', '500')]),
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

// The content script passes its own per-page prefix (a random token) so a page can neither guess nor
// pre-declare the names the panel registers.
export function namespaceFontStack(stack, prefix = INLINE_ASSIST_FONT_PREFIX) {
  const families = [];
  const renamed = String(stack || '').replace(/"([^"]+)"/g, (whole, family) => {
    if (!Object.hasOwn(INLINE_ASSIST_FONT_FILES, family)) return whole;
    if (!families.includes(family)) families.push(family);
    return `"${prefix}${family}"`;
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
export function inlineAssistFontStacks(fontProfile, profileStack, prefix = INLINE_ASSIST_FONT_PREFIX) {
  const signature = fontProfile === 'signature';
  const ui = namespaceFontStack(signature ? SIGNATURE_UI_STACK : profileStack, prefix);
  const display = signature ? namespaceFontStack(SIGNATURE_DISPLAY_STACK, prefix) : ui;
  const mono = namespaceFontStack(MONO_STACK, prefix);
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
