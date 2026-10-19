import { validateBrowserControlUrl } from './browser-control-safety.mjs';

const SCOPE_HELP_KEYS = Object.freeze({
  'this-tab': 'browser_control.help_scope_this_tab',
  'selected-tabs': 'browser_control.help_scope_selected_tabs',
  'task-set': 'browser_control.help_scope_task_set',
});

// The visible helper under the scope select names exactly what the chosen scope covers.
export function browserControlScopeHelpKey(scope) {
  return SCOPE_HELP_KEYS[scope] || SCOPE_HELP_KEYS['this-tab'];
}

// Presentation and explicit scope intent only; the worker owns the transaction.
export function createBrowserControlDialog({ dialog, launcher, closeButton, focusFallback, label, refresh,
  scopeInput, scopeHelp, tabsField, tabsList, applyButton, scopeHint, loadTabs, getScope, getSelectedTabIds,
  applyScope, translate = (key) => key,
}) {
  let enabled = false;
  let backdropPressed = false;
  let canChangeScope = false;
  let applying = false;
  let loadingTabs = false;
  let loadGeneration = 0;
  let draftTabIds = new Set();
  let feedbackKey = '';
  let flairPending = false;
  let previousState = 'off';

  const playFlair = () => {
    if (!flairPending || !dialog.open || !dialog.classList.contains('is-pointer-open')) return;
    dialog.classList.add('is-energized');
    flairPending = false;
  };
  const tabIsEligible = (tab) => validateBrowserControlUrl(tab.url, { allowLocalFiles: true }).ok;
  const syncScopeDraft = () => {
    if (!scopeInput) return;
    const multiTab = scopeInput.value !== 'this-tab';
    scopeInput.disabled = !canChangeScope || applying || loadingTabs;
    scopeInput.brandedSelect?.sync();
    if (scopeHelp) scopeHelp.textContent = translate(browserControlScopeHelpKey(scopeInput.value));
    tabsField.hidden = !multiTab;
    for (const box of tabsList.querySelectorAll('input')) {
      // Restricted tabs stay visible as disabled rows; they can never join the draft.
      box.disabled = box.dataset.restricted === 'true' || scopeInput.disabled || (!box.checked && draftTabIds.size >= 32);
    }
    applyButton.disabled = scopeInput.disabled || (multiTab && draftTabIds.size === 0);
    applyButton.setAttribute('aria-busy', String(applying));
    scopeHint.textContent = translate(!canChangeScope ? 'browser_control.scope_busy'
      : feedbackKey || (multiTab && !draftTabIds.size ? 'browser_control.scope_selection_required' : 'browser_control.scope_locked'));
  };
  const resetScopeDraft = async () => {
    if (!scopeInput) return;
    const generation = ++loadGeneration;
    scopeInput.value = getScope();
    draftTabIds = new Set(getSelectedTabIds());
    feedbackKey = '';
    loadingTabs = true;
    tabsList.replaceChildren();
    syncScopeDraft();
    try {
      const tabs = await loadTabs();
      if (generation !== loadGeneration || !dialog.open) return;
      const selectable = new Set(tabs.filter(tabIsEligible).map((tab) => tab.id));
      draftTabIds = new Set([...draftTabIds].filter((id) => selectable.has(id)));
      for (const tab of tabs) {
        const restricted = !tabIsEligible(tab);
        const option = dialog.ownerDocument.createElement('label');
        option.className = 'browser-control-tab-option';
        if (restricted) option.classList.add('is-restricted');
        // Each selectable tab explains its checkbox on hover and focus. A restricted row already
        // says in its own text why it cannot be chosen, so it gets no second explanation.
        const checkboxHelp = restricted ? '' : translate('browser_control.help_scope_tab');
        if (checkboxHelp) {
          option.dataset.controlHelp = 'scope_tab';
          option.dataset.help = checkboxHelp;
        }
        const checkbox = dialog.ownerDocument.createElement('input');
        checkbox.type = 'checkbox';
        if (checkboxHelp) checkbox.setAttribute('aria-description', checkboxHelp);
        checkbox.checked = !restricted && draftTabIds.has(tab.id);
        if (restricted) checkbox.dataset.restricted = 'true';
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) draftTabIds.add(tab.id); else draftTabIds.delete(tab.id);
          feedbackKey = '';
          syncScopeDraft();
        });
        const text = dialog.ownerDocument.createElement('span');
        text.className = 'browser-control-tab-text';
        const title = dialog.ownerDocument.createElement('span');
        title.textContent = tab.title || tab.url;
        title.title = title.textContent;
        text.append(title);
        if (restricted) {
          // Say why the row is unavailable instead of hiding it.
          const reason = dialog.ownerDocument.createElement('small');
          reason.textContent = translate('browser_control.tab_restricted');
          text.append(reason);
        }
        option.append(checkbox, text);
        tabsList.append(option);
      }
      if (!tabs.length) {
        const empty = dialog.ownerDocument.createElement('span');
        empty.textContent = translate('ui.no.matching.tabs');
        tabsList.append(empty);
      }
    } catch {
      if (generation === loadGeneration) feedbackKey = 'browser_control.scope_failed';
    } finally {
      if (generation === loadGeneration) { loadingTabs = false; syncScopeDraft(); }
    }
  };
  scopeInput?.addEventListener('change', () => { feedbackKey = ''; syncScopeDraft(); });
  applyButton?.addEventListener('click', async () => {
    if (applyButton.disabled || applying || !canChangeScope) return;
    applying = true;
    syncScopeDraft();
    try {
      await applyScope({ scope: scopeInput.value, tabIds: [...draftTabIds] });
      feedbackKey = 'browser_control.scope_updated';
    } catch (error) {
      feedbackKey = error?.code === 'controller_busy' ? 'browser_control.scope_busy' : 'browser_control.scope_failed';
    } finally {
      applying = false;
      syncScopeDraft();
    }
  });
  dialog.addEventListener('animationend', (event) => {
    if (event.animationName === 'control-flare') dialog.classList.remove('is-energized');
  });

  const restoreFocus = () => {
    launcher.setAttribute('aria-expanded', 'false');
    const target = launcher.hidden ? focusFallback : launcher;
    target?.focus({ preventScroll: true });
  };
  // Hover and focus help is for the icon-style buttons only; scope choices read their helper text on screen.
  const tooltip = dialog.querySelector('#browserControlTooltip');
  let helpTarget = null;
  // aria-describedby is a list of ids. Help adds the tooltip's id to that list and removes only that id,
  // so a control that also points at a hint (the scope picker) keeps the hint.
  const setHelpDescription = (button, shown) => {
    const ids = (button.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tooltip.id);
    if (shown) ids.push(tooltip.id);
    if (ids.length) button.setAttribute('aria-describedby', ids.join(' '));
    else button.removeAttribute('aria-describedby');
  };
  const hideHelp = () => {
    if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
    if (helpTarget) setHelpDescription(helpTarget, false);
    helpTarget = null;
  };
  const showHelp = (button) => {
    if (!tooltip || !dialog.open || !button?.dataset.help) return;
    if (helpTarget && helpTarget !== button) setHelpDescription(helpTarget, false);
    helpTarget = button;
    tooltip.textContent = button.dataset.help;
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    // A control named by its help text already says it; describing it with the same text would repeat it.
    if (!button.hasAttribute('data-help-as-name')) setHelpDescription(button, true);
    // Anchor option help to the picker, so a lower option's explanation cannot
    // cover the choices above it while the user moves through the menu.
    const picker = button.getAttribute('role') === 'option' ? button.closest('.branded-select') : null;
    const target = (picker || button).getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    const edge = 16;
    const left = Math.max(edge, Math.min(target.left + target.width / 2 - rect.width / 2, window.innerWidth - rect.width - edge));
    const above = target.top - rect.height - 10;
    const top = above >= edge ? above : Math.min(target.bottom + 10, window.innerHeight - rect.height - edge);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(edge, top)}px`;
  };
  const helpButton = (target) => target?.closest?.('[data-control-help]');
  dialog.addEventListener('pointerover', (event) => {
    const button = helpButton(event.target);
    if (button && !button.contains(event.relatedTarget)) showHelp(button);
  });
  dialog.addEventListener('pointerout', (event) => {
    const button = helpButton(event.target);
    if (button && !button.contains(event.relatedTarget)) hideHelp();
  });
  dialog.addEventListener('focusin', (event) => showHelp(helpButton(event.target)));
  dialog.addEventListener('focusout', hideHelp);
  dialog.addEventListener('scroll', hideHelp);
  dialog.addEventListener('click', (event) => { if (helpButton(event.target)) hideHelp(); });
  const close = () => {
    hideHelp();
    if (dialog.open) dialog.close();
  };
  const outsideCard = (event) => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom;
  };

  launcher.addEventListener('click', (event) => {
    if (!enabled || dialog.open) return;
    dialog.classList.toggle('is-pointer-open', event.detail > 0);
    dialog.showModal();
    playFlair();
    void resetScopeDraft();
    launcher.setAttribute('aria-expanded', 'true');
    // Refresh authority without activating another tab or blocking the dialog.
    Promise.resolve().then(refresh).catch(() => {});
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => {
    loadGeneration += 1;
    dialog.classList.remove('is-energized');
    hideHelp(); restoreFocus();
  });
  dialog.addEventListener('pointerdown', (event) => {
    backdropPressed = event.target === dialog && outsideCard(event);
  });
  dialog.addEventListener('click', (event) => {
    if (backdropPressed && event.target === dialog && outsideCard(event)) close();
    backdropPressed = false;
  });

  return {
    close,
    render({ enabled: nextEnabled, view, help = {}, canChangeScope: nextCanChangeScope = false }) {
      launcher.classList.toggle('just-enabled', nextEnabled && !enabled);
      if (nextEnabled && (!enabled || (view.state === 'ready' && previousState !== 'ready' && previousState !== 'active'))) flairPending = true;
      if (!nextEnabled) flairPending = false;
      previousState = view.state;
      enabled = nextEnabled;
      canChangeScope = nextCanChangeScope;
      if (!dialog.open && scopeInput) scopeInput.value = getScope();
      syncScopeDraft();
      playFlair();
      dialog.dataset.state = view.state;
      dialog.dataset.tone = view.tone;
      for (const button of dialog.querySelectorAll('[data-control-help]')) {
        const key = button.dataset.controlHelp;
        const text = help[key] || (key.startsWith('scope_') ? translate(`browser_control.help_${key}`) : '');
        if (text !== button.dataset.help) {
          button.dataset.help = text;
          // The status light is named by its help text (the full status), so the text is its name, not a description.
          if (button.hasAttribute('data-help-as-name')) button.setAttribute('aria-label', text);
          else button.setAttribute('aria-description', text);
          if (helpTarget === button) showHelp(button);
        }
      }
      launcher.hidden = !enabled;
      launcher.dataset.state = view.state;
      launcher.dataset.tone = view.tone;
      launcher.setAttribute('aria-label', `${label()}: ${view.title}`);
      launcher.title = `${label()}: ${view.title}\n${view.detail}`;
      if (!enabled) close();
    },
  };
}
