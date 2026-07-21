import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  APPEARANCE_THEMES,
  DEFAULT_APPEARANCE_THEME,
  DEFAULT_COLOR_MODE,
  normalizeAppearanceTheme,
  normalizeColorMode,
  resolveColorMode,
} from '../extension/lib/appearance-themes.mjs';
import * as appearance from '../extension/lib/appearance-themes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function cssBlock(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`))?.[1] || '';
}

function cssValue(block, property) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`${escapedProperty}\\s*:\\s*([^;]+);`))?.[1]?.trim() || '';
}

test('inline Assist resolves every canonical theme in both modes with Mono parity', () => {
  assert.equal(typeof appearance.resolveInlineAssistTheme, 'function');
  for (const theme of APPEARANCE_THEMES) {
    for (const mode of ['light', 'dark']) {
      const tokens = appearance.resolveInlineAssistTheme(theme.value, mode);
      assert.equal(tokens.theme, theme.value);
      assert.equal(tokens.mode, mode);
      for (const key of ['surface', 'panel', 'ink', 'fg', 'accent', 'primary', 'logo', 'logoBackground']) assert.match(tokens[key], /^#[0-9a-f]{6}$/i);
      assert.equal(tokens.logoBackground, '#ffffff');
      assert.equal(tokens.logo, theme.value === 'nous' ? '#0505e8' : '#111111');
    }
    assert.equal(
      appearance.resolveInlineAssistTheme(theme.value, 'dark').primary,
      appearance.resolveInlineAssistTheme(theme.value, 'light').primary,
      `${theme.value} logo color must not invert by mode`,
    );
  }
  const monoDark = appearance.resolveInlineAssistTheme('mono', 'dark');
  assert.deepEqual(monoDark, {
    theme: 'mono',
    mode: 'dark',
    surface: '#0d0d0d',
    panel: '#171717',
    ink: '#e5e5e5',
    fg: '#f1f1f1',
    accent: '#c9c9c9',
    primary: '#202020',
    logo: '#111111',
    logoBackground: '#ffffff',
  });
  const nousLight = appearance.resolveInlineAssistTheme('nous', 'light');
  assert.equal(nousLight.primary, '#0505e8');
  assert.equal(nousLight.logo, '#0505e8');
  assert.equal(nousLight.panel, '#ffffff');
});

test('Nous Light keeps message and composer cards opaque white', () => {
  const fulltabCss = read('extension/fulltab-themes.css');
  const selector = 'html[data-hermes-theme="nous"][data-hermes-mode="light"]';
  assert.match(fulltabCss, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.web-message \\{[^}]*background:\\s*#ffffff;`, 's'));
  assert.match(fulltabCss, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.web-message\\.user \\{[^}]*background:\\s*#ffffff;`, 's'));
  assert.match(fulltabCss, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.fulltab-composer \\{[^}]*background:\\s*#ffffff;`, 's'));
});

test('canonical Hermes appearance themes stay ordered with Nous first', () => {
  assert.deepEqual(APPEARANCE_THEMES.map((theme) => theme.value), [
    'nous',
    'midnight',
    'ember',
    'mono',
    'cyberpunk',
    'slate',
    'senter-space',
    'aurora',
    'solstice',
  ]);
  assert.equal(APPEARANCE_THEMES[0].name, 'Nous');
  assert.deepEqual(APPEARANCE_THEMES.slice(-3).map((theme) => theme.name), [
    'Senter Space',
    'Aphrodite',
    'Solstice',
  ]);
  assert.equal(DEFAULT_APPEARANCE_THEME, 'nous');
  assert.equal(DEFAULT_COLOR_MODE, 'dark');
});

test('Aphrodite replaces Aurora visually while preserving the stable aurora preference id', () => {
  const aphrodite = APPEARANCE_THEMES.find((theme) => theme.value === 'aurora');
  const sidepanelCss = read('extension/sidepanel-themes.css');
  const fulltabCss = read('extension/fulltab-themes.css');
  const appHtml = read('extension/app.html');

  assert.equal(aphrodite?.name, 'Aphrodite');
  assert.match(aphrodite?.description || '', /pink|rose|orchid/i);
  assert.match(cssBlock(fulltabCss, 'html[data-hermes-theme="aurora"][data-hermes-mode="light"]'), /--hermes-accent:\s*#[0-9a-f]{6}/i);
  assert.match(cssBlock(fulltabCss, 'html[data-hermes-theme="aurora"][data-hermes-mode="dark"]'), /--hermes-accent:\s*#[0-9a-f]{6}/i);
  assert.equal(
    cssValue(cssBlock(sidepanelCss, 'html[data-hermes-theme="aurora"][data-hermes-mode="light"]'), '--hermes-blue'),
    cssValue(cssBlock(fulltabCss, 'html[data-hermes-theme="aurora"][data-hermes-mode="light"]'), '--hermes-blue'),
  );
  assert.doesNotMatch(appHtml, /<span>\s*Model\s*<\/span>/i);
});

test('appearance normalization never falls through to system implicitly', () => {
  assert.equal(normalizeAppearanceTheme('unknown'), 'nous');
  assert.equal(normalizeColorMode('unknown'), 'dark');
  assert.equal(resolveColorMode('system', false), 'light');
  assert.equal(resolveColorMode('system', true), 'dark');
});

test('sidepanel implements every canonical palette and shares the Hermes Web Nous Light treatment', () => {
  const sidepanelThemeCssPath = path.join(root, 'extension', 'sidepanel-themes.css');
  const sidepanelThemeCss = fs.existsSync(sidepanelThemeCssPath) ? fs.readFileSync(sidepanelThemeCssPath, 'utf8') : '';
  const sidepanelCss = `${read('extension/sidepanel.css')}\n${sidepanelThemeCss}`;
  const fulltabCss = read('extension/fulltab-themes.css');
  const sidepanelHtml = read('extension/sidepanel.html');
  const sharedTokens = ['--hermes-blue', '--hermes-blue-deep', '--hermes-paper', '--hermes-ink', '--hermes-accent'];

  assert.match(sidepanelHtml, /<link rel="stylesheet" href="sidepanel-themes\.css" \/>/);
  assert.ok(fs.existsSync(sidepanelThemeCssPath), 'sidepanel must load a dedicated canonical theme layer');

  for (const theme of APPEARANCE_THEMES) {
    for (const mode of ['light', 'dark']) {
      const selector = `html[data-hermes-theme="${theme.value}"][data-hermes-mode="${mode}"]`;
      assert.ok(cssBlock(sidepanelCss, selector), `sidepanel must define ${theme.value} ${mode}`);
    }
  }

  for (const theme of ['senter-space', 'aurora', 'solstice']) {
    for (const mode of ['light', 'dark']) {
      const selector = `html[data-hermes-theme="${theme}"][data-hermes-mode="${mode}"]`;
      const sidepanelBlock = cssBlock(sidepanelCss, selector);
      const fulltabBlock = cssBlock(fulltabCss, selector);
      for (const token of sharedTokens) {
        assert.equal(cssValue(sidepanelBlock, token), cssValue(fulltabBlock, token), `${theme} ${mode} must match Hermes Web ${token}`);
      }
    }
  }

  const nousLightSelector = 'html[data-hermes-theme="nous"][data-hermes-mode="light"]';
  const sidepanelNousLight = cssBlock(sidepanelCss, nousLightSelector);
  const fulltabNousLight = cssBlock(fulltabCss, nousLightSelector);
  for (const token of sharedTokens) {
    assert.equal(cssValue(sidepanelNousLight, token), cssValue(fulltabNousLight, token), `Nous Light must match Hermes Web ${token}`);
  }
  assert.equal(cssValue(sidepanelNousLight, '--hermes-fg'), cssValue(fulltabNousLight, '--hermes-shell-fg'));
  assert.equal(cssValue(sidepanelNousLight, '--hermes-fg-rgb'), cssValue(fulltabNousLight, '--hermes-shell-fg-rgb'));
});
