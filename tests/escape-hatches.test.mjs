import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  baselineEntryKey,
  checkEscapeHatches,
  findEscapeHatchesInFile,
  loadBaseline,
  saveBaseline,
  scanTree,
} from '../scripts/check-escape-hatches.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkScript = path.join(repoRoot, 'scripts/check-escape-hatches.mjs');

function writeFixtureTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
}

test('findEscapeHatchesInFile flags comment markers but not strings', () => {
  const source = [
    'const label = "Complete your TODO list";',
    '// eslint-disable-next-line no-console',
    'console.log(1);',
    'const re = /FIXME/;',
    "const msg = 'HACK the planet';",
  ].join('\n');
  const hits = findEscapeHatchesInFile('fixture/sample.mjs', source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'eslint-disable');
});

test('findEscapeHatchesInFile flags TODO in line comments', () => {
  const hits = findEscapeHatchesInFile('fixture/todo.mjs', '// TODO: remove after v12\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'TODO');
});

test('checkEscapeHatches fails when a new hatch is not baselined', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbe-escape-new-'));
  const baselinePath = path.join(root, 'baseline.json');
  writeFixtureTree(root, {
    'extension/foo.mjs': '// eslint-disable-next-line no-console\n',
  });
  saveBaseline(baselinePath, { version: 1, entries: [] });
  const result = checkEscapeHatches({
    root,
    baselinePath,
    scanRoots: ['extension'],
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /not in the baseline/i);
});

test('checkEscapeHatches passes when hatch is baselined', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbe-escape-pass-'));
  const baselinePath = path.join(root, 'baseline.json');
  const relative = 'extension/foo.mjs';
  const content = '// eslint-disable-next-line no-console\n';
  writeFixtureTree(root, { [relative]: content });
  const hit = findEscapeHatchesInFile(relative, content)[0];
  saveBaseline(baselinePath, {
    version: 1,
    entries: [{ file: relative, pattern: hit.pattern, key: hit.key }],
  });
  const result = checkEscapeHatches({
    root,
    baselinePath,
    scanRoots: ['extension'],
  });
  assert.equal(result.ok, true);
});

test('checkEscapeHatches fails on stale baseline entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbe-escape-stale-'));
  const baselinePath = path.join(root, 'baseline.json');
  writeFixtureTree(root, { 'extension/clean.mjs': 'export const ok = 1;\n' });
  saveBaseline(baselinePath, {
    version: 1,
    entries: [{ file: 'extension/gone.mjs', pattern: 'eslint-disable', key: 'deadbeefdeadbeef' }],
  });
  const result = checkEscapeHatches({
    root,
    baselinePath,
    scanRoots: ['extension'],
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /stale/i);
});

test('i18n locale strings with TODO are not flagged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbe-escape-i18n-'));
  writeFixtureTree(root, {
    'extension/lib/locales/en.mjs': 'export default { todoHint: "Track your TODO items" };\n',
  });
  const hits = scanTree(root, ['extension']);
  assert.equal(hits.length, 0);
});

test('--update-baseline refuses to add entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbe-escape-update-'));
  const baselinePath = path.join(root, 'baseline.json');
  writeFixtureTree(root, {
    'extension/new.mjs': '// FIXME: ship this\n',
  });
  saveBaseline(baselinePath, { version: 1, entries: [] });
  const run = spawnSync(process.execPath, [checkScript, '--update-baseline'], {
    cwd: root,
    env: { ...process.env, HERMES_ESCAPE_HATCHES_ROOT: root, HERMES_ESCAPE_HATCHES_BASELINE: baselinePath },
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  const baseline = loadBaseline(baselinePath);
  assert.equal(baseline.entries.length, 0);
});

test('stable baseline keys do not depend on line numbers', () => {
  const a = baselineEntryKey('tests/x.test.mjs', 'eslint-disable', '// eslint-disable-next-line no-console');
  const withBlank = baselineEntryKey('tests/x.test.mjs', 'eslint-disable', '// eslint-disable-next-line no-console\n');
  assert.equal(a, withBlank);
});

test('checkEscapeHatches passes on the real repository tree', () => {
  const result = checkEscapeHatches({ root: repoRoot });
  assert.equal(result.ok, true, result.message);
});