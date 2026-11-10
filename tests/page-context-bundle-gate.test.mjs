import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('freshly injected gate uses latestInject after stale promise denied', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'http://192.168.8.1/' },
    run: 0,
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
  context.hermesAwaitPageScriptPolicy(() => { context.run += 1; });
  assert.equal(context.run, 0, 'stale deny must defer until latest decision is read');
  let inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, false);
  await context.hermesRefreshPageScriptPolicy();
  inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.run, 1);
});

test('deny first, refresh allow, then newly injected bundle gate runs deferred steps', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const denied = {
    location: { href: 'http://192.168.8.1/' },
    bundleRan: 0,
    browser: {
      runtime: {
        sendMessage() {
          return Promise.resolve({ inject: false });
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
  };
  denied.globalThis = denied;
  vm.createContext(denied);
  vm.runInContext(gateSource, denied);
  await denied.hermesRefreshPageScriptPolicy();
  await denied.hermesPageScriptPolicyPromise();

  const allowed = {
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
        allowed.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !allow;
        allowed.__HERMES_PAGE_SCRIPT_POLICY__.latestInject = allow;
        if (allow && typeof allowed.__hermesPageScriptPolicyDecided === 'function') {
          allowed.__hermesPageScriptPolicyDecided(allow);
        }
      },
    },
  };
  allowed.globalThis = allowed;
  vm.createContext(allowed);
  vm.runInContext(gateSource, allowed);
  allowed.hermesAwaitPageScriptPolicy(() => { allowed.bundleRan += 1; });
  assert.equal(allowed.bundleRan, 0);
  const inject = await allowed.hermesRefreshPageScriptPolicy();
  assert.equal(inject, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(allowed.bundleRan, 1);
});

test('hermesRefreshPageScriptPolicy replays deferred bundle steps after opt-in', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'http://192.168.8.1/' },
    run: 0,
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
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  context.hermesAwaitPageScriptPolicy(() => { context.run += 1; });
  assert.equal(context.run, 0);
  const inject = await context.hermesRefreshPageScriptPolicy();
  assert.equal(inject, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.run, 1);
});
