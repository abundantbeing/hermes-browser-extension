import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { packagedPageContextScriptFiles } from '../extension/lib/page-script-host-policy.mjs';
import { runPageContextBundleRestart } from '../extension/lib/page-context-bundle-restart.mjs';

const LOCALHOST = 'http://localhost/private';
const PUBLIC = 'https://example.com/page-a';
const tokenFor = (href) => `${new URL(href).origin}\u0000${href}`;

test('runPageContextBundleRestart return false blocks follow-up scripting collect on navigated frame', async () => {
  const sidepanel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const collect = sidepanel.match(/function collectPageContextWithSharedExtractor\(options = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(collect, /captureRequestAnchorToken/);
  assert.match(collect, /__HERMES_PAGE_SCRIPT_POLICY__/);
  assert.match(collect, /policyLocationToken/);

  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  let href = PUBLIC;
  const binding = {
    tabId: 61,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    captureRequestAnchorToken: tokenFor(PUBLIC),
    anchorToken: tokenFor(PUBLIC),
  };
  const fileInjections = [];
  const executeScript = async (request) => {
    if (request.files) {
      fileInjections.push([...request.files]);
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href')) {
      return [{ result: { href, origin: new URL(href).origin, token: tokenFor(href) } }];
    }
    return [{ result: undefined }];
  };
  href = LOCALHOST;
  const ok = await runPageContextBundleRestart(
    executeScript,
    binding,
    packagedPageContextScriptFiles(),
    {
      verifyBinding: async () => false,
      beforeInject: async () => false,
    },
  );
  assert.equal(ok, false);
  assert.equal(fileInjections.length, 0);
  const scriptingFallback = sidepanel.match(
    /async function getPageContextViaScripting\(tabId, options, originalError, tabUrl = ''\) \{[\s\S]*?\n\}/,
  )?.[0] || '';
  assert.match(scriptingFallback, /if \(!extractorInjected/);
  assert.match(scriptingFallback, /captureRequestAnchorToken: captureToken/);
  assert.match(scriptingFallback, /pageContextPolicyGrantMatchesAnchor/);
});