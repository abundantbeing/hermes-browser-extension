import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('HERMES_GET_PAGE_CONTEXT re-checks page-script policy before reading the document', async () => {
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(contentSource, /pageContextCaptureBlockedByGate/);
  assert.match(contentSource, /hermesRefreshPageScriptPolicy/);

  const sandbox = {
    console,
    globalThis: {},
    HermesContentExtractor: {
      collectPageContext: () => ({ ok: true, text: 'leaked', selectedText: '', meta: {} }),
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
  sandbox.location = { href: 'http://localhost/' };
  sandbox.chrome = sandbox.browserApi;
  sandbox.hermesBrowserApi = sandbox.chrome;
  sandbox.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
  sandbox.hermesAwaitPageScriptPolicy = (boot) => boot();

  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox);

  const listener = sandbox.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
  assert.equal(typeof listener, 'function');
  let response;
  listener({ type: 'HERMES_GET_PAGE_CONTEXT', options: {} }, {}, (value) => { response = value; });
  assert.equal(response?.ok, false);
  assert.equal(response?.skipped, true);
});