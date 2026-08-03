import {
  CONTEXT_MENU_ACTION_TYPES,
  CONTEXT_MENU_CONTEXTS,
  cloneDefaultContextMenuConfig as defaultContextMenuConfig,
  normalizeContextMenuConfig,
} from './context-menu-config.mjs';

const CONTEXT_LABELS = Object.freeze({
  page: ['ui.context.menu.editor.context.page', 'Page'],
  selection: ['ui.context.menu.editor.context.selection', 'Selection'],
  editable: ['ui.context.menu.editor.context.editable', 'Editable field'],
  link: ['ui.context.menu.editor.context.link', 'Link'],
  image: ['ui.context.menu.editor.context.image', 'Image'],
  video: ['ui.context.menu.editor.context.video', 'Video'],
  audio: ['ui.context.menu.editor.context.audio', 'Audio'],
});

const ACTION_LABELS = Object.freeze({
  [CONTEXT_MENU_ACTION_TYPES.PROMPT]: ['ui.context.menu.editor.action.prompt', 'Prompt Hermes'],
  [CONTEXT_MENU_ACTION_TYPES.INLINE]: ['ui.context.menu.editor.action.inline', 'Improve inline'],
  [CONTEXT_MENU_ACTION_TYPES.OPEN]: ['ui.context.menu.editor.action.open', 'Open Hermes'],
});

function defaultCreateId() {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `custom-${suffix}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
}

export function createContextMenuEditor({
  root,
  config,
  mutate,
  translate = (_key, fallback) => fallback,
  createId = defaultCreateId,
} = {}) {
  if (!root?.ownerDocument) throw new TypeError('Context-menu editor requires a root element.');
  if (typeof mutate !== 'function') throw new TypeError('Context-menu editor requires a mutation handler.');
  const documentRef = root.ownerDocument;
  let currentConfig = normalizeContextMenuConfig(config);
  let t = translate;
  let busy = false;
  let statusMessage = '';
  let statusKind = 'ok';
  const expandedItemIds = new Set(currentConfig.items[0]?.id ? [currentConfig.items[0].id] : []);

  function text(key, fallback) {
    const translated = t(key, fallback);
    return typeof translated === 'string' && translated !== key ? translated : fallback;
  }

  function element(tag, className = '', content = '') {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (content !== '') node.textContent = content;
    return node;
  }

  function button(className, label, content) {
    const node = element('button', className, content);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    return node;
  }

  function clearStatus() {
    if (!statusMessage) return;
    statusMessage = '';
    statusKind = 'ok';
    const status = root.querySelector('.context-menu-editor-status');
    if (!status) return;
    status.textContent = '';
    status.className = 'context-menu-editor-status ok';
    status.hidden = true;
  }

  async function perform(mutation) {
    if (busy) return;
    clearStatus();
    busy = true;
    root.setAttribute('aria-busy', 'true');
    try {
      const response = await mutate(mutation);
      const next = response?.config || response;
      if (next) currentConfig = normalizeContextMenuConfig(next);
      statusMessage = text('ui.context.menu.editor.saved', 'Right-click actions saved.');
      statusKind = 'ok';
      render();
    } catch (error) {
      statusMessage = error?.message || text('ui.context.menu.editor.error.save', 'Right-click actions could not be saved.');
      statusKind = 'error';
      render();
    } finally {
      busy = false;
      root.setAttribute('aria-busy', 'false');
    }
  }

  function showError(errorNode, message) {
    errorNode.textContent = message;
    errorNode.hidden = false;
  }

  function renderField(labelText, control) {
    const label = element('label', 'context-menu-editor-field');
    label.append(element('span', 'context-menu-editor-field-label', labelText), control);
    return label;
  }

  function renderCard(item, index) {
    const card = element('article', 'context-menu-editor-card');
    card.dataset.itemId = item.id;
    const expanded = expandedItemIds.has(item.id);
    const displayTitle = item.titleKey ? text(item.titleKey, item.title) : item.title;

    const header = element('div', 'context-menu-editor-card-header');
    const toggle = button(
      'context-menu-editor-card-toggle',
      expanded
        ? text('ui.context.menu.editor.collapse', 'Close action editor')
        : text('ui.context.menu.editor.expand', 'Edit action'),
      '',
    );
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.append(
      element('strong', 'context-menu-editor-card-title', displayTitle),
      element('span', 'context-menu-editor-card-chevron', expanded ? '−' : '+'),
    );
    toggle.addEventListener('click', () => {
      clearStatus();
      expandedItemIds.clear();
      if (!expanded) expandedItemIds.add(item.id);
      render();
    });
    header.append(toggle);

    const enabled = element('label', 'context-menu-enabled-control hermes-switch');
    const enabledLabel = element('span', 'context-menu-enabled-label', text('ui.context.menu.editor.enabled', 'Enabled'));
    const enabledInput = element('input', 'hermes-switch-input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = item.enabled;
    enabledInput.setAttribute('aria-label', `${text('ui.context.menu.editor.enabled', 'Enabled')}: ${displayTitle}`);
    const enabledTrack = element('span', 'hermes-switch-track');
    enabledTrack.setAttribute('aria-hidden', 'true');
    enabled.append(enabledLabel, enabledInput, enabledTrack);

    const controls = element('div', 'context-menu-editor-controls');
    controls.hidden = !expanded;
    const up = button('context-menu-icon-button', text('ui.context.menu.editor.move.up', 'Move up'), '↑');
    const down = button('context-menu-icon-button', text('ui.context.menu.editor.move.down', 'Move down'), '↓');
    const remove = button('context-menu-icon-button context-menu-remove-button', text('ui.context.menu.editor.remove', 'Remove action'), '×');
    up.disabled = index === 0;
    down.disabled = index === currentConfig.items.length - 1;
    up.addEventListener('click', () => perform({ type: 'move', id: item.id, offset: -1 }));
    down.addEventListener('click', () => perform({ type: 'move', id: item.id, offset: 1 }));
    remove.addEventListener('click', () => {
      expandedItemIds.delete(item.id);
      perform({ type: 'remove', id: item.id });
    });
    controls.append(up, down, remove);
    header.append(enabled, controls);

    const body = element('div', 'context-menu-editor-card-body');
    body.hidden = !expanded;
    const titleInput = element('input', 'context-menu-editor-input');
    titleInput.type = 'text';
    titleInput.maxLength = 80;
    titleInput.value = displayTitle;
    titleInput.dataset.field = 'title';

    const actionSelect = element('select', 'context-menu-editor-select');
    actionSelect.dataset.field = 'action';
    for (const actionType of Object.values(CONTEXT_MENU_ACTION_TYPES)) {
      const option = element('option', '', text(...ACTION_LABELS[actionType]));
      option.value = actionType;
      option.selected = actionType === item.action.type;
      actionSelect.append(option);
    }

    const promptInput = element('textarea', 'context-menu-editor-textarea');
    promptInput.rows = 3;
    promptInput.maxLength = 2_000;
    promptInput.value = item.action.type === CONTEXT_MENU_ACTION_TYPES.PROMPT ? item.action.prompt : '';
    promptInput.dataset.field = 'prompt';
    const promptField = renderField(text('ui.context.menu.editor.prompt', 'Prompt'), promptInput);
    promptField.hidden = item.action.type !== CONTEXT_MENU_ACTION_TYPES.PROMPT;

    const contexts = element('fieldset', 'context-menu-context-fieldset');
    contexts.append(element('legend', 'context-menu-editor-field-label', text('ui.context.menu.editor.contexts', 'Show on')));
    const contextGrid = element('div', 'context-menu-context-grid');
    for (const contextName of CONTEXT_MENU_CONTEXTS) {
      const option = element('label', 'context-menu-context-option');
      const input = element('input', 'context-menu-context-input');
      input.type = 'checkbox';
      input.value = contextName;
      input.checked = item.contexts.includes(contextName);
      input.disabled = item.action.type === CONTEXT_MENU_ACTION_TYPES.INLINE && contextName !== 'editable';
      const box = element('span', 'context-menu-context-box');
      box.setAttribute('aria-hidden', 'true');
      option.append(input, box, element('span', 'context-menu-context-label', text(...CONTEXT_LABELS[contextName])));
      contextGrid.append(option);
    }
    contexts.append(contextGrid);

    const error = element('p', 'context-menu-editor-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');

    titleInput.addEventListener('change', () => {
      clearStatus();
      const title = titleInput.value.trim();
      if (!title) {
        showError(error, text('ui.context.menu.editor.error.title', 'Title is required.'));
        return;
      }
      perform({ type: 'update', id: item.id, patch: { title, titleKey: '' } });
    });
    enabledInput.addEventListener('change', () => perform({
      type: 'update',
      id: item.id,
      patch: { enabled: enabledInput.checked },
    }));
    promptInput.addEventListener('change', () => {
      clearStatus();
      const prompt = promptInput.value.trim();
      if (!prompt) {
        showError(error, text('ui.context.menu.editor.error.prompt', 'Prompt is required.'));
        return;
      }
      perform({ type: 'update', id: item.id, patch: { action: { type: 'prompt', prompt } } });
    });
    actionSelect.addEventListener('change', () => {
      const actionType = actionSelect.value;
      const patch = actionType === CONTEXT_MENU_ACTION_TYPES.PROMPT
        ? { action: { type: actionType, prompt: item.action.prompt || 'Ask Hermes about this context.' } }
        : actionType === CONTEXT_MENU_ACTION_TYPES.INLINE
          ? { action: { type: actionType, actionId: 'improve' }, contexts: ['editable'] }
          : { action: { type: actionType } };
      perform({ type: 'update', id: item.id, patch });
    });
    contextGrid.addEventListener('change', () => {
      clearStatus();
      const selected = Array.from(contextGrid.querySelectorAll('.context-menu-context-input:checked')).map((input) => input.value);
      if (!selected.length) {
        for (const input of contextGrid.querySelectorAll('.context-menu-context-input')) {
          input.checked = item.contexts.includes(input.value);
        }
        showError(error, text('ui.context.menu.editor.error.context', 'Choose at least one context.'));
        return;
      }
      perform({ type: 'update', id: item.id, patch: { contexts: selected } });
    });

    body.append(
      renderField(text('ui.context.menu.editor.title', 'Title'), titleInput),
      renderField(text('ui.context.menu.editor.action', 'Action'), actionSelect),
      promptField,
      contexts,
      error,
    );
    card.append(header, body);
    return card;
  }

  function render() {
    root.replaceChildren();
    root.classList.add('context-menu-editor');
    const status = element('p', `context-menu-editor-status ${statusKind}`, statusMessage);
    status.hidden = !statusMessage;
    status.setAttribute('role', 'status');
    const list = element('div', 'context-menu-editor-list');
    currentConfig.items.forEach((item, index) => list.append(renderCard(item, index)));
    const empty = element('div', 'context-menu-editor-empty', text('ui.context.menu.editor.empty', 'No right-click actions are enabled. Add one or restore the defaults.'));
    empty.hidden = currentConfig.items.length > 0;

    const footer = element('div', 'context-menu-editor-footer');
    const add = button('context-menu-editor-add button-secondary', text('ui.context.menu.editor.add', 'Add action'), text('ui.context.menu.editor.add', 'Add action'));
    const restore = button('context-menu-editor-restore button-ghost', text('ui.context.menu.editor.restore', 'Restore defaults'), text('ui.context.menu.editor.restore', 'Restore defaults'));
    add.addEventListener('click', () => {
      const id = createId();
      expandedItemIds.add(id);
      perform({
        type: 'add',
        item: {
        id,
        title: text('ui.context.menu.editor.new.action', 'New action'),
        titleKey: '',
        enabled: true,
        contexts: ['selection'],
        action: { type: 'prompt', prompt: text('ui.context.menu.editor.new.prompt', 'Ask Hermes about this selection.') },
        },
      });
    });
    restore.addEventListener('click', () => {
      expandedItemIds.clear();
      const firstDefaultId = defaultContextMenuConfig().items[0]?.id;
      if (firstDefaultId) expandedItemIds.add(firstDefaultId);
      perform({ type: 'restore' });
    });
    footer.append(add, restore);
    root.append(status, list, empty, footer);
  }

  function setConfig(nextConfig) {
    currentConfig = normalizeContextMenuConfig(nextConfig);
    clearStatus();
    render();
  }

  function setTranslator(nextTranslate) {
    if (typeof nextTranslate === 'function') t = nextTranslate;
    clearStatus();
    render();
  }

  render();
  return {
    setConfig,
    setTranslator,
    getConfig: () => normalizeContextMenuConfig(currentConfig),
    destroy: () => root.replaceChildren(),
  };
}

export { defaultContextMenuConfig };
