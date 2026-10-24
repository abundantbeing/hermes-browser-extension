// DOM renderer for the Projects tab of the sessions drawer.
//
// Draws the controller's state into one container. It rebuilds the container on
// every change, so it also carries a focused control across the rebuild (by its
// data-fk key) and puts focus on the new view's first control when the view
// itself changes. Styles use the panel's semantic tokens (see sidepanel.css,
// "Projects tab").

import {
  describeProjectsFailure,
  filterProjectRows,
  flattenProjectSessions,
  formatLastActive,
  groupProjectRows,
  shortenPath,
} from './projects-view.mjs';

function h(doc, tag, attrs = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

function hostOf(endpoint = '') {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

// What the last render of each container drew, so an unchanged state (the
// drawer repaints on every live-roster tick) does not rebuild the DOM.
const lastDrawn = new WeakMap();

export function renderProjectsPanel({ container, controller, t, locale = 'en', now = Date.now() } = {}) {
  if (!container || !controller) return;
  // An input method mid-composition would be cancelled by a rebuild; the
  // composition's end repaints.
  if (container.getAttribute('data-composing') === '1') return;
  const doc = container.ownerDocument;
  const state = controller.state;
  const gate = controller.availability();
  const signature = JSON.stringify([state, locale, gate.available, gate.reason || '']);
  if (lastDrawn.get(container) === signature && container.childNodes.length) return;
  lastDrawn.set(container, signature);

  // Remember focus so typing in a field survives the rebuild.
  const active = doc.activeElement;
  const focusKey = active && container.contains(active) ? active.getAttribute('data-fk') : '';
  const selection = focusKey && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd] : null;
  const previousView = container.dataset.view || '';
  const previousStep = container.dataset.step || '';

  const body = [];
  container.dataset.view = state.view;
  const step = state.view === 'move' ? state.move?.step || '' : '';
  container.dataset.step = step;
  container.setAttribute('aria-busy', String(
    state.list.status === 'loading' || state.project?.status === 'loading' || state.move?.step === 'working',
  ));

  // A view whose data is gone (a finished create, a closed move) falls back to the list.
  const view = (state.view === 'create' && !state.create) || (state.view === 'move' && !state.move) || (state.view === 'project' && !state.project)
    ? 'list' : state.view;
  if (view === 'list') body.push(...renderList({ doc, state, controller, t, locale, now }));
  else if (view === 'project') body.push(...renderProject({ doc, state, controller, t, locale, now }));
  else if (view === 'create') body.push(...renderCreate({ doc, state, controller, t }));
  else if (view === 'move') body.push(...renderMove({ doc, state, controller, t }));

  container.replaceChildren(...body.flat().filter(Boolean));

  // A new answer (the live-turn question, the move result) is scrolled into view.
  const stepChanged = previousStep !== step && (step === 'result' || step === 'confirm-live');
  if (stepChanged) container.scrollTop = 0;
  let target = focusKey && !stepChanged ? container.querySelector(`[data-fk="${focusKey}"]`) : null;
  if (!target && (previousView !== state.view || stepChanged)) target = container.querySelector('[data-autofocus]');
  if (target && typeof target.focus === 'function') {
    target.focus({ preventScroll: false });
    if (selection && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(selection[0], selection[1]); } catch { /* not a text control */ }
    }
  }
}

// ---- Shared pieces ---------------------------------------------------------

function scopeLine({ doc, state, t }) {
  if (!state.scope) return null;
  return h(doc, 'div', {
    class: 'projects-scope',
    role: 'note',
    title: state.scope.endpoint,
    'data-testid': 'projects-scope',
  }, t('projects.scope', { profile: state.scope.profile, host: hostOf(state.scope.endpoint) }));
}

function noticeBar({ doc, state, controller, t }) {
  const notice = state.notice;
  if (!notice) return null;
  return h(doc, 'div', {
    class: `projects-notice projects-notice-${notice.tone || 'ok'}`,
    role: notice.tone === 'error' ? 'alert' : 'status',
  },
  h(doc, 'span', { class: 'projects-notice-text', text: t(notice.key, notice.params) }),
  h(doc, 'button', {
    type: 'button',
    class: 'session-action-button',
    'aria-label': t('projects.dismiss'),
    onClick: () => controller.dismissNotice(),
    text: '×',
  }));
}

function messageBlock({ doc, tone = 'info', title = '', text = '', reason = '', t, actions = [], testid = '' }) {
  return h(doc, 'div', {
    class: `projects-state projects-state-${tone}`,
    role: tone === 'error' ? 'alert' : 'status',
    'data-testid': testid || undefined,
    'data-reason': reason || undefined,
  },
  title && h(doc, 'strong', { class: 'projects-state-title', text: title }),
  text && h(doc, 'p', { class: 'projects-state-text', text }),
  reason && h(doc, 'code', { class: 'projects-state-reason', text: t('projects.reason_code', { reason }) }),
  actions.length ? h(doc, 'div', { class: 'projects-state-actions' }, actions) : null);
}

function failureBlock({ doc, failure, t, controller, retry = true }) {
  const text = t(failure.key, failure.params);
  const detail = failure.detail && !text.includes(failure.detail) ? failure.detail : '';
  return messageBlock({
    doc,
    t,
    tone: failure.unavailable ? 'info' : 'error',
    title: failure.unavailable ? t('projects.unavailable.title') : t('projects.error.title'),
    text: detail ? `${text} ${detail}` : text,
    reason: failure.unavailable ? failure.reason : '',
    testid: failure.unavailable ? 'projects-unavailable' : 'projects-error',
    actions: [
      failure.unavailable && h(doc, 'p', { class: 'projects-state-text projects-recents-note', text: t('projects.unavailable.recents_ok') }),
      retry && h(doc, 'button', {
        type: 'button',
        class: 'session-action-button',
        onClick: () => controller.refresh(),
        text: t('projects.retry'),
      }),
    ].filter(Boolean),
  });
}

function loadingBlock({ doc, t, text }) {
  return h(doc, 'div', { class: 'projects-state projects-state-loading', role: 'status' },
    h(doc, 'span', { class: 'projects-spinner', 'aria-hidden': 'true' }),
    h(doc, 'span', { text: text || t('projects.loading') }));
}

function backButton({ doc, t, controller, label, disabled = false }) {
  return h(doc, 'button', {
    type: 'button',
    class: 'projects-back',
    'data-fk': 'back',
    disabled,
    onClick: () => controller.back(),
  }, h(doc, 'span', { 'aria-hidden': 'true', class: 'projects-back-arrow', text: '←' }), h(doc, 'span', { text: label }));
}

function heading({ doc, text, level = 3, fk = '', autofocus = false }) {
  return h(doc, 'div', {
    class: 'projects-heading',
    role: 'heading',
    'aria-level': String(level),
    tabindex: autofocus ? '-1' : undefined,
    'data-fk': fk || undefined,
    'data-autofocus': autofocus || undefined,
    title: text,
    text,
  });
}

// ---- Project list ----------------------------------------------------------

function renderList({ doc, state, controller, t, locale, now }) {
  const out = [scopeLine({ doc, state, t }), noticeBar({ doc, state, controller, t })];
  const { list } = state;
  if (list.status === 'unavailable') {
    out.push(failureBlock({ doc, failure: list.failure, t, controller }));
    if (list.connectError) out.push(h(doc, 'p', { class: 'projects-state-text projects-connect-error', text: list.connectError }));
    return out;
  }
  if (list.status === 'error') {
    out.push(failureBlock({ doc, failure: list.failure, t, controller }));
    return out;
  }
  if (list.status === 'idle' || (list.status === 'loading' && !list.rows.length)) {
    out.push(loadingBlock({ doc, t }));
    return out;
  }
  if (list.notice) {
    out.push(messageBlock({
      doc, t, tone: 'info', text: t(list.notice.key, list.notice.params), testid: 'projects-partial',
    }));
  }
  const rows = filterProjectRows(list.rows, state.query);
  if (!list.rows.length) {
    out.push(messageBlock({
      doc,
      t,
      title: t('projects.empty.title'),
      text: t('projects.empty.text'),
      testid: 'projects-empty',
      actions: [h(doc, 'button', {
        type: 'button', class: 'session-action-button', 'data-autofocus': true, 'data-fk': 'empty-create',
        onClick: () => controller.startCreate(), text: t('projects.new'),
      })],
    }));
    return out;
  }
  if (!rows.length) {
    out.push(messageBlock({ doc, t, text: t('projects.no_match'), testid: 'projects-no-match' }));
    return out;
  }
  const groups = groupProjectRows(rows);
  const section = (titleKey, items) => {
    if (!items.length) return null;
    return h(doc, 'section', { class: 'projects-group', 'aria-label': t(titleKey) },
      h(doc, 'div', { class: 'session-group-title projects-group-title' },
        h(doc, 'span', { text: t(titleKey) }),
        h(doc, 'strong', { text: String(items.length) })),
      items.map((row) => projectRow({ doc, row, controller, t, locale, now, hasCounts: list.hasCounts })));
  };
  out.push(section('projects.group.projects', groups.projects));
  out.push(section('projects.group.detected', groups.auto));
  out.push(section('projects.group.home', groups.home));
  return out;
}

function projectRow({ doc, row, controller, t, locale, now, hasCounts }) {
  const path = shortenPath(row.path);
  const count = hasCounts && row.sessionCount !== null
    ? t('projects.session_count', { count: row.sessionCount }) : '';
  const recent = hasCounts ? formatLastActive(row.lastActive, { now, locale }) : '';
  const name = row.duplicateName && row.disambiguator ? `${row.name} · ${row.disambiguator}` : row.name;
  const label = [name, count, row.path].filter(Boolean).join(' · ');
  return h(doc, 'div', { class: 'session-option-row projects-row', 'data-project-id': row.id, 'data-kind': row.kind },
    h(doc, 'button', {
      type: 'button',
      class: 'session-option projects-option',
      'aria-label': label,
      'data-fk': `project:${row.id}`,
      onClick: () => controller.openProject(row.id),
    },
    h(doc, 'span', { class: 'session-option-name projects-name' },
      row.active && h(doc, 'span', { class: 'projects-active-dot', 'aria-hidden': 'true' }),
      h(doc, 'span', { class: 'projects-name-text', title: row.name, text: row.name }),
      row.duplicateName && row.disambiguator && h(doc, 'span', { class: 'projects-disambiguator', text: row.disambiguator })),
    h(doc, 'span', { class: 'session-option-meta', text: count || '' }),
    path.text && h(doc, 'span', { class: 'projects-path', title: path.full, text: path.text }),
    recent && h(doc, 'span', { class: 'projects-recent', text: recent })));
}

// ---- One project ---------------------------------------------------------

function renderProject({ doc, state, controller, t, locale, now }) {
  const { project } = state;
  const row = project?.row || state.list.rows.find((item) => item.id === project?.id) || null;
  const out = [
    backButton({ doc, t, controller, label: t('projects.back') }),
    heading({ doc, text: project?.name || '', fk: 'project-title', autofocus: true }),
    scopeLine({ doc, state, t }),
  ];
  const path = shortenPath(row?.path || project?.node?.path || '');
  if (path.text) out.push(h(doc, 'div', { class: 'projects-folder', title: path.full }, t('projects.folder'), ' ', h(doc, 'code', { text: path.full })));
  if (row?.cwd) {
    out.push(h(doc, 'div', { class: 'projects-actions' },
      h(doc, 'button', {
        type: 'button',
        class: 'projects-primary-action',
        'data-fk': 'new-session',
        onClick: () => controller.newSessionInProject(row),
        text: t('projects.new_session'),
      }),
      h(doc, 'p', { class: 'projects-hint', text: t('projects.new_session_hint') })));
  }
  out.push(noticeBar({ doc, state, controller, t }));
  if (project.status === 'unavailable' || project.status === 'error') {
    out.push(failureBlock({ doc, failure: project.failure, t, controller }));
    return out;
  }
  if (project.status === 'loading' && !project.node) {
    out.push(loadingBlock({ doc, t, text: t('projects.loading_sessions') }));
    return out;
  }
  const sessions = flattenProjectSessions(project.node, { query: state.query });
  if (!sessions.length) {
    const searching = Boolean(String(state.query || '').trim());
    out.push(messageBlock({
      doc,
      t,
      title: searching ? '' : t('projects.sessions.empty_title'),
      text: searching ? t('projects.sessions.no_match') : t('projects.sessions.empty_text'),
      testid: 'projects-sessions-empty',
    }));
    return out;
  }
  out.push(h(doc, 'section', { class: 'projects-group', 'aria-label': t('projects.sessions.title') },
    h(doc, 'div', { class: 'session-group-title projects-group-title' },
      h(doc, 'span', { text: t('projects.sessions.title') }),
      h(doc, 'strong', { text: String(sessions.length) })),
    sessions.map((session) => sessionRow({ doc, session, controller, t, locale, now }))));
  return out;
}

function sessionRow({ doc, session, controller, t, locale, now }) {
  const recent = formatLastActive(session.lastActive, { now, locale });
  const meta = [session.branch, recent].filter(Boolean).join(' · ');
  return h(doc, 'div', { class: 'session-option-row projects-session-row', 'data-session-id': session.id },
    h(doc, 'button', {
      type: 'button',
      class: 'session-option projects-option',
      'aria-label': [session.title, meta].filter(Boolean).join(' · '),
      'data-fk': `session:${session.id}`,
      onClick: () => controller.openProjectSession(session),
    },
    h(doc, 'span', { class: 'session-option-name', title: session.title, text: session.title }),
    h(doc, 'span', { class: 'session-option-meta', title: meta, text: meta }),
    session.cwd && h(doc, 'span', { class: 'projects-path', title: session.cwd, text: shortenPath(session.cwd).text })),
    h(doc, 'span', { class: 'session-actions' },
      h(doc, 'button', {
        type: 'button',
        class: 'session-action-button',
        title: t('projects.move.action_title'),
        'aria-label': t('projects.move.action_for', { title: session.title }),
        'data-fk': `move:${session.id}`,
        onClick: () => controller.startMove(session, { returnTo: 'project' }),
        text: t('projects.move.action'),
      })));
}

// ---- Create ----------------------------------------------------------------

function renderCreate({ doc, state, controller, t }) {
  const draft = state.create;
  const host = state.scope ? hostOf(state.scope.endpoint) : '';
  const check = controller.draftCheck();
  const show = draft.touched;
  const nameError = show && check.errors.name ? t(check.errors.name) : '';
  const pathError = show && check.errors.path
    ? t(check.errors.path, { project: check.warnings.owner || '' }) : '';
  const submitting = draft.status === 'submitting';
  const out = [
    backButton({ doc, t, controller, label: t('projects.back') }),
    heading({ doc, text: t('projects.create.title'), fk: 'create-title', autofocus: false }),
    scopeLine({ doc, state, t }),
  ];
  const form = h(doc, 'form', {
    class: 'projects-form',
    novalidate: true,
    onSubmit: (event) => { event.preventDefault(); controller.submitCreate(); },
  },
  field({
    doc, id: 'projectsCreateName', fk: 'create-name', label: t('projects.create.name'), value: draft.name,
    error: nameError, disabled: submitting, autofocus: true, maxlength: 120, autocomplete: 'off',
    onInput: (value) => controller.updateCreate('name', value),
  }),
  check.warnings.name && !check.errors.name && h(doc, 'div', { class: 'projects-warning', role: 'status', 'data-testid': 'projects-duplicate-name' },
    h(doc, 'span', { text: t('projects.create.warn.name_duplicate', { name: check.warnings.twin.name, folder: shortenPath(check.warnings.twin.path).text || check.warnings.twin.id }) }),
    h(doc, 'button', {
      type: 'button',
      class: 'session-action-button',
      onClick: () => controller.updateCreate('name', check.warnings.suggestion),
      text: t('projects.create.use_suggestion', { name: check.warnings.suggestion }),
    })),
  field({
    doc, id: 'projectsCreatePath', fk: 'create-path', label: t('projects.create.path'), value: draft.path,
    error: pathError, disabled: submitting, mono: true, autocomplete: 'off', spellcheck: false,
    placeholder: t('projects.create.path_placeholder'),
    hintId: 'projectsCreatePathHint',
    hint: t('projects.create.path_hint', { host: host || t('projects.create.the_gateway') }),
    onInput: (value) => controller.updateCreate('path', value),
  }));
  if (draft.error) {
    form.append(failureBlock({ doc, failure: draft.error, t, controller, retry: false }));
  }
  form.append(h(doc, 'div', { class: 'projects-form-actions' },
    h(doc, 'button', {
      type: 'submit',
      class: 'projects-primary-action',
      'data-fk': 'create-submit',
      disabled: submitting,
      'aria-busy': submitting ? 'true' : undefined,
      text: submitting ? t('projects.create.creating') : t('projects.create.submit'),
    }),
    h(doc, 'button', {
      type: 'button',
      class: 'session-action-button projects-cancel',
      disabled: submitting,
      onClick: () => controller.back(),
      text: t('projects.cancel'),
    })));
  out.push(form);
  return out;
}

function field({ doc, id, fk, label, value, error, disabled, autofocus, mono, hint, hintId, onInput, placeholder, maxlength, autocomplete, spellcheck }) {
  const errorId = `${id}Error`;
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ');
  const input = h(doc, 'input', {
    id,
    type: 'text',
    class: `projects-input${mono ? ' projects-input-mono' : ''}`,
    value,
    placeholder,
    disabled,
    maxlength,
    autocomplete,
    spellcheck: spellcheck === false ? 'false' : undefined,
    'data-fk': fk,
    'data-autofocus': autofocus || undefined,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': describedBy || undefined,
    onInput: (event) => onInput(event.target.value),
    onCompositionstart: (event) => { event.target.closest('[data-view]')?.setAttribute('data-composing', '1'); },
    onCompositionend: (event) => {
      event.target.closest('[data-view]')?.removeAttribute('data-composing');
      onInput(event.target.value);
    },
  });
  input.value = value;
  return h(doc, 'div', { class: 'projects-field' },
    h(doc, 'label', { for: id, class: 'projects-label', text: label }),
    input,
    hint && h(doc, 'p', { id: hintId, class: 'projects-hint', text: hint }),
    error && h(doc, 'p', { id: errorId, class: 'projects-field-error', role: 'alert', text: error }));
}

// ---- Move to project ---------------------------------------------------------

function renderMove({ doc, state, controller, t }) {
  const move = state.move;
  const out = [
    backButton({ doc, t, controller, label: t('projects.back'), disabled: move.step === 'working' }),
    heading({ doc, text: t('projects.move.title'), fk: 'move-title', autofocus: true }),
    h(doc, 'div', { class: 'projects-move-session', title: move.session.title },
      h(doc, 'span', { class: 'projects-label', text: t('projects.move.session') }),
      h(doc, 'strong', { class: 'projects-move-session-name', text: move.session.title })),
  ];
  if (move.session.cwd) {
    out.push(h(doc, 'div', { class: 'projects-folder', title: move.session.cwd }, t('projects.move.current_folder'), ' ', h(doc, 'code', { text: move.session.cwd })));
  }
  out.push(h(doc, 'p', { class: 'projects-warning projects-move-explainer', 'data-testid': 'projects-move-explainer', text: t('projects.move.explainer') }));

  const gate = controller.availability();
  if (!gate.available) {
    out.push(failureBlock({ doc, failure: describeProjectsFailure({ ...gate, unavailable: true }), t, controller, retry: false }));
    return out;
  }

  const confirming = move.step === 'confirm-live';
  // The answer comes first, where it is seen without scrolling the choices.
  if (confirming) {
    out.push(h(doc, 'div', { class: 'projects-state projects-state-warn', role: 'alertdialog', 'aria-labelledby': 'projectsLiveTitle', 'aria-describedby': 'projectsLiveText', 'data-testid': 'projects-live-confirm' },
      h(doc, 'strong', { id: 'projectsLiveTitle', class: 'projects-state-title', 'data-autofocus': true, tabindex: '-1', 'data-fk': 'live-title', text: t('projects.move.live_title') }),
      h(doc, 'p', { id: 'projectsLiveText', class: 'projects-state-text', text: t('projects.move.live_turn') }),
      h(doc, 'div', { class: 'projects-state-actions' },
        h(doc, 'button', { type: 'button', class: 'projects-primary-action', 'data-fk': 'live-confirm', onClick: () => controller.confirmMove(), text: t('projects.move.live_confirm') }),
        h(doc, 'button', { type: 'button', class: 'session-action-button', onClick: () => controller.cancelLiveConfirm(), text: t('projects.cancel') }))));
  } else if (move.outcome && move.step === 'result') {
    out.push(outcomeBlock({ doc, move, controller, t }));
  }

  const targets = controller.moveTargets();
  const busy = move.step === 'working' || confirming;
  const fieldset = h(doc, 'fieldset', { class: 'projects-choices', disabled: busy },
    h(doc, 'legend', { class: 'projects-label', text: t('projects.move.destination') }));
  if (state.list.status === 'loading' || state.list.status === 'idle') {
    fieldset.append(loadingBlock({ doc, t }));
  }
  for (const target of targets) {
    const id = `projectsMove-${target.id}`;
    fieldset.append(h(doc, 'label', { class: `projects-choice${target.current ? ' is-current' : ''}`, for: id },
      h(doc, 'input', {
        type: 'radio', id, name: 'projectsMoveTarget', value: target.id,
        checked: move.targetId === target.id,
        'data-fk': `target:${target.id}`,
        onChange: () => controller.chooseMoveTarget(target.id),
      }),
      h(doc, 'span', { class: 'projects-choice-copy' },
        h(doc, 'span', { class: 'projects-choice-name', title: target.label, text: target.label }),
        h(doc, 'span', { class: 'projects-path', title: target.cwd, text: shortenPath(target.cwd).text }),
        target.current && h(doc, 'span', { class: 'projects-choice-badge', text: t('projects.move.current') }))));
  }
  fieldset.append(h(doc, 'label', { class: 'projects-choice', for: 'projectsMove-custom' },
    h(doc, 'input', {
      type: 'radio', id: 'projectsMove-custom', name: 'projectsMoveTarget', value: 'custom',
      checked: move.targetId === 'custom', 'data-fk': 'target:custom',
      onChange: () => controller.chooseMoveTarget('custom'),
    }),
    h(doc, 'span', { class: 'projects-choice-copy' },
      h(doc, 'span', { class: 'projects-choice-name', text: t('projects.move.other_folder') }),
      h(doc, 'span', { class: 'projects-hint', text: t('projects.move.other_folder_hint') }))));
  out.push(fieldset);

  if (move.targetId === 'custom') {
    const pathError = move.pathError ? t(move.pathError) : '';
    out.push(field({
      doc, id: 'projectsMovePath', fk: 'move-path', label: t('projects.move.folder_path'), value: move.customPath,
      error: pathError, disabled: busy, mono: true, autocomplete: 'off', spellcheck: false,
      placeholder: t('projects.create.path_placeholder'),
      hintId: 'projectsMovePathHint', hint: t('projects.create.path_hint', { host: state.scope ? hostOf(state.scope.endpoint) : t('projects.create.the_gateway') }),
      onInput: (value) => controller.setMoveCustomPath(value),
    }));
    out.push(h(doc, 'div', { class: 'projects-form-actions' },
      h(doc, 'button', {
        type: 'button', class: 'session-action-button', disabled: busy || !move.customPath.trim(),
        onClick: () => controller.checkCustomFolder(), text: t('projects.move.check_folder'),
      })));
    if (move.folderCheck?.status === 'checking') out.push(h(doc, 'p', { class: 'projects-hint', role: 'status', text: t('projects.move.checking') }));
    if (move.folderCheck?.status === 'ok') {
      out.push(h(doc, 'p', { class: 'projects-hint', role: 'status', 'data-testid': 'projects-folder-check', text: move.folderCheck.projectName
        ? t('projects.move.folder_in_project', { name: move.folderCheck.projectName })
        : t('projects.move.folder_no_project') }));
    }
    if (move.folderCheck?.status === 'failed') {
      out.push(h(doc, 'p', { class: 'projects-field-error', role: 'alert', text: t(move.folderCheck.failure.key, move.folderCheck.failure.params) }));
    }
  }

  const destination = controller.moveDestination();
  if (confirming) return out;
  out.push(h(doc, 'div', { class: 'projects-form-actions' },
    h(doc, 'button', {
      type: 'button',
      class: 'projects-primary-action',
      'data-fk': 'move-submit',
      disabled: busy || !destination || !destination.cwd || move.outcome?.status === 'moved',
      'aria-busy': busy ? 'true' : undefined,
      onClick: () => controller.confirmMove(),
      text: busy ? t('projects.move.moving') : t('projects.move.submit', { name: destination?.label || '…' }),
    })));
  return out;
}

function outcomeBlock({ doc, move, controller, t }) {
  const outcome = move.outcome;
  const text = t(outcome.key, { ...outcome.params, name: outcome.destinationLabel });
  const detail = outcome.params?.detail && !text.includes(outcome.params.detail) ? ` ${outcome.params.detail}` : '';
  return h(doc, 'div', {
    class: `projects-state projects-state-${outcome.tone}`,
    role: outcome.tone === 'error' ? 'alert' : 'status',
    'data-testid': 'projects-move-result',
    tabindex: '-1',
    'data-autofocus': true,
    'data-status': outcome.status,
  },
  h(doc, 'p', { class: 'projects-state-text', text: `${text}${detail}` }),
  outcome.unavailableReason && h(doc, 'code', { class: 'projects-state-reason', text: t('projects.reason_code', { reason: outcome.unavailableReason }) }),
  outcome.reconcile && h(doc, 'div', { class: 'projects-state-actions' },
    h(doc, 'button', { type: 'button', class: 'session-action-button', onClick: () => controller.reconcileMove(), text: t('projects.move.check_again') })));
}
