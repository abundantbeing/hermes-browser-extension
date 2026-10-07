import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { APPEARANCE_THEMES, normalizeAppearanceTheme, resolveInlineAssistTheme } from '../extension/lib/appearance-themes.mjs';
import { contrastRatio } from '../extension/lib/custom-themes.mjs';

const layers = ['sidepanel-themes.css', 'fulltab-themes.css'].map((file) => ({
  file,
  css: readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'),
}));
const newThemes = ['everforest', 'classic', 'anti-nous'];

function palette(css, theme, mode) {
  const selector = `html[data-hermes-theme="${theme}"][data-hermes-mode="${mode}"]`;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body, `${theme}/${mode} palette must exist`);
  return Object.fromEntries([...body.matchAll(/(color-scheme|--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
}

for (const theme of newThemes) {
  test(`${theme} is a selectable built-in with both Inline Assist modes`, () => {
    assert.equal(normalizeAppearanceTheme(theme), theme);
    assert.equal(APPEARANCE_THEMES.filter((entry) => entry.value === theme).length, 1);
    for (const mode of ['dark', 'light']) {
      const tokens = resolveInlineAssistTheme(theme, mode);
      assert.equal(tokens.theme, theme);
      assert.equal(tokens.mode, mode);
      for (const key of ['surface', 'panel', 'ink', 'fg', 'accent', 'primary']) {
        assert.match(tokens[key], /^#[\da-f]{6}$/i);
      }
      assert.ok(contrastRatio(tokens.ink, tokens.panel) >= 4.5, `${theme}/${mode} Assist text must remain readable`);
    }
    assert.equal(resolveInlineAssistTheme(theme, 'system', false).mode, 'light');
    assert.equal(resolveInlineAssistTheme(theme, 'system', true).mode, 'dark');
  });
}

for (const { file, css } of layers) {
  for (const theme of newThemes) {
    for (const mode of ['dark', 'light']) {
      test(`${file} defines readable ${theme}/${mode} controls and reading surfaces`, () => {
        const tokens = palette(css, theme, mode);
        for (const key of ['--hermes-app-bg', '--hermes-paper', '--hermes-ink', '--hermes-fg', '--hermes-muted', '--hermes-primary-bg', '--hermes-primary-fg', '--hermes-input-bg', '--hermes-accent']) {
          assert.match(tokens[key], /^#[\da-f]{6}$/i, `${key} must be explicitly defined`);
        }
        for (const [fg, bg] of [['--hermes-ink', '--hermes-paper'], ['--hermes-muted', '--hermes-paper'], ['--hermes-fg', '--hermes-app-bg'], ['--hermes-primary-fg', '--hermes-primary-bg'], ['--hermes-ink', '--hermes-input-bg']]) {
          assert.ok(contrastRatio(tokens[fg], tokens[bg]) >= 4.5, `${file}: ${theme}/${mode}: ${fg} on ${bg}`);
        }
        assert.equal(tokens['color-scheme'], mode);
      });
    }
  }

  test(`${file} preserves Desktop Everforest and Classic palette identity`, () => {
    const forestDark = palette(css, 'everforest', 'dark');
    const forestLight = palette(css, 'everforest', 'light');
    assert.equal(forestDark['--hermes-app-bg'], '#2d353b');
    assert.equal(forestDark['--hermes-ink'], '#d3c6aa');
    assert.equal(forestDark['--hermes-accent'], '#a7c080');
    assert.equal(forestLight['--hermes-app-bg'], '#fdf6e3');
    assert.equal(forestLight['--hermes-ink'], '#5c6a72');
    assert.equal(forestLight['--hermes-accent'], '#586b35');
    const classicDark = palette(css, 'classic', 'dark');
    const classicLight = palette(css, 'classic', 'light');
    assert.equal(classicDark['--hermes-app-bg'], '#1a1a2e');
    assert.equal(classicDark['--hermes-ink'], '#fff8dc');
    assert.equal(classicDark['--hermes-accent'], '#ffbf00');
    assert.equal(classicLight['--hermes-app-bg'], '#f5f5f5');
    assert.equal(classicLight['--hermes-ink'], '#2b2109');
  });

  test(`${file} gives Anti-Nous navy reading surfaces, red actions and distinct gold trim`, () => {
    const dark = palette(css, 'anti-nous', 'dark');
    const light = palette(css, 'anti-nous', 'light');
    assert.equal(dark['--hermes-paper'], '#101b30');
    assert.equal(dark['--hermes-primary-bg'], '#b52b3d');
    assert.equal(dark['--hermes-trim'], '#d4af6c');
    assert.notEqual(dark['--hermes-trim'], dark['--hermes-accent']);
    assert.notEqual(dark['--hermes-danger'], dark['--hermes-accent']);
    assert.equal(light['--hermes-app-bg'], '#ffffff');
    assert.equal(light['--hermes-paper'], '#ffffff');
    assert.equal(light['--hermes-ink'], '#a52232');
  });
}
