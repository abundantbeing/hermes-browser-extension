import { MODEL_REASONING_EFFORTS } from './model-runtime-options.mjs';

export const EFFORT_PRESENTATION_STORAGE_KEY = 'hermesBrowserEffortPresentation';
const preferenceStores = new WeakMap();

export function normalizeEffortPresentation(value) {
  return value === 'buttons' ? 'buttons' : 'slider';
}

function preferenceStore(storage) {
  if (storage && preferenceStores.has(storage)) return preferenceStores.get(storage);
  let presentation = 'slider';
  let version = 0;
  const subscribers = new Map();
  const notify = () => {
    for (const [root, apply] of subscribers) {
      if (!root.isConnected) subscribers.delete(root);
      else apply(presentation);
    }
  };
  const store = {
    get value() { return presentation; },
    attach(root, apply) {
      for (const existing of subscribers.keys()) if (!existing.isConnected) subscribers.delete(existing);
      subscribers.set(root, apply);
    },
    async select(value) {
      const next = normalizeEffortPresentation(value);
      if (next === presentation) return;
      const previous = presentation;
      const selectionVersion = ++version;
      presentation = next;
      notify();
      try {
        await storage?.local?.set({ [EFFORT_PRESENTATION_STORAGE_KEY]: next });
      } catch (error) {
        if (version === selectionVersion) {
          presentation = previous;
          notify();
        }
        throw error;
      }
    },
  };
  if (storage) {
    preferenceStores.set(storage, store);
    const readVersion = version;
    Promise.resolve(storage.local.get(EFFORT_PRESENTATION_STORAGE_KEY)).then((saved) => {
      if (version !== readVersion) return;
      presentation = normalizeEffortPresentation(saved?.[EFFORT_PRESENTATION_STORAGE_KEY]);
      notify();
    }).catch(() => { /* Keep the usable Slider default when storage cannot be read. */ });
    storage.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !Object.hasOwn(changes, EFFORT_PRESENTATION_STORAGE_KEY)) return;
      const next = normalizeEffortPresentation(changes[EFFORT_PRESENTATION_STORAGE_KEY]?.newValue);
      if (next === presentation) return;
      version += 1;
      presentation = next;
      notify();
    });
  }
  return store;
}

export function createEffortControl({
  documentRef = globalThis.document,
  value = 'medium',
  buttons,
  storage,
  translate = (text) => text,
  effortLabel = (option) => translate(option.label),
  onCommit = () => {},
  onError = () => {},
  disabled = false,
  surface = 'panel',
} = {}) {
  const doc = documentRef;
  const make = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const root = make('div', 'effort-control');
  root.dataset.effortSurface = surface;
  root.dataset.i18nRuntime = '';
  const header = make('div', 'effort-control-header');
  const heading = make('div', 'effort-control-heading');
  const title = make('span', 'effort-control-title', translate('Effort'));
  const selected = make('strong', 'effort-control-value');
  heading.append(title, selected);
  const views = make('div', 'effort-control-views');
  views.setAttribute('role', 'radiogroup');
  views.setAttribute('aria-label', translate('Effort display'));
  const viewButtons = ['slider', 'buttons'].map((view) => {
    const button = make('button', 'effort-control-view', translate(view === 'slider' ? 'Slider' : 'Buttons'));
    button.type = 'button';
    button.dataset.effortView = view;
    button.setAttribute('role', 'radio');
    views.append(button);
    return button;
  });
  header.append(heading, views);

  const slider = make('div', 'effort-control-slider');
  const ends = make('div', 'effort-control-ends');
  ends.append(make('span', '', translate('Less effort')), make('span', '', translate('More effort')));
  const track = make('div', 'effort-control-track');
  const lane = make('div', 'effort-control-lane');
  lane.setAttribute('aria-hidden', 'true');
  lane.append(make('span', 'effort-control-fill'));
  for (const [index] of MODEL_REASONING_EFFORTS.entries()) {
    const stop = make('i', 'effort-control-stop');
    stop.style.setProperty('--effort-stop', `${index / (MODEL_REASONING_EFFORTS.length - 1) * 100}%`);
    lane.append(stop);
  }
  const range = make('input', 'effort-control-range');
  range.type = 'range';
  range.min = '0';
  range.max = String(MODEL_REASONING_EFFORTS.length - 1);
  range.step = '1';
  range.disabled = disabled;
  range.setAttribute('aria-label', translate('Reasoning effort'));
  range.title = translate('Higher effort can take more time and tokens.');
  range.dir = 'ltr';
  track.append(lane, range);
  const sparks = make('span', 'effort-control-sparks');
  sparks.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 48; index += 1) {
    const spark = make('i', 'effort-control-spark');
    spark.style.setProperty('--spark-x', `${6 + index * 29 % 89}%`);
    spark.style.setProperty('--spark-delay', `${index * 137 % 1700}ms`);
    spark.style.setProperty('--spark-drift', `${index % 2 ? 13 : -9}px`);
    spark.style.setProperty('--spark-rise', `${14 + index % 3 * 7}px`);
    sparks.append(spark);
  }
  slider.append(ends, track, sparks);
  const legacyButtons = buttons || make('div');
  const status = make('p', 'effort-control-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  root.append(header, slider, legacyButtons, status);

  const initial = MODEL_REASONING_EFFORTS.findIndex((option) => option.value === value);
  let committedIndex = initial >= 0 ? initial : 2;
  let cancelled = false;
  let pointerActive = false;
  const preview = (index) => {
    const bounded = Math.max(0, Math.min(MODEL_REASONING_EFFORTS.length - 1, Math.round(Number(index) || 0)));
    const option = MODEL_REASONING_EFFORTS[bounded];
    range.value = String(bounded);
    const label = effortLabel(option);
    selected.textContent = label;
    range.setAttribute('aria-valuetext', label);
    root.style.setProperty('--effort-progress', String(bounded / (MODEL_REASONING_EFFORTS.length - 1)));
    root.dataset.effortValue = option.value;
    root.dataset.effortCharge = option.value === 'ultra' || option.value === 'max' ? option.value : 'standard';
    for (const [position, stop] of lane.querySelectorAll('.effort-control-stop').entries()) {
      stop.dataset.reached = String(position <= bounded);
    }
  };
  const revert = () => {
    cancelled = true;
    pointerActive = false;
    delete root.dataset.effortDragging;
    preview(committedIndex);
  };
  range.addEventListener('pointerdown', () => {
    cancelled = false;
    pointerActive = true;
    root.dataset.effortDragging = '';
  });
  range.addEventListener('pointerup', () => {
    pointerActive = false;
    delete root.dataset.effortDragging;
  });
  range.addEventListener('pointercancel', revert);
  range.addEventListener('lostpointercapture', () => { if (pointerActive) revert(); });
  range.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') revert();
    else cancelled = false;
  });
  range.addEventListener('input', () => { if (!disabled && !cancelled) preview(range.value); });
  range.addEventListener('change', () => {
    if (disabled || cancelled || !root.isConnected) return;
    const nextIndex = Number(range.value);
    if (nextIndex === committedIndex) return;
    committedIndex = nextIndex;
    preview(nextIndex);
    onCommit(MODEL_REASONING_EFFORTS[nextIndex].value);
  });
  preview(committedIndex);

  const store = preferenceStore(storage);
  const applyPresentation = (presentation) => {
    const focusWasHidden = presentation === 'buttons' ? slider.contains(doc.activeElement) : legacyButtons.contains(doc.activeElement);
    root.dataset.effortPresentation = presentation;
    slider.hidden = presentation !== 'slider';
    legacyButtons.hidden = presentation !== 'buttons';
    for (const button of viewButtons) {
      const checked = button.dataset.effortView === presentation;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    if (presentation === 'buttons') revert();
    if (focusWasHidden) viewButtons.find((button) => button.dataset.effortView === presentation)?.focus();
  };
  const selectPresentation = async (presentation) => {
    status.hidden = true;
    try { await store.select(presentation); }
    catch (error) {
      status.textContent = translate('Could not save the effort display.');
      status.hidden = false;
      onError(error);
    }
  };
  for (const button of viewButtons) {
    button.addEventListener('click', () => { void selectPresentation(button.dataset.effortView); });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - viewButtons.indexOf(button);
      void selectPresentation(viewButtons[next].dataset.effortView);
      viewButtons[next].focus();
    });
  }
  applyPresentation(store.value);
  store.attach(root, applyPresentation);
  return root;
}
