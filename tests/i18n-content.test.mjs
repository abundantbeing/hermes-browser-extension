import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('generated content i18n bridge stays classic and precedes Hermes Assist', async () => {
  const source = read('extension/lib/i18n-content.js');
  const facade = read('extension/lib/browser-api-global.js');
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  assert.doesNotMatch(source, /MutationObserver/);

  const manifest = JSON.parse(read('extension/manifest.json'));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(scripts.indexOf('lib/browser-api-global.js') >= 0);
  assert.ok(scripts.indexOf('lib/browser-api-global.js') < scripts.indexOf('lib/i18n-content.js'));
  assert.ok(scripts.indexOf('lib/i18n-content.js') >= 0);
  assert.ok(scripts.indexOf('lib/i18n-content.js') < scripts.indexOf('content-inline-helper.js'));

  const listeners = new Set();
  const sandbox = {
    console,
    chrome: {
      storage: {
        local: { get: async () => ({ hermesBrowserLocale: 'zh-CN' }) },
        onChanged: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(facade, sandbox);
  vm.runInNewContext(source, sandbox);
  await sandbox.HermesI18nContent.ready;
  assert.notEqual(sandbox.HermesI18nContent.translateText('Hermes Assist'), 'Hermes Assist');
  assert.equal(sandbox.HermesI18nContent.translateText('Jon’s private draft'), 'Jon’s private draft');
});

test('Hermes Assist localizes application copy but preserves generated and user text', () => {
  const helper = read('extension/content-inline-helper.js');
  assert.match(helper, /HermesI18nContent/);
  assert.match(helper, /await i18n\.ready/);
  assert.match(helper, /makeRaw\('div', 'preview', resultText \|\| translateUiText\('\(empty draft\)'\)\)/);
  assert.match(helper, /makeRaw\('strong', '', resultSessionTitle/);
  assert.doesNotMatch(helper, /translateUiText\(resultText\)/);
});

test('Hermes Assist bridge excludes settings-only copy and remains bounded across all locales', () => {
  const source = read('extension/lib/i18n-content.js');
  assert.doesNotMatch(source, /Select your interface language/);
  assert.ok(source.length < 500_000, `content i18n bridge grew to ${source.length} bytes`);
});

test('Hermes Assist canonicalizes locale aliases and cannot miss an initialization race', async () => {
  const source = read('extension/lib/i18n-content.js');
  const facade = read('extension/lib/browser-api-global.js');
  const listeners = new Set();
  let resolveStoredLocale;
  const sandbox = {
    console,
    chrome: {
      storage: {
        local: { get: () => new Promise((resolve) => { resolveStoredLocale = resolve; }) },
        onChanged: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(facade, sandbox);
  vm.runInNewContext(source, sandbox);
  assert.equal(listeners.size, 1, 'listener must be registered before awaiting storage');
  for (const listener of listeners) listener({ hermesBrowserLocale: { newValue: 'ZH_cn' } }, 'local');
  resolveStoredLocale({ hermesBrowserLocale: 'en' });
  await sandbox.HermesI18nContent.ready;
  assert.equal(sandbox.HermesI18nContent.getLocale(), 'zh-CN');
  assert.notEqual(sandbox.HermesI18nContent.translateText('Hermes Assist'), 'Hermes Assist');

  const [storageListener] = listeners;
  for (const [value, expected] of [
    ['zh_Hant', 'zh-TW'],
    ['pt_PT', 'pt-BR'],
    ['ar_EG', 'ar'],
  ]) {
    storageListener({ hermesBrowserLocale: { newValue: value } }, 'local');
    assert.equal(sandbox.HermesI18nContent.getLocale(), expected);
  }
});
