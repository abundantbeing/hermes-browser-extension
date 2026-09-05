import assert from 'node:assert/strict';
import test from 'node:test';

import { readHermesSse } from '../extension/lib/fulltab-runtime.mjs';

test('readHermesSse forwards native user-input requests without swallowing terminal state', async () => {
  const frames = [
    'event: run.started\ndata: {"run_id":"run-1"}\n\n',
    'event: user_input.request\ndata: {"request_id":"request-1","session_id":"session-1","questions":[{"id":"choice","text":"Pick one"}]}\n\n',
    'event: assistant.completed\ndata: {"content":"Working while you decide"}\n\n',
    'event: run.completed\ndata: {"content":"Working while you decide","completed":true}\n\n',
  ];
  const bytes = new TextEncoder().encode(frames.join(''));
  let consumed = false;
  const response = {
    body: {
      getReader() {
        return {
          async read() {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        };
      },
    },
  };
  const requests = [];
  let runtime;

  const result = await readHermesSse(response, {
    onUserInput: (payload) => requests.push(payload),
    onRuntime: (payload) => { runtime = payload; },
  });

  assert.equal(result, 'Working while you decide');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request_id, 'request-1');
  assert.equal(runtime.status, 'completed');
});
