import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  renderContentExtractorRuntime,
  writeContentExtractorRuntime,
} from '../scripts/build-content-runtime.mjs';
import {
  EXTRACTION_SCHEMA,
  EXTRACTION_VERSION,
} from '../extension/lib/content-extraction-core.mjs';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..');

async function jsonFile(relativePath) {
  return JSON.parse(await readFile(path.join(rootDir, relativePath), 'utf8'));
}

test('classic content runtime is generated deterministically from the authored extractor core', async () => {
  const rendered = await renderContentExtractorRuntime({ rootDir });
  const generated = await readFile(path.join(rootDir, 'extension', 'content-extractor.js'), 'utf8');

  assert.equal(generated, rendered);
  assert.match(generated, /Generated from extension\/lib\/content-extraction-core\.mjs/);
  assert.doesNotMatch(generated, /^export\s/m);
  assert.doesNotMatch(generated, /^import\s/m);
});

test('generated classic runtime exposes the same schema and version without module imports', async () => {
  const rendered = await renderContentExtractorRuntime({ rootDir });
  const context = vm.createContext({ globalThis: {} });
  new vm.Script(rendered, { filename: 'content-extractor.js' }).runInContext(context);

  const api = context.globalThis.HermesContentExtractor;
  assert.equal(api.schema, EXTRACTION_SCHEMA);
  assert.equal(api.version, EXTRACTION_VERSION);
  assert.equal(typeof api.extractPageContent, 'function');
  assert.equal(api.html, undefined);
  assert.equal(context.globalThis.HermesSiteAdapters.schema, 'hermes.browser.site-capability.v1');
  assert.equal(typeof context.globalThis.HermesSiteAdapters.inspectSite, 'function');
  assert.equal(context.globalThis.HermesInlineDraft.mode, 'draft-copy-only');
  assert.equal(typeof context.globalThis.HermesInlineDraft.classifyEditable, 'function');
});

test('runtime writer can materialize an exact artifact outside the repository', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hermes-content-runtime-'));
  const destination = path.join(tempDir, 'content-extractor.js');
  const expected = await renderContentExtractorRuntime({ rootDir });

  await writeContentExtractorRuntime({ rootDir, destination });

  assert.equal(await readFile(destination, 'utf8'), expected);
});

test('Chromium and repository-root manifests load the extractor before the content bridge', async () => {
  const extensionManifest = await jsonFile('extension/manifest.json');
  const rootManifest = await jsonFile('manifest.json');

  assert.deepEqual(extensionManifest.content_scripts[0].js.slice(0, 2), ['content-extractor.js', 'content.js']);
  assert.deepEqual(rootManifest.content_scripts[0].js.slice(0, 2), ['extension/content-extractor.js', 'extension/content.js']);
});

test('build scripts generate the classic runtime before copying extension files', async () => {
  const build = await readFile(path.join(rootDir, 'scripts', 'build.mjs'), 'utf8');
  const firefox = await readFile(path.join(rootDir, 'scripts', 'build-firefox.mjs'), 'utf8');
  const packageJson = await jsonFile('package.json');

  assert.match(build, /writeContentExtractorRuntime/);
  assert.match(firefox, /writeContentExtractorRuntime/);
  assert.match(packageJson.scripts['check:js'], /check:content-runtime/);
  assert.equal(packageJson.scripts['check:content-runtime'], 'node scripts/build-content-runtime.mjs --check');
});

test('live and scripting-fallback capture delegate to the shared runtime', async () => {
  const content = await readFile(path.join(rootDir, 'extension', 'content.js'), 'utf8');
  const sidepanel = await readFile(path.join(rootDir, 'extension', 'sidepanel.js'), 'utf8');

  assert.match(content, /HermesContentExtractor\.collectPageContext/);
  assert.match(content, /HermesSiteAdapters\.inspectSite/);
  assert.match(content, /HermesSiteAdapters\.applySiteAdapterPolicy/);
  assert.doesNotMatch(content, /function collectReadablePageText\s*\(/);
  assert.match(sidepanel, /files:\s*\[extractorPath\]/);
  assert.match(sidepanel, /HermesContentExtractor\.collectPageContext/);
  assert.doesNotMatch(sidepanel, /function collectPageContextFallback\s*\(/);
});

test('normal capture never reinjects the content bridge and fallback injects only the extractor runtime', async () => {
  const sidepanel = await readFile(path.join(rootDir, 'extension', 'sidepanel.js'), 'utf8');
  const getPageContext = sidepanel.match(/async function getPageContext\(tab, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '';
  const getYoutubeTranscript = sidepanel.match(/async function getYoutubeTranscriptForTab\(tab\) \{[\s\S]*?\n\}/)?.[0] || '';
  const scriptingFallback = sidepanel.match(/async function getPageContextViaScripting\(tabId, options, originalError\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.doesNotMatch(sidepanel, /async function ensureContentScript\s*\(/);
  assert.doesNotMatch(getPageContext, /ensureContentScript/);
  assert.doesNotMatch(getYoutubeTranscript, /ensureContentScript/);
  assert.match(scriptingFallback, /files:\s*\[extractorPath\]/);
  assert.doesNotMatch(scriptingFallback, /files:\s*manifestContentScriptFiles\(\)/);
});
