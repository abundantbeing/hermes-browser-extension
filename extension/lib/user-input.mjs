function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

const USER_INPUT_RESULT_MARKER = Symbol('hermesUserInputResult');
const USER_INPUT_DELIVERIES = new Set(['steered', 'redirected', 'queued', 'deferred']);
const USER_INPUT_TERMINAL_STATUSES = new Set(['answered', 'expired', 'cancelled']);
const USER_INPUT_NOT_FOUND_CODES = new Set([
  'not_found',
  'request_not_found',
  'user_input_not_found',
  'user_input_request_not_found',
]);

function resultText(value) {
  const detail = value?.error?.message
    || value?.error
    || value?.detail
    || value?.message
    || '';
  return String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function resultStatus(value) {
  return stringValue(
    value?.status
    || value?.data?.status
    || value?.state
    || value?.error?.code
    || '',
  ).trim().toLowerCase().replace(/-/g, '_');
}

function resultCode(value) {
  return stringValue(
    value?.code
    || value?.error_code
    || value?.errorCode
    || value?.error?.code
    || '',
  ).trim().toLowerCase().replace(/-/g, '_');
}

function classifiedUserInputResult(fields) {
  const result = {
    accepted: fields.accepted === true,
    automaticResume: false,
    clear: fields.clear === true,
    delivery: fields.delivery || '',
    kind: fields.kind,
    recorded: fields.recorded === true,
    retryable: fields.retryable === true,
    status: fields.status,
    terminal: fields.terminal === true,
  };
  if (fields.message) result.message = fields.message;
  if (fields.error) result.error = fields.error;
  Object.defineProperty(result, USER_INPUT_RESULT_MARKER, { value: true });
  return result;
}

function isClassifiedUserInputResult(value) {
  return Boolean(value && typeof value === 'object' && value[USER_INPUT_RESULT_MARKER] === true);
}

/**
 * Normalize REST and WebSocket user-input acknowledgements into one UI result.
 * A result is only successful when the server explicitly supplies the accepted
 * boolean and a known status. HTTP status alone never authorizes clearing UI.
 */
export function classifyUserInputResult(value, { httpStatus = 0, error = null } = {}) {
  if (isClassifiedUserInputResult(value)) return value;

  const thrown = error || (value instanceof Error ? value : null);
  if (thrown) {
    const thrownStatus = resultStatus(thrown);
    const thrownCode = resultCode(thrown);
    if (thrownStatus === 'not_found' || USER_INPUT_NOT_FOUND_CODES.has(thrownCode)) {
      return classifiedUserInputResult({
        accepted: false,
        clear: true,
        kind: 'not_found',
        message: resultText(thrown),
        terminal: true,
        status: 'not_found',
      });
    }
    if (thrownStatus === 'invalid' || thrownCode === 'invalid') {
      return classifiedUserInputResult({
        accepted: false,
        kind: 'invalid',
        message: resultText(thrown) || 'Hermes rejected these answers. Check the fields and try again.',
        retryable: true,
        status: 'invalid',
      });
    }
    return classifiedUserInputResult({
      accepted: false,
      error: thrown,
      kind: 'transport',
      message: resultText(thrown) || 'Could not reach Hermes.',
      retryable: true,
      status: 'transport',
    });
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return classifiedUserInputResult({
      accepted: false,
      kind: 'malformed',
      message: 'Hermes returned an invalid user-input acknowledgement.',
      retryable: true,
      status: 'malformed',
    });
  }

  const status = resultStatus(value);
  const code = resultCode(value);
  const explicitNotFound = status === 'not_found' || USER_INPUT_NOT_FOUND_CODES.has(code);
  const message = resultText(value);
  const delivery = stringValue(value.delivery).trim().toLowerCase().replace(/-/g, '_');
  const deliveryKnown = !delivery || USER_INPUT_DELIVERIES.has(delivery);
  const accepted = value.accepted === true;
  const rejected = value.accepted === false;

  if (explicitNotFound && (rejected || status === 'not_found' || USER_INPUT_NOT_FOUND_CODES.has(code))) {
    return classifiedUserInputResult({
      accepted: false,
      clear: true,
      kind: 'not_found',
      message,
      terminal: true,
      status: 'not_found',
    });
  }

  if (status === 'invalid' || code === 'invalid') {
    return classifiedUserInputResult({
      accepted: false,
      kind: 'invalid',
      message: message || 'Hermes rejected these answers. Check the fields and try again.',
      retryable: true,
      status: 'invalid',
    });
  }

  const terminalStatus = status === 'already_answered' ? 'answered' : status;
  if (rejected && USER_INPUT_TERMINAL_STATUSES.has(terminalStatus)) {
    return classifiedUserInputResult({
      accepted: false,
      clear: true,
      kind: 'terminal',
      terminal: true,
      status: terminalStatus,
    });
  }

  if (accepted && terminalStatus === 'answered' && deliveryKnown) {
    return classifiedUserInputResult({
      accepted: true,
      clear: true,
      delivery,
      kind: 'accepted',
      recorded: true,
      status: 'answered',
    });
  }

  const statusCode = Number(httpStatus);
  const httpFailure = Number.isInteger(statusCode) && statusCode >= 400;
  return classifiedUserInputResult({
    accepted: false,
    kind: httpFailure ? 'transport' : 'malformed',
    message: message || (httpFailure ? `Hermes input answer failed (${statusCode}).` : 'Hermes returned an unrecognized user-input acknowledgement.'),
    retryable: true,
    status: httpFailure ? 'transport' : 'malformed',
  });
}

function userInputResultError(result) {
  if (result?.error instanceof Error) return result.error;
  return new Error(result?.message || 'Hermes did not accept these answers.');
}

export function normalizeUserInputRequest(value = {}, sessionIdOverride = '') {
  if (!value || typeof value !== 'object') return null;
  const requestId = stringValue(value.request_id || value.requestId).trim();
  const sessionId = stringValue(sessionIdOverride || value.session_id || value.sessionId).trim();
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
  const questions = rawQuestions.map((question) => {
    if (!question || typeof question !== 'object') return null;
    const id = stringValue(question.id).trim();
    const text = stringValue(question.text || question.question).trim();
    if (!id || !text) return null;
    const options = Array.isArray(question.options)
      ? question.options.filter((option) => typeof option === 'string').map((option) => option.trim()).filter(Boolean)
      : [];
    return {
      allowFreeText: question.allow_free_text === true || question.allowFreeText === true,
      defaultValue: question.default ?? question.defaultValue,
      id,
      options,
      text,
    };
  }).filter(Boolean);
  if (!requestId || !sessionId || !questions.length) return null;
  const status = stringValue(value.status).trim().toLowerCase();
  return {
    context: stringValue(value.context),
    expiresAt: Number.isFinite(value.expires_at) ? value.expires_at : Number.isFinite(value.expiresAt) ? value.expiresAt : 0,
    questions,
    requestId,
    sessionId,
    status: ['answered', 'expired'].includes(status) ? status : 'pending',
    turnId: stringValue(value.turn_id || value.turnId),
  };
}

export function pendingUserInputRecords(payload = {}, sessionId = '') {
  const rows = Array.isArray(payload?.requests)
    ? payload.requests
    : Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => normalizeUserInputRequest(row, sessionId))
    .filter((row) => row && row.status === 'pending');
}

export function userInputAnswerPayload(request, answers = {}) {
  const normalized = normalizeUserInputRequest(request, request?.sessionId);
  if (!normalized || !answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('A valid Hermes user-input request and answer object are required.');
  }
  const cleanAnswers = {};
  for (const question of normalized.questions) {
    const value = answers[question.id];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Answer required: ${question.text}`);
    }
    const clean = String(value).trim();
    if (!clean) throw new Error(`Answer required: ${question.text}`);
    cleanAnswers[question.id] = clean;
  }
  return {
    answers: cleanAnswers,
    request_id: normalized.requestId,
    session_id: normalized.sessionId,
    ...(normalized.turnId ? { turn_id: normalized.turnId } : {}),
  };
}

function defaultAnswer(question) {
  const value = question.defaultValue;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function appendLabelText(label, text) {
  const span = document.createElement('span');
  span.textContent = text;
  label.appendChild(span);
}

export function createUserInputController({ container, getActiveSessionId, sendAnswer, onError, onResult } = {}) {
  const requests = new Map();
  const drafts = new Map();
  const submissionLocks = new Set();
  let activeSessionId = '';
  let focusState = null;

  const requestKey = (sessionId, requestId) => `${sessionId}:${requestId}`;
  const keyForRequest = (request) => requestKey(request.sessionId, request.requestId);
  const visibleRequests = () => [...requests.values()].filter((request) => request.sessionId === activeSessionId && request.status === 'pending');

  function draftFor(request) {
    const key = keyForRequest(request);
    const current = { ...(drafts.get(key) || {}) };
    for (const question of request.questions) {
      const value = current[question.id];
      if (value !== undefined && (!question.options.length || question.allowFreeText || question.options.includes(value))) continue;
      delete current[question.id];
      const initial = defaultAnswer(question);
      if (initial && (!question.options.length || question.allowFreeText || question.options.includes(initial))) {
        current[question.id] = initial;
      }
    }
    drafts.set(key, current);
    return current;
  }

  function collectDraft(request, form) {
    const answers = {};
    for (const question of request.questions) {
      const selected = [...form.querySelectorAll('input[type="radio"]')]
        .find(input => input.name === `user-input-${request.requestId}-${question.id}` && input.checked);
      const freeText = [...form.querySelectorAll('input.user-input-free-text')]
        .find(input => input.name === `user-input-${request.requestId}-${question.id}-free`);
      const value = selected?.value || freeText?.value || '';
      if (value) answers[question.id] = value;
    }
    drafts.set(keyForRequest(request), answers);
  }

  function captureDrafts() {
    if (!container) return;
    for (const article of container.querySelectorAll('article[data-request-id][data-session-id]')) {
      const request = requests.get(requestKey(article.dataset.sessionId, article.dataset.requestId));
      const form = article.querySelector('form');
      if (request && form) collectDraft(request, form);
    }
    const active = document.activeElement;
    const article = active?.closest?.('article[data-request-id][data-session-id]');
    if (active && article && container.contains(active)) {
      focusState = {
        fieldName: active.name || '',
        requestKey: requestKey(article.dataset.sessionId, article.dataset.requestId),
        selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
        selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      };
    }
  }

  function restoreFocus() {
    if (!focusState || !container) return;
    const article = [...container.querySelectorAll('article[data-request-id][data-session-id]')]
      .find(candidate => requestKey(candidate.dataset.sessionId, candidate.dataset.requestId) === focusState.requestKey);
    const input = article && [...article.querySelectorAll('input')].find(candidate => candidate.name === focusState.fieldName);
    if (!input) return;
    input.focus();
    if (typeof focusState.selectionStart === 'number' && typeof focusState.selectionEnd === 'number' && typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    }
  }

  function render() {
    if (!container) return;
    captureDrafts();
    container.replaceChildren();
    const visible = visibleRequests();
    container.hidden = visible.length === 0;
    for (const request of visible) {
      const article = document.createElement('article');
      article.className = 'user-input-card';
      article.dataset.requestId = request.requestId;
      article.dataset.sessionId = request.sessionId;
      article.setAttribute('aria-labelledby', `user-input-title-${request.requestId}`);

      const header = document.createElement('header');
      header.className = 'user-input-card-header';
      const heading = document.createElement('h2');
      heading.id = `user-input-title-${request.requestId}`;
      heading.textContent = 'Hermes needs your input';
      header.appendChild(heading);
      if (visible.length > 1) {
        const count = document.createElement('span');
        count.className = 'user-input-card-count';
        count.textContent = `${visible.length} pending`;
        header.appendChild(count);
      }
      article.appendChild(header);

      if (request.context) {
        const context = document.createElement('p');
        context.className = 'user-input-card-context';
        context.textContent = request.context;
        article.appendChild(context);
      }

      const form = document.createElement('form');
      form.className = 'user-input-card-form';
      const draft = draftFor(request);
      for (const question of request.questions) {
        const fieldset = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = question.text;
        fieldset.appendChild(legend);
        const initial = draft[question.id] ?? defaultAnswer(question);
        if (question.options.length) {
          const options = document.createElement('div');
          options.className = 'user-input-options';
          options.setAttribute('role', 'radiogroup');
          options.setAttribute('aria-label', question.text);
          for (const option of question.options) {
            const label = document.createElement('label');
            label.className = 'user-input-option';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `user-input-${request.requestId}-${question.id}`;
            input.value = option;
            input.checked = initial === option;
            appendLabelText(label, option);
            label.prepend(input);
            options.appendChild(label);
          }
          fieldset.appendChild(options);
        }
        if (question.allowFreeText || !question.options.length) {
          const input = document.createElement('input');
          input.className = 'user-input-free-text';
          input.name = `user-input-${request.requestId}-${question.id}-free`;
          input.type = 'text';
          input.value = question.options.includes(initial) ? '' : initial;
          input.placeholder = question.options.length ? 'Or enter another answer' : 'Your answer';
          input.autocomplete = 'off';
          fieldset.appendChild(input);
        }
        form.appendChild(fieldset);
      }

      const actions = document.createElement('div');
      actions.className = 'user-input-card-actions';
      const status = document.createElement('span');
      status.className = 'user-input-card-status';
      status.setAttribute('role', 'status');
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'Submit answers';
      actions.append(status, submit);
      form.appendChild(actions);

      const collectAnswers = () => {
        const answers = {};
        let missing = '';
        for (const question of request.questions) {
          const selected = [...form.querySelectorAll('input[type="radio"]')]
            .find(input => input.name === `user-input-${request.requestId}-${question.id}` && input.checked);
          const freeText = [...form.querySelectorAll('input.user-input-free-text')]
            .find(input => input.name === `user-input-${request.requestId}-${question.id}-free`);
          const value = selected?.value || freeText?.value || '';
          if (!value.trim()) {
            missing = question.text;
            break;
          }
          answers[question.id] = value.trim();
        }
        return { answers, missing };
      };
      const updateSubmitState = () => {
        submit.disabled = Boolean(collectAnswers().missing);
      };
      form.addEventListener('input', (event) => {
        const input = event.target;
        if (input.matches('input.user-input-free-text') && input.value) {
          const prefix = input.name.replace(/-free$/, '');
          for (const radio of form.querySelectorAll('input[type="radio"]')) {
            if (radio.name === prefix) radio.checked = false;
          }
        }
        updateSubmitState();
        collectDraft(request, form);
      });
      form.addEventListener('change', () => {
        collectDraft(request, form);
        updateSubmitState();
      });
      updateSubmitState();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const { answers, missing } = collectAnswers();
        if (missing) {
          status.textContent = `Answer required: ${missing}`;
          return;
        }
        const requestKeyValue = keyForRequest(request);
        if (submissionLocks.has(requestKeyValue)) return;
        submissionLocks.add(requestKeyValue);
        submit.disabled = true;
        status.textContent = 'Sending…';
        try {
          const result = classifyUserInputResult(await sendAnswer(request, answers));
          try { onResult?.(result, request); } catch (callbackError) { void callbackError; }
          if (result.clear) {
            requests.delete(requestKeyValue);
            drafts.delete(requestKeyValue);
            if (focusState?.requestKey === requestKeyValue) focusState = null;
            render();
            return;
          }
          updateSubmitState();
          status.textContent = result.message || 'Could not send Hermes input.';
          onError?.(userInputResultError(result), request);
        } catch (error) {
          const result = classifyUserInputResult(error);
          try { onResult?.(result, request); } catch (callbackError) { void callbackError; }
          if (result.clear) {
            requests.delete(requestKeyValue);
            drafts.delete(requestKeyValue);
            if (focusState?.requestKey === requestKeyValue) focusState = null;
            render();
            return;
          }
          updateSubmitState();
          status.textContent = result.message || error?.message || 'Could not send Hermes input.';
          onError?.(error, request);
        } finally {
          submissionLocks.delete(requestKeyValue);
        }
      });
      article.appendChild(form);
      container.appendChild(article);
    }
    restoreFocus();
  }

  return {
    clear(requestId, sessionIdOverride = '') {
      const id = String(requestId || '').trim();
      const sessionKey = String(sessionIdOverride || activeSessionId || '').trim();
      captureDrafts();
      for (const [key, request] of requests) {
        if (request.sessionId === sessionKey && request.requestId === id) {
          requests.delete(key);
          drafts.delete(key);
          if (focusState?.requestKey === key) focusState = null;
        }
      }
      render();
    },
    replace(sessionId, rows) {
      const key = String(sessionId || '').trim();
      captureDrafts();
      for (const [requestKeyValue, request] of requests) {
        if (request.sessionId === key) requests.delete(requestKeyValue);
      }
      for (const request of pendingUserInputRecords({ data: rows }, key)) requests.set(keyForRequest(request), request);
      render();
    },
    setActiveSession(sessionId) {
      activeSessionId = String(sessionId || '').trim();
      if (typeof getActiveSessionId === 'function') activeSessionId = String(getActiveSessionId() || activeSessionId).trim();
      render();
    },
    upsert(value, sessionIdOverride = '') {
      const request = normalizeUserInputRequest(value, sessionIdOverride);
      if (!request || request.status !== 'pending') return null;
      requests.set(keyForRequest(request), request);
      render();
      return request;
    },
  };
}
