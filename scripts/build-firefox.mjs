/**
 * Firefox build script for Hermes Browser Extension.
 *
 * Copies the extension source to dist/firefox/ and generates a Firefox-compatible
 * manifest.json by replacing Chromium's service worker with Firefox's module
 * background scripts, stripping Chrome-only keys/permissions, and adding Gecko
 * identity plus built-in data-consent categories.
 *
 * Firefox uses sidebar_action (already in the manifest) for sidebar support.
 * browser-runtime.mjs already detects Firefox via UA and browser.sidebarAction.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeContentExtractorRuntime } from './build-content-runtime.mjs';

const root = process.cwd();
const src = path.join(root, 'extension');
const dest = path.join(root, 'dist', 'firefox');
const buildInfoFileName = 'build-info.json';

await writeContentExtractorRuntime({ rootDir: root });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.name === buildInfoFileName) continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function buildInfo() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commit = gitOutput(['rev-parse', 'HEAD']);
  const branch = gitOutput(['branch', '--show-current']);
  const status = gitOutput(['status', '--short', '--untracked-files=no']);
  return {
    name: packageJson.name,
    version: packageJson.version,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : '',
    branch,
    dirty: Boolean(status),
    builtAt: new Date().toISOString(),
    repository: packageJson.repository?.url || '',
    target: 'firefox',
  };
}

// Read source manifest and transform for Firefox
const sourceManifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

// Remove Chrome-only keys
delete sourceManifest.side_panel;
delete sourceManifest.minimum_chrome_version;

// Remove sidePanel from permissions (Firefox doesn't support it)
if (Array.isArray(sourceManifest.permissions)) {
  sourceManifest.permissions = sourceManifest.permissions.filter((p) => p !== 'sidePanel');
}

// Firefox MV3 uses background.scripts; service_worker is ignored without this fallback.
if (sourceManifest.background?.service_worker) {
  sourceManifest.background = {
    scripts: [sourceManifest.background.service_worker],
    type: sourceManifest.background.type || 'module',
  };
}

// audioCapture is Chromium-only. Firefox voice support uses runtime feature detection.
if (Array.isArray(sourceManifest.optional_permissions)) {
  sourceManifest.optional_permissions = sourceManifest.optional_permissions.filter((permission) => permission !== 'audioCapture');
  if (!sourceManifest.optional_permissions.length) delete sourceManifest.optional_permissions;
}

// Add Firefox-specific settings
sourceManifest.browser_specific_settings = {
  gecko: {
    id: 'hermes-browser@abundantbeing.github.io',
    strict_min_version: '142.0',
    data_collection_permissions: {
      required: ['websiteContent', 'personalCommunications'],
    },
  },
};

// Write build info
const infoJson = `${JSON.stringify(buildInfo(), null, 2)}\n`;

// Clean and copy
fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);

// Write Firefox manifest
fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify(sourceManifest, null, 2)}\r\n`);

// Write build-info.json
fs.writeFileSync(path.join(dest, buildInfoFileName), infoJson);

console.log(`Built Firefox extension: ${dest}`);
console.log('Firefox manifest: module background script, Firefox sidebar, no audioCapture, declared data consent');
console.log(`Stamped build metadata: ${buildInfoFileName}`);
