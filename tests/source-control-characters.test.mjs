import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A control character in source is invisible in an editor and silently changes meaning: a backspace written into a
// regular expression where "\b" was meant made the page reader's display:contents rule never match. No authored
// source, test, fixture or doc may carry one (tab, newline and carriage return are the allowed whitespace).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['extension', 'companion-plugin', 'scripts', 'tests', 'guides'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.py', '.html', '.css', '.json', '.md', '.yaml', '.yml']);
const SKIP = new Set(['node_modules', 'vendor', 'dist', '.git', '__pycache__']);
// built from code points, so the test itself carries no control-character pattern for the linter to flag
const char = (code) => String.fromCharCode(code);
const CONTROL = new RegExp(`[${char(0)}-${char(8)}${char(11)}${char(12)}${char(14)}-${char(31)}${char(127)}]`);

function* files(directory) {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue;
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (EXTENSIONS.has(path.extname(name))) yield full;
  }
}

test('no authored file carries a control character', () => {
  const found = [];
  for (const top of SCAN) {
    for (const file of files(path.join(root, top))) {
      const text = readFileSync(file, 'utf8');
      const match = CONTROL.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        found.push(`${path.relative(root, file)}:${line} U+${match[0].charCodeAt(0).toString(16).padStart(4, '0')}`);
      }
    }
  }
  for (const file of ['README.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const match = CONTROL.exec(readFileSync(path.join(root, file), 'utf8'));
    if (match) found.push(`${file} U+${match[0].charCodeAt(0).toString(16)}`);
  }
  assert.deepEqual(found, []);
});
