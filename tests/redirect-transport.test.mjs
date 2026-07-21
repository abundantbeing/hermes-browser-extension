import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = (name) => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');

test('extension gateway, dashboard, and resource fetch boundaries reject redirects', () => {
  for (const name of [
    'sidepanel.js',
    'voice-dictation.js',
    'background.js',
    'content.js',
    'lib/agent-discovery.mjs',
    'lib/model-discovery.mjs',
  ]) {
    assert.match(source(name), /redirect:\s*'error'/, `${name} must reject redirects at its fetch boundary`);
  }
});