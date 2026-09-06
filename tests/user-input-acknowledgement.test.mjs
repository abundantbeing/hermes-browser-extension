import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  classifyUserInputResult,
  createUserInputController,
} from '../extension/lib/user-input.mjs';

function fields(result) {
  return {
    accepted: result.accepted,
    automaticResume: result.automaticResume,
    clear: result.clear,
    delivery: result.delivery,
    kind: result.kind,
    recorded: result.recorded,
    retryable: result.retryable,
    status: result.status,
    terminal: result.terminal,
  };
}

test('classifies an accepted answered acknowledgement as recorded', () => {
  const result = classifyUserInputResult({ accepted: true, status: 'answered' });

  assert.deepEqual(fields(result), {
    accepted: true,
    automaticResume: false,
    clear: true,
    delivery: '',
    kind: 'accepted',
    recorded: true,
    retryable: false,
    status: 'answered',
    terminal: false,
  });
});

test('classifies already answered as a terminal stale-request reconciliation', () => {
  const result = classifyUserInputResult({ accepted: false, status: 'answered' });

  assert.deepEqual(fields(result), {
    accepted: false,
    automaticResume: false,
    clear: true,
    delivery: '',
    kind: 'terminal',
    recorded: false,
    retryable: false,
    status: 'answered',
    terminal: true,
  });
});

test('classifies expired and cancelled answers as terminal without an error path', () => {
  for (const status of ['expired', 'cancelled']) {
    const result = classifyUserInputResult({ accepted: false, status });
    assert.deepEqual(fields(result), {
      accepted: false,
      automaticResume: false,
      clear: true,
      delivery: '',
      kind: 'terminal',
      recorded: false,
      retryable: false,
      status,
      terminal: true,
    });
  }
});

test('classifies invalid answers as retryable and preserves the request', () => {
  const result = classifyUserInputResult({
    accepted: false,
    status: 'invalid',
    error: { message: 'Choose an answer.' },
  });

  assert.deepEqual(fields(result), {
    accepted: false,
    automaticResume: false,
    clear: false,
    delivery: '',
    kind: 'invalid',
    recorded: false,
    retryable: true,
    status: 'invalid',
    terminal: false,
  });
  assert.equal(result.message, 'Choose an answer.');
});

test('normalizes multiline acknowledgement details before displaying them', () => {
  const result = classifyUserInputResult({
    accepted: false,
    status: 'invalid',
    error: { message: 'First line\nSecond\tline' },
  });

  assert.equal(result.message, 'First line Second line');
});

test('clears only an explicit not-found acknowledgement', () => {
  const explicit = classifyUserInputResult({ accepted: false, status: 'not_found' });
  assert.deepEqual(fields(explicit), {
    accepted: false,
    automaticResume: false,
    clear: true,
    delivery: '',
    kind: 'not_found',
    recorded: false,
    retryable: false,
    status: 'not_found',
    terminal: true,
  });

  const generic404 = classifyUserInputResult(
    { error: { message: 'The request could not be loaded.' } },
    { httpStatus: 404 },
  );
  assert.equal(generic404.clear, false);
  assert.equal(generic404.retryable, true);
});

test('preserves deferred delivery and never presents it as automatic resume', () => {
  const result = classifyUserInputResult({
    accepted: true,
    status: 'answered',
    delivery: 'deferred',
  });

  assert.deepEqual(fields(result), {
    accepted: true,
    automaticResume: false,
    clear: true,
    delivery: 'deferred',
    kind: 'accepted',
    recorded: true,
    retryable: false,
    status: 'answered',
    terminal: false,
  });
});

test('does not treat an HTTP 200 or unknown delivery as a successful acknowledgement', () => {
  const missingStatus = classifyUserInputResult({ accepted: true }, { httpStatus: 200 });
  assert.equal(missingStatus.kind, 'malformed');
  assert.equal(missingStatus.clear, false);
  assert.equal(missingStatus.retryable, true);

  const unknownDelivery = classifyUserInputResult({
    accepted: true,
    status: 'answered',
    delivery: 'resumed',
  });
  assert.equal(unknownDelivery.kind, 'malformed');
  assert.equal(unknownDelivery.clear, false);
});

test('clears an explicit not-found WebSocket RPC error without clearing generic transport failures', () => {
  const rpcError = Object.assign(new Error('Request is gone.'), { code: 'not_found', status: 404 });
  const gone = classifyUserInputResult(rpcError);

  assert.equal(gone.clear, true);
  assert.equal(gone.kind, 'not_found');
  assert.equal(gone.retryable, false);

  const networkError = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  const retry = classifyUserInputResult(networkError);
  assert.equal(retry.clear, false);
  assert.equal(retry.retryable, true);
});

test('classifies a thrown network failure as retryable without clearing the draft', () => {
  const networkError = new TypeError('fetch failed');
  const result = classifyUserInputResult(networkError);

  assert.deepEqual(fields(result), {
    accepted: false,
    automaticResume: false,
    clear: false,
    delivery: '',
    kind: 'transport',
    recorded: false,
    retryable: true,
    status: 'transport',
    terminal: false,
  });
  assert.equal(result.error, networkError);
});

function request() {
  return {
    request_id: 'request-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    questions: [{ id: 'answer', text: 'Answer', options: ['yes'], default: 'yes' }],
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('locks a request across an awaited submit so duplicate events send once', async () => {
  const { document, Event } = parseHTML('<!doctype html><html><body><section id="requests"></section></body></html>');
  const previousDocument = globalThis.document;
  globalThis.document = document;
  let resolveSend;
  let calls = 0;
  const send = new Promise((resolve) => { resolveSend = resolve; });
  try {
    const container = document.getElementById('requests');
    const controller = createUserInputController({
      container,
      sendAnswer: () => {
        calls += 1;
        return send;
      },
    });
    controller.setActiveSession('session-1');
    controller.upsert(request());

    const form = container.querySelector('form');
    const submit = container.querySelector('button[type="submit"]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    assert.equal(calls, 1);
    assert.equal(submit.disabled, true);

    resolveSend({ accepted: true, status: 'answered' });
    await flush();
    assert.equal(container.hidden, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('keeps the draft after invalid acknowledgement and permits a retry', async () => {
  const { document, Event } = parseHTML('<!doctype html><html><body><section id="requests"></section></body></html>');
  const previousDocument = globalThis.document;
  globalThis.document = document;
  let calls = 0;
  try {
    const container = document.getElementById('requests');
    const controller = createUserInputController({
      container,
      sendAnswer: async () => {
        calls += 1;
        return calls === 1
          ? { accepted: false, status: 'invalid', error: { message: 'Try again.' } }
          : { accepted: true, status: 'answered' };
      },
    });
    controller.setActiveSession('session-1');
    controller.upsert(request());

    const form = container.querySelector('form');
    const firstSubmit = container.querySelector('button[type="submit"]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    assert.equal(calls, 1);
    assert.equal(container.hidden, false);
    assert.equal(container.querySelector('input[type="radio"]').checked, true);
    assert.equal(firstSubmit.disabled, false);
    assert.match(container.querySelector('.user-input-card-status').textContent, /Try again/);

    container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(calls, 2);
    assert.equal(container.hidden, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
