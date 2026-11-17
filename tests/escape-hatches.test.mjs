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

test('findEscapeHatchesInFile sees TODO after a regex literal with a quote', () => {
  const hits = findEscapeHatchesInFile(
    'fixture/regex.mjs',
    'const quote = /"/; // TODO: remove this\n',
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'TODO');
});

test('findEscapeHatchesInFile does not treat TODO inside strings after regex', () => {
  const hits = findEscapeHatchesInFile(
    'fixture/regex2.mjs',
    'const a = /[/*]/; const b = "TODO: hide";\n',
  );
  assert.equal(hits.length, 0);
});

test('findEscapeHatchesInFile sees TODO inside template expression comments', () => {
  const hits = findEscapeHatchesInFile(
    'fixture/template.mjs',
    'const x = `a${/* TODO: inner */ 1}b`;\n',
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'TODO');
});

test('findEscapeHatchesInFile scans CSS block comments', () => {
  const hits = findEscapeHatchesInFile('extension/panel.css', '/* TODO: tune spacing */\n.rule {}\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'TODO');
});

test('findEscapeHatchesInFile scans HTML comments and inline script comments', () => {
  const html = [
    '<!-- FIXME: ship layout -->',
    '<script type="module">',
    '// TODO: boot',
    '</script>',
  ].join('\n');
  const hits = findEscapeHatchesInFile('extension/page.html', `${html}\n`);
  const patterns = hits.map((h) => h.pattern).sort();
  assert.deepEqual(patterns, ['FIXME', 'TODO']);
});

test('findEscapeHatchesInFile skips non-JavaScript script bodies in HTML', () => {
  const html = [
    '<script type="application/json">{"label":"TODO in json"}</script>',
    '<!-- TODO: only this hatch -->',
    '<script type="text/javascript">',
    '// TODO: still flagged',
    '</script>',
    '<script type="module">',
    '// TODO: module hatch',
    '</script>',
  ].join('\n');
  const hits = findEscapeHatchesInFile('extension/page.html', `${html}\n`);
  const patterns = hits.map((h) => h.pattern).sort();
  assert.deepEqual(patterns, ['TODO', 'TODO', 'TODO']);
  assert.equal(hits.filter((h) => h.pattern === 'TODO' && h.comment.includes('only this')).length, 1);
});

test('findEscapeHatchesInFile sees TODO in Python f-string replacement expressions', () => {
  const source = 'value = f"""before {1 # TODO: revisit\n} literal TODO here"""\n';
  const hits = findEscapeHatchesInFile('scripts/sample.py', source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'TODO');
  assert.match(hits[0].comment, /revisit/);
});

test('findEscapeHatchesInFile scans Python line comments but not strings', () => {
  const source = ['label = "not a # TODO"', '# TODO: migrate script'].join('\n');
  const hits = findEscapeHatchesInFile('scripts/pytools/sample.py', `${source}\n`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, 'TODO');
});

test('findEscapeHatchesInFile rejects TypeScript-only syntax', () => {
  assert.throws(
    () => findEscapeHatchesInFile('fixture/typed.ts', 'const x: number = 1;\n'),
    /cannot parse fixture\/typed\.ts/i,
  );
});

test('findEscapeHatchesInFile accepts TypeScript extension when syntax is plain ECMAScript', () => {
  const hits = findEscapeHatchesInFile('fixture/plain.ts', '// TODO: later\n');
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