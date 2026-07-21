import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readHermesSse } from '../extension/lib/fulltab-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const encode = (text) => new TextEncoder().encode(text);

test('Hermes Web stops reading as soon as run.completed arrives even if the HTTP stream stays open', async () => {
  let cancelled = false;
  const body = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(encode('event: assistant.completed\ndata: {"content":"finished"}\n\n'));
      controller.enqueue(encode('event: run.completed\ndata: {"runtime":{"model":"gpt-5.6-luna"}}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = { body };
  const outcome = await Promise.race([
    readHermesSse(response, {}),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  assert.equal(outcome, 'finished');
  assert.equal(cancelled, true);
});

test('the side panel treats run.completed as the terminal SSE boundary', () => {
  const source = read('extension/sidepanel.js');
  const readSseResponse = source.match(/async function readSseResponse\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(readSseResponse, /event\.type === 'run\.completed'[\s\S]*return true/);
  assert.match(readSseResponse, /if \(terminal\)[\s\S]*reader\.cancel/);
});
