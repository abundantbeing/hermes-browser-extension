import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_BROWSER_CONSENT, backgroundBrowserConsentIdentity } from '../extension/lib/background-task-browser.mjs';
import { launchChrome } from './e2e-chrome-env.mjs';
import {
  CdpClient, DIST, TEST_ACCESS_VALUE, chromeExecutable, ensureExtensionStartupPage,
  fetchJson, killChrome, startControllerFixture, unpackedExtensionId, waitFor,
} from './e2e-phase6-browser-control.mjs';

const profile = await mkdtemp(path.join(os.tmpdir(), 'hermes-background-e2e-'));
let held = false;
let releasePage;
const pageGate = new Promise((resolve) => { releasePage = resolve; });
const fixture = await startControllerFixture({
  controlPath: '/api/plugins/hermes-browser-extension/control',
  holdPage() { held = true; return pageGate; },
});
const extensionId = unpackedExtensionId(DIST);
const chrome = launchChrome(chromeExecutable(), [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
  `chrome-extension://${extensionId}/request-permissions.html`,
], { stdio: 'ignore' });
let page;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile));
  const [port] = (await readFile(portFile, 'utf8')).split('\n');
  const devtoolsBase = `http://127.0.0.1:${port}`;
  await ensureExtensionStartupPage(devtoolsBase, extensionId);
  const targets = await fetchJson(`${devtoolsBase}/json/list`);
  page = new CdpClient(targets.find((t) => t.url.startsWith(`chrome-extension://${extensionId}/`) && t.type === 'page').webSocketDebuggerUrl);
  await page.connect();
  const foreground = await page.evaluate('(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id)()');
  const gatewayUrl = fixture.baseUrl;
  const settings = {
    gatewayUrl, connectionTransport: 'local-api', apiKey: TEST_ACCESS_VALUE, browserControlEnabled: false,
  };
  const consent = await backgroundBrowserConsentIdentity(settings);
  const storedApiKey = await page.evaluate(`(async () => {
    const { packSavedConnectionStorage } = await import(chrome.runtime.getURL('lib/saved-connections.mjs'));
    const packed = await packSavedConnectionStorage(${JSON.stringify(settings)});
    await chrome.storage.local.set({ ...packed, [${JSON.stringify(BACKGROUND_BROWSER_CONSENT)}]: ${JSON.stringify(consent)} });
    return packed.hermesBrowserSettings.apiKey;
  })()`);
  assert.equal(storedApiKey, '', 'background control must load the key from encrypted storage');
  let controller = await waitFor(() => fixture.connections[0]);
  assert.equal(fixture.registrations[0].session_id, 'hermes:background-browser:v1');
  assert.equal(fixture.registrations[0].capabilities.includes('browser_batch'), false);
  assert.equal(await page.evaluate('chrome.tabs.query({}).then(tabs => tabs.length)'), 1);

  let sequence = 0;
  async function command(action, args = {}, session = 'feishu-session-A') {
    const id = `test-${++sequence}`;
    controller.send({
      method: 'browser.controller.command',
      params: { command_id: id, action, arguments: args, background_session: session },
    });
    return (await waitFor(() => fixture.results.find((frame) => frame.params.command_id === id))).params;
  }

  const first = await command('browser_tab_create', { url: `${gatewayUrl}/second` });
  assert.equal(first.ok, true, JSON.stringify(first));
  const { tab, groupId } = first.result;
  assert.equal(tab.active, false);
  const snapshot = await command('browser_snapshot', { tab_id: tab.id });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.match(JSON.stringify(snapshot.result), /Second Page|Second page reached/);
  const second = await command('browser_tab_create', { url: `${gatewayUrl}/fixture` });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.result.groupId, groupId);
  const fixtureId = second.result.tab.id;
  const fixtureView = await command('browser_snapshot', { tab_id: fixtureId });
  const button = fixtureView.result?.refs?.find?.((ref) => ref.name === 'Apply draft');
  assert.ok(button, JSON.stringify(fixtureView));
  const clicked = await command('browser_click', { tab_id: fixtureId, ref: button.ref });
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.match(JSON.stringify(clicked.result), /Applied/);

  const slow = command('browser_tab_create', { url: `${gatewayUrl}/held` });
  await waitFor(() => held);
  let other;
  try {
    other = await command('browser_navigate', { url: `${gatewayUrl}/second` }, 'feishu-session-B');
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.equal(fixture.results.length < sequence, true, 'the other session finished while the first page was held');
  } finally {
    releasePage();
    await slow;
  }
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.notEqual(other.result.groupId, groupId);
  assert.equal((await command('browser_snapshot', { tab_id: tab.id }, 'feishu-session-B')).error.code, 'lease_not_owned');
  assert.equal((await command('browser_snapshot', { tab_id: foreground })).error.code, 'lease_not_owned');
  assert.equal((await command('browser_tab_activate', { tab_id: tab.id })).error.code, 'background_action_unavailable');
  assert.equal(await page.evaluate('(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id)()'), foreground);
  const reencrypted = await page.evaluate(`(async () => {
    const {
      packedHermesBrowserSettingsWrite, SAVED_CONNECTION_SECRETS_STORAGE_KEY,
    } = await import(chrome.runtime.getURL('lib/saved-connections.mjs'));
    const storage = chrome.storage.local;
    const before = await storage.get(SAVED_CONNECTION_SECRETS_STORAGE_KEY);
    const packed = await packedHermesBrowserSettingsWrite(${JSON.stringify({
      ...settings, botModeDisplayDensity: 'compact',
    })}, storage);
    await storage.set(packed);
    return JSON.stringify(before[SAVED_CONNECTION_SECRETS_STORAGE_KEY])
      !== JSON.stringify(packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY]);
  })()`);
  assert.equal(reencrypted, true, 'saving an unrelated setting should exercise the encrypted key rewrite');
  controller = await waitFor(() => fixture.connections[1]);
  const afterSave = await command('browser_snapshot', { tab_id: fixtureId });
  assert.equal(afterSave.ok, true, JSON.stringify(afterSave));
  assert.match(JSON.stringify(afterSave.result), /Applied/);

  await page.evaluate("chrome.storage.local.remove('hermesBackgroundBrowserConsent')");
  await waitFor(() => controller.closedAt);
  console.log('Background browser passed: real Chrome grouped and clicked in the background, isolated sessions, and revoked consent.');
} finally {
  releasePage();
  page?.close();
  killChrome(chrome);
  await fixture.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
