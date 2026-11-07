// The Firefox guide's tables are generated from the capability matrix, and the docs may not say Hermes Control is
// Chromium-only: Firefox has a restricted one (browser-controller-adapter.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITY_DOCS_END,
  CAPABILITY_DOCS_START,
  CAPABILITY_ENGINES,
  BROWSER_CAPABILITY_ROWS,
  capabilityDocsBlock,
  capabilityRowsFor,
} from '../extension/lib/browser-capability-matrix.mjs';
import { FIREFOX_ACTIONS } from '../extension/lib/browser-controller-adapter.mjs';
import { withCapabilityBlock } from '../scripts/sync-capability-docs.mjs';
import { controlToolName } from '../extension/lib/control-tool-names.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const guide = read('guides/firefox.md');

test('the Firefox guide carries exactly the generated matrix, so it cannot drift from the module', () => {
  const start = guide.indexOf(CAPABILITY_DOCS_START);
  const end = guide.indexOf(CAPABILITY_DOCS_END) + CAPABILITY_DOCS_END.length;
  assert.ok(start > 0 && end > start, 'the guide has the generated block');
  assert.equal(guide.slice(start, end), capabilityDocsBlock(), 'run npm run sync:capabilities');
  assert.equal(withCapabilityBlock(guide), guide);
});

test('sync:capabilities and check:capabilities run from this file path on Unix', () => {
  const script = fileURLToPath(new URL('../scripts/sync-capability-docs.mjs', import.meta.url));
  const check = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /matches the capability matrix/);
});

test('every feature row and its Firefox status appears in the guide', () => {
  for (const entry of BROWSER_CAPABILITY_ROWS) {
    assert.ok(guide.includes(`| ${entry.label} |`), `${entry.id} is missing from the guide`);
  }
  for (const entry of capabilityRowsFor(CAPABILITY_ENGINES.FIREFOX)) {
    assert.ok(guide.includes(entry.reason.replace(/\|/g, '\\|')), `${entry.id}: the Firefox reason is in the guide`);
  }
});

test('the guide names the Hermes Control tools Firefox offers, taken from the adapter, and no others', () => {
  const section = guide.slice(guide.indexOf('## Hermes Control on Firefox'), guide.indexOf('## Hermes Web on Firefox'));
  const named = new Set([...section.matchAll(/`(tab_[a-z_]+)`/g)].map((match) => match[1]));
  const offered = new Set(FIREFOX_ACTIONS.map((action) => controlToolName(action, 'plugin')));
  assert.deepEqual([...named].sort(), [...offered].sort());
});

test('no document says Hermes Control is Chromium-only; Firefox has a restricted one', () => {
  const claim = /(?:Hermes Control|tab control|real-tab attach)[^.\n]{0,80}\bChromium-only\b|\bChromium-only\b[^.\n]{0,40}(?:Hermes Control|tab control)|Firefox gets chat and page context only|Chat and context only,/i;
  for (const path of ['README.md', 'guides/connection-guide.md', 'guides/troubleshooting.md', 'PERMISSIONS.md', 'PRIVACY.md', 'SECURITY.md', 'DATA-FLOW.md', 'companion-plugin/README.md', 'companion-plugin/install.md']) {
    assert.doesNotMatch(read(path), claim, `${path} understates Firefox's Hermes Control`);
  }
});

test('the README and the connection guide send readers to the Firefox guide', () => {
  assert.match(read('README.md'), /\]\(\.\/guides\/firefox\.md\)/);
  assert.match(read('guides/connection-guide.md'), /\]\(\.\/firefox\.md\)/);
  assert.match(read('companion-plugin/README.md'), /\]\(\.\.\/guides\/firefox\.md\)/);
});
