import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gateUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);
const browserApiUrl = new URL('../extension/lib/browser-api-global.js', import.meta.url);

test('opt-in on open private IP publishes one shared pending promise for restarted bundle entries', async () => {
  const gateSource = await readFile(gateUrl, 'utf8');
  const facadeSource = await readFile(browserApiUrl, 'utf8');
  let releasePolicy;
  const policyReply = new Promise((resolve) => {
    releasePolicy = resolve;
  });
  const context = {
    location: { href: 'http://192.168.8.1/dashboard', origin: 'http://192.168.8.1' },
    __HERMES_BROWSER_CONTENT_LOADED__: 'prior-bridge',
    extractorReady: false,
    bridgeReady: false,
    browser: {
      runtime: {
        sendMessage(message) {
          return policyReply.then((reply) => ({ ...reply, seq: message.seq }));
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    __HERMES_PAGE_SCRIPT_POLICY__: {
      likelyPrivate: true,
      decided: true,
      latestInject: false,
      policyLocationToken: 'http://192.168.8.1\u0000http://192.168.8.1/old',
      promise: Promise.resolve(false),
      policySeq: 0,
    },
    globalThis: {},
    URL,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);

  const shared = context.hermesPageScriptPolicyPromise();
  let extractorSettled = 'pending';
  shared.then((inject) => {
    extractorSettled = inject;
    if (inject) context.extractorReady = true;
  });
  context.hermesAwaitPageScriptPolicy(() => { context.bridgeReady = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(extractorSettled, 'pending');
  assert.equal(context.extractorReady, false);
  assert.equal(context.bridgeReady, false);

  releasePolicy({ inject: true, allowLocalDocuments: false });
  const inject = await shared;
  assert.equal(inject, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.extractorReady, true);
  assert.equal(context.bridgeReady, true);
  assert.equal(
    context.__HERMES_PAGE_SCRIPT_POLICY__.policyLocationToken,
    'http://192.168.8.1\u0000http://192.168.8.1/dashboard',
  );

  vm.runInContext(facadeSource, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(context.hermesBrowserApi, 'bridge facade boots only after shared allow');
});