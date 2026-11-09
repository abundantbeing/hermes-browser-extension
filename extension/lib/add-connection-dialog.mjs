// The Add connection window: steps, fields and the test before a connection is added.
// The markup is static in sidepanel.html, so every word goes through the i18n catalogs; this module
// shows the right step and wires the controls. What each step asks, and what it makes, is in
// add-connection.mjs; the test of the connection is probe-connection.mjs.

import {
  certificateAddress,
  connectionFromDraft,
  firstInvalidStep,
  newConnectionDraft,
  stepProblems,
  stepsFor,
} from './add-connection.mjs';
import { MAX_CONNECTION_HEADERS, normalizeConnectionHeaders } from './connection-headers.mjs';
import { holdFocusInside } from './dialog-focus.mjs';
import { probeConnection } from './probe-connection.mjs';

const TITLE_KEYS = Object.freeze({ where: 'addconn.title_where', signin: 'addconn.title_signin', options: 'addconn.title_options' });
const ADDRESS_ERRORS = Object.freeze({
  required: 'addconn.err_address_required',
  invalid: 'addconn.err_address_invalid',
  'not-local': 'addconn.err_address_not_local',
  'https-required': 'addconn.err_address_https',
});
const HEADER_ERRORS = Object.freeze({
  blocked: 'addconn.err_header_blocked',
  invalid: 'addconn.err_header_invalid',
  repeated: 'addconn.err_header_repeated',
  empty: 'addconn.err_header_empty',
  long: 'addconn.err_header_long',
  many: 'addconn.err_header_many',
});
const RESULT_KEYS = Object.freeze({
  unreachable: 'addconn.result_unreachable',
  unauthorized: 'addconn.result_unauthorized',
  'not-hermes': 'addconn.result_not_hermes',
});

export function createAddConnectionDialog({
  root = globalThis.document,
  translate = (key) => key,
  probe = probeConnection,
  openAddress = () => {},
  onAdd = async () => {},
  onSaveOptions = async () => {},
  onClose = () => {},
} = {}) {
  const dialog = root?.getElementById?.('addConnectionDialog');
  if (!dialog) return null;
  const byId = (id) => root.getElementById(id);
  const ui = {
    kicker: byId('addConnectionKicker'),
    title: byId('addConnectionTitle'),
    stepCount: byId('addConnectionSteps'),
    back: byId('addConnectionBack'),
    close: byId('addConnectionClose'),
    next: byId('addConnectionNext'),
    anyway: byId('addConnectionAnyway'),
    openAddress: byId('addConnectionOpenAddress'),
    result: byId('addConnectionResult'),
    address: byId('addConnectionAddress'),
    addressField: byId('addConnectionAddressField'),
    addressHint: byId('addConnectionAddressHint'),
    addressError: byId('addConnectionAddressError'),
    name: byId('addConnectionName'),
    key: byId('addConnectionKey'),
    keyField: byId('addConnectionKeyField'),
    keyError: byId('addConnectionKeyError'),
    browserNote: byId('addConnectionBrowserNote'),
    headers: byId('addConnectionHeaders'),
    addHeader: byId('addConnectionAddHeader'),
    trust: byId('addConnectionTrust'),
    certGroup: byId('addConnectionCertGroup'),
  };
  const stepPanels = [...dialog.querySelectorAll('[data-add-step]')];
  const typeTiles = [...dialog.querySelectorAll('[data-add-type]')];
  const methodTiles = [...dialog.querySelectorAll('[data-add-method]')];

  let draft = newConnectionDraft();
  let step = 'where';
  // 'add' walks the steps for a new connection; 'options' changes the options of the one in use.
  let mode = 'add';
  let busy = false;
  let failed = false;
  let problems = {};
  let headerRowsBuilt = -1;
  // Each Add press is one attempt. Closing the window ends it: a test still waiting must never add anything.
  let attempt = 0;
  let pendingTest = null;
  let committing = false;
  const focusHold = holdFocusInside(root, dialog, () => stepFocusTarget());

  function endAttempt() {
    attempt += 1;
    pendingTest?.abort();
    pendingTest = null;
  }

  const stepList = () => (mode === 'options' ? ['options'] : stepsFor(draft));
  const isLast = () => stepList().at(-1) === step;
  const focusables = () => [...dialog.querySelectorAll('button, input, a[href]')]
    .filter((node) => !node.disabled && !node.hidden && node.offsetParent !== null);

  function setText(node, text) {
    node.textContent = text;
    node.hidden = !text;
  }

  function renderHeaderRows() {
    ui.headers.replaceChildren(...draft.headers.map((header, index) => {
      const row = root.createElement('div');
      row.className = 'add-connection-header-row';
      const name = root.createElement('input');
      name.type = 'text';
      name.value = header.name;
      name.dataset.headerField = 'name';
      name.dataset.headerIndex = String(index);
      name.autocomplete = 'off';
      name.spellcheck = false;
      name.maxLength = 64;
      name.placeholder = translate('addconn.header_name');
      name.setAttribute('aria-label', translate('addconn.header_name'));
      const value = root.createElement('input');
      value.type = 'text';
      value.value = header.value;
      value.dataset.headerField = 'value';
      value.dataset.headerIndex = String(index);
      value.autocomplete = 'off';
      value.spellcheck = false;
      value.placeholder = translate('addconn.header_value');
      value.setAttribute('aria-label', translate('addconn.header_value'));
      const remove = root.createElement('button');
      remove.type = 'button';
      remove.dataset.headerRemove = String(index);
      remove.textContent = '×';
      remove.setAttribute('aria-label', translate('addconn.header_remove'));
      remove.title = translate('addconn.header_remove');
      const error = root.createElement('p');
      error.className = 'add-connection-error';
      error.dataset.headerError = String(index);
      error.setAttribute('role', 'alert');
      error.hidden = true;
      row.append(name, value, remove, error);
      return row;
    }));
    headerRowsBuilt = draft.headers.length;
  }

  function renderHeaderErrors() {
    for (const error of ui.headers.querySelectorAll('[data-header-error]')) {
      const found = (problems.headers || []).find((entry) => String(entry.index) === error.dataset.headerError);
      setText(error, found ? translate(HEADER_ERRORS[found.problem] || HEADER_ERRORS.invalid) : '');
    }
    const tooMany = (problems.headers || []).some((entry) => entry.problem === 'many');
    if (tooMany) ui.addHeader.title = translate('addconn.err_header_many');
    else ui.addHeader.removeAttribute('title');
  }

  function render() {
    const list = stepList();
    const index = Math.max(0, list.indexOf(step));
    for (const panel of stepPanels) panel.hidden = panel.dataset.addStep !== step;
    ui.title.textContent = translate(TITLE_KEYS[step]);
    setText(ui.stepCount, list.length > 1 ? translate('addconn.step_count', { current: index + 1, total: list.length }) : '');
    ui.back.hidden = index === 0;
    for (const tile of typeTiles) {
      const on = tile.dataset.addType === draft.type;
      tile.setAttribute('aria-checked', String(on));
      tile.classList.toggle('selected', on);
    }
    for (const tile of methodTiles) {
      const on = tile.dataset.addMethod === draft.method;
      tile.setAttribute('aria-checked', String(on));
      tile.classList.toggle('selected', on);
    }
    const hasAddress = draft.type !== 'cloud';
    ui.addressField.hidden = !hasAddress;
    ui.address.placeholder = draft.type === 'local' ? 'http://127.0.0.1:8642' : 'https://hermes.example.com';
    ui.addressHint.textContent = translate(draft.type === 'local' ? 'addconn.address_hint_local' : 'addconn.address_hint_remote');
    setText(ui.addressError, problems.address ? translate(ADDRESS_ERRORS[problems.address] || ADDRESS_ERRORS.invalid) : '');
    ui.address.setAttribute('aria-invalid', String(Boolean(problems.address)));
    ui.keyField.hidden = draft.method !== 'token';
    ui.browserNote.hidden = draft.method !== 'browser';
    setText(ui.keyError, problems.key ? translate('addconn.err_key_required') : '');
    ui.key.setAttribute('aria-invalid', String(Boolean(problems.key)));
    ui.certGroup.hidden = draft.type !== 'remote';
    ui.trust.checked = draft.trustSelfSigned === true;
    if (headerRowsBuilt !== draft.headers.length) renderHeaderRows();
    renderHeaderErrors();
    ui.addHeader.disabled = draft.headers.length >= MAX_CONNECTION_HEADERS;
    ui.next.disabled = busy;
    const lastLabel = mode === 'options' ? 'addconn.save_options' : 'addconn.add';
    ui.next.textContent = busy ? translate('addconn.testing') : translate(failed ? 'addconn.try_again' : (isLast() ? lastLabel : 'ui.next'));
    ui.anyway.hidden = !failed;
    ui.anyway.disabled = busy;
    ui.openAddress.hidden = !(failed && ui.result.dataset.status === 'unreachable' && certificateAddress(draft));
  }

  function showResult(text, state, status = '') {
    ui.result.textContent = text;
    ui.result.dataset.state = state;
    ui.result.dataset.status = status;
    ui.result.hidden = !text;
  }

  function clearResult() {
    failed = false;
    showResult('', '', '');
  }

  function focusProblem() {
    const target = problems.address ? ui.address : problems.key ? ui.key : ui.headers.querySelector('input');
    target?.focus();
  }

  function stepFocusTarget() {
    const find = (selector) => dialog.querySelector(`[data-add-step="${step}"] ${selector}`);
    return find('[aria-checked="true"]') || find('input:not([hidden]):not(.settings-switch-input)') || find('button:not([hidden]):not(:disabled)');
  }

  function goTo(nextStep) {
    step = nextStep;
    problems = {};
    clearResult();
    render();
    stepFocusTarget()?.focus();
  }

  async function saveOptions() {
    problems = stepProblems(draft, 'options');
    if (Object.keys(problems).length) {
      render();
      focusProblem();
      return;
    }
    busy = true;
    clearResult();
    render();
    try {
      await onSaveOptions({ headers: normalizeConnectionHeaders(draft.headers), trustSelfSigned: draft.trustSelfSigned === true });
      hide();
    } catch {
      busy = false;
      showResult(translate('connections.error'), 'error', 'failed');
      render();
    }
  }

  async function finish({ skipTest = false } = {}) {
    if (mode === 'options') { await saveOptions(); return; }
    const invalid = firstInvalidStep(draft);
    if (invalid) {
      if (invalid !== step) goTo(invalid);
      problems = stepProblems(draft, invalid);
      render();
      focusProblem();
      return;
    }
    busy = true;
    clearResult();
    render();
    endAttempt();
    const mine = attempt;
    const controller = new AbortController();
    pendingTest = controller;
    const live = () => mine === attempt && !dialog.hidden;
    const connection = connectionFromDraft(draft);
    const testable = connection.connectionMode !== 'cloud' && connection.connectionTransport !== 'remote-dashboard';
    let outcome = { ok: true, status: 'untested' };
    if (testable && !skipTest) {
      outcome = await probe({ gatewayUrl: connection.gatewayUrl, apiKey: connection.apiKey, headers: connection.connectionHeaders, signal: controller.signal })
        .catch((error) => ({ ok: false, status: 'unreachable', detail: String(error?.message || error) }));
      if (!live()) return;
    }
    if (!outcome.ok) {
      busy = false;
      failed = true;
      const certificate = outcome.status === 'unreachable' && certificateAddress(draft);
      const text = translate(RESULT_KEYS[outcome.status] || RESULT_KEYS['not-hermes']);
      showResult(certificate ? `${text} ${translate('addconn.result_cert')}` : text, 'error', outcome.status);
      render();
      return;
    }
    committing = true;
    try {
      await onAdd({ name: draft.name.trim(), connection });
      committing = false;
      hide();
    } catch {
      committing = false;
      busy = false;
      failed = true;
      showResult(translate('connections.error'), 'error', 'failed');
      render();
    }
  }

  async function next() {
    if (busy) return;
    if (failed) { await finish(); return; }
    problems = stepProblems(draft, step);
    if (Object.keys(problems).length) {
      render();
      focusProblem();
      return;
    }
    if (!isLast()) { goTo(stepList()[stepList().indexOf(step) + 1]); return; }
    await finish();
  }

  function show({ mode: wanted = 'add', name = '', connection = null } = {}) {
    mode = wanted === 'options' ? 'options' : 'add';
    draft = mode === 'options'
      ? newConnectionDraft({
        type: connection?.connectionMode || 'remote',
        address: connection?.gatewayUrl || '',
        method: connection?.apiKey ? 'token' : 'browser',
        trustSelfSigned: connection?.connectionTrustSelfSigned === true,
        headers: normalizeConnectionHeaders(connection?.connectionHeaders).map((header) => ({ ...header })),
      })
      : newConnectionDraft();
    step = mode === 'options' ? 'options' : 'where';
    ui.kicker.textContent = mode === 'options' ? name : translate('addconn.kicker');
    busy = false;
    problems = {};
    headerRowsBuilt = -1;
    ui.address.value = '';
    ui.name.value = '';
    ui.key.value = '';
    endAttempt();
    committing = false;
    clearResult();
    render();
    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    focusHold.start();
    (stepFocusTarget() || dialog).focus();
  }

  function hide() {
    if (dialog.hidden || committing) return;
    focusHold.stop();
    endAttempt();
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
    busy = false;
    onClose();
  }

  for (const tile of typeTiles) {
    tile.addEventListener('click', () => {
      draft = { ...draft, type: tile.dataset.addType };
      problems = {};
      clearResult();
      render();
    });
  }
  for (const tile of methodTiles) {
    tile.addEventListener('click', () => {
      draft = { ...draft, method: tile.dataset.addMethod };
      problems = {};
      clearResult();
      render();
    });
  }
  ui.address.addEventListener('input', () => { draft.address = ui.address.value; delete problems.address; clearResult(); render(); });
  ui.name.addEventListener('input', () => { draft.name = ui.name.value; });
  ui.key.addEventListener('input', () => { draft.apiKey = ui.key.value; delete problems.key; clearResult(); render(); });
  ui.trust.addEventListener('change', () => { draft.trustSelfSigned = ui.trust.checked; });
  ui.addHeader.addEventListener('click', () => {
    if (draft.headers.length >= MAX_CONNECTION_HEADERS) return;
    draft.headers = [...draft.headers, { name: '', value: '' }];
    render();
    ui.headers.querySelector(`[data-header-index="${draft.headers.length - 1}"][data-header-field="name"]`)?.focus();
  });
  ui.headers.addEventListener('input', (event) => {
    const field = event.target?.dataset?.headerField;
    if (!field) return;
    const index = Number(event.target.dataset.headerIndex);
    draft.headers = draft.headers.map((header, at) => (at === index ? { ...header, [field]: event.target.value } : header));
    delete problems.headers;
    renderHeaderErrors();
  });
  ui.headers.addEventListener('click', (event) => {
    const index = event.target?.closest?.('[data-header-remove]')?.dataset?.headerRemove;
    if (index === undefined) return;
    draft.headers = draft.headers.filter((_, at) => at !== Number(index));
    problems = {};
    render();
    ui.addHeader.focus();
  });
  ui.back.addEventListener('click', () => {
    if (busy) return;
    const list = stepList();
    goTo(list[Math.max(0, list.indexOf(step) - 1)]);
  });
  ui.close.addEventListener('click', hide);
  ui.next.addEventListener('click', () => { void next(); });
  ui.anyway.addEventListener('click', () => { if (!busy) void finish({ skipTest: true }); });
  ui.openAddress.addEventListener('click', () => {
    const address = certificateAddress(draft);
    if (address) openAddress(address);
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
      return;
    }
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && event.target?.tagName === 'INPUT' && event.target.type !== 'checkbox') {
      event.preventDefault();
      void next();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes.at(-1);
    if (event.shiftKey && (root.activeElement === first || root.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && root.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return { show, hide, isOpen: () => !dialog.hidden };
}
