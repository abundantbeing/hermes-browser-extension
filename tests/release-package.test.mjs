import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const packageLock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const sourceManifest = JSON.parse(readFileSync(new URL('extension/manifest.json', root), 'utf8'));
const rootManifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const pluginYaml = readFileSync(new URL('companion-plugin/plugin.yaml', root), 'utf8');
const packageSource = readFileSync(new URL('scripts/package.mjs', root), 'utf8');
const manifestCheckSource = readFileSync(new URL('scripts/check-manifest.mjs', root), 'utf8');

test('release version mirrors stay synchronized before build output is considered', () => {
  const pluginVersion = pluginYaml.match(/^version:\s*([^\s]+)\s*$/m)?.[1] || '';
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages?.['']?.version, packageJson.version);
  assert.equal(sourceManifest.version, packageJson.version);
  assert.equal(rootManifest.version, packageJson.version);
  assert.equal(pluginVersion, packageJson.version);
});

test('package command builds both target trees before archiving', () => {
  assert.match(packageJson.scripts.package, /npm run build/);
  assert.match(packageJson.scripts.package, /npm run build:firefox/);
  assert.match(packageJson.scripts.package, /scripts\/package\.mjs/);
});

test('release packager creates versioned isolated Chromium and Firefox archives plus checksums', () => {
  assert.match(packageSource, /hermes-browser-extension-v\$\{version\}-chromium\.tar\.gz/);
  assert.match(packageSource, /hermes-browser-extension-v\$\{version\}-firefox-preview\.tar\.gz/);
  assert.match(packageSource, /SHA256SUMS-v\$\{version\}\.txt/);
  assert.match(packageSource, /release-manifest\.json/);
  assert.match(packageSource, /chromium/);
  assert.match(packageSource, /firefox/);
  assert.match(packageSource, /createHash\(['"]sha256['"]\)/);
});

test('manifest verifier covers lockfile, companion plugin, and Firefox build version mirrors', () => {
  assert.match(manifestCheckSource, /package-lock\.json/);
  assert.match(manifestCheckSource, /companion-plugin[\\/'].*plugin\.yaml/);
  assert.match(manifestCheckSource, /dist.*firefox.*manifest\.json/s);
  assert.match(manifestCheckSource, /Firefox manifest/);
});
