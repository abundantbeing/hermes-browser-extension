// Signature font guaranteed-fallback contract (v0.3.4 rider, plan
// docs/plans/2026-09-27-v0.3.4-signature-font-guaranteed-fallback-plan.md, F1-F4).
//
// Rules signature faces ship in extension/assets/fonts/. The stack still names
// bundled Space Grotesk and HermesDisplay so a failed @font-face never drops to
// a random system font. These static assertions fail CI if either token surface
// drifts or the build stops verifying referenced font files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const designTokens = read('extension/lib/design-tokens.css');
const sidepanelCss = read('extension/sidepanel.css');
const fontsCss = read('extension/lib/fonts.css');
const appearancePreferences = read('extension/lib/appearance-preferences.mjs');
const checkManifest = read('scripts/check-manifest.mjs');

function tokenValue(css, token) {
  const match = css.match(new RegExp(`--${token}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : '';
}

test('full-tab tokens fall back to bundled faces before system fonts', () => {
  const ui = tokenValue(designTokens, 'hermes-font-ui');
  assert.match(ui, /^"Rules Variable",\s*"Space Grotesk"/, 'UI stack must name the bundled Space Grotesk right after Rules Variable');
  const display = tokenValue(designTokens, 'hermes-font-display');
  assert.match(display, /^"Rules Gothic Compressed",\s*"HermesDisplay"/, 'display stack must name the bundled HermesDisplay right after Rules Gothic Compressed');
  assert.doesNotMatch(display, /"Rules Gothic Compressed",\s*"Rules Variable"/, 'display stack must not fall straight to the licensed family');
});

test('side panel tokens fall back to bundled faces before system fonts', () => {
  assert.match(tokenValue(sidepanelCss, 'hermes-font-ui'), /^"Rules Variable",\s*"Space Grotesk"/);
  assert.match(tokenValue(sidepanelCss, 'hermes-font-display'), /^"Rules Gothic Compressed",\s*"HermesDisplay"/);
  assert.match(tokenValue(sidepanelCss, 'hermes-font-brand'), /^"Rules Gothic Compressed",\s*"HermesDisplay"/);
});

test('signature chat headlines use the chosen display font, not the Sigurd stand-in or a named face', () => {
  for (const file of ['extension/sidepanel.css', 'extension/lib/surface-text-zoom.css']) {
    assert.doesNotMatch(
      read(file),
      /data-hermes-font-profile="signature"[^}]*"HermesDisplay", "Sigurd"/,
      `${file} must not force Sigurd onto signature headlines`,
    );
    // Chat headlines take the display token, which the profile sets; no chat sheet names the Rules face itself.
    assert.match(read(file), /data-hermes-font-profile="signature"[^}]*font-family:\s*var\(--hermes-font-display\)/, `${file} must take the display token`);
    assert.doesNotMatch(read(file), /data-hermes-font-profile="signature"[^}]*"Rules Gothic Compressed", "Collapse"/, `${file} must not name the Rules face and Collapse`);
  }
});

test('code faces prefer Aeonik Fono and message code uses the mono token', () => {
  assert.match(tokenValue(sidepanelCss, 'hermes-font-mono'), /^"Aeonik Fono",\s*"Aeonik Fono Pro",\s*"Aeonik Fono Pro TRIAL",\s*"HermesMono"/);
  assert.match(tokenValue(designTokens, 'hermes-font-mono'), /^"Aeonik Fono",\s*"Aeonik Fono Pro",\s*"Aeonik Fono Pro TRIAL",\s*"HermesMono"/);
  assert.match(sidepanelCss, /\.message-content code \{[^}]*font-family:\s*var\(--hermes-font-mono\)/s);
});

test('appearance preview stack names the bundled display fallback', () => {
  const line = appearancePreferences.match(/if \(profile === 'signature'\)[^\n]*/)?.[0] || '';
  assert.match(line, /"HermesDisplay"/);
  assert.match(line, /"Space Grotesk"|sans-serif/);
});

test('fallback @font-face registrations exist in the side panel', () => {
  assert.match(designTokens, /@font-face\s*\{[^}]*font-family:\s*"HermesDisplay"/s);
  assert.match(sidepanelCss, /@font-face\s*\{[^}]*font-family:\s*"HermesDisplay"/s);
  assert.match(fontsCss, /@font-face\s*\{[^}]*font-family:\s*"Space Grotesk"/s, 'Space Grotesk must be registered for the side panel');
  // fonts.css is the shared registration for Space Grotesk, so the page must link it.
  for (const page of ['extension/sidepanel.html']) {
    assert.match(read(page), /href="lib\/fonts\.css"/, `${page} must link lib/fonts.css so the bundled fallback resolves`);
  }
});

test('every bundled fallback face exists on disk and is a required manifest asset', () => {
  const assets = [
    'extension/assets/fonts/Sigurd-Variable.woff2',
    'extension/assets/fonts/RulesVariable.woff2',
    'extension/assets/fonts/RulesGothicCmp-Medium.woff2',
    'extension/assets/fonts/RulesCompressed-Medium.woff2',
    'extension/assets/fonts/google/SpaceGrotesk-400.woff2',
    'extension/assets/fonts/google/SpaceGrotesk-600.woff2',
  ];
  for (const asset of assets) {
    assert.ok(existsSync(new URL(`../${asset}`, import.meta.url)), `${asset} must exist`);
    const manifestPath = asset.replace(/^extension\//, '');
    assert.match(checkManifest, new RegExp(manifestPath.replace(/[.]/g, '\\.')), `${manifestPath} must be listed in scripts/check-manifest.mjs requiredFiles`);
  }
});

test('fonts.css documents the bundled fallback stack and Rules licensing pointer', () => {
  assert.doesNotMatch(fontsCss, /stay on the build machine and are not part of the public source tree/);
  assert.match(fontsCss, /Rules\*\.woff2|Blaze Type/i);
  assert.match(fontsCss, /fallback/i);
});

// F2: the honest degradation note. It must exist (hidden by default) on both
// settings surfaces, carry the new i18n key, and be driven by the probe.
test('settings surface exposes the honest signature-fallback note element', () => {
  for (const page of ['extension/sidepanel.html']) {
    const html = read(page);
    assert.match(html, /data-i18n="appearance\.font_fallback_note"/, `${page} must own the fallback note via i18n`);
    assert.match(html, /<p[^>]*hidden[^>]*>\s*[^<]*Rules signature font did not load/, `${page} must ship the note hidden by default`);
  }
});

test('every locale catalog carries the fallback note key', () => {
  const dir = new URL('../extension/lib/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  assert.equal(files.length, 21, 'all 21 locale catalogs must be present');
  for (const name of files) {
    const catalog = readFileSync(new URL(name, dir), 'utf8');
    assert.match(catalog, /"appearance\.font_fallback_note":\s*"[^"]+"/, `${name} must translate appearance.font_fallback_note`);
  }
});

test('Rules Gothic Compressed @font-face declares Medium weight only', () => {
  for (const file of ['extension/sidepanel.css', 'extension/lib/design-tokens.css']) {
    const block = read(file).match(/@font-face\s*\{[^}]*font-family:\s*"Rules Gothic Compressed"[^}]*\}/s)?.[0] || '';
    assert.match(block, /RulesGothicCmp-Medium\.woff2/);
    assert.match(block, /font-weight:\s*500;/);
    assert.doesNotMatch(block, /font-weight:\s*100\s+900/);
  }
});

test('availability probe iterates registered faces, never document.fonts.check', () => {
  const source = read('extension/lib/font-availability.mjs');
  // Strip comments: the docstring explains why check() is avoided, but no live
  // code may call it.
  const code = source.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\.check\s*\(/, 'the probe must read FontFace status, not trust check()');
  assert.match(code, /Symbol\.iterator/, 'the probe must iterate the FontFaceSet');
  assert.match(code, /\.status/, 'the probe must read the FontFace status');
  assert.match(code, /\.load\b/, 'the probe must force an unloaded face to settle');
});

test('the settings surface wires the probe to the note element', () => {
  for (const file of ['extension/sidepanel.js']) {
    const source = read(file);
    assert.match(source, /probeSignatureFonts/, `${file} must import the availability probe`);
    assert.match(source, /signatureFontFallbackNote/i, `${file} must toggle the fallback note element`);
  }
});
