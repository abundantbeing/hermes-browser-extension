import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('pageScriptPolicyPromise follows latestInject after refresh even when the guard promise stayed false', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'http://192.168.8.1/' },
    bundleRan: 0,
    browser: {
      runtime: {
        sendMessage() {
          return Promise.resolve({ inject: true });
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    __HERMES_PAGE_SCRIPT_POLICY__: {
      decided: true,
      latestInject: false,
      promise: Promise.resolve(false),
      _resolvePolicy(inject) {
        const allow = Boolean(inject);
        context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !allow;
        context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject = allow;
      },
    },
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  let inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, false);
  context.hermesAwaitPageScriptPolicy(() => { context.bundleRan += 1; });
  assert.equal(context.bundleRan, 0);
  await context.hermesRefreshPageScriptPolicy();
  inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.bundleRan, 1);
});

test('fresh gate install without document_start guard still runs after policy refresh', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'http://127.0.0.1:18901/' },
    ran: 0,
    browser: {
      runtime: {
        sendMessage() {
          return Promise.resolve({ inject: true });
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  assert.equal(typeof context.hermesRefreshPageScriptPolicy, 'function');
  await context.hermesRefreshPageScriptPolicy();
  context.hermesAwaitPageScriptPolicy(() => { context.ran += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.ran, 1);
  assert.equal(context.__HERMES_PAGE_SCRIPT_POLICY__?.latestInject, true);
});
