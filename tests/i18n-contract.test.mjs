import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SUPPORTED_LOCALES } from '../extension/lib/i18n-registry.mjs';
import { CHECK_JS } from '../scripts/check-js.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Sidepanel exposes the branded native language selector', () => {
  const sidepanel = read('extension/sidepanel.html');
  const css = read('extension/sidepanel.css');
  const languageRule = css.match(/\.language-select\s*\{[^}]*\}/s)?.[0] || '';

  for (const source of [sidepanel]) {
    assert.match(source, /<select[^>]+data-language-select[^>]*>/);
    assert.match(source, /<option value="en">English<\/option>/);
    assert.match(source, /<option value="zh-CN">简体中文<\/option>/);
    assert.doesNotMatch(source, /\/\s+data-i18n/);
  }

  assert.match(css, /\.language-select\s*\{[^}]*background:\s*var\(--hermes-input-bg,\s*var\(--hermes-paper\)\)/s);
  assert.match(css, /\.language-select\s*\{[^}]*color:\s*var\(--hermes-ink\)/s);
  assert.match(css, /\.language-select\s*\{[^}]*border:\s*1px solid var\(--hermes-line-strong\)/s);
  assert.match(css, /\.language-select\s*\{[^}]*border-radius:\s*var\(--radius\)/s);
  assert.match(css, /\.language-select option\s*\{[^}]*background:\s*var\(--hermes-input-bg,\s*var\(--hermes-paper\)\)/s);
  assert.match(css, /\.language-select option\s*\{[^}]*color:\s*var\(--hermes-ink\)/s);
  assert.doesNotMatch(css, /\.language-select[^}]*border-radius:\s*8px/s);
  assert.doesNotMatch(languageRule, /--hermes-surface/);
  assert.match(css, /:lang\(zh-CN\) \[data-i18n\][^{]*\{[^}]*letter-spacing:\s*0\.025em/s);
});

test('Arabic RTL mirrors the primary composer and mobile navigation', () => {
  const sidepanelCss = read('extension/sidepanel.css');
  assert.match(sidepanelCss, /html\[dir="rtl"\]\s+\.composer-wake/);
  assert.match(sidepanelCss, /html\[dir="rtl"\]\s+\.composer-input-wrap\.busy-draft\.can-steer textarea/);
});

test('CJK, Devanagari, Thai, and Arabic localized copy avoids forced uppercase and tracking', () => {
  for (const css of [read('extension/sidepanel.css')]) {
    assert.match(css, /:lang\(zh-TW\) \[data-i18n\][\s\S]*text-transform:\s*none/);
    assert.match(css, /:lang\(ja\) \[data-i18n\][\s\S]*text-transform:\s*none/);
    assert.match(css, /:lang\(ko\) \[data-i18n\][\s\S]*text-transform:\s*none/);
    assert.match(css, /:lang\(hi\) \[data-i18n\][\s\S]*letter-spacing:\s*0/);
    assert.match(css, /:lang\(th\) \[data-i18n\][\s\S]*letter-spacing:\s*0/);
    assert.match(css, /:lang\(ar\) \[data-i18n\][\s\S]*letter-spacing:\s*0/);
  }
});

test('runtime i18n uses explicit semantic sinks instead of a whole-document observer', () => {
  const source = read('extension/lib/i18n.mjs');
  assert.doesNotMatch(source, /MutationObserver/);
  assert.match(source, /querySelectorAll\('\[data-i18n\]/);
  assert.match(source, /chrome\.storage|storageEvents/);
});

test('the shared locale registry is compatible with MV3 extension service workers', () => {
  const source = read('extension/lib/i18n-registry.mjs');
  assert.doesNotMatch(source, /\bimport\s*\(/, 'Chrome extension service workers do not support dynamic import().');
  const background = read('extension/background.js');
  assert.doesNotMatch(background, /await\s+initI18n\(\)/, 'Background event listeners must register without waiting for locale initialization.');
});

test('language option labels are invariant endonyms and accessibility labels are localizable', () => {
  for (const relativePath of ['extension/sidepanel.html']) {
    const source = read(relativePath);
    const select = source.match(/<select[^>]+data-language-select[\s\S]*?<\/select>/)?.[0] || '';
    assert.match(select, /data-i18n-aria-label="settings\.language\.label"/);
    assert.doesNotMatch(select, /<option[^>]+data-i18n/);
  }
});

test('Sidepanel populates language options from the shared registry', () => {
  for (const relativePath of ['extension/sidepanel.js']) {
    const source = read(relativePath);
    assert.match(source, /populateLanguageSelect/);
    assert.match(source, /populateLanguageSelect\([^)]*LanguageSelect|populateLanguageSelect\([^)]*languageSelect/);
  }
  const runtime = read('extension/lib/i18n.mjs');
  assert.match(runtime, /SUPPORTED_LOCALES\.map\(\(locale\) => locale\.id\)/);
  assert.match(runtime, /option\.textContent = locale\.nativeName/);
});

test('i18n modules and validator are included in JavaScript and manifest verification', () => {
  const packageJson = JSON.parse(read('package.json'));
  const validator = read('scripts/check-i18n.mjs');
  assert.match(CHECK_JS, /extension\/lib\/i18n\.mjs/);
  assert.match(CHECK_JS, /extension\/lib\/i18n-registry\.mjs/);
  assert.match(CHECK_JS, /scripts\/check-i18n\.mjs/);
  assert.match(packageJson.scripts['check:manifest'], /check:i18n|check-i18n|generate-browser-locales/);
  assert.match(validator, /loadLocaleMessages, SUPPORTED_LOCALES/);
  assert.match(validator, /for \(const locale of SUPPORTED_LOCALES\)/);
  assert.match(validator, /changed protected token/);
  assert.match(validator, /changed protected literal/);
});

test('browser-native locale packs localize both root and packaged manifests', () => {
  const generator = read('scripts/generate-browser-locales.mjs');
  assert.match(generator, /manifest\.extension_name/);
  assert.match(generator, /manifest\.extension_description/);
  assert.match(generator, /manifest\.open_sidebar/);
  assert.doesNotMatch(generator, /const nativeCopy/);
  for (const manifestPath of ['manifest.json', 'extension/manifest.json']) {
    const manifest = JSON.parse(read(manifestPath));
    assert.equal(manifest.default_locale, 'en');
    assert.equal(manifest.name, '__MSG_extensionName__');
    assert.equal(manifest.description, '__MSG_extensionDescription__');
  }
  assert.equal(SUPPORTED_LOCALES.length, 21);
  for (const directory of ['_locales', 'extension/_locales']) {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(read(`${directory}/${locale.browserDirectory}/messages.json`));
      assert.equal(typeof messages.extensionName?.message, 'string');
      assert.equal(typeof messages.extensionDescription?.message, 'string');
    }
  }
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['check:i18n'], /generate-browser-locales/);
});
