import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Hard rule: a scrollbar floats over what it scrolls (lib/overlay-scrollbar.mjs). No area keeps an empty
// strip beside its content for one (scrollbar-gutter: stable), the gap that sat beside the model search.
// The side panel's older areas below still reserve one and are being moved to the floating thumb; this
// list may only shrink.
const KNOWN_STRIPS = Object.freeze({
  'extension/sidepanel.css': 9,
  'extension/lib/branded-select.css': 1,
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'vendor' || name === 'locales' || name === '_locales' ? [] : sources(full);
    return /\.(css|html|js|mjs)$/.test(name) ? [full] : [];
  });
}

test('no area in the extension keeps a strip beside its content for a scrollbar', () => {
  const found = {};
  for (const file of sources(path.join(root, 'extension'))) {
    const count = (readFileSync(file, 'utf8').match(/scrollbar-gutter\s*:\s*stable/g) || []).length;
    if (count) found[path.relative(root, file).split(path.sep).join('/')] = count;
  }
  for (const [file, count] of Object.entries(found)) {
    assert.ok(Object.hasOwn(KNOWN_STRIPS, file), `${file} reserves a scrollbar strip: use attachOverlayScrollbar instead`);
    assert.ok(count <= KNOWN_STRIPS[file], `${file} reserves ${count} scrollbar strips, more than the ${KNOWN_STRIPS[file]} already being removed`);
  }
  assert.equal(found['extension/content-inline-helper.js'], undefined, 'Hermes Assist keeps none');
});
