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

test('Hermes Web rejects EOF after run.started without a terminal lifecycle event', async () => {
  const body = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(encode('event: run.started\ndata: {"run_id":"run-disconnected"}\n\n'));
      controller.enqueue(encode('event: assistant.delta\ndata: {"delta":"partial"}\n\n'));
      controller.close();
    },
  });
  await assert.rejects(() => readHermesSse({ body }, {}), /closed before terminal run state/i);
});

test('the side panel treats run.completed as the terminal SSE boundary and rejects started EOF', () => {
  const source = read('extension/sidepanel.js');
  const readSseResponse = source.match(/async function readSseResponse\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(readSseResponse, /\['run\.completed', 'run\.failed', 'run\.cancelled'\]\.includes\(event\.type\)[\s\S]*return true/);
  assert.match(readSseResponse, /if \(terminal\)[\s\S]*reader\.cancel/);
  assert.match(readSseResponse, /sawRunStarted/);
  assert.match(readSseResponse, /closed before terminal run state/i);
});
