import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('HERMES_GET_PAGE_CONTEXT refreshes policy before honoring a cached denial', async () => {
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const gateCheck = contentSource.indexOf('if (message?.type === \'HERMES_GET_PAGE_CONTEXT\')');
  const refreshAt = contentSource.indexOf('hermesRefreshPageScriptPolicy', gateCheck);
  const cachedDenialAt = contentSource.indexOf('pageContextCaptureBlockedByGate()', refreshAt);
  assert.ok(refreshAt > gateCheck);
  assert.ok(cachedDenialAt > refreshAt, 'cached gate denial must not run before policy refresh');

  let refreshCalls = 0;
  const sandbox = {
    console,
    globalThis: {},
    HermesContentExtractor: {
      collectPageContext: () => ({ ok: true, text: 'context', selectedText: '', meta: {} }),
    },
    browserApi: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: () => Promise.resolve(),
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.document = { addEventListener() {} };
  sandbox.window = {};
  sandbox.location = { href: 'https://example.com/group' };
  sandbox.chrome = sandbox.browserApi;
  sandbox.hermesBrowserApi = sandbox.chrome;
  sandbox.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
  sandbox.__HERMES_PAGE_SCRIPT_POLICY__ = { latestInject: false };
  sandbox.hermesRefreshPageScriptPolicy = () => {
    refreshCalls += 1;
    sandbox.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;
    sandbox.__HERMES_PAGE_SCRIPT_POLICY__ = { latestInject: true };
    return Promise.resolve(true);
  };
  sandbox.hermesIsPageContextCaptureUrlBlocked = () => false;
  sandbox.hermesAwaitPageScriptPolicy = (boot) => boot();

  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox);

  const listener = sandbox.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
  let response;
  await new Promise((resolve) => {
    listener({ type: 'HERMES_GET_PAGE_CONTEXT', options: {} }, {}, (value) => {
      response = value;
      resolve();
    });
  });
  assert.equal(refreshCalls, 1);
  assert.equal(response?.ok, true);
  assert.equal(response?.text, 'context');
});