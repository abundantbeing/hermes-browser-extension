// Writes the generated capability tables into guides/firefox.md, or checks that they are current.
//   node scripts/sync-capability-docs.mjs          rewrite the block
//   node scripts/sync-capability-docs.mjs --check  exit 1 when the guide is out of date
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CAPABILITY_DOCS_END,
  CAPABILITY_DOCS_START,
  capabilityDocsBlock,
} from '../extension/lib/browser-capability-matrix.mjs';

const root = path.resolve(import.meta.dirname, '..');
const guidePath = path.join(root, 'guides', 'firefox.md');

export function withCapabilityBlock(source) {
  const start = source.indexOf(CAPABILITY_DOCS_START);
  const end = source.indexOf(CAPABILITY_DOCS_END);
  if (start < 0 || end < start) throw new Error('guides/firefox.md has no capability-matrix block to fill.');
  return `${source.slice(0, start)}${capabilityDocsBlock()}${source.slice(end + CAPABILITY_DOCS_END.length)}`;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const current = fs.readFileSync(guidePath, 'utf8');
  const next = withCapabilityBlock(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('guides/firefox.md is out of date: run npm run sync:capabilities');
      process.exit(1);
    }
    console.log('guides/firefox.md matches the capability matrix');
  } else {
    fs.writeFileSync(guidePath, next);
    console.log('guides/firefox.md updated');
  }
}
