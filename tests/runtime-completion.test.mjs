import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the side panel treats run.completed as the terminal SSE boundary and rejects started EOF', () => {
  const source = read('extension/sidepanel.js');
  const readSseResponse = source.match(/async function readSseResponse\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(readSseResponse, /\['run\.completed', 'run\.failed', 'run\.cancelled'\]\.includes\(event\.type\)[\s\S]*return true/);
  assert.match(readSseResponse, /if \(terminal\)[\s\S]*reader\.cancel/);
  assert.match(readSseResponse, /sawRunStarted/);
  assert.match(readSseResponse, /closed before terminal run state/i);
});
