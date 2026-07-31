import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('zh dictionary is valid ESM and exposes non-empty frozen entries', async () => {
  const mod = await import(`../extension/lib/i18n-zh.mjs?t=${Date.now()}`);
  const dict = mod.ZH_DICTIONARY;
  assert.ok(dict && typeof dict === 'object');
  assert.ok(Object.keys(dict).length > 500, `expected >500 entries, got ${Object.keys(dict).length}`);
  assert.ok(Object.isFrozen(dict));
  // spot-check core UI strings
  assert.equal(dict['Settings'], '设置');
  assert.equal(dict['Connect to Hermes'], '连接到 Hermes');
  assert.equal(dict['Language'], '语言');
});

test('i18n.mjs exports the expected API', async () => {
  const mod = await import(`../extension/lib/i18n.mjs?t=${Date.now()}`);
  assert.equal(typeof mod.t, 'function');
  assert.equal(typeof mod.initI18n, 'function');
  assert.equal(typeof mod.setLanguage, 'function');
  assert.equal(typeof mod.getLanguage, 'function');
  assert.equal(typeof mod.applyI18n, 'function');
});

test('t() falls back to the English original for unknown keys', async () => {
  const mod = await import(`../extension/lib/i18n.mjs?t=${Date.now()}`);
  // force zh so dictionary lookup happens
  await mod.setLanguage('zh');
  assert.equal(mod.t('Totally unknown string 42'), 'Totally unknown string 42');
  await mod.setLanguage('en');
  assert.equal(mod.t('Settings'), 'Settings');
  assert.equal(mod.t('Settings'), 'Settings');
});

test('every data-i18n marker in shipped HTML has a dictionary entry', async () => {
  const mod = await import(`../extension/lib/i18n-zh.mjs?t=${Date.now()}`);
  const dict = mod.ZH_DICTIONARY;
  const htmlFiles = ['sidepanel.html', 'app.html', 'request-permissions.html', 'voice-dictation.html'];
  const missing = [];
  for (const file of htmlFiles) {
    const html = await readFile(path.join(rootDir, 'extension', file), 'utf8');
    const re = /data-i18n(?:-title|-placeholder|-aria-label|-alt)?="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const key = m[1];
      if (key && !(key in dict)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
