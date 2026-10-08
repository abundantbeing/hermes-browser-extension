import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Picker hover/focus contrast across light palettes. Parses the real CSS;
// sidepanel.css loads before sidepanel-themes.css (sidepanel.html), so later rules win ties.
const sidepanelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const themesCss = readFileSync(new URL('../extension/sidepanel-themes.css', import.meta.url), 'utf8');
const LIGHT_PALETTE = /^html\[data-hermes-theme="([^"]+)"\]\[data-hermes-mode="light"\]$/;

function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorText, body]) => ({
    selectors: selectorText.replace(/\s+/g, ' ').trim().split(',').map((s) => s.trim()).filter(Boolean),
    decls: Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    })),
  }));
}
const RULES = [...parseRules(sidepanelCss), ...parseRules(themesCss)];

function specificity(selector) {
  const s = selector.replace(/\[[^\]]*\]/g, ' [a] ').replace(/:not\(([^)]*)\)/g, ' $1 ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[a\]/g) || []).length
    + (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
  const types = (s.replace(/\[a\]|\.[\w-]+|#[\w-]+|:+[\w-]+(\([^)]*\))?/g, ' ').match(/\b[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const maxSpec = (list) => list.reduce((best, s) => (best && cmp(best, s) >= 0 ? best : s), null);
const hasDecl = (suffix, prop, value) => RULES.some((r) => r.selectors.some((s) => s.endsWith(suffix)) && r.decls[prop] === value);
const declOf = (suffix, prop) => RULES.find((r) => r.selectors.some((s) => s.endsWith(suffix)) && r.decls[prop] !== undefined)?.decls[prop];

const palettes = (() => {
  const out = new Map();
  for (const r of RULES) for (const s of r.selectors) {
    const m = LIGHT_PALETTE.exec(s);
    if (!m) continue;
    const tokens = Object.fromEntries(Object.entries(r.decls).filter(([k]) => k.startsWith('--hermes-')));
    out.set(m[1], { ...(out.get(m[1]) ?? {}), ...tokens });
  }
  return out;
})();

function rgbOf(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const nums = String(value ?? '').split(',').map((v) => Number(v.trim()));
  assert.ok(nums.length === 3 && nums.every(Number.isFinite), `unsupported colour token: ${value}`);
  return nums;
}
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const mix = (top, alpha, bottom) => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha));
const primaryPair = (tok) => ({
  fill: rgbOf(tok['--hermes-primary-bg'] ?? tok['--hermes-ink']),
  text: rgbOf(tok['--hermes-primary-fg'] ?? tok['--hermes-paper']),
});

test('provider hover and focus pair fill and text above every light theme colour override', () => {
  const themeMax = maxSpec(RULES.flatMap((r) => (r.decls.color === undefined ? [] : r.selectors))
    .filter((s) => s.includes('data-hermes-theme=') && s.includes('data-hermes-mode="light"') && /\.model-provider-option(?![\w-])/.test(s) && !s.includes('.selected'))
    .map(specificity));
  assert.ok(themeMax, 'expected light theme colour overrides on .model-provider-option');
  const outranks = (s, suffix) => s.endsWith(suffix) && cmp(specificity(s), themeMax) > 0;
  const rule = RULES.find((r) => r.selectors.some((s) => outranks(s, '.model-provider-option:hover'))
    && r.selectors.some((s) => outranks(s, '.model-provider-option:focus-visible'))
    && r.decls.background !== undefined && /primary-fg/.test(r.decls.color ?? ''));
  assert.ok(rule, `no provider hover+focus rule outranks theme override specificity ${themeMax}`);
});

test('every light palette resolves a readable primary fill and text', () => {
  assert.equal(palettes.size, 12, `light palettes: ${[...palettes.keys()].join(', ')}`);
  for (const [name, tok] of palettes) {
    const { fill, text } = primaryPair(tok);
    assert.ok(contrast(text, fill) >= 4.5, `${name}: primary text ${contrast(text, fill).toFixed(2)}:1`);
  }
});

test('provider count keeps 4.5:1 on hover, focus and selected rows in light palettes', () => {
  const restOpacity = Number(declOf('.model-provider-count', 'opacity') ?? 1);
  const lightRule = RULES.find((r) => r.selectors.some((s) => s.includes('data-hermes-mode="light"') && s.endsWith('.model-provider-count')) && r.decls.opacity !== undefined);
  const opacity = lightRule ? Number(lightRule.decls.opacity) : restOpacity;
  for (const [name, tok] of palettes) {
    const { fill, text } = primaryPair(tok);
    const shown = mix(text, opacity, fill);
    assert.ok(contrast(shown, fill) >= 4.5, `${name}: count ${contrast(shown, fill).toFixed(2)}:1 at opacity ${opacity}`);
  }
});

test('focused model rows keep name and meta inside the inverse fill', () => {
  assert.ok(hasDecl('.model-option:focus-visible .model-option-meta', 'color', 'inherit'));
  assert.ok(hasDecl('.model-option:focus-visible .model-option-name', 'color', 'inherit'));
});

test('observed model rows keep primary text when focused', () => {
  assert.ok(hasDecl('.model-option.observed:focus-visible', 'color', 'var(--hermes-primary-fg, var(--hermes-paper))'));
});

test('legacy effort rows keep strong text inside the focused fill', () => {
  assert.ok(hasDecl('.model-effort-option:focus-visible strong', 'color', 'inherit'));
});

test('light model meta on hover reaches 4.5:1 over the tinted row', () => {
  const alphaOf = (css) => Number(/rgba\(var\(--hermes-fg-rgb\),\s*([\d.]+)\)/.exec(css ?? '')?.[1]);
  const tint = alphaOf(RULES.find((r) => r.selectors.some((s) => s.endsWith('.model-option:hover')) && /--hermes-fg-rgb/.test(r.decls.background ?? ''))?.decls.background);
  const metaCss = RULES.find((r) => r.selectors.some((s) => s.includes('data-hermes-mode="light"') && s.endsWith('.model-option:hover .model-option-meta')))?.decls.color
    ?? RULES.find((r) => r.selectors.includes('.model-option-meta'))?.decls.color;
  const meta = alphaOf(metaCss);
  assert.ok(Number.isFinite(tint) && Number.isFinite(meta), `tint=${tint} meta=${meta}`);
  for (const [name, tok] of palettes) {
    const fg = rgbOf(tok['--hermes-fg-rgb'] ?? tok['--hermes-fg']);
    const menu = rgbOf(tok['--hermes-menu-bg']);
    const row = mix(fg, tint, menu);
    const text = mix(fg, meta, row);
    assert.ok(contrast(text, row) >= 4.5, `${name}: meta ${contrast(text, row).toFixed(2)}:1 at alpha ${meta}`);
  }
});
