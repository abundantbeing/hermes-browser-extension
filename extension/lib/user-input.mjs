function stringValue(value) {
  return typeof value === 'string' ? value : '';
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

export function createUserInputController({ container, getActiveSessionId, sendAnswer, onError } = {}) {
  const requests = new Map();
  let activeSessionId = '';

  const visibleRequests = () => [...requests.values()].filter((request) => request.sessionId === activeSessionId && request.status === 'pending');

  function render() {
    if (!container) return;
    container.replaceChildren();
    const visible = visibleRequests();
    container.hidden = visible.length === 0;
    for (const request of visible) {
      const article = document.createElement('article');
      article.className = 'user-input-card';
      article.dataset.requestId = request.requestId;
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
      for (const question of request.questions) {
        const fieldset = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = question.text;
        fieldset.appendChild(legend);
        const initial = defaultAnswer(question);
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
      });
      form.addEventListener('change', updateSubmitState);
      updateSubmitState();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const { answers, missing } = collectAnswers();
        if (missing) {
          status.textContent = `Answer required: ${missing}`;
          return;
        }
        submit.disabled = true;
        status.textContent = 'Sending…';
        try {
          await sendAnswer(request, answers);
          requests.delete(request.requestId);
          render();
        } catch (error) {
          updateSubmitState();
          status.textContent = error?.message || 'Could not send Hermes input.';
          onError?.(error, request);
        }
      });
      article.appendChild(form);
      container.appendChild(article);
    }
  }

  return {
    clear(requestId) {
      requests.delete(String(requestId || '').trim());
      render();
    },
    replace(sessionId, rows) {
      const key = String(sessionId || '').trim();
      for (const [requestId, request] of requests) {
        if (request.sessionId === key) requests.delete(requestId);
      }
      for (const request of pendingUserInputRecords({ data: rows }, key)) requests.set(request.requestId, request);
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
      requests.set(request.requestId, request);
      render();
      return request;
    },
  };
}
