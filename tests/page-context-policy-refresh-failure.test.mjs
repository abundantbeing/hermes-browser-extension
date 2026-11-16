import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadGateVm(sendMessage) {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'https://example.com/one', origin: 'https://example.com' },
    browser: { runtime: { sendMessage } },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  return context;
}

test('overlapping refreshes fail closed when the newest policy request errors', async () => {
  const context = await loadGateVm((message) => {
    if (message.seq === 1) {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ inject: true, seq: 1 }), 40);
      });
    }
    return Promise.reject(new Error('policy transport failed'));
  });

  context.location.href = 'https://example.com/two';
  const pending = context.hermesPageScriptPolicyPromise();
  void context.hermesRefreshPageScriptPolicy();
  const newest = await context.hermesRefreshPageScriptPolicy();
  assert.equal(newest, false);

  const inject = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('shared policy promise hung')), 250)),
  ]);
  assert.equal(inject, false);
  assert.equal(context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject, false);
});

test('HERMES_GET_PAGE_CONTEXT replies denied when the newest overlapping refresh fails', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

  const context = {
    console,
    location: { href: 'https://example.com/start', origin: 'https://example.com' },
    browserApi: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: () => Promise.resolve(),
      },
    },
    browser: {
      runtime: {
        sendMessage(message) {
          if (message.seq === 1) {
            return new Promise((resolve) => {
              setTimeout(() => resolve({ inject: true, seq: 1 }), 40);
            });
          }
          return Promise.reject(new Error('policy transport failed'));
        },
      },
    },
    document: { addEventListener() {} },
    window: {},
    HermesContentExtractor: {
      collectPageContext: () => ({ ok: true, text: 'leaked', selectedText: '', meta: {} }),
    },
    HermesSiteAdapters: {
      inspectSite: () => ({}),
      applySiteAdapterPolicy: (pageContext) => pageContext,
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    hermesIsPageContextCaptureUrlBlocked: () => false,
    hermesAwaitPageScriptPolicy: (boot) => boot(),
    globalThis: {},
  };
  context.globalThis = context;
  context.chrome = context.browserApi;
  context.hermesBrowserApi = context.browserApi;
  vm.createContext(context);
  vm.runInContext(contentSource, context);
  const listener = context.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
  assert.equal(typeof listener, 'function');
  vm.runInContext(gateSource, context);

  context.location.href = 'https://example.com/moved';
  void context.hermesRefreshPageScriptPolicy();
  await context.hermesRefreshPageScriptPolicy();

  let response;
  let replied = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture request hung')), 300);
    listener(
      { type: 'HERMES_GET_PAGE_CONTEXT', options: {} },
      {},
      (value) => {
        replied = true;
        response = value;
        clearTimeout(timer);
        resolve();
      },
    );
  });

  assert.equal(replied, true, 'capture request must reply, not hang');
  assert.equal(response?.ok, false);
  assert.notEqual(response?.text, 'leaked');
});