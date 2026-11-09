// The Delete connection window: it lists every saved connection and asks which one to delete.
// Nothing is chosen to begin with, so the connection in use is never what a stray press removes.
// The markup is static in sidepanel.html, so every word goes through the i18n catalogs.

import { holdFocusInside } from './dialog-focus.mjs';

export function createDeleteConnectionDialog({
  root = globalThis.document,
  translate = (key) => key,
  onDelete = async () => {},
  onClose = () => {},
} = {}) {
  const dialog = root?.getElementById?.('deleteConnectionDialog');
  if (!dialog) return null;
  const byId = (id) => root.getElementById(id);
  const ui = {
    list: byId('deleteConnectionList'),
    close: byId('deleteConnectionClose'),
    cancel: byId('deleteConnectionCancel'),
    confirm: byId('deleteConnectionConfirm'),
    detail: byId('deleteConnectionDetail'),
    chosen: byId('deleteConnectionChosen'),
    error: byId('deleteConnectionError'),
  };
  let entries = [];
  let chosenId = '';
  let busy = false;
  // Rows are disabled while a delete runs, so focus falls back to the first control that still takes it.
  const focusHold = holdFocusInside(root, dialog, () => [
    ui.list.querySelector('[aria-checked="true"]'),
    ui.list.querySelector('button'),
    ui.close,
  ].find((node) => node && !node.disabled));

  const focusables = () => [...dialog.querySelectorAll('button')]
    .filter((node) => !node.disabled && !node.hidden && node.offsetParent !== null);

  function row(entry) {
    const button = root.createElement('button');
    button.type = 'button';
    button.className = 'conn-mode-card';
    button.dataset.deleteId = entry.id;
    button.setAttribute('role', 'radio');
    const head = root.createElement('span');
    head.className = 'conn-mode-head';
    const title = root.createElement('span');
    title.className = 'conn-mode-title';
    title.textContent = entry.name;
    const mark = root.createElement('span');
    mark.className = 'conn-mode-check';
    mark.setAttribute('aria-hidden', 'true');
    head.append(title, mark);
    const desc = root.createElement('span');
    desc.className = 'conn-mode-desc';
    desc.textContent = entry.active ? `${entry.summary} · ${translate('connections.in_use')}` : entry.summary;
    button.append(head, desc);
    return button;
  }

  function render() {
    for (const button of ui.list.children) {
      const on = button.dataset.deleteId === chosenId;
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('selected', on);
      button.disabled = busy;
    }
    const entry = entries.find((item) => item.id === chosenId);
    ui.chosen.hidden = !entry;
    ui.chosen.textContent = entry ? translate('connections.delete_confirm', { name: entry.name }) : '';
    ui.confirm.disabled = busy || !entry;
    ui.cancel.disabled = busy;
  }

  function show({ connections = [] } = {}) {
    entries = connections.map((entry) => ({ ...entry }));
    chosenId = '';
    busy = false;
    ui.error.hidden = true;
    ui.list.replaceChildren(...entries.map(row));
    render();
    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    focusHold.start();
    (ui.list.querySelector('button') || dialog).focus();
  }

  function hide() {
    if (dialog.hidden || busy) return;
    focusHold.stop();
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
    onClose();
  }

  async function confirm() {
    if (busy || !chosenId) return;
    busy = true;
    ui.error.hidden = true;
    render();
    try {
      await onDelete(chosenId);
      busy = false;
      hide();
    } catch {
      busy = false;
      ui.error.textContent = translate('connections.error');
      ui.error.hidden = false;
      render();
    }
  }

  ui.list.addEventListener('click', (event) => {
    const id = event.target?.closest?.('[data-delete-id]')?.dataset?.deleteId;
    if (!id || busy) return;
    chosenId = id;
    ui.error.hidden = true;
    render();
  });
  ui.close.addEventListener('click', hide);
  ui.cancel.addEventListener('click', hide);
  ui.confirm.addEventListener('click', () => { void confirm(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
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
