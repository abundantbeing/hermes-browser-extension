import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { packagedPageContextScriptFiles } from '../extension/lib/page-script-host-policy.mjs';
import {
  pageContextBundleRestartFilesFromManifest,
} from '../extension/lib/page-context-bundle-restart.mjs';

const gateUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);
const browserApiUrl = new URL('../extension/lib/browser-api-global.js', import.meta.url);

test('frame fallback restart injects gate-first files and blocks bundle boot on localhost navigation', async () => {
  const restartFiles = pageContextBundleRestartFilesFromManifest(packagedPageContextScriptFiles());
  assert.match(restartFiles[0], /page-context-bundle-gate/);

  const gateSource = await readFile(gateUrl, 'utf8');
  const facadeSource = await readFile(browserApiUrl, 'utf8');
  let href = 'https://example.com/app';
  const context = {
    get location() {
      return { href, origin: new URL(href).origin };
    },
    __HERMES_BROWSER_CONTENT_LOADED__: 'stale-bridge',
    bundleBoots: 0,
    captures: 0,
    browser: {
      runtime: {
        sendMessage(message) {
          const url = message?.url || href;
          const inject = url.includes('localhost') ? false : true;
          return Promise.resolve({ inject, seq: message.seq, allowLocalDocuments: false });
        },
      },
    },
    HermesContentExtractor: { collectPageContext: () => ({ ok: true, text: 'leaked', selectedText: '', meta: {} }) },
    globalThis: {},
    URL,
  };
  context.globalThis = context;
  vm.createContext(context);

  context.__HERMES_PAGE_SCRIPT_POLICY__ = {
    decided: true,
    latestInject: true,
    policyLocationToken: `https://example.com\u0000https://example.com/app`,
    policySeq: 0,
  };
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;

  href = 'http://localhost/private';
  vm.runInContext(gateSource, context);
  vm.runInContext(facadeSource, context);

  const inject = await context.hermesPageScriptPolicyPromise();
  assert.equal(inject, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.bundleBoots, 0);

  const allowed = context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject === true
    && context.__HERMES_PAGE_SCRIPT_POLICY__.policyLocationToken === `http://localhost\u0000http://localhost/private`
    && context.__HERMES_PAGE_SCRIPTS_BLOCKED__ !== true;
  assert.equal(allowed, false);
  if (allowed && context.HermesContentExtractor?.collectPageContext) {
    context.captures += 1;
  }
  assert.equal(context.captures, 0);
});