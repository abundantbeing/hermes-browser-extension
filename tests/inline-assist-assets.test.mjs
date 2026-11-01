import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { INLINE_ASSIST_ICONS, inlineAssistIconAsset } from '../extension/lib/inline-assist-look.mjs';

const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const pageResources = manifest.web_accessible_resources[0].resources;

test('every trigger icon is packaged and pages may load it', () => {
  for (const icon of INLINE_ASSIST_ICONS) {
    for (const tone of ['light', 'dark']) {
      const asset = inlineAssistIconAsset(icon, tone);
      assert.ok(existsSync(new URL(asset, root)), `${asset} is missing`);
      assert.ok(pageResources.includes(asset), `${asset} is not web-accessible`);
    }
  }
});

test('no bundled font is ever web-accessible', () => {
  for (const entry of manifest.web_accessible_resources) {
    for (const resource of entry.resources) assert.doesNotMatch(resource, /assets\/fonts\//, resource);
  }
});
