import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('stale allow reply does not unblock after a newer deny', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  let seq = 0;
  const responses = new Map([
    [1, { inject: true, seq: 1 }],
    [2, { inject: false, seq: 2 }],
  ]);
  const context = {
    location: { href: 'https://news.example.com/' },
    run: 0,
    browser: {
      runtime: {
        sendMessage(message) {
          seq += 1;
          const reply = responses.get(message.seq) || { inject: false, seq: message.seq };
          if (message.seq === 1) {
            return new Promise((resolve) => {
              setTimeout(() => resolve(reply), 25);
            });
          }
          return Promise.resolve(reply);
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  context.hermesAwaitPageScriptPolicy(() => { context.run += 1; });

  const slow = context.hermesRefreshPageScriptPolicy();
  const deny = await context.hermesRefreshPageScriptPolicy();
  assert.equal(deny, false);
  assert.equal(context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject, false);
  await slow;

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(context.run, 0, 'late allow reply must not replay deferred bundle steps');
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
});

test('overlapping refreshes on an allowed page await the newest allow', async () => {
  const gateSource = await readFile(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = {
    location: { href: 'https://news.example.com/' },
    browser: {
      runtime: {
        sendMessage(message) {
          const reply = { inject: true, seq: message.seq };
          if (message.seq === 1) {
            return new Promise((resolve) => {
              setTimeout(() => resolve(reply), 25);
            });
          }
          return Promise.resolve(reply);
        },
      },
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: true,
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);

  const slow = context.hermesRefreshPageScriptPolicy();
  const fast = await context.hermesRefreshPageScriptPolicy();
  assert.equal(fast, true);
  assert.equal(await slow, true);
});