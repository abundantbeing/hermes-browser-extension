import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as browserRuntime from '../extension/lib/browser-runtime.mjs';

async function importRequiredModule(path, label) {
  try {
    return await import(path);
  } catch (error) {
    assert.fail(`${label} is required by the Phase 3 browser-platform contract: ${error?.message || error}`);
  }
}

test('browser product identity names only products proven by runtime signals', () => {
  assert.equal(typeof browserRuntime.detectBrowserProduct, 'function', 'detectBrowserProduct must exist');

  const edge = browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
  });
  assert.deepEqual(edge, {
    id: 'edge',
    label: 'Microsoft Edge',
    engine: 'chromium',
    confidence: 'high',
    source: 'user-agent',
  });

  const comet = browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    extensionUrl: 'comet-extension://extension-id/sidepanel.html',
  });
  assert.equal(comet.id, 'comet');
  assert.equal(comet.label, 'Perplexity Comet');
  assert.equal(comet.source, 'extension-scheme');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    brands: [{ brand: 'Comet', version: '150' }],
  }).id, 'comet');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Comet/150.0.0.0',
  }).id, 'comet');

  const chrome = browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    brands: [{ brand: 'Google Chrome', version: '150' }],
  });
  assert.equal(chrome.id, 'chrome');
  assert.equal(chrome.label, 'Google Chrome');

  const maskedFork = browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    brands: [{ brand: 'Chromium', version: '150' }],
  });
  assert.equal(maskedFork.id, 'chromium');
  assert.equal(maskedFork.label, 'Chromium browser');
  assert.equal(maskedFork.confidence, 'masked');
  assert.notEqual(maskedFork.label, 'Google Chrome');
});

test('browser product identity preserves Brave, Opera-family, Firefox, and Safari signals', () => {
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    braveApi: { isBrave() {} },
  }).id, 'brave');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 OPR/120.0.0.0',
  }).label, 'Opera / Opera GX');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 OPR/120.0.0.0',
    brands: [{ brand: 'Opera GX', version: '120' }],
  }).id, 'opera-gx');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    brands: [{ brand: 'Arc', version: '1' }],
  }).id, 'arc');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Firefox/140.0',
    extensionUrl: 'moz-extension://extension-id/sidepanel.html',
  }).id, 'firefox');
  assert.equal(browserRuntime.detectBrowserProduct({
    userAgent: 'Mozilla/5.0 Version/18.0 Safari/605.1.15',
    extensionUrl: 'safari-web-extension://extension-id/sidepanel.html',
  }).id, 'safari');
});

test('browser capability matrix comes from API probes rather than product identity', () => {
  assert.equal(typeof browserRuntime.probeBrowserCapabilities, 'function', 'probeBrowserCapabilities must exist');
  const product = {
    id: 'chromium',
    label: 'Chromium browser',
    engine: 'chromium',
    confidence: 'masked',
    source: 'engine-only',
  };
  const capable = browserRuntime.probeBrowserCapabilities({
    product,
    api: {
      sidePanel: { open() {}, setOptions() {} },
      scripting: { executeScript() {} },
      tabs: { query() {}, create() {} },
      storage: { local: { get() {}, set() {} } },
      contextMenus: { create() {} },
      downloads: { download() {} },
      debugger: { attach() {}, sendCommand() {} },
      tabGroups: { query() {} },
    },
    sidebarAction: null,
    speechRecognition: null,
  });
  assert.equal(capable.product.id, 'chromium');
  assert.equal(capable.panelHost, 'side-panel');
  assert.equal(capable.apis.sidePanel, true);
  assert.equal(capable.apis.sidebarAction, false);
  assert.equal(capable.apis.scripting, true);
  assert.equal(capable.apis.debugger, true);
  assert.equal(capable.apis.tabGroups, true);
  assert.equal(capable.apis.voiceRecognition, false);
  assert.equal(capable.fallbacks.fullTab, true);

  const sameProductWithoutApis = browserRuntime.probeBrowserCapabilities({
    product,
    api: {},
    sidebarAction: null,
  });
  assert.equal(sameProductWithoutApis.panelHost, 'full-tab');
  assert.equal(sameProductWithoutApis.apis.sidePanel, false);
  assert.equal(sameProductWithoutApis.apis.scripting, false);
  assert.equal(sameProductWithoutApis.apis.debugger, false);
  assert.equal(sameProductWithoutApis.fallbacks.fullTab, true);
});

test('microphone settings targets follow the proven browser product instead of assuming Chrome', () => {
  assert.equal(typeof browserRuntime.browserMicrophoneSettingsUrl, 'function');
  assert.equal(
    browserRuntime.browserMicrophoneSettingsUrl({
      product: { id: 'edge', engine: 'chromium' },
      extensionUrl: 'chrome-extension://extension-id/',
    }),
    'edge://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fextension-id%2F',
  );
  assert.equal(browserRuntime.browserMicrophoneSettingsUrl({
    product: { id: 'firefox', engine: 'gecko' },
    extensionUrl: 'moz-extension://extension-id/',
  }), '');
  assert.equal(browserRuntime.browserMicrophoneSettingsUrl({
    product: { id: 'safari', engine: 'webkit' },
    extensionUrl: 'safari-web-extension://extension-id/',
  }), '');
});

test('shared browser API wrapper prefers browser namespace and falls back to chrome namespace', async () => {
  const module = await importRequiredModule('../extension/lib/browser-api.mjs', 'browser-api.mjs');
  assert.equal(typeof module.resolveBrowserApi, 'function');

  const browserApi = { runtime: { id: 'browser-api' } };
  const chromeApi = { runtime: { id: 'chrome-api' } };
  assert.deepEqual(module.resolveBrowserApi({ browserApi, chromeApi }), {
    api: browserApi,
    namespace: 'browser',
    available: true,
  });
  assert.deepEqual(module.resolveBrowserApi({ browserApi: null, chromeApi }), {
    api: chromeApi,
    namespace: 'chrome',
    available: true,
  });
  assert.deepEqual(module.resolveBrowserApi({ browserApi: null, chromeApi: null }), {
    api: null,
    namespace: 'unavailable',
    available: false,
  });
});

test('controller adapter contract is defined but control remains disabled in Phase 3', async () => {
  const module = await importRequiredModule('../extension/lib/browser-controller-adapter.mjs', 'browser-controller-adapter.mjs');
  assert.equal(typeof module.controllerAdapterContractFor, 'function');

  const chromium = module.controllerAdapterContractFor({
    product: { id: 'edge', engine: 'chromium' },
    capabilities: { apis: { debugger: true, scripting: true, tabs: true } },
  });
  assert.equal(chromium.id, 'chromium-cdp');
  assert.equal(chromium.enabled, false);
  assert.deepEqual(chromium.actions, []);
  assert.match(chromium.reason, /control is disabled/i);

  const firefox = module.controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { scripting: true, tabs: true, debugger: false } },
  });
  assert.equal(firefox.id, 'firefox-webextension');
  assert.equal(firefox.enabled, false);
  assert.deepEqual(firefox.actions, []);

  const unsupported = module.controllerAdapterContractFor({
    product: { id: 'unknown', engine: 'unknown' },
    capabilities: { apis: {} },
  });
  assert.equal(unsupported.id, 'unsupported');
  assert.equal(unsupported.enabled, false);

  const source = readFileSync(new URL('../extension/lib/browser-controller-adapter.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.debugger\.(?:attach|sendCommand)\s*\(/, 'Phase 3 must not add CDP action code');
});

test('classic content scripts use a preloaded shared browser API facade', () => {
  const facadeUrl = new URL('../extension/lib/browser-api-global.js', import.meta.url);
  let facadeSource = '';
  try {
    facadeSource = readFileSync(facadeUrl, 'utf8');
  } catch (error) {
    assert.fail(`browser-api-global.js is required for classic content scripts: ${error?.message || error}`);
  }

  const browserApi = { runtime: { id: 'browser-api' } };
  const chromeApi = { runtime: { id: 'chrome-api' } };
  const browserContext = { browser: browserApi, chrome: chromeApi };
  browserContext.globalThis = browserContext;
  vm.runInNewContext(facadeSource, browserContext);
  assert.equal(browserContext.hermesBrowserApi, browserApi);

  const chromeContext = { browser: null, chrome: chromeApi };
  chromeContext.globalThis = chromeContext;
  vm.runInNewContext(facadeSource, chromeContext);
  assert.equal(chromeContext.hermesBrowserApi, chromeApi);

  const packagedManifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const repositoryManifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(packagedManifest.content_scripts[0].js[0], 'lib/browser-api-global.js');
  assert.equal(repositoryManifest.content_scripts[0].js[0], 'extension/lib/browser-api-global.js');

  for (const file of ['content.js', 'content-inline-helper.js', 'lib/i18n-content.js']) {
    const source = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    assert.match(source, /hermesBrowserApi/, `${file} must consume the shared facade`);
    assert.doesNotMatch(source, /(?<![\w.])chrome\.(?:runtime|storage|tabs|scripting)/, `${file} must not directly select the chrome namespace`);
  }
});

test('manifest packaging assumptions are explicit for Chromium, Firefox, and Safari/WebKit', async () => {
  const profiles = await importRequiredModule('../scripts/manifest-profiles.mjs', 'manifest-profiles.mjs');
  const chromium = profiles.manifestAssumptionsFor('chromium');
  const firefox = profiles.manifestAssumptionsFor('firefox');
  const safari = profiles.manifestAssumptionsFor('safari-webkit');

  assert.equal(chromium.backgroundMode, 'service-worker-module');
  assert.equal(chromium.panelMode, 'side-panel');
  assert.equal(firefox.backgroundMode, 'background-scripts-module');
  assert.equal(firefox.panelMode, 'sidebar-action');
  assert.deepEqual(firefox.removedPermissions, ['debugger', 'offscreen', 'sidePanel']);
  assert.equal(safari.packaging, 'xcode-safari-web-extension-converter');
  assert.equal(safari.requiresMacOS, true);
  assert.equal(safari.directBuildSupported, false);
  assert.throws(() => profiles.manifestAssumptionsFor('unknown-browser'), /Unknown manifest target/);

  const firefoxBuild = readFileSync(new URL('../scripts/build-firefox.mjs', import.meta.url), 'utf8');
  assert.match(firefoxBuild, /manifest-profiles\.mjs/);
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const requiredFile of [
    'extension/lib/browser-api.mjs',
    'extension/lib/browser-api-global.js',
    'extension/lib/browser-controller-adapter.mjs',
    'scripts/manifest-profiles.mjs',
  ]) {
    assert.match(packageJson.scripts['check:js'], new RegExp(requiredFile.replaceAll('.', '\\.')));
  }
});

test('all 21 locale catalogs keep generic browser copy product-neutral', async () => {
  const { SUPPORTED_LOCALES, loadLocaleMessages } = await import('../extension/lib/i18n-registry.mjs');
  const keys = [
    'permissions.state',
    'ui.always.on.browser.wake.listening.requires.chromium.offscreen.do.3c68b702',
    'ui.chrome.can.suppress.microphone.prompts.inside.extension.side.pa.79f6cc35',
    'ui.chromium.can.block.microphone.capture.inside.extension.side.pan.88bae971',
    'ui.click.allow.microphone.to.request.access.chromium.requires.this.275e9aeb',
    'ui.opening.chromium.microphone.permission.prompt',
    'ui.prefers.hermes.native.wake.engine.locally.and.uses.chromium.on.42c1439e',
    'ui.this.chromium.browser.does.not.expose.mediarecorder.getusermedi.936d7f71',
  ];

  assert.equal(SUPPORTED_LOCALES.length, 21);
  for (const locale of SUPPORTED_LOCALES) {
    const messages = await loadLocaleMessages(locale.id);
    for (const key of keys) {
      assert.equal(typeof messages[key], 'string', `${locale.id}:${key} must remain translated`);
      assert.doesNotMatch(messages[key], /\b(?:Chrome|Chromium)\b/i, `${locale.id}:${key} must not claim a browser product`);
    }
  }
});
