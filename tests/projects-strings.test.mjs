import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import english from '../extension/lib/locales/en.mjs';

test('every projects string the modules and the drawer ask for exists in English', () => {
  const sources = [
    'extension/lib/projects-view.mjs',
    'extension/lib/projects-controller.mjs',
    'extension/lib/projects-panel.mjs',
    'extension/sidepanel.js',
    'extension/sidepanel.html',
  ];
  const keys = new Set();
  for (const file of sources) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/['"`](projects\.(?:[a-z_]+\.)*[a-z_]+)['"`]/g)) keys.add(match[1]);
  }
  const methodNames = new Set(['projects.list', 'projects.tree', 'projects.project_sessions', 'projects.create', 'projects.for_cwd']);
  const missing = [...keys].filter((key) => !methodNames.has(key) && !Object.hasOwn(english, key));
  assert.deepEqual(missing, []);
  const unused = Object.keys(english).filter((key) => key.startsWith('projects.')).filter((key) => !keys.has(key));
  assert.deepEqual(unused, [], 'no orphaned projects strings');
});
