import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('scripting fallback lists the dynamically registered page bundle, not manifest launch scripts only', async () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const manifestJs = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
  assert.ok(manifestJs.some((file) => file.endsWith('hermes-web-launch.js')));
  assert.ok(!manifestJs.some((file) => file.endsWith('content-extractor.js')), 'extractor must not rely on static manifest');

  const { packagedPageContextScriptFiles, buildRegisteredPageScriptDefinition } = await import('../extension/lib/page-script-host-policy.mjs');
  const bundle = packagedPageContextScriptFiles();
  assert.ok(bundle.includes('content-extractor.js'));
  assert.deepEqual(bundle, buildRegisteredPageScriptDefinition({}, { packaged: true }).js);

  const sidepanel = read('extension/sidepanel.js');
  assert.match(sidepanel, /extensionPageContextPackaged/);
  assert.match(sidepanel, /buildRegisteredPageScriptDefinition\(settings, \{ packaged \}\)/);
  const background = read('extension/background.js');
  assert.match(background, /extensionPageContextPackaged\(\(\) => browserApi\.runtime\.getManifest\(\)\)/);
});
