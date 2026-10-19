// Custom listbox for native selects whose OS popup cannot use the panel scrollbar.
// The original select stays in the DOM so existing change handlers and tests keep working.

let anonymousSelectCount = 0;

export function mountBrandedSelect(select, { previewFont, language = false } = {}) {
  if (!select) return null;
  if (select.brandedSelect) {
    select.brandedSelect.sync();
    return select.brandedSelect;
  }

  const root = document.createElement('div');
  root.className = 'branded-select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'branded-select-button';
  // A select without an id still needs unique ids for its button and list, or
  // every such select shares "Button" and "List" and aria-controls is ambiguous.
  const baseId = select.id || `brandedSelect${anonymousSelectCount += 1}`;
  button.id = `${baseId}Button`;
  // Opt-in help belongs to the visible picker too; the native select is hidden behind it.
  if (select.dataset.controlHelp) button.dataset.controlHelp = select.dataset.controlHelp;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div');
  list.className = 'branded-select-list';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  list.id = `${baseId}List`;
  button.setAttribute('aria-controls', list.id);
  root.append(button, list);
  select.after(root);
  select.classList.add('branded-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const label = select.id ? document.querySelector(`label[for="${select.id}"]`) : null;
  if (label) label.htmlFor = button.id;

  function close() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function sync() {
    const option = select.selectedOptions?.[0] || select.options[select.selectedIndex];
    const text = option?.textContent?.trim() || select.getAttribute('aria-label') || '';
    button.textContent = text;
    const accessible = select.getAttribute('aria-label') || text;
    if (accessible) button.setAttribute('aria-label', accessible);
    button.disabled = select.disabled;
    if (select.disabled) close();
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const value = select.getAttribute(attribute);
      if (value) button.setAttribute(attribute, value);
      else button.removeAttribute(attribute);
    }
  }

  function open() {
    list.replaceChildren();
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'branded-select-option';
      if (language) item.classList.add('branded-select-option-language');
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      item.textContent = option.textContent.trim();
      // Opt-in help belongs to the visible option, not the clipped native select.
      if (option.dataset.controlHelp) {
        item.dataset.controlHelp = option.dataset.controlHelp;
        item.dataset.help = option.title;
        item.setAttribute('aria-description', option.title);
      }
      const selected = option.value === select.value;
      item.setAttribute('aria-selected', String(selected));
      if (typeof previewFont === 'function') {
        const family = previewFont(option.value);
        if (family) item.style.fontFamily = family;
      }
      item.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        close();
      });
      list.append(item);
    }
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  button.addEventListener('click', () => {
    if (list.hidden) open();
    else close();
  });
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  select.addEventListener('change', sync);
  const observer = new MutationObserver(sync);
  observer.observe(select, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['disabled', 'aria-label', 'aria-labelledby', 'aria-describedby'],
  });

  const api = { sync, close };
  select.brandedSelect = api;
  sync();
  return api;
}
