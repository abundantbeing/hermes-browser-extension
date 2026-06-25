import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const requiredFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  'sidepanel.css',
  'sidepanel.js',
  'request-permissions.html',
  'request-permissions.js',
  'voice-dictation.html',
  'voice-dictation.js',
  'lib/common.mjs',
  'assets/fonts/Sigurd-Variable.woff2',
  'assets/fonts/CourierPrime-Regular.woff2',
  'assets/img/hermes-badge.webp',
  'assets/img/hermes-browse.webp',
  'assets/img/ray-field.svg',
  'assets/icons/icon-16.png',
  'assets/icons/icon-32.png',
  'assets/icons/icon-48.png',
  'assets/icons/icon-128.png',
].filter(Boolean);

const errors = [];

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (!manifest.permissions?.includes('sidePanel')) errors.push('sidePanel permission missing');
if (!manifest.permissions?.includes('storage')) errors.push('storage permission missing');
if (manifest.permissions?.includes('debugger')) errors.push('debugger permission is intentionally not allowed in v0.1');
if (!manifest.optional_permissions?.includes('audioCapture')) errors.push('audioCapture optional permission missing for runtime microphone prompt');
if (manifest.permissions?.includes('audioCapture')) errors.push('audioCapture should be optional so dictation can request it on click');
if (manifest.permissions?.includes('microphone') || manifest.optional_permissions?.includes('microphone')) {
  errors.push('microphone is a Web Permission name, not a Chrome extension manifest permission; use the request-permissions page instead');
}
if (!manifest.host_permissions?.includes('http://127.0.0.1/*')) errors.push('localhost gateway host permission missing');

for (const file of requiredFiles) {
  const filePath = path.join(root, 'extension', file);
  if (!fs.existsSync(filePath)) errors.push(`Missing manifest asset: ${file}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`Manifest OK: ${manifest.name} ${manifest.version}`);
