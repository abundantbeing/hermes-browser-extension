import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const localeDirectory = path.join(root, 'extension', 'lib', 'locales');
const expectedKeys = [
  'custom_theme.active_unavailable',
  'custom_theme.choose_theme_file',
  'custom_theme.confirm_delete',
  'custom_theme.confirm_reset',
  'custom_theme.contrast_failed',
  'custom_theme.custom_themes',
  'custom_theme.delete_failed',
  'custom_theme.delete_theme',
  'custom_theme.deleted',
  'custom_theme.export_theme',
  'custom_theme.file_read_failed',
  'custom_theme.import_description',
  'custom_theme.input_too_large',
  'custom_theme.install_theme',
  'custom_theme.installed',
  'custom_theme.invalid_file_type',
  'custom_theme.light_and_dark',
  'custom_theme.light_only',
  'custom_theme.limit_reached',
  'custom_theme.paste_theme_json',
  'custom_theme.preview_theme',
  'custom_theme.reset_complete',
  'custom_theme.reset_failed',
  'custom_theme.reset_storage',
  'custom_theme.save_failed',
  'custom_theme.storage_corrupt',
  'custom_theme.storage_unavailable',
  'custom_theme.user_installed',
  'custom_theme.valid',
  'custom_theme.validation_errors',
].sort();

async function loadCatalog(file) {
  return (await import(`${pathToFileURL(path.join(localeDirectory, file)).href}?phase2=${Date.now()}-${file}`)).default;
}

const files = (await readdir(localeDirectory)).filter((file) => file.endsWith('.mjs')).sort();
const catalogs = new Map(await Promise.all(files.map(async (file) => [file.replace(/\.mjs$/, ''), await loadCatalog(file)])));

test('custom theme locale family is exact and complete in all 21 runtime catalogs', () => {
  assert.equal(catalogs.size, 21);
  for (const [locale, catalog] of catalogs) {
    const keys = Object.keys(catalog).filter((key) => key.startsWith('custom_theme.')).sort();
    assert.deepEqual(keys, expectedKeys, `${locale} custom_theme key set`);
    for (const key of expectedKeys) {
      assert.equal(typeof catalog[key], 'string', `${locale} ${key} must be a string`);
      assert.ok(catalog[key].trim(), `${locale} ${key} must not be empty`);
    }
  }
});

test('custom theme translations preserve protected technical tokens and are genuinely localized', () => {
  const english = catalogs.get('en');
  assert.ok(english);
  for (const [locale, catalog] of catalogs) {
    if (locale === 'en') continue;
    let localized = 0;
    for (const key of expectedKeys) {
      if (catalog[key] !== english[key]) localized += 1;
      for (const token of ['JSON', 'CSS', 'URL']) {
        if (english[key].includes(token)) assert.ok(catalog[key].includes(token), `${locale} ${key} must preserve ${token}`);
      }
    }
    assert.ok(localized >= 28, `${locale} should localize at least 28 of 30 custom-theme messages; got ${localized}`);
  }
});
