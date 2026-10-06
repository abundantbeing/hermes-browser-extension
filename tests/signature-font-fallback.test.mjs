// Signature font guaranteed-fallback contract (v0.3.4 rider, plan
// docs/plans/2026-09-27-v0.3.4-signature-font-guaranteed-fallback-plan.md, F1-F4).
//
// The licensed Rules faces are git-ignored and absent from the public source
// tree, so the signature stack must fall back to a bundled, tracked face
// before any system font. These static assertions fail the build if either
// token surface (full-tab design-tokens.css, side panel sidepanel.css) ever
// points at a missing face or the fallback registration drifts.
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

test('signature chat headlines use the display stack, not the Sigurd stand-in', () => {
  for (const file of ['extension/sidepanel.css', 'extension/app.css', 'extension/lib/surface-text-zoom.css']) {
    const css = read(file);
    assert.doesNotMatch(
      css,
      /data-hermes-font-profile="signature"[^}]*"HermesDisplay", "Sigurd"/,
      `${file} must not force Sigurd onto signature headlines`,
    );
    assert.match(css, /data-hermes-font-profile="signature"[^}]*"Rules Gothic Compressed", "Collapse"/);
  }
});

test('code faces prefer Aeonik Fono and message code uses the mono token', () => {
  assert.match(tokenValue(sidepanelCss, 'hermes-font-mono'), /^"Aeonik Fono",\s*"Aeonik Fono Pro",\s*"Aeonik Fono Pro TRIAL",\s*"HermesMono"/);
  assert.match(tokenValue(designTokens, 'hermes-font-mono'), /^"Aeonik Fono",\s*"Aeonik Fono Pro",\s*"Aeonik Fono Pro TRIAL",\s*"HermesMono"/);
  assert.match(sidepanelCss, /\.message-content code \{[^}]*font-family:\s*var\(--hermes-font-mono\)/s);
  assert.match(read('extension/app.css'), /\.web-message-content pre,\s*\.web-message-content code \{ font-family: var\(--hermes-font-mono\); \}/);
});

test('appearance preview stack names the bundled display fallback', () => {
  const line = appearancePreferences.match(/if \(profile === 'signature'\)[^\n]*/)?.[0] || '';
  assert.match(line, /"HermesDisplay"/);
  assert.match(line, /"Space Grotesk"|sans-serif/);
});

test('fallback @font-face registrations exist on both surfaces', () => {
  assert.match(designTokens, /@font-face\s*\{[^}]*font-family:\s*"HermesDisplay"/s);
  assert.match(sidepanelCss, /@font-face\s*\{[^}]*font-family:\s*"HermesDisplay"/s);
  assert.match(fontsCss, /@font-face\s*\{[^}]*font-family:\s*"Space Grotesk"/s, 'Space Grotesk must be registered for both HTML surfaces');
  // fonts.css is the shared registration for Space Grotesk, so both pages must link it.
  for (const page of ['extension/sidepanel.html', 'extension/app.html']) {
    assert.match(read(page), /href="lib\/fonts\.css"/, `${page} must link lib/fonts.css so the bundled fallback resolves`);
  }
});

test('every bundled fallback face exists on disk and is a required manifest asset', () => {
  const assets = [
    'extension/assets/fonts/Sigurd-Variable.woff2',
    'extension/assets/fonts/google/SpaceGrotesk-400.woff2',
    'extension/assets/fonts/google/SpaceGrotesk-600.woff2',
  ];
  for (const asset of assets) {
    assert.ok(existsSync(new URL(`../${asset}`, import.meta.url)), `${asset} must exist`);
    const manifestPath = asset.replace(/^extension\//, '');
    assert.match(checkManifest, new RegExp(manifestPath.replace(/[.]/g, '\\.')), `${manifestPath} must be listed in scripts/check-manifest.mjs requiredFiles`);
  }
});

test('fonts.css documents the guaranteed-fallback contract, not a broken signature', () => {
  assert.doesNotMatch(fontsCss, /stay on the build machine and are not part of the public source tree/);
  assert.match(fontsCss, /fallback/i);
});

// F2: the honest degradation note. It must exist (hidden by default) on both
// settings surfaces, carry the new i18n key, and be driven by the probe.
test('settings surfaces expose the honest signature-fallback note element', () => {
  for (const page of ['extension/sidepanel.html', 'extension/app.html']) {
    const html = read(page);
    assert.match(html, /data-i18n="appearance\.font_fallback_note"/, `${page} must own the fallback note via i18n`);
    assert.match(html, /<p[^>]*hidden[^>]*>\s*[^<]*Licensed signature font not installed/, `${page} must ship the note hidden by default`);
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

test('both settings surfaces wire the probe to the note element', () => {
  for (const file of ['extension/sidepanel.js', 'extension/app.js']) {
    const source = read(file);
    assert.match(source, /probeSignatureFonts/, `${file} must import the availability probe`);
    assert.match(source, /signatureFontFallbackNote/i, `${file} must toggle the fallback note element`);
  }
});
