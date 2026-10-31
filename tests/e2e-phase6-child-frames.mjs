// Hermes Control reaches a page's child frames, in a real browser.
//
// A live stream's chat, an embedded player, a comment box: each is its own iframe, and the page's own
// accessibility tree never describes it. This loads the unpacked extension in Chromium, attaches a tab
// whose page looks like a live stream (a long recommendations list around a same-site chat frame), and
// drives it through the real controller path:
//   - the turn's page view and browser_snapshot list the chat composer, with a ref that works;
//   - typing into the composer and pressing Send reach the chat frame;
//   - controls in an inline (srcdoc) frame and in a scripted blank frame are reachable too;
//   - a child frame on a restricted page (a checkout inside an allowed page) is never read;
//   - a ref keeps its number when another frame in the page comes or goes;
//   - a frame with more controls than the view budget is reported as cut, not as complete.
// Chat frames of a real live stream are same-site with the watch page, so they are in the tab's own
// process; this fixture serves the page and its frames from two ports of one host to match.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { launchChrome } from './e2e-chrome-env.mjs';
import {
  CdpClient,
  DIST,
  REAL_CAPABILITIES,
  ROOT,
  TEST_ACCESS_VALUE,
  TEST_SESSION_ID,
  chromeExecutable,
  ensureExtensionStartupPage,
  fetchJson,
  killChrome,
  startControllerFixture,
  unpackedExtensionId,
  waitFor,
} from './e2e-phase6-browser-control.mjs';

const PROFILE = path.join(ROOT, 'tmp', `e2e-phase6-child-frames-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const SCREENSHOT = path.join(QA_DIR, 'phase6-child-frames.png');
const VERDICT = path.join(QA_DIR, 'phase6-child-frames-verdict.json');

const COMPOSER_TEXT = 'hello from Hermes in the live chat';
const CARD_SECRET = 'CARD-SECRET-TEXT-4242';

function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
  });
}

const CHAT_PAGE = `<!doctype html><html><head><title>Live chat</title><style>
  body { font: 14px sans-serif; margin: 0; } #items { height: 300px; overflow: auto; }
  #input { border: 1px solid #888; min-height: 24px; padding: 4px; margin: 4px; }
</style></head><body>
  <div id="items">${Array.from({ length: 40 }, (_, index) => `<div role="listitem"><b>viewer${index}</b> chat message number ${index}</div>`).join('')}</div>
  <div id="input" contenteditable="true" role="textbox" aria-label="Chat" aria-multiline="false"></div>
  <button id="send" type="button" aria-label="Send">Send</button>
  <script>
    const input = document.getElementById('input');
    const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    input.addEventListener('input', () => post('/api/typed', { text: input.textContent }));
    document.getElementById('send').addEventListener('click', () => {
      const text = input.textContent;
      post('/api/sent', { text });
      const item = document.createElement('div'); item.setAttribute('role', 'listitem'); item.textContent = 'you ' + text;
      document.getElementById('items').appendChild(item);
      input.textContent = '';
    });
  </script></body></html>`;

const AD_PAGE = '<!doctype html><title>Ad</title><p>Sponsored: a trivial ad slot</p>';
const CHECKOUT_PAGE = `<!doctype html><title>Pay</title><h1>Pay now</h1><label>Card holder <input aria-label="Card holder"></label><p>${CARD_SECRET}</p>`;
const BIG_FRAME_PAGE = `<!doctype html><title>Many controls</title>${Array.from({ length: 460 }, (_, index) => `<button type="button">Emoji ${index}</button>`).join('')}`;

function watchPage(childBase) {
  const links = Array.from({ length: 650 }, (_, index) => `<li><a href="#video-${index}">Recommended video number ${index}: a sample title</a></li>`).join('');
  const chips = Array.from({ length: 120 }, (_, index) => `<button type="button">Filter chip ${index}</button>`).join('');
  return `<!doctype html><html><head><title>Live stream test</title><style>
    body { margin: 0; font: 14px sans-serif; } .frames { position: absolute; left: 520px; top: 180px; width: 420px; }
    iframe { display: block; border: 1px solid #aaa; margin-bottom: 6px; width: 400px; } #chat { height: 420px; }
  </style></head><body>
    <header><h1>Live: Hermes stream</h1><button type="button" id="subscribe">Subscribe</button></header>
    <section class="frames">
      <iframe id="ads" title="Advertisement" src="${childBase}/ad" height="60"></iframe>
      <iframe id="chat" title="Live chat" src="${childBase}/live_chat?v=abc"></iframe>
      <iframe id="inline" title="Inline reply" height="60" srcdoc="&lt;button&gt;Reply inline&lt;/button&gt;&lt;p&gt;Inline frame text&lt;/p&gt;"></iframe>
      <iframe id="blank" title="Scripted frame" height="60"></iframe>
      <iframe id="pay" title="Payment" height="120" src="${childBase}/checkout/pay"></iframe>
    </section>
    <nav><ul>${links}</ul><div>${chips}</div></nav>
    <script>
      const blank = document.getElementById('blank').contentDocument;
      blank.body.innerHTML = '<label>Blank frame note <input aria-label="Blank frame note"></label>';
    </script>
  </body></html>`;
}

async function startPages() {
  const state = { typed: [], sent: [], childHits: [] };
  const child = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    state.childHits.push(url.pathname);
    if (req.method === 'POST' && url.pathname === '/api/typed') { state.typed.push((await readBody(req)).text); res.writeHead(204).end(); return; }
    if (req.method === 'POST' && url.pathname === '/api/sent') { state.sent.push((await readBody(req)).text); res.writeHead(204).end(); return; }
    if (url.pathname === '/live_chat') return html(res, CHAT_PAGE);
    if (url.pathname === '/ad') return html(res, AD_PAGE);
    if (url.pathname === '/big') return html(res, BIG_FRAME_PAGE);
    if (url.pathname === '/checkout/pay') return html(res, CHECKOUT_PAGE);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => child.listen(0, '127.0.0.1', resolve));
  const childBase = `http://localhost:${child.address().port}`;
  const parent = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/watch') return html(res, watchPage(childBase));
    if (url.pathname === '/with-big-frame') return html(res, `<!doctype html><title>Big frame</title><button type="button">Main button</button><iframe title="Emoji picker" src="${childBase}/big" width="500" height="300"></iframe>`);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve));
  return {
    state,
    parentBase: `http://localhost:${parent.address().port}`,
    close: async () => {
      await new Promise((resolve) => child.close(resolve));
      await new Promise((resolve) => parent.close(resolve));
    },
  };
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before the child-frames journey.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const pages = await startPages();
  const fixture = await startControllerFixture();
  const startedAt = Date.now();
  let chrome;
  let browser;
  let extension;
  let page;
  let chromeStderr = '';

  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = launchChrome(chromeExecutable(), [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--lang=en-US',
      '--remote-debugging-port=0',
      `--user-data-dir=${PROFILE}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `chrome-extension://${extensionId}/request-permissions.html`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    chrome.stderr.on('data', (chunk) => { chromeStderr += String(chunk); });

    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;
    await ensureExtensionStartupPage(devtoolsBase, extensionId);
    const version = await fetchJson(`${devtoolsBase}/json/version`);
    browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.connect();

    const extensionTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').startsWith(`chrome-extension://${extensionId}/`)) || null;
    });
    extension = new CdpClient(extensionTarget.webSocketDebuggerUrl);
    await extension.connect();
    await extension.call('Runtime.enable');
    await waitFor(() => extension.evaluate('Boolean(globalThis.chrome?.runtime?.sendMessage && chrome?.storage?.local)'));

    await extension.evaluate(`(() => {
      const authField = ['api', 'Key'].join('');
      return chrome.storage.local.set({
        hermesBrowserSettings: {
          connectionSchemaVersion: 1,
          connectionMode: 'local',
          connectionTransport: 'local-api',
          gatewayMode: 'local-api',
          gatewayUrl: ${JSON.stringify(fixture.baseUrl)},
          [authField]: ${JSON.stringify(TEST_ACCESS_VALUE)},
          tokenSource: 'e2e-child-frames',
          sessionId: ${JSON.stringify(TEST_SESSION_ID)},
          sessionStartMode: 'resume',
          browserControlEnabled: true,
          browserControlPaused: false,
          browserControlScope: 'this-tab',
        },
        hermesBrowserIntroSeen: true
      });
    })()`);
    const rebound = await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_SETTINGS_REFRESH' })`);
    assert.equal(rebound?.ok, true, JSON.stringify(rebound));
    await waitFor(() => fixture.registrations.some((item) => JSON.stringify(item.capabilities) === JSON.stringify([...REAL_CAPABILITIES])));
    await waitFor(() => fixture.connections.length >= 1);
    const status = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected && value?.controlEnabled && value?.controllerId ? value : null
    )));

    const openAttachedTab = async (url) => {
      const tab = await extension.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: true })`);
      const tabId = Number(tab.id);
      assert.ok(Number.isInteger(tabId) && tabId > 0);
      const targetPage = await waitFor(async () => {
        const targets = await fetchJson(`${devtoolsBase}/json/list`);
        return targets.find((target) => target.type === 'page' && String(target.url || '') === url) || null;
      }, 30_000, 250);
      const client = new CdpClient(targetPage.webSocketDebuggerUrl);
      await client.connect();
      await client.call('Runtime.enable');
      await client.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await waitFor(() => client.evaluate(`document.readyState === 'complete'`), 30_000, 100);
      const lease = await extension.evaluate(`chrome.runtime.sendMessage({
        type: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
        kind: 'this-tab',
        ownerId: ${JSON.stringify(status.controllerId)},
        ownership: 'owned',
        tabIds: [${tabId}]
      })`);
      assert.equal(lease?.ok, true, JSON.stringify(lease));
      await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);
      const target = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({
        type: 'HERMES_CONTROLLER_TARGET_RESOLVE', tabId: ${tabId}, frameId: 0, expectedUrl: ${JSON.stringify(url)}
      })`).then((value) => (value?.availability === 'available' ? value : null)), 30_000, 250);
      return { tabId, client, target, url };
    };

    const controllerConnectionFor = (action) => {
      const match = [...fixture.registrations]
        .map((registration, index) => ({ registration, index }))
        .reverse()
        .find(({ registration }) => Array.isArray(registration.capabilities) && registration.capabilities.includes(action));
      const connection = match ? fixture.connections[match.index] : null;
      assert.ok(connection && !connection.socket.destroyed && connection.socket.writable, `No live controller connection for ${action}.`);
      return connection;
    };
    let sequence = 0;
    const command = (tab) => async (action, args = {}, { approve = false } = {}) => {
      sequence += 1;
      const commandId = `child-frames-${sequence}-${action}`;
      controllerConnectionFor(action).send({
        method: 'browser.controller.command',
        params: {
          command_id: commandId,
          action,
          arguments: args,
          tab_id: tab.target.tabId,
          frame_id: tab.target.frameId,
          document_generation: tab.target.documentGeneration,
        },
      });
      const result = waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === commandId), 45_000, 100);
      if (approve) {
        const approval = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' }).then((value) => (
          value?.pendingApproval?.commandId === ${JSON.stringify(commandId)} ? value.pendingApproval : null
        ))`), 20_000, 100);
        const granted = await extension.evaluate(`chrome.runtime.sendMessage({
          type: 'HERMES_CONTROLLER_APPROVAL_GRANT',
          approvalId: ${JSON.stringify(approval.approvalId)},
          approvalNonce: ${JSON.stringify(approval.approvalNonce)},
          commandId: ${JSON.stringify(approval.commandId)},
          controllerId: ${JSON.stringify(approval.controllerId)},
          leaseId: ${JSON.stringify(approval.leaseId)},
          leaseGeneration: ${Number(approval.leaseGeneration)},
          action: ${JSON.stringify(approval.action)},
          tabId: ${Number(approval.tabId)},
          documentGeneration: ${Number(approval.documentGeneration)},
          paused: true
        })`);
        assert.equal(granted?.ok, true, JSON.stringify(granted));
      }
      return (await result).params;
    };
    const refMatching = (refs, role, pattern) => refs.find((item) => item.role === role && pattern.test(item.name || ''));

    // ---- 1. the live stream page: a long main frame and a same-site chat frame ----------------------------------------
    const watchUrl = `${pages.parentBase}/watch`;
    const watch = await openAttachedTab(watchUrl);
    page = watch.client;
    const run = command(watch);
    await waitFor(() => pages.state.childHits.includes('/live_chat'), 30_000, 100);
    await waitFor(() => page.evaluate(`document.getElementById('blank').contentDocument.querySelector('input') !== null`), 10_000, 100);
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The turn's page view is what the model sees first; the chat composer has to be in it.
    const prepared = await extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_PREPARE_TURN', tabId: ${watch.tabId}, frameId: 0, expectedUrl: ${JSON.stringify(watchUrl)}
    })`);
    assert.equal(prepared?.state, 'ready', JSON.stringify(prepared).slice(0, 400));
    const turnText = String(prepared?.controlSnapshot?.text || '');
    assert.match(turnText, /textbox "Chat"/, `the turn's page view must list the live chat composer:\n${turnText.slice(0, 1500)}`);
    assert.match(turnText, /button "Send"/, 'the turn\'s page view must list the chat Send button');
    assert.match(turnText, /chat message number/, 'the turn\'s page view must carry the chat text');
    assert.match(turnText, /button "Subscribe"/);

    const snapshot = await run('browser_snapshot');
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot).slice(0, 600));
    const refs = snapshot.result.refs;
    const composer = refMatching(refs, 'textbox', /^Chat$/);
    const send = refMatching(refs, 'button', /^Send$/);
    const inlineReply = refMatching(refs, 'button', /^Reply inline$/);
    const blankNote = refMatching(refs, 'textbox', /^Blank frame note$/);
    assert.ok(composer?.ref && send?.ref, `chat refs missing from the snapshot: ${JSON.stringify(refs.filter((item) => item.frameId))}`);
    assert.ok(inlineReply?.ref, 'a control in an inline (srcdoc) frame must be reachable');
    assert.ok(blankNote?.ref, 'a control in a scripted blank frame must be reachable');
    assert.match(composer.ref, /^@f\w+e\d+$/, 'a framed control\'s ref names its frame');

    // A frame on a restricted page inside an allowed page is never read.
    const everything = JSON.stringify(snapshot.result);
    for (const forbidden of [CARD_SECRET, 'Pay now', 'Card holder']) {
      assert.equal(everything.includes(forbidden), false, `restricted child frame content leaked into the snapshot: ${forbidden}`);
    }
    assert.equal(JSON.stringify(prepared).includes(CARD_SECRET), false, 'restricted child frame content leaked into the turn view');

    // ---- 2. comment in the live chat: type, then Send ------------------------------------------------------------------
    const typed = await run('browser_type', { ref: composer.ref, text: COMPOSER_TEXT });
    assert.equal(typed.ok, true, JSON.stringify(typed).slice(0, 600));
    await waitFor(() => pages.state.typed.at(-1) === COMPOSER_TEXT, 10_000, 100);
    const clicked = await run('browser_click', { ref: send.ref }, { approve: true });
    assert.equal(clicked.ok, true, JSON.stringify(clicked).slice(0, 600));
    await waitFor(() => pages.state.sent.includes(COMPOSER_TEXT), 10_000, 100);

    // The inline frame's button and the scripted frame's field work too.
    const inlineClick = await run('browser_click', { ref: inlineReply.ref });
    assert.equal(inlineClick.ok, true, JSON.stringify(inlineClick).slice(0, 600));
    const blankType = await run('browser_type', { ref: blankNote.ref, text: 'typed in a blank frame' });
    assert.equal(blankType.ok, true, JSON.stringify(blankType).slice(0, 600));
    const blankValue = await page.evaluate(`document.getElementById('blank').contentDocument.querySelector('input').value`);
    assert.equal(blankValue, 'typed in a blank frame');

    // ---- 3. refs survive another frame leaving the page ----------------------------------------------------------------
    const before = (await run('browser_snapshot')).result.refs;
    const composerBefore = refMatching(before, 'textbox', /^Chat$/);
    const sendBefore = refMatching(before, 'button', /^Send$/);
    await page.evaluate(`document.getElementById('ads').remove()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = (await run('browser_snapshot')).result.refs;
    assert.equal(refMatching(after, 'textbox', /^Chat$/)?.ref, composerBefore.ref, 'the chat composer kept its ref when an earlier frame was removed');
    assert.equal(refMatching(after, 'button', /^Send$/)?.ref, sendBefore.ref, 'the Send button kept its ref when an earlier frame was removed');
    const stillTyping = await run('browser_type', { ref: composerBefore.ref, text: 'second comment' });
    assert.equal(stillTyping.ok, true, 'a ref minted before the other frame left still works: ' + JSON.stringify(stillTyping).slice(0, 400));

    const shot = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(SCREENSHOT, Buffer.from(shot.data, 'base64'));

    // ---- 4. a frame with more controls than the view holds is reported as cut --------------------------------------------
    const bigUrl = `${pages.parentBase}/with-big-frame`;
    const big = await openAttachedTab(bigUrl);
    const runBig = command(big);
    await waitFor(() => pages.state.childHits.includes('/big'), 30_000, 100);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const bigSnapshot = await runBig('browser_snapshot', { full: true });
    assert.equal(bigSnapshot.ok, true, JSON.stringify(bigSnapshot).slice(0, 600));
    assert.equal(bigSnapshot.result.truncated, true, 'a frame cut by the per-frame cap must not look complete');
    assert.ok(bigSnapshot.result.element_count >= 461, `element_count must count the controls that were cut, got ${bigSnapshot.result.element_count}`);
    big.client.close();

    const verdict = {
      verdict: 'PASS',
      durationMs: Date.now() - startedAt,
      page: watchUrl,
      composerRef: composer.ref,
      sendRef: send.ref,
      framedRefs: refs.filter((item) => item.frameId).length,
      turnViewHasComposer: true,
      restrictedFrameRead: false,
      screenshot: SCREENSHOT,
    };
    await writeFile(VERDICT, `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(JSON.stringify(verdict, null, 2));
  } catch (error) {
    error.message = `${error.message}\nChrome stderr tail:\n${chromeStderr.slice(-2000)}`;
    throw error;
  } finally {
    page?.close();
    extension?.close();
    browser?.close();
    killChrome(chrome);
    await fixture.close();
    await pages.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await main();
process.exit(0);
