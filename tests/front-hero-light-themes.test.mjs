import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const themeCss = readFileSync(path.join(root, 'extension', 'sidepanel-themes.css'), 'utf8').replace(/\r\n/g, '\n');

const NOUS_LIGHT = 'html[data-hermes-theme="nous"][data-hermes-mode="light"]';
const ANTI_NOUS_LIGHT = 'html[data-hermes-theme="anti-nous"][data-hermes-mode="light"]';
const HERO = '.hero-card';

// The original Nous-light pin. After this change it belongs to the Settings
// banner (.release-sidecar) alone and must stay byte-identical.
const SETTINGS_BANNER_PIN = `${NOUS_LIGHT} .release-sidecar {
  color: #f8faff;
  --hermes-fg: #f8faff;
  --hermes-fg-rgb: 248, 250, 255;
  --hermes-ink: #0505e8;
  --hermes-ink-rgb: 5, 5, 232;
  --hermes-accent: #dbe6ff;
  --hermes-accent-rgb: 219, 230, 255;
  --hermes-panel-rgb: 5, 5, 232;
  --hermes-bg-rgb: 5, 5, 232;
  --hermes-app-bg: #0505e8;
  --hermes-shadow-rgb: 0, 0, 0;
}`;

function parseRules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(text))) {
    const selectors = match[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const decls = {};
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
    rules.push({ selectors, decls });
  }
  return rules;
}

function mergedDecls(selector) {
  const out = {};
  for (const rule of parseRules(themeCss)) {
    if (rule.selectors.includes(selector)) Object.assign(out, rule.decls);
  }
  return out;
}

function heroDecls(scope) {
  return mergedDecls(`${scope} ${HERO}`);
}

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a 6-digit hex colour, got ${hex}`);
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the Settings banner keeps the original Nous light pin verbatim', () => {
  assert.ok(themeCss.includes(SETTINGS_BANNER_PIN), 'the .release-sidecar pin must stay byte-identical');
});

test('the shared Nous light pin no longer lists the front hero with the banner', () => {
  for (const rule of parseRules(themeCss)) {
    const banner = rule.selectors.some((s) => s.endsWith(' .release-sidecar'));
    const hero = rule.selectors.some((s) => s.endsWith(' .hero-card'));
    assert.ok(!(banner && hero), `selector list mixes hero and banner: ${rule.selectors.join(' | ')}`);
  }
});

test('the front hero gets a light paper surface in Nous and Anti-Nous light', () => {
  for (const [label, scope, ink] of [['Nous', NOUS_LIGHT, '#0000f2'], ['Anti-Nous', ANTI_NOUS_LIGHT, '#d4182d']]) {
    const decls = heroDecls(scope);
    assert.ok(Object.keys(decls).length > 0, `${label} light needs a scoped .hero-card rule`);
    assert.ok(decls['--hermes-app-bg'], `${label} hero needs a paper --hermes-app-bg`);
    assert.ok(luminance(decls['--hermes-app-bg']) >= 0.85, `${label} hero surface must be light paper`);
    assert.equal(decls['--hermes-fg'], ink, `${label} hero ink should be the brand colour`);
    assert.ok(contrast(ink, decls['--hermes-app-bg']) >= 4.5, `${label} hero ink must stay readable on paper`);
  }
});

test('the front hero close control stays visible on paper', () => {
  for (const scope of [NOUS_LIGHT, ANTI_NOUS_LIGHT]) {
    const rule = parseRules(themeCss).find((r) => r.selectors.includes(`${scope} .hero-dismiss`));
    assert.ok(rule, `${scope} needs a .hero-dismiss rule`);
    assert.ok(rule.decls.color, 'dismiss rule must set its colour');
    assert.doesNotMatch(rule.decls.color, /#fff(?:fff)?\b|\bwhite\b/i, 'hard-coded white would vanish on paper');
  }
});

test('hero and banner rules are scoped to Nous and Anti-Nous light only', () => {
  const scopes = [NOUS_LIGHT, ANTI_NOUS_LIGHT];
  for (const rule of parseRules(themeCss)) {
    for (const selector of rule.selectors) {
      if (!/hero-|release-sidecar|browserIntro/.test(selector)) continue;
      assert.ok(scopes.some((scope) => selector.startsWith(scope)), `unscoped hero/banner selector: ${selector}`);
    }
  }
});

test('the hero treatment never touches typography or card geometry', () => {
  const locked = ['min-height', 'height', 'width', 'padding', 'border-radius', 'font-family', 'font-size',
    'letter-spacing', 'line-height', 'text-transform'];
  for (const rule of parseRules(themeCss)) {
    if (!rule.selectors.some((s) => /hero-/.test(s))) continue;
    for (const prop of locked) {
      assert.ok(!(prop in rule.decls), `${rule.selectors.join(' | ')} must not set ${prop}`);
    }
  }
});

test('the global Anti-Nous light palette tokens are not mutated', () => {
  const palette = mergedDecls(ANTI_NOUS_LIGHT);
  assert.equal(palette['--hermes-app-bg'], '#ffffff');
  assert.equal(palette['--hermes-fg'], '#d4182d');
  assert.equal(palette['--hermes-accent'], '#d4182d');
  assert.equal(palette['--hermes-panel-rgb'], '255, 255, 255');
});
