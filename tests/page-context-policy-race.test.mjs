import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { readFile as read } from 'node:fs/promises';

test('bundle gate defers callbacks until policy allows injection', async () => {
  const gateSource = await read(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  const context = { run: 0 };
  let resolvePolicy;
  context.__HERMES_PAGE_SCRIPT_POLICY__ = {
    promise: new Promise((resolve) => { resolvePolicy = resolve; }),
    likelyPrivate: false,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  context.hermesAwaitPageScriptPolicy(() => { context.run += 1; });
  assert.equal(context.run, 0);
  resolvePolicy(true);
  await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.run, 1);
});

test('late deny blocks bundle after guard starts (excluded public port)', async () => {
  let resolvePolicy;
  const context = { run: 0, HermesContentExtractor: null };
  context.__HERMES_PAGE_SCRIPT_POLICY__ = {
    promise: new Promise((resolve) => { resolvePolicy = resolve; }),
    likelyPrivate: false,
  };
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;
  context.globalThis = context;
  vm.createContext(context);
  const gate = await read(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  vm.runInContext(gate, context);
  context.hermesAwaitPageScriptPolicy(() => {
    context.run += 1;
    context.HermesContentExtractor = { marker: true };
  });
  resolvePolicy(false);
  await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.run, 0);
  assert.equal(context.HermesContentExtractor, null);
});

test('late allow unblocks private host when opt-in is enabled', async () => {
  let resolvePolicy;
  const context = { run: 0, HermesContentExtractor: null };
  context.__HERMES_PAGE_SCRIPT_POLICY__ = {
    promise: new Promise((resolve) => { resolvePolicy = resolve; }),
    likelyPrivate: true,
  };
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
  context.globalThis = context;
  vm.createContext(context);
  const gate = await read(new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url), 'utf8');
  vm.runInContext(gate, context);
  context.hermesAwaitPageScriptPolicy(() => {
    context.run += 1;
    context.HermesContentExtractor = { marker: true };
  });
  assert.equal(context.run, 0);
  resolvePolicy(true);
  await context.__HERMES_PAGE_SCRIPT_POLICY__.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.run, 1);
  assert.ok(context.HermesContentExtractor);
});

test('content extractor wrapper waits for policy before defining runtime', async () => {
  const header = await read(new URL('../extension/content-extractor.js', import.meta.url), 'utf8');
  assert.match(header, /hermesContentExtractorPolicyGate/);
  assert.match(header, /hermesPageScriptPolicyPromise/);
});
