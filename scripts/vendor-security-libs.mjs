// Vendors DOMPurify's ESM build into the extension tree so the MV3 extension
// stays fully self-contained (no bundler; `load unpacked` runs straight from
// the extension/ source tree). Committed files must match these sources.
//
// Usage: node scripts/vendor-security-libs.mjs
// After upgrading a dependency in package.json, re-run this script and
// commit the changed vendored file together with the package bump.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable security/detect-non-literal-fs-filename -- build tooling: all
// fs paths derive from pinned package metadata and repo constants, never user input.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'extension', 'lib', 'vendor');

const entries = [
  {
    packageName: 'dompurify',
    sourceFile: path.join('dist', 'purify.es.mjs'),
    destFile: 'purify.es.mjs',
  },
];

fs.mkdirSync(vendorDir, { recursive: true });

for (const entry of entries) {
  const packageJsonPath = path.join(root, 'node_modules', entry.packageName, 'package.json');
  const sourcePath = path.join(root, 'node_modules', entry.packageName, entry.sourceFile);
  if (!fs.existsSync(packageJsonPath)) throw new Error(`Package not installed: ${entry.packageName}`);
  if (!fs.existsSync(sourcePath)) throw new Error(`Vendor source missing for ${entry.packageName}: ${sourcePath}`);
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const destPath = path.join(vendorDir, entry.destFile);
  fs.copyFileSync(sourcePath, destPath);
  const bytes = fs.statSync(destPath).size;
  console.log(`Vendored ${entry.packageName}@${pkg.version} -> extension/lib/vendor/${entry.destFile} (${bytes} bytes)`);
}

console.log('Vendor sync complete. Commit the vendored files with the dependency bump.');
