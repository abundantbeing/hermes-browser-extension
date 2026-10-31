import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createDOMPurify from '../extension/lib/vendor/purify.es.mjs';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('the shipped sanitizer includes the fixes released in DOMPurify 3.4.17', () => {
  const version = createDOMPurify.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(version.localeCompare('3.4.17', 'en', { numeric: true }) >= 0, `DOMPurify ${version} predates the security fixes`);
});

test('the vendored sanitizer and lockfile match the installed browser runtime', async () => {
  const lock = JSON.parse(await read('package-lock.json'));
  const installed = JSON.parse(await read('node_modules/dompurify/package.json'));
  assert.equal(createDOMPurify.version, lock.packages['node_modules/dompurify'].version);
  assert.equal(createDOMPurify.version, installed.version);
  assert.equal(await read('extension/lib/vendor/purify.es.mjs'), await read('node_modules/dompurify/dist/purify.es.mjs'));
});
