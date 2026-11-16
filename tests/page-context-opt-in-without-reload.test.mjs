import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gateUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);

async function loadGateContext() {
  const gateSource = await readFile(gateUrl, 'utf8');
  const context = {
    location: { href: 'http://192.168.8.1/' },
    listenerStarted: 0,
    extractorStarted: 0,
    browser: {
      runtime: {
        sendMessage() {
          return Promise.resolve({ inject: true });
        },
      },
    },
    globalThis: {},
  };
  context.globalThis = context;
  const guardStub = `
    globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
    globalThis.__HERMES_PAGE_SCRIPT_POLICY__ = {
      likelyPrivate: true,
      decided: true,
      latestInject: false,
      promise: Promise.resolve(false),
      _resolvePolicy(inject) {
        const allow = Boolean(inject);
        globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !allow;
        globalThis.__HERMES_PAGE_SCRIPT_POLICY__.latestInject = allow;
      },
    };
  `;
  vm.createContext(context);
  vm.runInContext(guardStub, context);
  vm.runInContext(gateSource, context);
  return { context, gateSource };
}

test('Greptile scenario: manual bundle install without refresh stays blocked on stale deny', async () => {
  const { context, gateSource } = await loadGateContext();
  context.hermesAwaitPageScriptPolicy(() => { context.listenerStarted += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.listenerStarted, 0);
  assert.equal(await context.hermesPageScriptPolicyPromise(), false);
  vm.runInContext(gateSource, context);
  context.hermesAwaitPageScriptPolicy(() => { context.extractorStarted += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.extractorStarted, 0);
});

test('Greptile scenario: allow flip marks bundle restart before deferred bridge boots', async () => {
  const { context } = await loadGateContext();
  context.hermesAwaitPageScriptPolicy(() => { context.listenerStarted += 1; });
  assert.equal(await context.hermesRefreshPageScriptPolicy(), true);
  assert.equal(context.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__, true);
});

test('Greptile scenario: saved opt-in, refresh, manual bundle install without reload starts listener and extractor', async () => {
  const { context, gateSource } = await loadGateContext();
  context.hermesAwaitPageScriptPolicy(() => { context.listenerStarted += 1; });
  assert.equal(await context.hermesRefreshPageScriptPolicy(), true);
  vm.runInContext(gateSource, context);
  context.hermesAwaitPageScriptPolicy(() => { context.extractorStarted += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.listenerStarted, 1);
  assert.equal(context.extractorStarted, 1);
  assert.equal(await context.hermesPageScriptPolicyPromise(), true);
});