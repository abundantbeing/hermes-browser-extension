import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SURFACE_KINDS,
  buildFullTabHandoffUrl,
  createSurfaceId,
  fullTabEntryPathForPage,
  parseFullTabHandoff,
} from '../extension/lib/surface-protocol.mjs';
import * as surfaceProtocol from '../extension/lib/surface-protocol.mjs';
import { readdir, readFile } from 'node:fs/promises';

test('full-tab entry path supports packaged and repository-root layouts in every browser scheme', () => {
  assert.equal(fullTabEntryPathForPage('chrome-extension://abc/sidepanel.html'), 'app.html');
  assert.equal(fullTabEntryPathForPage('comet-extension://abc/extension/sidepanel.html'), 'extension/app.html');
  assert.equal(fullTabEntryPathForPage('moz-extension://abc/sidepanel.html'), 'app.html');
});

test('surface ids distinguish side-panel and full-tab instances', () => {
  assert.equal(createSurfaceId({ kind: SURFACE_KINDS.SIDE_PANEL, instanceId: 'panel-7' }), 'sidepanel:panel-7');
  assert.equal(createSurfaceId({ kind: SURFACE_KINDS.FULL_TAB, instanceId: 'tab-11' }), 'fulltab:tab-11');
  assert.throws(() => createSurfaceId({ kind: 'popup', instanceId: 'x' }), /Unknown surface kind/);
});

test('full-tab handoff preserves safe session and browser-tab identity', () => {
  const url = buildFullTabHandoffUrl({
    runtimeUrl: (path) => `chrome-extension://abc/${path}`,
    sessionId: 'browser-session:2026/07',
    sourceTabId: 42,
    sourceSurfaceId: 'sidepanel:panel-7',
  });
  const parsed = parseFullTabHandoff(new URL(url).search);
  assert.equal(new URL(url).pathname, '/app.html');
  assert.deepEqual(parsed, {
    sessionId: 'browser-session:2026/07',
    newChat: false,
    sourceTabId: 42,
    sourceSurfaceId: 'sidepanel:panel-7',
  });
});

test('fresh Hermes Web handoff is explicit and carries no Browser session identity', () => {
  const url = buildFullTabHandoffUrl({
    runtimeUrl: (path) => `chrome-extension://abc/${path}`,
    sessionId: 'browser-session-that-must-not-leak',
    newChat: true,
    sourceTabId: 42,
    sourceSurfaceId: 'sidepanel:panel-7',
  });
  const parsed = parseFullTabHandoff(new URL(url).search);

  assert.equal(new URL(url).searchParams.has('sessionId'), false);
  assert.deepEqual(parsed, {
    sessionId: '',
    newChat: true,
    sourceTabId: 42,
    sourceSurfaceId: 'sidepanel:panel-7',
  });
});

test('full-tab handoff rejects oversized or malformed identifiers', () => {
  assert.deepEqual(parseFullTabHandoff('?sessionId=%00bad&sourceTabId=-2&sourceSurfaceId=x'), {
    sessionId: '',
    newChat: false,
    sourceTabId: null,
    sourceSurfaceId: '',
  });
  assert.equal(parseFullTabHandoff(`?sessionId=${'a'.repeat(600)}`).sessionId, '');
});

// shouldAcceptSurfaceRevision was exported but imported nowhere: no surface carries a state revision, so it
// described a window registry this extension does not have. It is gone; this keeps the module honest.
test('the surface protocol mints and parses ids and handoff URLs, and claims nothing more', async () => {
  assert.deepEqual(Object.keys(surfaceProtocol).sort(), [
    'SURFACE_KINDS', 'buildFullTabHandoffUrl', 'createSurfaceId', 'fullTabEntryPathForPage', 'parseFullTabHandoff',
  ]);
  const source = await readFile(new URL('../extension/lib/surface-protocol.mjs', import.meta.url), 'utf8');
  assert.match(source, /not a window registry/);
  const lib = new URL('../extension/lib/', import.meta.url);
  for (const file of await readdir(lib)) {
    if (!/\.(m?js)$/.test(file) || file === 'surface-protocol.mjs') continue;
    assert.doesNotMatch(await readFile(new URL(file, lib), 'utf8'), /shouldAcceptSurfaceRevision/, file);
  }
  for (const file of ['sidepanel.js', 'app.js', 'background.js']) {
    assert.doesNotMatch(await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8'), /shouldAcceptSurfaceRevision/, file);
  }
});
