import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { SURFACE_KINDS, createSurfaceId } from '../extension/lib/surface-protocol.mjs';
import * as surfaceProtocol from '../extension/lib/surface-protocol.mjs';

test('the side panel is the only surface kind, and its ids carry the kind', () => {
  assert.deepEqual({ ...SURFACE_KINDS }, { SIDE_PANEL: 'sidepanel' });
  assert.equal(createSurfaceId({ kind: SURFACE_KINDS.SIDE_PANEL, instanceId: 'panel-7' }), 'sidepanel:panel-7');
  assert.throws(() => createSurfaceId({ kind: 'popup', instanceId: 'x' }), /Unknown surface kind/);
  assert.throws(() => createSurfaceId({ kind: 'fulltab', instanceId: 'tab-11' }), /Unknown surface kind/);
});

test('surface ids reject empty, oversized or malformed instance ids', () => {
  assert.throws(() => createSurfaceId({ kind: SURFACE_KINDS.SIDE_PANEL, instanceId: '' }), /instance id is required/);
  assert.throws(() => createSurfaceId({ kind: SURFACE_KINDS.SIDE_PANEL, instanceId: '\u0000bad' }), /instance id is required/);
  assert.throws(() => createSurfaceId({ kind: SURFACE_KINDS.SIDE_PANEL, instanceId: 'a'.repeat(200) }), /instance id is required/);
});

// shouldAcceptSurfaceRevision was exported but imported nowhere: no surface carries a state revision, so it
// described a window registry this extension does not have. The full-tab handoff went with the full tab.
test('the surface protocol mints ids and claims nothing more', async () => {
  assert.deepEqual(Object.keys(surfaceProtocol).sort(), ['SURFACE_KINDS', 'createSurfaceId']);
  const source = await readFile(new URL('../extension/lib/surface-protocol.mjs', import.meta.url), 'utf8');
  assert.match(source, /not a window registry/);
  const lib = new URL('../extension/lib/', import.meta.url);
  for (const file of await readdir(lib)) {
    if (!/\.(m?js)$/.test(file) || file === 'surface-protocol.mjs') continue;
    assert.doesNotMatch(await readFile(new URL(file, lib), 'utf8'), /shouldAcceptSurfaceRevision/, file);
  }
  for (const file of ['sidepanel.js', 'background.js']) {
    assert.doesNotMatch(await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8'), /shouldAcceptSurfaceRevision/, file);
  }
});
