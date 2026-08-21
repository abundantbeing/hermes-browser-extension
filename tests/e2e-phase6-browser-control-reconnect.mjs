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

const PROFILE = path.join(ROOT, 'tmp', `e2e-phase6-browser-control-reconnect-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const SCREENSHOT = path.join(QA_DIR, 'phase6-reconnect-controlled-tab.png');
const VERDICT = path.join(QA_DIR, 'phase6-reconnect-verdict.json');
const HEARTBEAT_PERIOD_MS = 60_000;
const TEST_TEXT = ['phase', 'six', 'reconnect', 'value'].join('-');

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before the reconnect CFT journey.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const fixture = await startControllerFixture();
  const startedAt = Date.now();
  let chrome;
  let browser;
  let extension;
  let controlled;
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
          tokenSource: 'e2e-controller-reconnect',
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

    const statusBefore = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected && value?.controllerId ? value : null
    )));
    const fixtureUrl = `${fixture.baseUrl}/fixture`;
    const tab = await extension.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true })`);
    const tabId = Number(tab.id);
    assert.ok(Number.isInteger(tabId) && tabId > 0);

    const controlledTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '').startsWith(fixtureUrl)) || null;
    });
    controlled = new CdpClient(controlledTarget.webSocketDebuggerUrl);
    await controlled.connect();
    await controlled.call('Runtime.enable');
    await waitFor(() => controlled.evaluate(`Boolean(document.querySelector('#draft') && globalThis.phase6State)`));

    const lease = await extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
      kind: 'this-tab',
      ownerId: ${JSON.stringify(statusBefore.controllerId)},
      ownership: 'owned',
      tabIds: [${tabId}]
    })`);
    assert.equal(lease?.ok, true, JSON.stringify(lease));
    await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);

    const resolveTarget = () => extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_TARGET_RESOLVE',
      tabId: ${tabId},
      frameId: 0,
      expectedUrl: ${JSON.stringify(fixtureUrl)}
    })`);
    const target = await waitFor(() => resolveTarget().then((value) => value?.availability === 'available' ? value : null));
    assert.equal(target.isolatedFallback, 'forbidden');

    const durableBefore = await extension.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    const ownedLeaseBefore = durableBefore.hermesBrowserTabLeases.entries.find((item) => item.tabId === tabId);
    assert.ok(ownedLeaseBefore?.leaseId, JSON.stringify(durableBefore.hermesBrowserTabLeases));

    // Prove the real worker-owned socket survives two complete heartbeat periods
    // before any forced recovery action.
    await waitFor(
      () => fixture.heartbeats.length >= 2 && Date.now() - startedAt >= HEARTBEAT_PERIOD_MS * 2,
      HEARTBEAT_PERIOD_MS * 2 + 25_000,
      250,
    );
    assert.ok(Date.now() - startedAt >= HEARTBEAT_PERIOD_MS * 2);

    const postIdleStatus = await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`);
    const postIdleDurable = await extension.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    const snapshotConnection = fixture.connections.at(-1);
    snapshotConnection.send({
      method: 'browser.controller.command',
      params: {
        command_id: 'reconnect-snapshot',
        action: 'browser_snapshot',
        arguments: {},
        tab_id: target.tabId,
        frame_id: target.frameId,
        document_generation: target.documentGeneration,
      },
    });
    let snapshot;
    try {
      snapshot = await waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === 'reconnect-snapshot'));
    } catch (error) {
      const socketDiagnostics = fixture.connections.map((connection, index) => ({
        index,
        openedAt: connection.openedAt,
        closedAt: connection.closedAt,
        destroyed: connection.socket.destroyed,
        writable: connection.socket.writable,
        writableEnded: connection.socket.writableEnded,
        frames: connection.frames,
      }));
      throw new Error(`Post-idle snapshot stalled: ${JSON.stringify({
        durationMs: Date.now() - startedAt,
        postIdleStatus,
        postIdleDurable,
        heartbeats: fixture.heartbeats,
        registrations: fixture.registrations.map((item) => ({
          controller_id: item.controller_id,
          generation: item.generation,
          session_id: item.session_id,
        })),
        sockets: socketDiagnostics,
        results: fixture.results.map((frame) => ({
          command_id: frame?.params?.command_id,
          ok: frame?.params?.ok,
          error: frame?.params?.error,
        })),
      })}`, { cause: error });
    }
    assert.equal(snapshot.params.ok, true, JSON.stringify(snapshot.params));
    const buttonRef = snapshot.params.result.refs.find((item) => item.role === 'button' && /Apply draft/i.test(item.name));
    const textboxRef = snapshot.params.result.refs.find((item) => item.role === 'textbox' && /Draft title/i.test(item.name));
    assert.ok(buttonRef?.ref && textboxRef?.ref, JSON.stringify(snapshot.params.result.refs));

    // Pause a real consequential command for approval, then drop the exact
    // controller transport. This makes the pending state deterministic instead
    // of relying on a click being slow enough to overlap the disconnect.
    const originConnectionIndex = fixture.connections.length - 1;
    const originConnection = fixture.connections[originConnectionIndex];
    originConnection.send({
      method: 'browser.controller.command',
      params: {
        command_id: 'reconnect-approval',
        action: 'browser_press',
        arguments: { key: 'Enter' },
        tab_id: target.tabId,
        frame_id: target.frameId,
        document_generation: target.documentGeneration,
      },
    });
    const pendingBefore = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.pendingApproval?.commandId === 'reconnect-approval' ? value.pendingApproval : null
    )));
    fixture.forceDisconnect(originConnectionIndex);

    await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_WAKE' })`);
    await waitFor(() => fixture.connections.length >= originConnectionIndex + 2);
    const statusAfter = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected ? value : null
    )));
    assert.equal(statusAfter.controllerId, statusBefore.controllerId);
    assert.equal(statusAfter.generation, statusBefore.generation);

    const pendingAfter = statusAfter.pendingApproval;
    assert.equal(pendingAfter.commandId, pendingBefore.commandId);
    assert.equal(pendingAfter.approvalNonce, pendingBefore.approvalNonce);
    const granted = await extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_APPROVAL_GRANT',
      approvalId: ${JSON.stringify(pendingAfter.approvalId)},
      approvalNonce: ${JSON.stringify(pendingAfter.approvalNonce)},
      commandId: ${JSON.stringify(pendingAfter.commandId)},
      controllerId: ${JSON.stringify(pendingAfter.controllerId)},
      leaseId: ${JSON.stringify(pendingAfter.leaseId)},
      leaseGeneration: ${Number(pendingAfter.leaseGeneration)},
      action: ${JSON.stringify(pendingAfter.action)},
      tabId: ${Number(pendingAfter.tabId)},
      documentGeneration: ${Number(pendingAfter.documentGeneration)},
      paused: true
    })`);
    assert.equal(granted?.ok, true, JSON.stringify(granted));
    const approvalResult = await waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === 'reconnect-approval'));
    assert.equal(approvalResult.params.ok, true, JSON.stringify(approvalResult.params));
    assert.equal(fixture.results.filter((frame) => frame?.params?.command_id === 'reconnect-approval').length, 1);

    const durableAfter = await extension.evaluate(`chrome.storage.local.get([
      'hermesBrowserControllerWorker',
      'hermesBrowserTabLeases',
      'hermesBrowserControllerLifecycle'
    ])`);
    const ownedLeaseAfter = durableAfter.hermesBrowserTabLeases.entries.find((item) => item.tabId === tabId);
    assert.equal(ownedLeaseAfter.leaseId, ownedLeaseBefore.leaseId);
    assert.equal(ownedLeaseAfter.generation, ownedLeaseBefore.generation);
    assert.equal(durableAfter.hermesBrowserControllerWorker.terminalOutbox.length, 0);

    const reboundConnection = fixture.connections.at(-1);
    const sendCommand = async (commandId, action, args = {}) => {
      reboundConnection.send({
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
      return waitFor(() => fixture.results.find((frame) => frame?.params?.command_id === commandId));
    };

    const clicked = await sendCommand('reconnect-click', 'browser_click', { ref: buttonRef.ref });
    assert.equal(clicked.params.ok, true, JSON.stringify(clicked.params));
    assert.equal(await controlled.evaluate('phase6State.clicks'), 1);
    const typed = await sendCommand('reconnect-type', 'browser_type', { ref: textboxRef.ref, text: TEST_TEXT });
    assert.equal(typed.params.ok, true, JSON.stringify(typed.params));
    assert.doesNotMatch(JSON.stringify(typed.params), new RegExp(TEST_TEXT));
    assert.equal((await sendCommand('reconnect-press', 'browser_press', { key: 'a', modifiers: ['shift'] })).params.ok, true);
    assert.equal((await sendCommand('reconnect-scroll', 'browser_scroll', { direction: 'down' })).params.ok, true);
    const screenshot = await sendCommand('reconnect-screenshot', 'browser_screenshot');
    assert.equal(screenshot.params.ok, true, JSON.stringify(screenshot.params));
    assert.match(screenshot.params.result.dataUrl, /^data:image\/png;base64,/);

    const secondTab = await sendCommand('reconnect-create-tab', 'browser_tab_create', {
      url: `${fixture.baseUrl}/second`,
      active: false,
      task_set_id: 'reconnect-task-set',
    });
    assert.equal(secondTab.params.ok, true, JSON.stringify(secondTab.params));
    const secondTabId = Number(secondTab.params.result?.tab?.id);
    assert.ok(Number.isInteger(secondTabId) && secondTabId > 0, JSON.stringify(secondTab.params));
    const createdLease = await waitFor(() => extension.evaluate(`chrome.storage.local.get('hermesBrowserTabLeases')`).then((value) => (
      value.hermesBrowserTabLeases?.entries?.find((item) => item.tabId === secondTabId) || null
    )));
    assert.equal(createdLease.ownerId, statusBefore.controllerId);
    assert.equal(createdLease.generation, statusAfter.generation);
    assert.equal(createdLease.taskSetId, 'reconnect-task-set');
    const listed = await sendCommand('reconnect-tabs', 'browser_tabs');
    assert.equal(listed.params.ok, true, JSON.stringify(listed.params));
    assert.ok(listed.params.result.tabs.some((item) => item.id === secondTabId));
    assert.equal((await sendCommand('reconnect-activate', 'browser_tab_activate', { tab_id: secondTabId })).params.ok, true);
    assert.equal((await sendCommand('reconnect-scroll-to-result', 'browser_scroll_to', { ref: buttonRef.ref })).params.ok, true);

    const screenshotPage = await controlled.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(SCREENSHOT, Buffer.from(screenshotPage.data, 'base64'));

    const persistedJson = JSON.stringify(durableAfter);
    assert.equal(persistedJson.includes(TEST_ACCESS_VALUE), false);
    assert.equal(persistedJson.includes(TEST_TEXT), false);
    assert.equal(persistedJson.includes(fixtureUrl), false);
    assert.equal(fixture.results.some((frame) => frame?.params?.error?.code === 'ControllerCancelled'), false);
    assert.equal(fixture.results.some((frame) => /fallback/i.test(JSON.stringify(frame))), false);

    const released = await extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_RELEASE',
      ownerId: ${JSON.stringify(statusBefore.controllerId)},
      generation: ${statusAfter.generation},
      tabIds: [${tabId}]
    })`);
    assert.equal(released?.ok, true, JSON.stringify(released));

    const verdict = {
      verdict: 'PASS',
      browser: 'Hermes Chrome for Testing',
      extensionId,
      durationMs: Date.now() - startedAt,
      heartbeatPeriodMs: HEARTBEAT_PERIOD_MS,
      heartbeatCount: fixture.heartbeats.length,
      reconnectCount: fixture.connections.length - 1,
      controllerIdStable: statusAfter.controllerId === statusBefore.controllerId,
      generationBefore: statusBefore.generation,
      generationAfter: statusAfter.generation,
      leaseIdStable: ownedLeaseAfter.leaseId === ownedLeaseBefore.leaseId,
      leaseGenerationBefore: ownedLeaseBefore.generation,
      leaseGenerationAfter: ownedLeaseAfter.generation,
      reconnectTerminalCount: fixture.results.filter((frame) => frame?.params?.command_id === 'reconnect-approval').length,
      terminalOutboxAfterReconnect: durableAfter.hermesBrowserControllerWorker.terminalOutbox.length,
      exactTarget: { tabId, documentGeneration: target.documentGeneration, isolatedFallback: target.isolatedFallback },
      realActions: ['snapshot', 'click', 'type', 'press-with-modifier', 'scroll', 'screenshot', 'tab-create', 'tabs', 'tab-activate', 'scroll-to'],
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
    controlled?.close();
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
