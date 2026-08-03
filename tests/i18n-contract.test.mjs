import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Sidepanel and Hermes Web expose the same branded native language selector', () => {
  const sidepanel = read('extension/sidepanel.html');
  const app = read('extension/app.html');
  const css = read('extension/sidepanel.css');
  const languageRule = css.match(/\.language-select\s*\{[^}]*\}/s)?.[0] || '';

  for (const source of [sidepanel, app]) {
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

test('Hermes Web settings preserve selector, focus, option, and CJK typography parity', () => {
  const css = read('extension/app.css');
  const themes = read('extension/fulltab-themes.css');
  assert.match(css, /\.web-settings-dialog \.language-select\s*\{[^}]*padding-right:\s*34px[^}]*letter-spacing:\s*0/s);
  assert.match(css, /\.web-settings-dialog select option\s*\{[^}]*background:\s*var\(--hermes-paper\)[^}]*color:\s*var\(--hermes-ink\)/s);
  assert.match(css, /\.web-settings-dialog (?:input|select):focus[^}]*box-shadow:\s*0 0 0 2px var\(--hermes-accent\)/s);
  assert.match(themes, /:lang\(zh-CN\) \.web-settings-dialog \.appearance-row > div:first-child strong[^}]*letter-spacing:\s*0\.025em[^}]*text-transform:\s*none/s);
});

test('runtime i18n uses explicit semantic sinks instead of a whole-document observer', () => {
  const source = read('extension/lib/i18n.mjs');
  assert.doesNotMatch(source, /MutationObserver/);
  assert.match(source, /querySelectorAll\('\[data-i18n\]/);
  assert.match(source, /chrome\.storage|storageEvents/);
});

test('language option labels are invariant endonyms and accessibility labels are localizable', () => {
  for (const relativePath of ['extension/sidepanel.html', 'extension/app.html']) {
    const source = read(relativePath);
    const select = source.match(/<select[^>]+data-language-select[\s\S]*?<\/select>/)?.[0] || '';
    assert.match(select, /data-i18n-aria-label="settings\.language\.label"/);
    assert.doesNotMatch(select, /<option[^>]+data-i18n/);
  }
});

test('i18n modules and validator are included in JavaScript and manifest verification', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['check:js'], /extension\/lib\/i18n\.mjs/);
  assert.match(packageJson.scripts['check:js'], /extension\/lib\/i18n-registry\.mjs/);
  assert.match(packageJson.scripts['check:js'], /scripts\/check-i18n\.mjs/);
  assert.match(packageJson.scripts['check:manifest'], /check:i18n|check-i18n|generate-browser-locales/);
});

test('browser-native locale packs localize both root and packaged manifests', () => {
  for (const manifestPath of ['manifest.json', 'extension/manifest.json']) {
    const manifest = JSON.parse(read(manifestPath));
    assert.equal(manifest.default_locale, 'en');
    assert.equal(manifest.name, '__MSG_extensionName__');
    assert.equal(manifest.description, '__MSG_extensionDescription__');
  }
  for (const directory of ['_locales', 'extension/_locales']) {
    for (const locale of ['en', 'zh_CN']) {
      const messages = JSON.parse(read(`${directory}/${locale}/messages.json`));
      assert.equal(typeof messages.extensionName?.message, 'string');
      assert.equal(typeof messages.extensionDescription?.message, 'string');
    }
  }
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['check:i18n'], /generate-browser-locales/);
});
