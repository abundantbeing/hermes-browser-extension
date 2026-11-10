import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('hermesRefreshPageScriptPolicy replays deferred bundle steps after opt-in', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  let resolvePolicy;
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
      promise: Promise.resolve(false),
      _resolvePolicy(inject) {
        context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !inject;
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
