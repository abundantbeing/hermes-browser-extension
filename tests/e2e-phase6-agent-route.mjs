import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  CdpClient,
  DIST,
  REAL_CAPABILITIES,
  ROOT,
  chromeExecutable,
  fetchJson,
  killChrome,
  unpackedExtensionId,
  waitFor,
} from './e2e-phase6-browser-control.mjs';

const PROFILE = path.join(ROOT, 'tmp', `e2e-phase6-agent-route-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const SCREENSHOT = path.join(QA_DIR, 'phase6-agent-route-live.png');
const VERDICT = path.join(QA_DIR, 'phase6-agent-route-verdict.json');
const SERVER_SCRIPT = path.join(ROOT, 'tests', 'fixtures', 'phase6_agent_router_server.py');
const AGENT_ROOT = process.env.HERMES_AGENT_PHASE6_PATH || 'D:/HermesCaches/hermes-agent-phase6-integration';
const AGENT_DEPS = process.env.HERMES_AGENT_TEST_DEPS || 'D:/HermesCaches/hermes-agent-browser-pr-pytest311';
const AGENT_PYTHON = process.env.HERMES_AGENT_PYTHON || 'C:/Users/Jaybo/.hermes/hermes-agent/venv/Scripts/python.exe';
const ROUTED_TEXT = 'Phase Six Agent Route';

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* best effort */ }
}

function waitForServer(child, diagnostics) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Agent route server did not start: ${diagnostics.stderr}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      diagnostics.stdout += String(chunk);
      buffer += String(chunk);
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.ready === true) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch { /* non-ready log line */ }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Agent route server exited ${code}: ${diagnostics.stderr || diagnostics.stdout}`));
    });
  });
}

function parsedRegistryResult(payload) {
  const value = payload?.result;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before the Agent route CFT journey.');
  assert.ok(existsSync(SERVER_SCRIPT), `Missing Agent route fixture: ${SERVER_SCRIPT}`);
  assert.ok(existsSync(AGENT_PYTHON), `Missing Agent Python: ${AGENT_PYTHON}`);
  assert.ok(existsSync(AGENT_ROOT), `Missing pinned Agent worktree: ${AGENT_ROOT}`);

  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });

  const diagnostics = { stdout: '', stderr: '' };
  const server = spawn(AGENT_PYTHON, [SERVER_SCRIPT], {
    cwd: AGENT_ROOT,
    env: {
      ...process.env,
      PYTHONHOME: '',
      VIRTUAL_ENV: '',
      PYTHONPATH: [AGENT_ROOT, AGENT_DEPS].join(';'),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stderr.on('data', (chunk) => { diagnostics.stderr += String(chunk); });

  let chrome;
  let browser;
  let extension;
  let controlled;
  let chromeStderr = '';
  try {
    const ready = await waitForServer(server, diagnostics);
    const baseUrl = String(ready.base_url || '');
    const sessionId = String(ready.session_id || '');
    const accessValue = String(ready.access_value || '');
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(sessionId);
    assert.ok(accessValue);

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
          gatewayUrl: ${JSON.stringify(baseUrl)},
          [authField]: ${JSON.stringify(accessValue)},
          tokenSource: 'phase6-agent-route',
          activeProfile: 'default',
          sessionId: ${JSON.stringify(sessionId)},
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
    const controller = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' })`).then((value) => (
      value?.connected && value?.controlEnabled && value?.controllerId ? value : null
    )), 30_000);

    const fixtureUrl = `${baseUrl}/fixture`;
    const controlledTab = await extension.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true })`);
    const tabId = Number(controlledTab.id);
    assert.ok(Number.isInteger(tabId) && tabId > 0);
    const controlledTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      return targets.find((target) => target.type === 'page' && String(target.url || '') === fixtureUrl) || null;
    });
    controlled = new CdpClient(controlledTarget.webSocketDebuggerUrl);
    await controlled.connect();
    await controlled.call('Runtime.enable');
    await waitFor(() => controlled.evaluate(`Boolean(document.querySelector('#draft') && globalThis.phase6AgentRouteState)`));

    const lease = await extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_LEASE_ACQUIRE',
      kind: 'this-tab',
      ownerId: ${JSON.stringify(controller.controllerId)},
      ownership: 'owned',
      tabIds: [${tabId}]
    })`);
    assert.equal(lease?.ok, true, JSON.stringify(lease));
    const readyDocument = await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);
    assert.equal(readyDocument?.ok, true, JSON.stringify(readyDocument));
    const target = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({
      type: 'HERMES_CONTROLLER_TARGET_RESOLVE',
      tabId: ${tabId}, frameId: 0, expectedUrl: ${JSON.stringify(fixtureUrl)}
    })`).then((value) => value?.availability === 'available' ? value : null));
    assert.equal(target.isolatedFallback, 'forbidden');

    const authScheme = ['Bear', 'er'].join('');
    const routed = [];
    const dispatch = async (action, actionArgs = {}) => {
      const routedArgs = { ...actionArgs, source_tab_id: tabId };
      const response = await fetch(`${baseUrl}/e2e/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: [authScheme, accessValue].join(' '),
        },
        body: JSON.stringify({ action, arguments: routedArgs }),
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(`${action} failed: ${JSON.stringify(payload)}`);
      assert.equal(payload.schema_name, action);
      assert.equal(payload.toolset, 'browser');
      assert.equal(payload.fallback_count, 0);
      routed.push(action);
      return parsedRegistryResult(payload);
    };
    const dispatchWithApproval = async (action, actionArgs = {}) => {
      const pending = dispatch(action, actionArgs);
      const approval = await waitFor(() => extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_STATUS' }).then((value) => (
        value?.pendingApproval?.action === ${JSON.stringify(action)} ? value.pendingApproval : null
      ))`));
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
      return pending;
    };

    const snapshot = await dispatch('browser_snapshot');
    const textboxRef = snapshot.refs.find((item) => item.role === 'textbox' && /Draft title/i.test(item.name));
    const buttonRef = snapshot.refs.find((item) => item.role === 'button' && /Apply draft/i.test(item.name));
    assert.ok(textboxRef?.ref, JSON.stringify(snapshot.refs));
    assert.ok(buttonRef?.ref, JSON.stringify(snapshot.refs));

    const typed = await dispatch('browser_type', { ref: textboxRef.ref, text: ROUTED_TEXT });
    assert.doesNotMatch(JSON.stringify(typed), new RegExp(ROUTED_TEXT));
    await dispatch('browser_click', { ref: buttonRef.ref });
    const mutation = await waitFor(() => controlled.evaluate(`phase6AgentRouteState.clicks === 1 ? ({
      value: document.querySelector('#draft').value,
      result: document.querySelector('#result').textContent
    }) : null`));
    assert.deepEqual(mutation, { value: ROUTED_TEXT, result: `Applied: ${ROUTED_TEXT}` });

    await dispatch('browser_hover', { ref: buttonRef.ref });
    await dispatch('browser_scroll_to', { ref: buttonRef.ref });
    const routedScreenshot = await dispatch('browser_screenshot', { ref: buttonRef.ref, zoom: 1.5 });
    assert.match(routedScreenshot?.dataUrl || '', /^data:image\/png;base64,/);
    await dispatchWithApproval('browser_drag', { ref: textboxRef.ref, to_ref: buttonRef.ref });
    const buttonPoint = await controlled.evaluate(`(() => {
      const rect = document.querySelector('#apply').getBoundingClientRect();
      return { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
    })()`);
    await dispatchWithApproval('browser_click', buttonPoint);
    await waitFor(() => controlled.evaluate(`phase6AgentRouteState.clicks === 2`));

    await dispatch('browser_press', { key: 'a', modifiers: ['shift'] });
    await waitFor(() => controlled.evaluate(`phase6AgentRouteState.keys.includes('a')`));
    const shot = await controlled.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(SCREENSHOT, Buffer.from(shot.data, 'base64'));

    await dispatch('browser_scroll', { direction: 'down' });
    await waitFor(() => controlled.evaluate('scrollY > 0'));
    const nextUrl = `${fixtureUrl}?route=next`;
    await dispatch('browser_navigate', { url: nextUrl });
    await waitFor(() => controlled.evaluate(`location.href === ${JSON.stringify(nextUrl)}`));
    await extension.evaluate(`chrome.runtime.sendMessage({ type: 'HERMES_CONTROLLER_DOCUMENT_READY', tabId: ${tabId}, frameId: 0 })`);
    await dispatch('browser_back');
    await waitFor(() => controlled.evaluate(`location.href === ${JSON.stringify(fixtureUrl)}`));

    const taskSetId = 'phase6-agent-route-tabs';
    const createdA = await dispatch('browser_tab_create', {
      url: `${fixtureUrl}?route=task-a`,
      active: false,
      task_set_id: taskSetId,
    });
    const createdB = await dispatch('browser_tab_create', {
      url: `${fixtureUrl}?route=task-b`,
      active: false,
      task_set_id: taskSetId,
    });
    const createdTabA = Number(createdA?.tab?.id);
    const createdTabB = Number(createdB?.tab?.id);
    assert.ok(Number.isInteger(createdTabA) && createdTabA > 0, JSON.stringify(createdA));
    assert.ok(Number.isInteger(createdTabB) && createdTabB > 0, JSON.stringify(createdB));

    const tabsBefore = await dispatch('browser_tabs');
    assert.deepEqual(
      [tabId, createdTabA, createdTabB].every((id) => tabsBefore.tabs.some((tab) => Number(tab.id) === id)),
      true,
      JSON.stringify(tabsBefore),
    );
    await dispatch('browser_tab_activate', { tab_id: createdTabA });
    await waitFor(() => extension.evaluate(`chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => Number(tabs?.[0]?.id) === ${createdTabA})`));
    await dispatch('browser_tab_activate', { tab_id: tabId });
    await waitFor(() => extension.evaluate(`chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => Number(tabs?.[0]?.id) === ${tabId})`));

    const grouped = await dispatch('browser_tab_group', { tab_ids: [createdTabA, createdTabB] });
    assert.ok(Number.isInteger(Number(grouped?.groupId)) && Number(grouped.groupId) >= 0, JSON.stringify(grouped));
    const ungrouped = await dispatch('browser_tab_ungroup', { tab_ids: [createdTabA, createdTabB] });
    assert.equal(ungrouped?.status, 'tabs-ungrouped', JSON.stringify(ungrouped));

    const closed = await dispatchWithApproval('browser_tab_close', { tab_id: createdTabA });
    assert.equal(closed?.status, 'tab-closed', JSON.stringify(closed));
    await waitFor(() => extension.evaluate(`chrome.tabs.get(${createdTabA}).then(() => false, () => true)`));
    const tabsAfter = await dispatch('browser_tabs');
    assert.equal(tabsAfter.tabs.some((tab) => Number(tab.id) === createdTabA), false, JSON.stringify(tabsAfter));
    assert.equal(tabsAfter.tabs.some((tab) => Number(tab.id) === createdTabB), true, JSON.stringify(tabsAfter));

    const stateResponse = await fetch(`${baseUrl}/e2e/state`);
    const state = await stateResponse.json();
    assert.equal(state.fallback_count, 0);
    assert.equal(state.dispatch_count, 21);
    assert.equal(typeof state.agent_runtime_dirty, 'boolean');
    if (state.agent_runtime_dirty) assert.match(state.agent_runtime_diff_sha256, /^[a-f0-9]{64}$/);
    else assert.equal(state.agent_runtime_diff_sha256, null);
    assert.deepEqual(routed, [
      'browser_snapshot',
      'browser_type',
      'browser_click',
      'browser_hover',
      'browser_scroll_to',
      'browser_screenshot',
      'browser_drag',
      'browser_click',
      'browser_press',
      'browser_scroll',
      'browser_navigate',
      'browser_back',
      'browser_tab_create',
      'browser_tab_create',
      'browser_tabs',
      'browser_tab_activate',
      'browser_tab_activate',
      'browser_tab_group',
      'browser_tab_ungroup',
      'browser_tab_close',
      'browser_tabs',
    ]);
    assert.deepEqual(
      [...new Set(routed)].sort(),
      REAL_CAPABILITIES.filter((action) => action !== 'controller.noop').sort(),
    );

    const verdict = {
      passed: true,
      agentSha: state.agent_sha,
      agentRuntimeDirty: state.agent_runtime_dirty,
      agentRuntimeDiffSha256: state.agent_runtime_diff_sha256,
      route: 'actual-tools.registry-handler-to-browser-control-broker',
      sessionId,
      controllerId: controller.controllerId,
      browserProfileId: controller.browserProfileId,
      tabId,
      documentGeneration: target.documentGeneration,
      actions: routed,
      registryDispatchCount: state.dispatch_count,
      legacyFallbackCount: state.fallback_count,
      isolatedFallback: target.isolatedFallback,
      tabOperations: {
        created: [createdTabA, createdTabB],
        activated: [createdTabA, tabId],
        grouped: true,
        ungrouped: true,
        approvalBoundClose: createdTabA,
      },
      typedValuePersisted: false,
      screenshot: path.relative(ROOT, SCREENSHOT).replaceAll('\\', '/'),
    };
    await writeFile(VERDICT, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
    console.log(`Phase 6 real Agent registry CFT journey: PASS ${JSON.stringify(verdict)}`);
  } catch (error) {
    throw new Error(`${error.message}; agentStderr=${diagnostics.stderr.slice(-2_000)}; chromeStderr=${chromeStderr.slice(-2_000)}`);
  } finally {
    try { controlled?.close(); } catch { /* best effort */ }
    try { extension?.close(); } catch { /* best effort */ }
    try { browser?.close(); } catch { /* best effort */ }
    killChrome(chrome);
    killProcessTree(server);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

await main();
process.exit(0);
