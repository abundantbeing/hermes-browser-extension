import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { privateNetworkHost } from '../extension/lib/common.mjs';
import { renderPageContextInstallGuard } from '../scripts/build-page-context-guard.mjs';

const HOST_FIXTURES = [
  ['127.0.0.2', true],
  ['127.0.0.1', true],
  ['10.4.5.6', true],
  ['fd12::1', true],
  ['fe80::1', true],
  ['router.local', true],
  ['machine', true],
  ['example.com', false],
];

test('generated guard embeds the same privateNetworkHost classifier as common.mjs', () => {
  const source = renderPageContextInstallGuard();
  assert.match(source, /const privateNetworkHost = /);
  for (const [host, expected] of HOST_FIXTURES) {
    assert.equal(privateNetworkHost(host), expected, host);
    assert.equal(source.includes(`privateNetworkHost('${host}')`), false);
  }
  const embedded = source.match(/const privateNetworkHost = ([\s\S]+?)\n\n  const likelyPrivate/)?.[1];
  assert.ok(embedded, 'embedded classifier missing');
  const context = { globalThis: {} };
  vm.createContext(context);
  vm.runInContext(`${embedded}\nthis.classify = privateNetworkHost;`, context);
  for (const [host, expected] of HOST_FIXTURES) {
    assert.equal(context.classify(host), expected, host);
  }
});

test('guard resolves policy over promise-based sendMessage (Firefox)', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  assert.match(source, /globalThis\.browser\.runtime\.sendMessage\(message\)/);
  assert.doesNotMatch(source, /sendMessage\(message\);\s*if \(maybePromise/);
  assert.match(source, /Generated from extension\/lib\/common\.mjs privateNetworkHost/);

  const context = {
    location: { hostname: 'example.com', href: 'https://example.com:8443/' },
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        sendMessage(message) {
          assert.equal(message.type, 'HERMES_PAGE_SCRIPT_POLICY');
          return Promise.resolve({ inject: false });
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const inject = await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  assert.equal(inject, false);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
});

test('guard calls runtime.sendMessage only once on Chrome', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  let sendCount = 0;
  const context = {
    location: { hostname: 'example.com', href: 'https://example.com/' },
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          sendCount += 1;
          assert.equal(message.type, 'HERMES_PAGE_SCRIPT_POLICY');
          if (typeof callback === 'function') callback({ inject: true });
        },
      },
    },
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  assert.equal(sendCount, 1);
});

test('guard uses callback sendMessage when sendMessage returns void (Chrome)', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  const context = {
    location: { hostname: 'example.com', href: 'https://example.com/' },
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          assert.equal(message.type, 'HERMES_PAGE_SCRIPT_POLICY');
          if (typeof callback === 'function') callback({ inject: true });
          return undefined;
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const inject = await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  assert.equal(inject, true);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, false);
});

test('guard stays fail-closed until an authoritative inject decision arrives', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  assert.match(source, /fail closed/);
  assert.doesNotMatch(source, /finish\(!likelyPrivate\)/);
});

test('slow excluded-public denial keeps bundle blocked until decision resolves false', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  let resolveLate;
  const policy = new Promise((resolve) => { resolveLate = resolve; });
  const context = {
    location: { hostname: 'example.com', href: 'https://example.com/' },
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        sendMessage() {
          return policy;
        },
      },
    },
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(context.__HERMES_PAGE_SCRIPT_POLICY__.decided, false);
  resolveLate({ inject: false });
  const inject = await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  assert.equal(inject, false);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
});

test('messaging failure leaves bundle blocked with no decision', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  const context = {
    location: { hostname: 'example.com', href: 'https://example.com/' },
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        sendMessage() {
          return Promise.reject(new Error('offline'));
        },
      },
    },
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
  assert.equal(context.__HERMES_PAGE_SCRIPT_POLICY__.decided, false);
});

test('late private allow resolves policy after opt-in', async () => {
  const source = await readFile(new URL('../extension/page-context-install-guard.js', import.meta.url), 'utf8');
  let resolveLate;
  const policy = new Promise((resolve) => { resolveLate = resolve; });
  const context = {
    location: { hostname: '192.168.8.1', href: 'http://192.168.8.1/' },
    setTimeout,
    clearTimeout,
    browser: {
      runtime: {
        sendMessage() {
          return policy;
        },
      },
    },
    globalThis: {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, true);
  resolveLate({ inject: true });
  const inject = await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  assert.equal(inject, true);
  assert.equal(context.__HERMES_PAGE_SCRIPTS_BLOCKED__, false);
});
