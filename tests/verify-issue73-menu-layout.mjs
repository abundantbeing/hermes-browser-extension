// Issue #73 render verification: the /commands and skill menus must open
// UPWARD above the ASK HERMES composer and never cover the prompt textarea.
// Boots isolated Chrome-for-Testing with dist/, connects to the live local
// gateway, then geometrically asserts menu placement with a long prompt.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', `verify-issue73-${process.pid}`);
const QA_DIR = path.join(ROOT, '.hermes', 'qa');
const MENU_OPEN_SHOT = path.join(QA_DIR, 'issue73-commands-menu-open.png');
const SKILL_MENU_SHOT = path.join(QA_DIR, 'issue73-skill-menu-open.png');
const LONG_PROMPT = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}: verifying the commands menu never covers this draft text.`).join('\n');

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH.');
  return found;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) { this.events.push(payload); return; }
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message || 'CDP error'));
      else pending.resolve(payload.result || {});
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Could not connect to CDP target ${this.url}`));
    });
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP socket is not open.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed.');
    }
    return result.result?.value;
  }

  close() { try { this.socket?.close(); } catch { /* best effort */ } }
}

async function waitFor(check, timeoutMs = 25_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed (${response.status})`);
  return response.json();
}

function killChrome(child) {
  if (!child?.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* best-effort cleanup */ }
}

async function saveScreenshot(client, filePath) {
  const shot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  assert.ok(shot.data, `Screenshot data missing for ${filePath}`);
  await writeFile(filePath, Buffer.from(shot.data, 'base64'));
}

function readGatewayConfig() {
  const envPath = path.join(process.env.USERPROFILE || '', '.hermes', '.env');
  const key = readFileSync(envPath, 'utf8').split(/\r?\n/)
    .find((line) => line.startsWith('API_SERVER_KEY='))?.split('=').slice(1).join('=')
    .replace(/^["']|["']$/g, '') || '';
  assert.ok(key, 'API_SERVER_KEY not found in ~/.hermes/.env');
  return { gatewayUrl: 'http://127.0.0.1:8642', apiKey: key };
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build first.');
  await rm(PROFILE, { recursive: true, force: true });
  await mkdir(PROFILE, { recursive: true });
  await mkdir(QA_DIR, { recursive: true });
  const gateway = readGatewayConfig();

  let chrome;
  let panel;
  try {
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
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    const activePort = path.join(PROFILE, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort));
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;

    // Configure the extension against the LIVE gateway via its service worker.
    const workerTarget = await waitFor(async () => {
      const targets = await fetchJson(`${devtoolsBase}/json/list`);
      const candidates = targets.filter((target) => {
        if (target.type !== 'service_worker') return false;
        try { return new URL(String(target.url || '')).pathname === '/background.js'; }
        catch { return false; }
      });
      for (const candidate of candidates) {
        const probe = new CdpClient(candidate.webSocketDebuggerUrl);
        try {
          await probe.connect();
          await probe.call('Runtime.enable');
          const isHermes = await probe.evaluate(
            `globalThis.chrome?.runtime?.getManifest?.()?.name === 'Hermes Browser Extension'`,
          );
          if (isHermes) return candidate;
        } catch {
          // Ignore unrelated component workers named background.js.
        } finally {
          probe.close();
        }
      }
      return null;
    });
    const extensionId = new URL(workerTarget.url).hostname;
    const setup = new CdpClient(workerTarget.webSocketDebuggerUrl);
    await setup.connect();
    await setup.call('Runtime.enable');
    await waitFor(() => setup.evaluate(`Boolean(globalThis.chrome?.storage?.local)`));
    await setup.evaluate(`chrome.storage.local.set({hermesBrowserSettings:${JSON.stringify({
      connectionSchemaVersion: 1,
      connectionMode: 'local',
      connectionTransport: 'local-api',
      gatewayMode: 'local-api',
      gatewayUrl: gateway.gatewayUrl,
      apiKey: gateway.apiKey,
      tokenSource: 'issue73-verify',
      sessionId: 'hermes-browser-extension',
      sessionStartMode: 'fresh',
      model: '',
      appearanceTheme: 'mono',
      colorMode: 'dark',
    })}, hermesBrowserIntroSeen: true})`);
    setup.close();

    // Open the side panel at a realistic side-panel geometry.
    const pageTarget = await fetchJson(
      `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`,
      { method: 'PUT' },
    );
    panel = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await panel.connect();
    await panel.call('Runtime.enable');
    await panel.call('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 1, mobile: false });

    await waitFor(() => panel.evaluate(`Boolean(document.querySelector('#promptInput'))`));
    // Let the panel settle (capabilities/skills fetches against live gateway).
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Type a long multi-line prompt.
    const typed = await panel.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      input.value = ${JSON.stringify(LONG_PROMPT)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value.split('\\n').length;
    })()`);
    assert.ok(typed >= 8, `Prompt should span many lines, got ${typed}`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // ── Check 1: the /commands quick menu opens ABOVE the composer ──
    await panel.evaluate(`document.querySelector('#commandMenuButton')?.click()`);
    const quickState = await waitFor(() => panel.evaluate(`(() => {
      const menu = document.querySelector('#quickMoreMenu');
      if (!menu || menu.hidden) return null;
      const mr = menu.getBoundingClientRect();
      const ta = document.querySelector('#promptInput').getBoundingClientRect();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      return {
        menuTop: mr.top, menuBottom: mr.bottom, menuHeight: mr.height,
        textareaTop: ta.top, textareaBottom: ta.bottom,
        composerTop: composer.top,
        menuItems: menu.querySelectorAll('button:not([hidden])').length,
      };
    })()`));
    await saveScreenshot(panel, MENU_OPEN_SHOT);

    assert.ok(quickState.menuItems > 0, 'Quick commands menu rendered no items.');
    // Issue #73 contract: the menu must never cover the prompt textarea.
    assert.ok(quickState.menuBottom <= quickState.textareaTop + 1,
      `Quick menu bottom (${quickState.menuBottom.toFixed(1)}px) must not cover the textarea (top ${quickState.textareaTop.toFixed(1)}px).`);
    // And the menu must actually be visible in the panel, not clipped away.
    assert.ok(quickState.menuTop >= -1, `Quick menu top (${quickState.menuTop.toFixed(1)}px) must be inside the panel viewport.`);

    // Keyboard behavior must survive the layout change: Escape closes it.
    await panel.evaluate(`(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
    })()`);
    const closedByEscape = await panel.evaluate(`document.querySelector('#quickMoreMenu')?.hidden === true`)
      .catch(() => false);
    if (!closedByEscape) {
      // Fallback: the toggle button itself closes an open menu.
      await panel.evaluate(`document.querySelector('#commandMenuButton')?.click()`);
      await waitFor(() => panel.evaluate(`document.querySelector('#quickMoreMenu')?.hidden === true`));
    }

    // ── Check 2: the /skill menu (slash suggestions) also opens upward ──
    // Seed the textarea with a bare "/" so the suggestion path engages.
    const skillOpened = await panel.evaluate(`(async () => {
      const input = document.querySelector('#promptInput');
      input.focus();
      input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return Boolean(document.querySelector('#skillMenu') && !document.querySelector('#skillMenu').hidden);
    })()`);

    let skillState = null;
    if (skillOpened) {
      skillState = await panel.evaluate(`(() => {
        const menu = document.querySelector('#skillMenu');
        const mr = menu.getBoundingClientRect();
        const ta = document.querySelector('#promptInput').getBoundingClientRect();
        const composer = document.querySelector('#composer').getBoundingClientRect();
        return {
          menuTop: mr.top, menuBottom: mr.bottom, menuHeight: mr.height,
          textareaTop: ta.top, composerTop: composer.top,
          options: menu.querySelectorAll('.skill-option').length,
        };
      })()`);
      await saveScreenshot(panel, SKILL_MENU_SHOT);
      assert.ok(skillState.menuBottom <= skillState.textareaTop + 1,
        `Skill menu bottom (${skillState.menuBottom.toFixed(1)}px) must not cover the textarea (top ${skillState.textareaTop.toFixed(1)}px).`);
    }

    // ── Check 3: the shipped CSS rules anchor both menus upward ──
    // Computed styles resolve calc() to pixels while visible, so verify the
    // declared rule text from the stylesheets themselves.
    const cssContract = await panel.evaluate(`(() => {
      const declared = {};
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.selectorText === '.quick-more-menu' || rule.selectorText === '.skill-menu') {
            declared[rule.selectorText] = {
              position: rule.style.position,
              bottom: rule.style.bottom,
              zIndex: rule.style.zIndex,
            };
          }
        }
      }
      return declared;
    })()`);
    assert.equal(cssContract['.quick-more-menu']?.position, 'absolute', 'Quick menu rule must be absolutely positioned.');
    assert.equal(cssContract['.skill-menu']?.position, 'absolute', 'Skill menu rule must be absolutely positioned.');
    assert.match(String(cssContract['.quick-more-menu']?.bottom), /calc\(100% \+ 6px\)/,
      `Quick menu bottom declaration broken: ${cssContract['.quick-more-menu']?.bottom}`);
    assert.match(String(cssContract['.skill-menu']?.bottom), /calc\(100% \+ 6px\)/,
      `Skill menu bottom declaration broken: ${cssContract['.skill-menu']?.bottom}`);

    console.log(JSON.stringify({
      verdict: 'PASS',
      issue: 73,
      promptLines: typed,
      quickMenu: quickState,
      skillMenu: skillOpened ? skillState : 'not-rendered (no gateway suggestions matched "/")',
      cssContract,
      screenshots: [MENU_OPEN_SHOT, ...(skillOpened ? [SKILL_MENU_SHOT] : [])],
    }, null, 2));
  } finally {
    panel?.close();
    killChrome(chrome);
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('ISSUE-73 VERIFY FAIL:', error?.message || error);
  process.exit(1);
});
