import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CdpClient,
  DIST,
  REAL_CAPABILITIES,
  ROOT,
  TEST_ACCESS_VALUE,
  TEST_SESSION_ID,
  chromeExecutable,
  fetchJson,
  killChrome,
  startControllerFixture,
  unpackedExtensionId,
  waitFor,
} from './e2e-phase6-browser-control.mjs';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=874kn8I_JTs';
const PROFILE = path.join(ROOT, 'tmp', `e2e-phase6-youtube-like-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const SCREENSHOT = path.join(QA_DIR, 'phase6-youtube-like.png');
const VERDICT = path.join(QA_DIR, 'phase6-youtube-like-verdict.json');

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before the YouTube CFT journey.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const fixture = await startControllerFixture();
  const startedAt = Date.now();
  let chrome;
  let browser;
  let extension;
  let youtube;
  let chromeStderr = '';

  try {
    const extensionId = unpackedExtensionId(DIST);
    chrome = spawn(chromeExecutable(), [
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
          tokenSource: 'e2e-youtube-like',
          sessionId: ${JSON.stringify(TEST_SESSION_ID)},
          sessionStartMode: 'resume',
          browserControlEnabled: true,
          browserControlPaused: false,
          browserControlScope: 'this-tab',
          browserControlViewBehavior: 'stay'
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

    const tab = await extension.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(YOUTUBE_URL)}, active: true })`);
    const tabId = Number(tab.id);
    assert.ok(Number.isInteger(tabId) && tabId > 0);
    await waitFor(() => extension.evaluate(`chrome.tabs.get(${tabId})`).then((value) => (
      value?.status === 'complete' && String(value?.url || '').startsWith('https://www.youtube.com/watch') ? value : null
    )), 90_000, 250);

    const targetPage = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').startsWith('https://www.youtube.com/watch')) || null;
    }, 30_000, 250);
    youtube = new CdpClient(targetPage.webSocketDebuggerUrl);
    await youtube.connect();
    await youtube.call('Runtime.enable');
    await waitFor(() => youtube.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('ytd-app'))`), 60_000, 250);

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
      type: 'HERMES_CONTROLLER_TARGET_RESOLVE',
      tabId: ${tabId},
      frameId: 0,
      expectedUrl: ${JSON.stringify(YOUTUBE_URL)}
    })`).then((value) => value?.availability === 'available' ? value : null), 30_000, 250);
    assert.equal(target.isolatedFallback, 'forbidden');
    assert.equal(target.tabId, tabId);

    const controllerConnectionFor = (action) => {
      const match = [...fixture.registrations]
        .map((registration, index) => ({ registration, index }))
        .reverse()
        .find(({ registration }) => Array.isArray(registration.capabilities) && registration.capabilities.includes(action));
      const connection = match ? fixture.connections[match.index] : null;
      assert.ok(connection && !connection.socket.destroyed && connection.socket.writable, `No live controller connection for ${action}.`);
      return connection;
    };
    const sendCommand = async (commandId, action, args = {}) => {
      controllerConnectionFor(action).send({
        method: 'browser.controller.command',
        params: {
          command_id: commandId,
          action,
          arguments: args,
          tab_id: target.tabId,
          frame_id: target.frameId,
          document_generation: target.documentGeneration,
        },
      });
      return waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === commandId), 45_000, 200);
    };

    const revealed = await sendCommand('youtube-like-reveal-controls', 'browser_scroll', { direction: 'down', amount: 720 });
    assert.equal(revealed.params.ok, true, JSON.stringify(revealed.params));
    await waitFor(() => youtube.evaluate(`(() => [...document.querySelectorAll('button, [role="button"]')]
      .some((node) => {
        const label = String(node.getAttribute?.('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim();
        return /\\blike\\b/i.test(label) && !/dislike/i.test(label);
      }))()`), 60_000, 250);

    const snapshot = await sendCommand('youtube-like-snapshot', 'browser_snapshot');
    assert.equal(snapshot.params.ok, true, JSON.stringify(snapshot.params));
    const buttons = snapshot.params.result.refs.filter((item) => item.role === 'button');
    const likeRef = buttons.find((item) => /\blike this video\b/i.test(item.name) && !/dislike/i.test(item.name))
      || buttons.find((item) => /^like(?:\s|$)/i.test(item.name) && !/dislike/i.test(item.name));
    assert.ok(likeRef?.ref, `YouTube Like button was not found. Button candidates: ${JSON.stringify(buttons.map((item) => item.name).filter(Boolean).slice(0, 80))}`);

    const clicked = await sendCommand('youtube-like-click', 'browser_click', { ref: likeRef.ref });
    assert.equal(clicked.params.ok, true, JSON.stringify(clicked.params));
    let observedEffect;
    try {
      observedEffect = await waitFor(() => youtube.evaluate(`(() => {
        const controls = [...document.querySelectorAll('button, [role="button"]')];
        const pressed = controls.some((node) => node.getAttribute?.('aria-pressed') === 'true'
          && /\\blike\\b/i.test(node.getAttribute?.('aria-label') || node.textContent || '')
          && !/dislike/i.test(node.getAttribute?.('aria-label') || node.textContent || ''));
        if (pressed) return 'liked';
        const popupText = [...document.querySelectorAll('ytd-popup-container, ytd-modal-with-title-and-button-renderer, tp-yt-paper-dialog, [role="dialog"]')]
          .map((node) => String(node.textContent || ''))
          .join(' ');
        if (/sign in/i.test(popupText) && /(like|opinion)/i.test(popupText)) return 'sign-in-prompt';
        return null;
      })()`), 15_000, 200);
    } catch (error) {
      const diagnostics = await youtube.evaluate(`(() => ({
        popupText: [...document.querySelectorAll('ytd-popup-container, ytd-modal-with-title-and-button-renderer, tp-yt-paper-dialog, [role="dialog"]')]
          .map((node) => String(node.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .slice(0, 1200),
        likeControls: [...document.querySelectorAll('button, [role="button"]')]
          .map((node) => ({
            label: String(node.getAttribute?.('aria-label') || node.textContent || '').replace(/\\s+/g, ' ').trim(),
            pressed: node.getAttribute?.('aria-pressed') || ''
          }))
          .filter((item) => /like/i.test(item.label) && !/dislike/i.test(item.label))
          .slice(0, 20)
      }))()`);
      const failureShot = await youtube.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(SCREENSHOT, Buffer.from(failureShot.data, 'base64'));
      throw new Error(`YouTube click effect was not observed: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    assert.ok(['liked', 'sign-in-prompt'].includes(observedEffect));

    const screenshot = await youtube.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    const durable = await extension.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    const persisted = JSON.stringify(durable);
    assert.equal(persisted.includes(TEST_ACCESS_VALUE), false);
    assert.equal(persisted.includes(YOUTUBE_URL), false);
    assert.equal(fixture.results.some((frame) => /fallback/i.test(JSON.stringify(frame))), false);

    const released = await extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_RELEASE',
      ownerId: ${JSON.stringify(status.controllerId)},
      tabIds: [${tabId}]
    })`);
    assert.equal(released?.ok, true, JSON.stringify(released));

    const verdict = {
      verdict: 'PASS',
      browser: 'Hermes Chrome for Testing',
      target: YOUTUBE_URL,
      durationMs: Date.now() - startedAt,
      controllerIdStable: status.controllerId === (await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`)).controllerId,
      exactTarget: { tabId, documentGeneration: target.documentGeneration, isolatedFallback: target.isolatedFallback },
      action: 'browser_click',
      targetRole: likeRef.role,
      targetName: likeRef.name,
      observedEffect,
      fallbackCount: 0,
      restrictedPersistence: false,
      screenshot: SCREENSHOT,
    };
    await writeFile(VERDICT, `${JSON.stringify(verdict, null, 2)}\n`);
    console.log(JSON.stringify(verdict, null, 2));
  } catch (error) {
    error.message = `${error.message}\nChrome stderr tail:\n${chromeStderr.slice(-3000)}`;
    throw error;
  } finally {
    youtube?.close();
    extension?.close();
    browser?.close();
    killChrome(chrome);
    await fixture.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

await main();
process.exit(0);
