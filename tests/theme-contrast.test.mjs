import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Light-theme hover/contrast contract for the panel and the full tab.
 *
 * Background: hovering a control on a light palette used to drop its tile (the hover
 * re-used the surrounding surface colour or a hardcoded white) and pale `--hermes-accent`
 * text made enabled controls read as disabled. The fix standardises every hover/focus-visible
 * state on one token pair — the theme's action surface with ink/paper fallbacks — which is
 * asserted here per theme, together with the SAVE/TEST/X row that was unreadable in light mode.
 */

const root = path.resolve(import.meta.dirname, '..');

const sidepanelCss = readFileSync(path.join(root, 'extension', 'sidepanel.css'), 'utf8');
const sidepanelThemesCss = readFileSync(path.join(root, 'extension', 'sidepanel-themes.css'), 'utf8');
const contextMenuCss = readFileSync(path.join(root, 'extension', 'context-menu-editor.css'), 'utf8');
const appCss = readFileSync(path.join(root, 'extension', 'app.css'), 'utf8');
const appParityCss = readFileSync(path.join(root, 'extension', 'app-parity.css'), 'utf8');
const designTokensCss = readFileSync(path.join(root, 'extension', 'lib', 'design-tokens.css'), 'utf8');
const fulltabThemesCss = readFileSync(path.join(root, 'extension', 'fulltab-themes.css'), 'utf8');

const SIDE_PANEL_BUNDLE = [sidepanelCss, sidepanelThemesCss, contextMenuCss];
const FULL_TAB_BUNDLE = [designTokensCss, appCss, appParityCss, fulltabThemesCss];

const ACTION_PAIR = [
  'background: var(--hermes-primary-bg, var(--hermes-ink))',
  'color: var(--hermes-primary-fg, var(--hermes-paper))',
  'border-color: var(--hermes-primary-fg, var(--hermes-paper))',
];

// ---------------------------------------------------------------------------
// tiny CSS readers (no deps, deterministic)
// ---------------------------------------------------------------------------

function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rules(css) {
  const source = withoutComments(css);
  const out = [];
  let index = 0;
  let selectorStart = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '{') {
      const selector = source.slice(selectorStart, index).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let end = index + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
        end += 1;
      }
      out.push({ selector, body: source.slice(index + 1, end - 1) });
      index = end;
      selectorStart = index;
      continue;
    }
    if (char === '}') selectorStart = index + 1;
    index += 1;
  }
  return out;
}

function declarations(body) {
  const out = new Map();
  for (const match of body.matchAll(/([-a-zA-Z0-9_]+)\s*:\s*([^;{}]+)/g)) {
    out.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return out;
}

function themeTokenBlocks(css) {
  return rules(css)
    .filter((rule) => /^html\[data-hermes-theme/.test(rule.selector) && !/[.:#\s]>+[^{]*\{/.test(rule.selector))
    .map((rule) => {
      const theme = /data-hermes-theme(?:="([^"]*)")?/.exec(rule.selector)?.[1] ?? '';
      const mode = /data-hermes-mode="([^"]+)"/.exec(rule.selector)?.[1] ?? '';
      return { selector: rule.selector, theme, mode, tokens: declarations(rule.body) };
    });
}

function paletteFor(fileCssList, theme, mode) {
  const tokens = new Map();
  for (const css of fileCssList) {
    for (const block of themeTokenBlocks(css)) {
      const matchesRoot = block.selector === ':root';
      const matchesTheme = block.theme === theme && (block.mode === mode || block.mode === '');
      if (matchesRoot || matchesTheme) {
        for (const [key, value] of block.tokens) tokens.set(key, value);
      }
    }
  }
  return tokens;
}

function resolveToken(tokens, name, seen = new Set()) {
  const value = tokens.get(name);
  if (value === undefined || seen.has(name)) return undefined;
  const reference = /^var\(\s*(--[-a-zA-Z0-9_]+)\s*(?:,([\s\S]*))?\)$/.exec(value.trim());
  if (!reference) return value;
  seen.add(name);
  const resolved = resolveToken(tokens, reference[1], seen);
  if (resolved !== undefined) return resolved;
  return reference[2] === undefined ? undefined : resolveToken(tokens, reference[2].trim(), seen);
}

function substitute(tokens, value, depth = 0) {
  if (depth > 8 || typeof value !== 'string') return value;
  return value.replace(/var\(\s*(--[-a-zA-Z0-9_]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (match, name, fallback) => {
    const resolved = resolveToken(tokens, name);
    if (resolved !== undefined) return substitute(tokens, resolved, depth + 1);
    if (fallback !== undefined) return substitute(tokens, fallback.trim(), depth + 1);
    return match;
  });
}

function color(value, over = { r: 255, g: 255, b: 255 }) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/(.)/g, '$1$1') : hex[1];
    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
  if (!rgb) return undefined;
  const parsed = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  if (parsed.a >= 1) return parsed;
  return {
    r: parsed.r * parsed.a + over.r * (1 - parsed.a),
    g: parsed.g * parsed.a + over.g * (1 - parsed.a),
    b: parsed.b * parsed.a + over.b * (1 - parsed.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function ruleFor(css, selectorFragment) {
  const all = rules(css);
  const found = all.find((rule) => rule.selector.split(',').some((part) => part.trim() === selectorFragment))
    ?? all.find((rule) => rule.selector.split(',').some((part) => part.trim().endsWith(selectorFragment)));
  assert.ok(found, `expected a rule for ${selectorFragment}`);
  return found.body.replace(/\s+/g, ' ');
}

function cssVariableNames(css) {
  const names = new Set();
  for (const match of withoutComments(css).matchAll(/(--hermes[-a-zA-Z0-9_]*)\s*:/g)) names.add(match[1]);
  return names;
}

// ---------------------------------------------------------------------------
// 1. which palettes are light?
// ---------------------------------------------------------------------------

const BUILT_IN_THEMES = ['nous', 'midnight', 'ember', 'mono', 'cyberpunk', 'slate', 'senter-space', 'aurora', 'solstice'];
const LIGHT_THEMES = ['nous', 'midnight', 'ember', 'mono', 'cyberpunk', 'slate', 'senter-space', 'aurora', 'solstice'];

function panelPalette(theme, mode) {
  return paletteFor(SIDE_PANEL_BUNDLE, theme, mode);
}

test('every built-in theme declares a light and a dark palette, and the paper token identifies light', () => {
  const light = [];
  const dark = [];
  for (const theme of BUILT_IN_THEMES) {
    for (const mode of ['light', 'dark']) {
      const tokens = panelPalette(theme, mode);
      const paper = color(resolveToken(tokens, '--hermes-paper'));
      const ink = color(resolveToken(tokens, '--hermes-ink'));
      assert.ok(paper, `${theme}/${mode} should define --hermes-paper`);
      assert.ok(ink, `${theme}/${mode} should define --hermes-ink`);
      (luminance(paper) > 0.5 ? light : dark).push(theme);
      assert.ok(contrast(paper, ink) >= 7, `${theme}/${mode} paper and ink should be a strong pair`);
    }
  }
  assert.deepEqual(light.sort(), [...LIGHT_THEMES].sort(), 'light palettes (paper luminance > 0.5) should be the nine light themes');
  assert.equal(dark.length, BUILT_IN_THEMES.length, 'each theme should also resolve a dark palette');
});

// ---------------------------------------------------------------------------
// 2. the standardised hover pair is guaranteed to contrast in every palette
// ---------------------------------------------------------------------------

test('the outlined-inverted hover pair keeps >= 4.5:1 text contrast in every built-in palette', () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const mode of ['light', 'dark']) {
      const tokens = panelPalette(theme, mode);
      const paper = color(resolveToken(tokens, '--hermes-paper'));
      const ink = color(resolveToken(tokens, '--hermes-ink'));
      const primaryBg = color(resolveToken(tokens, '--hermes-primary-bg')) ?? ink;
      const primaryFg = color(resolveToken(tokens, '--hermes-primary-fg')) ?? paper;
      assert.ok(
        contrast(primaryFg, primaryBg) >= 4.5,
        `${theme}/${mode}: hover label on the action surface should read (got ${contrast(primaryFg, primaryBg).toFixed(2)}:1)`,
      );
      // the inverse direction is used by controls whose resting tile is already filled
      assert.ok(
        contrast(primaryBg, primaryFg) >= 4.5,
        `${theme}/${mode}: the filled resting tile should also read`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. no hover/focus state hides a control behind the surrounding surface
// ---------------------------------------------------------------------------

const BOUNDARY_PROPERTIES = ['border-color', 'border', 'box-shadow', 'outline', 'background-image'];

test('no hover/focus rule paints a hardcoded white tile or overlay', () => {
  for (const [label, css] of [['sidepanel.css', sidepanelCss], ['app.css', appCss]]) {
    for (const rule of rules(css)) {
      if (!/:hover|:focus-visible/.test(rule.selector)) continue;
      const decls = declarations(rule.body);
      const background = decls.get('background') ?? decls.get('background-color') ?? '';
      assert.doesNotMatch(
        background,
        /#fff\b|#ffffff|rgba?\(\s*255\s*,\s*255\s*,\s*255/i,
        `${label}: ${rule.selector} must not paint a hardcoded white background`,
      );
    }
  }
});

test('a hover that repaints the body with the surface token must still draw a boundary', () => {
  for (const [label, css] of [['sidepanel.css', sidepanelCss], ['app.css', appCss]]) {
    for (const rule of rules(css)) {
      if (!/:hover|:focus-visible/.test(rule.selector)) continue;
      const decls = declarations(rule.body);
      const background = (decls.get('background') ?? decls.get('background-color') ?? '').trim();
      if (!/^var\(--hermes-paper\)$/.test(background)) continue;
      const boundary = BOUNDARY_PROPERTIES.some((property) => decls.has(property));
      assert.ok(boundary, `${label}: ${rule.selector} hides the control body in the surface colour without a boundary`);
    }
  }
});

test('hover/focus rules never reference an undefined theme token without a fallback', () => {
  for (const [label, css, bundle] of [
    ['sidepanel.css', sidepanelCss, SIDE_PANEL_BUNDLE],
    ['app.css', appCss, FULL_TAB_BUNDLE],
  ]) {
    const defined = new Set();
    for (const part of bundle) for (const name of cssVariableNames(part)) defined.add(name);
    for (const rule of rules(css)) {
      if (!/:hover|:focus-visible/.test(rule.selector)) continue;
      for (const match of rule.body.matchAll(/var\(\s*(--hermes[-a-zA-Z0-9_]*)\s*([,)])/g)) {
        const [, name, terminator] = match;
        if (defined.has(name)) continue;
        assert.equal(terminator, ',', `${label}: ${rule.selector} references ${name} which no stylesheet defines, so it needs a fallback`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. the named controls all use the one outlined-inverted treatment
// ---------------------------------------------------------------------------

const OUTLINED_INVERTED_SELECTORS = [
  'button:hover',
  'button:focus-visible',
  '.settings-button:hover',
  '.settings-button:focus-visible',
  '#newSessionButton:hover',
  '#newSessionButton:focus-visible',
  '.settings-close-icon:hover',
  '.settings-close-icon:focus-visible',
  '.hero-dismiss:hover',
  '.browser-control-dismiss:hover',
  '.settings-connection-test:hover',
  '#saveSettingsTopButton:hover',
  '.bot-mode-head-action:hover',
  '.marketplace-theme-search button:hover',
  '.marketplace-theme-card button:hover',
  '#textZoomPresetGrid [data-text-zoom-percent]:hover',
  '.operation-toast button:hover',
  '.side-question-close:hover',
];

test('every named control hovers with the action-pair tile, its label colour outline, and no pale accent', () => {
  for (const selector of OUTLINED_INVERTED_SELECTORS) {
    const body = ruleFor(sidepanelCss, selector);
    const boundary = body.includes('border-color: var(--hermes-primary-fg, var(--hermes-paper))')
      || body.includes('border: 1px solid var(--hermes-primary-fg, var(--hermes-paper))');
    assert.ok(boundary, `${selector} should outline itself in the label colour (got: ${body})`);
    for (const declaration of ACTION_PAIR.filter((entry) => !entry.startsWith('border-color'))) {
      assert.ok(body.includes(declaration), `${selector} should declare "${declaration}" (got: ${body})`);
    }
    assert.doesNotMatch(body, /255,\s*255,\s*255/, `${selector} must not use a hardcoded white`);
    assert.doesNotMatch(body, /color: var\(--hermes-accent\)/, `${selector} must not paint its label in the pale accent`);
  }
});

test('the text-zoom stepper inverts into the action pair on hover (it draws dividers, not an outline)', () => {
  for (const selector of ['#textZoomDecreaseButton:hover', '#textZoomIncreaseButton:hover']) {
    const body = ruleFor(sidepanelCss, selector);
    assert.ok(body.includes('background: var(--hermes-primary-bg, var(--hermes-ink))'), `${selector} should invert its tile`);
    assert.ok(body.includes('color: var(--hermes-primary-fg, var(--hermes-paper))'), `${selector} should invert its glyph`);
    assert.doesNotMatch(body, /255,\s*255,\s*255/, `${selector} must not use a hardcoded white`);
  }
});

test('controls whose resting tile is a filled action surface invert outward on hover', () => {
  const send = ruleFor(sidepanelCss, '#sendButton:hover');
  assert.match(send, /background: var\(--hermes-primary-fg, var\(--hermes-paper\)\)/, '#sendButton should flip its fill to the label colour');
  assert.match(send, /color: var\(--hermes-primary-bg, var\(--hermes-ink\)\)/, '#sendButton should take the action colour for its label');
  assert.match(send, /border-color: var\(--hermes-primary-bg, var\(--hermes-ink\)\)/, '#sendButton should draw its boundary in the action colour');
  for (const selector of ['#saveSettingsButton:hover', '#connectButton:hover', '#startupConnectButton:not([hidden]):hover']) {
    const body = ruleFor(sidepanelCss, selector);
    assert.match(body, /background: var\(--hermes-primary-fg, var\(--hermes-paper\)\)/, `${selector} should flip its fill to the label colour`);
  }
});

// ---------------------------------------------------------------------------
// 5. the SAVE / TEST / X row stays readable in every light palette
// ---------------------------------------------------------------------------

const SETTINGS_ROW = [
  ['#saveSettingsTopButton', '#saveSettingsTopButton', 'SAVE'],
  ['.settings-connection-test', '.settings-connection-test', 'TEST'],
  ['.settings-close-icon', '.settings-close-icon', 'the settings close X'],
];

test('the settings header row keeps enabled controls readable in every light palette', () => {
  for (const [selector, baseSelector, label] of SETTINGS_ROW) {
    const hover = ruleFor(sidepanelCss, `${baseSelector}:hover`);
    assert.ok(hover.includes('background: var(--hermes-primary-bg, var(--hermes-ink))'), `${selector} hover should invert into the action surface`);
    const base = ruleFor(sidepanelCss, selector);
    assert.match(base, /background: var\(--hermes-paper\)/, `${selector} should sit on the paper surface`);
    assert.match(base, /color: var\(--hermes-ink\)/, `${selector} should use the readable ink label, not the pale accent`);
    assert.match(base, /border-color: var\(--hermes-line-strong\)/, `${selector} should draw a readable border`);
    for (const theme of LIGHT_THEMES) {
      const tokens = panelPalette(theme, 'light');
      const paper = color(resolveToken(tokens, '--hermes-paper'));
      const ink = color(resolveToken(tokens, '--hermes-ink'));
      const line = color(resolveToken(tokens, '--hermes-line-strong') ?? substitute(tokens, 'rgba(var(--hermes-ink-rgb), 0.78)'), paper);
      assert.ok(
        contrast(ink, paper) >= 4.5,
        `${label} in ${theme}/light should keep >= 4.5:1 label contrast (got ${contrast(ink, paper).toFixed(2)}:1)`,
      );
      assert.ok(
        contrast(line, paper) >= 3,
        `${label} in ${theme}/light should keep >= 3:1 border contrast (got ${contrast(line, paper).toFixed(2)}:1)`,
      );
    }
  }
});

test('danger and missing-token hovers carry safe fallbacks instead of dead declarations', () => {
  for (const selector of [
    '#customThemeResetButton:focus-visible',
    '.custom-theme-card-actions .danger-action:focus-visible',
  ]) {
    const body = ruleFor(sidepanelCss, selector);
    assert.match(body, /var\(--hermes-on-danger, var\(--hermes-paper\)\)/, `${selector} needs a readable label fallback`);
  }
  const toast = ruleFor(sidepanelCss, '.operation-toast button:hover');
  assert.doesNotMatch(toast, /--hermes-line-subtle/, 'the toast hover should not depend on an undefined token');
});

test('the full tab carries the same token fallbacks and no hardcoded white hover', () => {
  for (const selector of [
    '.md-code-copy:hover',
    '.custom-theme-card-actions button:hover',
    '.marketplace-theme-card button:hover',
    '.web-settings-dialog .marketplace-theme-search button:hover',
  ]) {
    const body = ruleFor(appCss, selector);
    assert.match(body, /var\(--hermes-primary-bg, var\(--hermes-ink\)\)/, `${selector} should fall back to ink so the rule is never dead`);
    assert.doesNotMatch(body, /#fff\b|255,\s*255,\s*255/, `${selector} must not paint a hardcoded white`);
  }
});
