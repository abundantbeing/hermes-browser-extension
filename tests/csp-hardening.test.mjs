import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const manifests = {
  'extension/manifest.json': JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')),
  'manifest.json': JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')),
};

test('extension pages cannot embed plugins, rebase URLs or submit forms away, and frame only the local gateway', () => {
  for (const [name, manifest] of Object.entries(manifests)) {
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'(;|$)/, name);
    assert.match(csp, /object-src 'none'/, name);
    assert.match(csp, /base-uri 'none'/, name);
    assert.match(csp, /form-action 'none'/, name);
    // The approval page of a local gateway is shown in the panel; nothing else is.
    assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/, name);
    const frameSources = csp.match(/frame-src ([^;]*);/)[1].split(' ');
    assert.deepEqual(frameSources, ['http://127.0.0.1:*', 'http://localhost:*'], `${name}: frames are limited to a local gateway`);
    // User-configured gateways still need to be reachable.
    assert.match(csp, /connect-src http: https:/, name);
  }
});

test('the extension pages really do not use frames or plugin elements', () => {
  for (const page of ['sidepanel.html']) {
    const html = readFileSync(new URL(`../extension/${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<(?:iframe|object|embed)\b/i, page);
  }
});
