import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createUserInputController } from '../extension/lib/user-input.mjs';

function request(sessionId, requestId, options = ['a', 'b'], allowFreeText = false) {
  return {
    context: '',
    request_id: requestId,
    session_id: sessionId,
    questions: [{
      allow_free_text: allowFreeText,
      id: 'choice',
      options,
      text: 'Pick one',
    }],
  };
}

function setup() {
  const { document } = parseHTML('<body><div id="requests"></div></body>');
  globalThis.document = document;
  const container = document.querySelector('#requests');
  let activeSessionId = 'session-1';
  const controller = createUserInputController({
    container,
    getActiveSessionId: () => activeSessionId,
    sendAnswer: async () => ({ accepted: true, status: 'answered' }),
  });
  controller.setActiveSession('session-1');
  return {
    container,
    controller,
    setActiveSession(sessionId) {
      activeSessionId = sessionId;
      controller.setActiveSession(sessionId);
    },
  };
}

function inputFor(container, requestId, kind = 'text') {
  return container.querySelector(`[data-request-id="${requestId}"] input.${kind === 'text' ? 'user-input-free-text' : 'user-input-option'}`)
    || container.querySelector(`[data-request-id="${requestId}"] input[type="${kind === 'text' ? 'text' : 'radio'}"]`);
}

function dispatch(document, target, type) {
  target.dispatchEvent(new document.defaultView.Event(type, { bubbles: true }));
}

test('clears a terminal request only in the event owning session', () => {
  const { container, controller, setActiveSession } = setup();
  controller.upsert(request('session-1', 'request-a', [], true));
  controller.upsert(request('session-2', 'request-a', [], true));

  controller.clear('request-a', 'session-2');

  setActiveSession('session-1');
  assert.equal(container.querySelector('[data-request-id="request-a"]') !== null, true);
  setActiveSession('session-2');
  assert.equal(container.hidden, true);
});

test('preserves a typed draft when another pending request is upserted and replayed', () => {
  const { container, controller } = setup();
  controller.upsert(request('session-1', 'request-a', [], true));
  const first = inputFor(container, 'request-a');
  first.value = 'keep this draft';
  dispatch(document, first, 'input');

  controller.upsert(request('session-1', 'request-b', [], true));
  controller.replace('session-1', [request('session-1', 'request-a', [], true), request('session-1', 'request-b', [], true)]);

  assert.equal(inputFor(container, 'request-a').value, 'keep this draft');
});

test('keeps drafts isolated when switching sessions and returning', () => {
  const { container, controller, setActiveSession } = setup();
  controller.upsert(request('session-1', 'request-a', [], true));
  const first = inputFor(container, 'request-a');
  first.value = 'session one';
  dispatch(document, first, 'input');

  setActiveSession('session-2');
  controller.upsert(request('session-2', 'request-a', [], true));
  const second = inputFor(container, 'request-a');
  second.value = 'session two';
  dispatch(document, second, 'input');

  setActiveSession('session-1');
  assert.equal(inputFor(container, 'request-a').value, 'session one');
  setActiveSession('session-2');
  assert.equal(inputFor(container, 'request-a').value, 'session two');
});

test('drops a closed-option draft when the same request id receives a new schema', () => {
  const { container, controller } = setup();
  controller.upsert(request('session-1', 'request-a', ['a', 'b']));
  const radio = container.querySelectorAll('[data-request-id="request-a"] input[type="radio"]')[1];
  radio.checked = true;
  dispatch(document, radio, 'change');

  controller.upsert(request('session-1', 'request-a', ['a', 'c']));

  assert.equal(inputFor(container, 'request-a', 'radio').checked, false);
});

test('preserves radio-to-free-text transitions and clears only the terminal request', () => {
  const { container, controller } = setup();
  controller.upsert(request('session-1', 'request-a', ['a'], true));
  controller.upsert(request('session-1', 'request-b', [], true));
  const radio = inputFor(container, 'request-a', 'radio');
  radio.checked = true;
  dispatch(document, radio, 'change');
  const freeText = inputFor(container, 'request-a');
  freeText.value = 'custom answer';
  dispatch(document, freeText, 'input');

  controller.clear('request-b');
  assert.equal(inputFor(container, 'request-a').value, 'custom answer');
  assert.equal(inputFor(container, 'request-a', 'radio').checked, false);
});
