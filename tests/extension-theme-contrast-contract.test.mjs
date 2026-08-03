import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const sidepanelHtml = readFileSync(path.join(root, 'extension', 'sidepanel.html'), 'utf8');
const sidepanelCss = readFileSync(path.join(root, 'extension', 'sidepanel.css'), 'utf8');
const themeCss = readFileSync(path.join(root, 'extension', 'sidepanel-themes.css'), 'utf8');
const contextMenuEditorCss = readFileSync(path.join(root, 'extension', 'context-menu-editor.css'), 'utf8');
const logoPath = path.join(root, 'extension', 'assets', 'img', 'hermes-agent-logo.svg');

test('extension uses the supplied Hermes Agent logo as a theme-colored vector mask', () => {
  assert.equal(existsSync(logoPath), true, 'the supplied Hermes Agent SVG should ship with the extension');
  assert.match(sidepanelHtml, /class="brand-mini-mark"/, 'brand header should render the themed vector mark');
  assert.match(sidepanelCss, /mask:\s*url\("assets\/img\/hermes-agent-logo\.svg"\)/, 'brand mark should use the supplied vector asset');
  assert.match(sidepanelCss, /background:\s*var\(--hermes-brand-mark/, 'brand mark should resolve through a theme color token');
});

test('Senter, Aurora, and Solstice light modes keep panel text dark while action surfaces stay light', () => {
  for (const [theme, label] of [['senter-space', 'Senter'], ['aurora', 'Aurora'], ['solstice', 'Solstice']]) {
    const selector = `html[data-hermes-theme="${theme}"][data-hermes-mode="light"]`;
    const start = themeCss.indexOf(selector);
    assert.notEqual(start, -1, `${label} light palette should exist`);
    const block = themeCss.slice(start, themeCss.indexOf('}', start));
    assert.match(block, /--hermes-fg:\s*#[0-9a-f]{6}/i, `${label} light mode needs an ink foreground token`);
    assert.match(block, /--hermes-primary-fg:\s*#[0-9a-f]{6}/i, `${label} light mode needs readable action text`);
    assert.match(block, /--hermes-user-fg:\s*#[0-9a-f]{6}/i, `${label} light mode needs readable user-message text`);
  }
});

test('context-menu settings controls use explicit theme-aware native and primary color pairs', () => {
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor-select\s*\{[^}]*background:\s*var\(--hermes-input-bg,\s*var\(--hermes-paper\)\)\s*!important;/s,
    'the native select surface should resolve from the active theme input token',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor-select option\s*\{[^}]*background:\s*var\(--hermes-input-bg,\s*var\(--hermes-paper\)\);[^}]*color:\s*var\(--hermes-ink\);/s,
    'native option rows need an explicit readable background and foreground',
  );
  assert.match(
    contextMenuEditorCss,
    /html\[data-hermes-mode="dark"\] \.context-menu-editor-select\s*\{[^}]*color-scheme:\s*dark;/s,
    'dark themes should request dark native select chrome',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor-add\s*\{[^}]*background:\s*var\(--hermes-primary-bg,\s*var\(--hermes-ink\)\);[^}]*color:\s*var\(--hermes-primary-fg,\s*var\(--hermes-paper\)\);/s,
    'Add Action should use a high-contrast primary token pair in every theme',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor \.hermes-switch-input:checked \+ \.hermes-switch-track\s*\{[^}]*background:\s*var\(--hermes-primary-bg,\s*var\(--hermes-ink\)\);/s,
    'checked editor switches should retain the primary background on Hermes Web',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor \.hermes-switch-input:checked \+ \.hermes-switch-track::after\s*\{[^}]*background:\s*var\(--hermes-primary-fg,\s*var\(--hermes-paper\)\);/s,
    'checked editor switches should retain the primary foreground on Hermes Web',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor \.context-menu-context-input:checked \+ \.context-menu-context-box\s*\{[^}]*background:\s*var\(--hermes-primary-bg,\s*var\(--hermes-ink\)\);/s,
    'checked context boxes should use the primary background token pair',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-editor \.context-menu-context-input:checked \+ \.context-menu-context-box::after\s*\{[^}]*color:\s*var\(--hermes-primary-fg,\s*var\(--hermes-paper\)\);/s,
    'checked context marks should use the primary foreground token pair',
  );
  assert.match(
    contextMenuEditorCss,
    /\.context-menu-icon-button:hover:not\(:disabled\),\s*\.context-menu-icon-button:focus-visible\s*\{[^}]*background:\s*var\(--hermes-primary-bg,\s*var\(--hermes-ink\)\)\s*!important;[^}]*color:\s*var\(--hermes-primary-fg,\s*var\(--hermes-paper\)\)\s*!important;/s,
    'editor icon hover and focus states should use the primary token pair',
  );
});
