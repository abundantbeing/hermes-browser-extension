// The "Hermes Web is not available" dialog: why it did not open, the three commands that
// turn the Webapp on (each with a copy button), a link to the docs and a way to check again.
// The markup is static in sidepanel.html (so every word goes through the i18n catalogs);
// this module only shows the right reason and wires the buttons.

import { CODE_COPIED_ICON, CODE_COPY_ICON, writeClipboardText } from './markdown-code-copy.mjs';

const COPIED_RESET_MS = 1500;
const REASONS = Object.freeze(['unreachable', 'needs-address', 'invalid-address', 'permission-denied']);
const REASONS_WITH_ADDRESS = new Set(['unreachable', 'permission-denied']);

export function webappDialogReason(status) {
  return REASONS.includes(status) ? status : 'unreachable';
}

export function createWebappDialog({
  root = globalThis.document,
  translate = (key) => key,
  clipboard = globalThis.navigator?.clipboard,
  onRetry = () => {},
  onClose = () => {},
} = {}) {
  const dialog = root?.getElementById?.('webappDialog');
  if (!dialog) return null;
  const closeButton = root.getElementById('webappDialogClose');
  const retryButton = root.getElementById('webappDialogRetry');
  const addressEl = root.getElementById('webappDialogAddress');
  const copyStatus = root.getElementById('webappCopyStatus');
  const copyButtons = [...dialog.querySelectorAll('[data-webapp-copy]')];
  const resets = new Map();

  const restoreCopyButton = (button) => {
    button.classList.remove('copied');
    button.setAttribute('aria-label', translate('webapp.copy_command'));
    button.innerHTML = CODE_COPY_ICON;
    resets.delete(button);
  };

  const focusables = () => [...dialog.querySelectorAll('button, a[href]')].filter((node) => !node.disabled && !node.hidden);

  // `routes: 'present'` means the gateway answered about its Webapp and signs a tab in itself, so
  // `hermes webapp` is not a step: turning the Webapp on and restarting the gateway is.
  function show({ reason = 'unreachable', address = '', routes = '' } = {}) {
    const shown = webappDialogReason(reason);
    for (const step of dialog.querySelectorAll('[data-webapp-sign-in]')) step.hidden = routes === 'present';
    for (const paragraph of dialog.querySelectorAll('[data-webapp-reason]')) {
      paragraph.hidden = paragraph.dataset.webappReason !== shown;
    }
    // A connection with no address to try (a remote gateway without one, or Hermes Cloud) has
    // no computer here to run the commands on, so only the reason and the guide show.
    const hostSteps = shown !== 'needs-address';
    const detail = root.getElementById('webappDialogDetail');
    if (detail) detail.hidden = !hostSteps;
    const commands = dialog.querySelector('.webapp-commands');
    if (commands) commands.hidden = !hostSteps;
    dialog.setAttribute('aria-describedby', hostSteps ? 'webappDialogDetail' : 'webappDialogNeedsAddress');
    if (addressEl) {
      const showAddress = REASONS_WITH_ADDRESS.has(shown) && Boolean(address);
      addressEl.textContent = showAddress ? address : '';
      addressEl.hidden = !showAddress;
    }
    if (copyStatus) copyStatus.textContent = '';
    dialog.hidden = false;
    dialog.focus();
  }

  function hide() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    for (const [button, timer] of resets) {
      clearTimeout(timer);
      restoreCopyButton(button);
    }
    onClose();
  }

  closeButton?.addEventListener('click', hide);
  retryButton?.addEventListener('click', () => {
    hide();
    onRetry();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = root.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
  for (const button of copyButtons) {
    button.addEventListener('click', async () => {
      const command = button.dataset.webappCopy || '';
      try {
        await writeClipboardText(command, clipboard);
      } catch {
        return;
      }
      clearTimeout(resets.get(button));
      button.classList.add('copied');
      button.setAttribute('aria-label', translate('ui.copied'));
      button.innerHTML = CODE_COPIED_ICON;
      if (copyStatus) copyStatus.textContent = translate('ui.copied');
      resets.set(button, setTimeout(() => {
        restoreCopyButton(button);
        if (copyStatus) copyStatus.textContent = '';
      }, COPIED_RESET_MS));
    });
  }

  return { show, hide, element: dialog };
}
