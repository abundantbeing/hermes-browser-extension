import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromeExecutableCandidates } from './e2e-code-highlighting-support.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

const CUSTOM_BOUNDARY_VARIABLES = Object.freeze({
  '--hermes-canvas': '#ffffff',
  '--hermes-paper': '#ffffff',
  '--hermes-paper-rgb': '255, 255, 255',
  '--hermes-ink': '#000000',
  '--hermes-ink-rgb': '0, 0, 0',
  '--hermes-blue': '#000000',
  '--hermes-blue-rgb': '0, 0, 0',
  '--hermes-blue-deep': '#000000',
  '--hermes-blue-deep-rgb': '0, 0, 0',
  '--hermes-primary': '#000000',
  '--hermes-on-primary': '#767676',
  '--hermes-accent': '#000000',
  '--hermes-shell-fg': '#767676',
  '--hermes-shell-fg-rgb': '118, 118, 118',
  '--hermes-user-bg': '#000000',
  '--hermes-user-fg': '#767676',
  '--hermes-fg': '#767676',
  '--hermes-fg-rgb': '118, 118, 118',
});

function chromeExecutable() {
  const candidates = chromeExecutableCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Compatible Chrome/Edge not found. Set CHROME_PATH. Tried: ${candidates.join(', ')}`);
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
      document.documentElement.dataset.hermesTheme = ${JSON.stringify(surface.theme)};
      document.documentElement.dataset.hermesMode = ${JSON.stringify(surface.mode)};
      document.documentElement.dataset.hermesEffectiveMode = ${JSON.stringify(surface.effectiveMode || surface.mode)};
      const message = document.createElement('article');
      message.className = ${JSON.stringify(surface.messageClass)};
      const content = document.createElement('div');
      content.className = ${JSON.stringify(surface.contentClass)};
      content.innerHTML = renderMarkdownSafe(${JSON.stringify(surface.markdown)});
      highlightCodeBlocks(content);
      message.append(content);
      document.body.replaceChildren(message);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.documentElement.dataset.hermesTheme = ${JSON.stringify(surface.theme)};
      document.documentElement.dataset.hermesMode = ${JSON.stringify(surface.mode)};
      document.documentElement.dataset.hermesEffectiveMode = ${JSON.stringify(surface.effectiveMode || surface.mode)};
      for (const [name, value] of Object.entries(${JSON.stringify(surface.variables || {})})) {
        document.documentElement.style.setProperty(name, value);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const code = content.querySelector('pre > code');
      const pre = code?.closest('pre');
      const token = code?.querySelector(${JSON.stringify(surface.tokenSelector)});
      const parseColor = (value) => {
        const serialized = String(value || '');
        const parts = serialized.match(/[0-9.]+/g)?.map(Number) || [];
        const scale = serialized.startsWith('color(srgb ') ? 255 : 1;
        return {
          r: (parts[0] || 0) * scale,
          g: (parts[1] || 0) * scale,
          b: (parts[2] || 0) * scale,
          a: parts[3] ?? 1,
        };
      };
      const composite = (front, back) => ({
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
        a: 1,
      });
      const luminance = (color) => {
        const channel = (value) => {
          const normalized = value / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      };
      const contrast = (left, right) => {
        const high = Math.max(luminance(left), luminance(right));
        const low = Math.min(luminance(left), luminance(right));
        return (high + 0.05) / (low + 0.05);
      };
      const bodyBackground = composite(
        parseColor(getComputedStyle(document.body).backgroundColor),
        parseColor(getComputedStyle(document.documentElement).backgroundColor),
      );
      const messageBackground = composite(parseColor(getComputedStyle(message).backgroundColor), bodyBackground);
      const preStyle = pre ? getComputedStyle(pre) : null;
      const codeStyle = code ? getComputedStyle(code) : null;
      const tokenStyle = token ? getComputedStyle(token) : null;
      const preBackground = composite(parseColor(preStyle?.backgroundColor), messageBackground);
      const tokenColor = parseColor(tokenStyle?.color);

      return {
        theme: document.documentElement.dataset.hermesTheme || '',
        mode: document.documentElement.dataset.hermesMode || '',
        effectiveMode: document.documentElement.dataset.hermesEffectiveMode || '',
        language: code?.dataset.highlighted || '',
        source: code?.textContent || '',
        tokenCount: code?.querySelectorAll(${JSON.stringify(surface.tokenSelector)}).length || 0,
        overflowX: preStyle?.overflowX || '',
        codeColor: codeStyle?.color || '',
        tokenColor: tokenStyle?.color || '',
        messageBackground: getComputedStyle(message).backgroundColor,
        preBackground: preStyle?.backgroundColor || '',
        contrastRatio: token ? contrast(tokenColor, preBackground) : 0,
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
        name: 'side panel Python', page: 'sidepanel.html', messageClass: 'message assistant', contentClass: 'message-content',
        markdown: '```python\ndef greet(name):\n    return f"Hi {name}"\n```', source: 'def greet(name):\n    return f"Hi {name}"',
        language: 'python', tokenSelector: '.hljs-keyword', theme: 'nous', mode: 'dark',
      },
      {
        name: 'Hermes Web TypeScript', page: 'app.html', messageClass: 'web-message assistant', contentClass: 'web-message-content',
        markdown: '```tsx\nconst view: JSX.Element = <Panel enabled />;\n```', source: 'const view: JSX.Element = <Panel enabled />;',
        language: 'typescript', tokenSelector: '.hljs-keyword', theme: 'nous', mode: 'light',
      },
      {
        name: 'side panel HTML user', page: 'sidepanel.html', messageClass: 'message user', contentClass: 'message-content',
        markdown: '```html\n<div>Hello</div>\n```', source: '<div>Hello</div>',
        language: 'xml', tokenSelector: '.hljs-name', theme: 'cyberpunk', mode: 'light',
      },
      {
        name: 'Hermes Web JSON user', page: 'app.html', messageClass: 'web-message user', contentClass: 'web-message-content',
        markdown: '```json\n{"answer": 42}\n```', source: '{"answer": 42}',
        language: 'json', tokenSelector: '.hljs-attr', theme: 'cyberpunk', mode: 'light',
      },
      {
        name: 'side panel custom assistant', page: 'sidepanel.html', messageClass: 'message assistant', contentClass: 'message-content',
        markdown: '```js\nconst label = "value";\n```', source: 'const label = "value";',
        language: 'javascript', tokenSelector: '.hljs-string', theme: 'custom:contrast-boundary', mode: 'dark',
        effectiveMode: 'light', variables: CUSTOM_BOUNDARY_VARIABLES, expectDistinctToken: false,
      },
      {
        name: 'Hermes Web custom assistant', page: 'app.html', messageClass: 'web-message assistant', contentClass: 'web-message-content',
        markdown: '```js\nconst label = "value";\n```', source: 'const label = "value";',
        language: 'javascript', tokenSelector: '.hljs-string', theme: 'custom:contrast-boundary', mode: 'dark',
        effectiveMode: 'light', variables: CUSTOM_BOUNDARY_VARIABLES, expectDistinctToken: false,
      },
      {
        name: 'side panel custom user', page: 'sidepanel.html', messageClass: 'message user', contentClass: 'message-content',
        markdown: '```js\nconst count = 42;\n```', source: 'const count = 42;',
        language: 'javascript', tokenSelector: '.hljs-number', theme: 'custom:contrast-boundary', mode: 'dark',
        effectiveMode: 'light', variables: CUSTOM_BOUNDARY_VARIABLES, expectDistinctToken: false,
      },
      {
        name: 'Hermes Web custom user', page: 'app.html', messageClass: 'web-message user', contentClass: 'web-message-content',
        markdown: '```js\nconst count = 42;\n```', source: 'const count = 42;',
        language: 'javascript', tokenSelector: '.hljs-number', theme: 'custom:contrast-boundary', mode: 'dark',
        effectiveMode: 'light', variables: CUSTOM_BOUNDARY_VARIABLES, expectDistinctToken: false,
      },
    ];

    const results = {};
    for (const surface of surfaces) {
      const result = await inspectSurface(devtoolsBase, extensionId, surface);
      assert.equal(result.theme, surface.theme, `${surface.name} theme`);
      assert.equal(result.mode, surface.mode, `${surface.name} mode`);
      assert.equal(result.effectiveMode, surface.effectiveMode || surface.mode, `${surface.name} effective mode`);
      assert.equal(result.language, surface.language, `${surface.name} language`);
      assert.equal(result.source, surface.source, `${surface.name} source preservation`);
      assert.ok(result.tokenCount >= 1, `${surface.name} token spans`);
      assert.ok(['auto', 'scroll'].includes(result.overflowX), `${surface.name} horizontal overflow`);
      if (surface.expectDistinctToken !== false) {
        assert.notEqual(result.tokenColor, result.codeColor, `${surface.name} visible token styling`);
      }
      assert.ok(
        result.contrastRatio >= 4.5,
        `${surface.name} token contrast ${result.contrastRatio.toFixed(2)}:1 (${result.tokenColor} on ${result.preBackground} over ${result.messageBackground})`,
      );
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
