import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

function chromeExecutable() {
  const home = os.homedir();
  const candidates = [
    process.env.CHROME_PATH,
    path.join(home, 'opt/chrome-for-testing/chrome-linux64/chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `System Chrome/Edge not found. Set CHROME_PATH (WSL: ~/opt/chrome-for-testing/chrome-linux64/chrome). Tried: ${candidates.join(', ')}`,
    );
  }
  return found;
}

function unpackedExtensionId(extensionPath) {
  const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
  const digest = createHash('sha256')
    .update(Buffer.from(path.resolve(extensionPath), encoding))
    .digest()
    .subarray(0, 16);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

async function waitFor(check, timeoutMs = 25_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed (${response.status})`);
  return response.json();
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message || 'CDP error'));
      else pending.resolve(payload.result || {});
    };
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Could not connect to ${this.url}`));
    });
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('CDP socket is not open.');
    }
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
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* best-effort cleanup */ }
  }
}

function stopChrome(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* best-effort cleanup */ }
  }
}

async function inspectSurface(devtoolsBase, extensionId, surface) {
  const target = await fetchJson(
    `${devtoolsBase}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/${surface.page}`)}`,
    { method: 'PUT' },
  );
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.call('Runtime.enable');
    await client.call('Page.enable');
    await waitFor(() => client.evaluate(`document.readyState === 'complete'`));
    return await client.evaluate(`(async () => {
      const { renderMarkdownSafe } = await import(chrome.runtime.getURL('lib/sanitizer.mjs'));
      const { highlightCodeBlocks } = await import(chrome.runtime.getURL('lib/code-highlighting.mjs'));
      const root = document.createElement('div');
      root.className = ${JSON.stringify(surface.contentClass)};
      root.innerHTML = renderMarkdownSafe(${JSON.stringify(surface.markdown)});
      highlightCodeBlocks(root);
      document.body.replaceChildren(root);
      const code = root.querySelector('pre > code');
      const keyword = code?.querySelector('.hljs-keyword');
      const pre = code?.closest('pre');
      const snapshot = async (mode) => {
        document.documentElement.dataset.hermesMode = mode;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          codeColor: getComputedStyle(code).color,
          keywordColor: getComputedStyle(keyword).color,
        };
      };
      return {
        language: code?.dataset.highlighted || '',
        source: code?.textContent || '',
        keywordCount: code?.querySelectorAll('.hljs-keyword').length || 0,
        overflowX: getComputedStyle(pre).overflowX,
        light: await snapshot('light'),
        dark: await snapshot('dark'),
      };
    })()`);
  } finally {
    client.close();
  }
}

async function main() {
  assert.ok(existsSync(path.join(DIST, 'manifest.json')), 'Run npm run build before this test.');
  const profile = await mkdtemp(path.join(os.tmpdir(), 'hermes-code-highlighting-'));
  const extensionId = unpackedExtensionId(DIST);
  let chrome;
  let stderr = '';
  try {
    chrome = spawn(chromeExecutable(), [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      'about:blank',
    ], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    chrome.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const activePort = path.join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(activePort), 40_000);
    const [portLine] = (await readFile(activePort, 'utf8')).trim().split('\n');
    const devtoolsBase = `http://127.0.0.1:${Number(portLine)}`;

    const surfaces = [
      {
        name: 'side panel',
        page: 'sidepanel.html',
        contentClass: 'message-content',
        markdown: '```python\ndef greet(name):\n    return f"Hi {name}"\n```',
        source: 'def greet(name):\n    return f"Hi {name}"',
        language: 'python',
      },
      {
        name: 'Hermes Web',
        page: 'app.html',
        contentClass: 'web-message-content',
        markdown: '```tsx\nconst view: JSX.Element = <Panel enabled />;\n```',
        source: 'const view: JSX.Element = <Panel enabled />;',
        language: 'typescript',
      },
    ];

    const results = {};
    for (const surface of surfaces) {
      const result = await inspectSurface(devtoolsBase, extensionId, surface);
      assert.equal(result.language, surface.language, `${surface.name} language`);
      assert.equal(result.source, surface.source, `${surface.name} source preservation`);
      assert.ok(result.keywordCount >= 1, `${surface.name} keyword spans`);
      assert.ok(['auto', 'scroll'].includes(result.overflowX), `${surface.name} horizontal overflow`);
      assert.notEqual(result.light.keywordColor, result.light.codeColor, `${surface.name} light syntax color`);
      assert.notEqual(result.dark.keywordColor, result.dark.codeColor, `${surface.name} dark syntax color`);
      assert.notEqual(result.light.keywordColor, result.dark.keywordColor, `${surface.name} theme-specific syntax colors`);
      results[surface.name] = result;
    }
    console.log(JSON.stringify({ verdict: 'PASS', surfaces: results }, null, 2));
  } catch (error) {
    if (stderr.trim()) console.error(stderr.trim());
    throw error;
  } finally {
    stopChrome(chrome);
    await rm(profile, { recursive: true, force: true });
  }
}

await main();
