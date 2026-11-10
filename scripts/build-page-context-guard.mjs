import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { privateNetworkHost } from '../extension/lib/common.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), '..');
const generatedRelativePath = 'extension/page-context-install-guard.js';
const POLICY_TIMEOUT_MS = 4000;

export function renderPageContextInstallGuard({ privateHostFn = privateNetworkHost } = {}) {
  const classifierSource = privateHostFn.toString();
  return `/* Generated from extension/lib/common.mjs privateNetworkHost. Do not edit directly. */\n(() => {\n  'use strict';\n  const browserApi = globalThis.browser || globalThis.chrome;\n  if (!browserApi?.runtime?.sendMessage) return;\n\n  const privateNetworkHost = ${classifierSource};\n\n  const likelyPrivate = privateNetworkHost(location.hostname);\n  if (likelyPrivate) globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;\n  let settled = false;\n\n  const promise = new Promise((resolve) => {\n    const finish = (inject) => {\n      if (settled) return;\n      settled = true;\n      globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !inject;\n      resolve(Boolean(inject));\n    };\n\n    const timeout = setTimeout(() => finish(!likelyPrivate), ${POLICY_TIMEOUT_MS});\n\n    const onDecision = (response) => {\n      clearTimeout(timeout);\n      if (response && typeof response.inject === 'boolean') finish(response.inject);\n      else finish(!likelyPrivate);\n    };\n\n    const fail = () => finish(!likelyPrivate);\n    const message = { type: 'HERMES_PAGE_SCRIPT_POLICY', url: location.href };\n\n    try {\n      if (typeof globalThis.browser?.runtime?.sendMessage === 'function') {\n        Promise.resolve(globalThis.browser.runtime.sendMessage(message)).then(onDecision).catch(fail);\n      } else {\n        browserApi.runtime.sendMessage(message, (response) => {\n          if (browserApi.runtime.lastError) fail();\n          else onDecision(response);\n        });\n      }\n    } catch {\n      fail();\n    }\n  });\n\n  globalThis.__HERMES_PAGE_SCRIPT_POLICY__ = { promise, likelyPrivate };\n})();\n`;
}

export async function writePageContextInstallGuard({
  rootDir = defaultRootDir,
  destination = path.join(rootDir, ...generatedRelativePath.split('/')),
} = {}) {
  const rendered = renderPageContextInstallGuard();
  await writeFile(destination, rendered, 'utf8');
  return destination;
}

export async function checkPageContextInstallGuard({
  rootDir = defaultRootDir,
  destination = path.join(rootDir, ...generatedRelativePath.split('/')),
} = {}) {
  const expected = renderPageContextInstallGuard();
  try {
    return (await readFile(destination, 'utf8')) === expected;
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.includes('--check')) {
    if (!await checkPageContextInstallGuard()) {
      console.error(`[page-context-guard] ${generatedRelativePath} is missing or stale. Run: npm run build:page-context-guard`);
      process.exitCode = 1;
      return;
    }
    console.log(`[page-context-guard] ${generatedRelativePath} is current.`);
    return;
  }
  const destination = await writePageContextInstallGuard();
  console.log(`[page-context-guard] wrote ${path.relative(defaultRootDir, destination).replaceAll('\\', '/')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
