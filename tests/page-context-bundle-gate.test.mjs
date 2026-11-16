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

test('stale policyLocationToken does not allow capture after in-document navigation', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'http://localhost/private', origin: 'http://localhost' },
    browser: {
      runtime: {
        sendMessage(message) {
          return Promise.resolve({ inject: false, seq: message.seq, allowLocalDocuments: false });
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: false,
    __HERMES_PAGE_SCRIPT_POLICY__: {
      decided: true,
      latestInject: true,
      policyLocationToken: 'https://example.com\u0000https://example.com/safe',
      policySeq: 0,
    },
    globalThis: {},
    URL,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  const inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, false);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
});

test('re-injected bundle gate clears stale allow before booting bundle code', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  let calls = 0;
  const context = {
    location: { href: 'http://localhost/' },
    bundleRan: 0,
    __HERMES_BROWSER_CONTENT_LOADED__: 'reinject-test',
    browser: {
      runtime: {
        sendMessage() {
          calls += 1;
          return Promise.resolve({ inject: false, seq: calls });
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: false,
    __HERMES_PAGE_SCRIPT_POLICY__: {
      decided: true,
      latestInject: true,
      policySeq: 0,
      promise: Promise.resolve(true),
    },
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
  assert.equal(context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject, null);
  context.hermesAwaitPageScriptPolicy(() => { context.bundleRan += 1; });
  assert.equal(context.bundleRan, 0);
  const inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, false);
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

test('policy allow flip sets bundle restart sentinel for full dependency-ordered reinstall', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'http://192.168.8.1/' },
    browser: {
      runtime: {
        sendMessage(message) {
          return Promise.resolve({ inject: true, seq: message?.seq });
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    __HERMES_PAGE_SCRIPT_POLICY__: { policySeq: 0 },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  await context.hermesRefreshPageScriptPolicy();
  assert.equal(context.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__, true);
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
