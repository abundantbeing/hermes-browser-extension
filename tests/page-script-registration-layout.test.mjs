import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRegisteredPageScriptDefinition,
  extensionPageContextPackaged,
} from '../extension/lib/page-script-host-policy.mjs';

test('extensionPageContextPackaged detects dist vs repository script paths', () => {
  assert.equal(extensionPageContextPackaged(() => ({ content_scripts: [{ js: ['content.js'] }] })), true);
  assert.equal(extensionPageContextPackaged(() => ({ content_scripts: [{ js: ['extension/content.js'] }] })), false);
  const packagedDef = buildRegisteredPageScriptDefinition({}, { packaged: true });
  const repoDef = buildRegisteredPageScriptDefinition({}, { packaged: false });
  assert.match(packagedDef.js[0], /^lib\//);
  assert.match(repoDef.js[0], /^extension\//);
});
