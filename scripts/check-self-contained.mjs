// Guards the extension against remote code references. The extension is
// intentionally 100% self-contained: every script ships in the package, and
// the CSP allows only 'self' scripts. This check fails the build if an
// extension page or module ever references an http(s):// script source or
// dynamic import — a malicious or accidental external dependency would
// otherwise bypass the CSP and SRI story entirely.
//
// Usage: node scripts/check-self-contained.mjs [path]
// Defaults to scanning extension/ (the source tree).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable security/detect-non-literal-fs-filename -- build tooling: the
// scan target is the extension tree, never user-controlled input.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = path.resolve(process.argv[2] || path.join(root, 'extension'));

const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store']);
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.json']);

// Match <script src="http(s)://..."> in HTML, plus static and dynamic
// ESM imports of http(s):// URLs in JS modules. Comments are not excluded:
// a documented remote reference is still a red flag worth surfacing.
const REMOTE_REFERENCE_PATTERNS = [
  /<script[^>]+src=["']https?:\/\//i,
  /(?:from\s*|import\s*\()["']https?:\/\//i,
  /<link[^>]+href=["']https?:\/\/[^"']*\.(?:js|mjs)(?:[?#"']|$)/i,
];

const violations = [];
function scanDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      scanDirectory(path.join(directory, entry.name));
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const filePath = path.join(directory, entry.name);
    const content = fs.readFileSync(filePath, 'utf8');
    const relative = path.relative(root, filePath);
    for (const pattern of REMOTE_REFERENCE_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relative}: matches ${pattern}`);
        break;
      }
    }
  }
}

export function checkSelfContained(scanRoot = path.join(root, 'extension')) {
  const absolute = path.resolve(scanRoot);
  violations.length = 0;
  scanDirectory(absolute);
  if (violations.length) {
    throw new Error(
      `Self-contained check FAILED (${violations.length} remote reference(s)):\n${violations.map((violation) => `  - ${violation}`).join('\n')}\nThe extension must stay fully self-contained. Vendor the dependency instead.`,
    );
  }
  return absolute;
}

scanDirectory(scanRoot);

if (violations.length) {
  console.error(`Self-contained check FAILED (${violations.length} remote reference(s)):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error('The extension must stay fully self-contained. Vendor the dependency instead.');
  process.exit(1);
}

console.log(`Self-contained check passed: ${scanRoot}`);
