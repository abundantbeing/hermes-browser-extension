import {
  DEFAULT_LOCALE,
  loadLocaleMessages,
  localeDirection,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from './i18n-registry.mjs';

import { getBrowserApi } from './browser-api.mjs';

export { DEFAULT_LOCALE, localeDirection, normalizeLocale } from './i18n-registry.mjs';

export const LOCALE_STORAGE_KEY = 'hermesBrowserLocale';

export function populateLanguageSelect(select) {
  if (!select) return;
  const expected = SUPPORTED_LOCALES.map((locale) => locale.id).join('|');
  const current = Array.from(select.options || [], (option) => option.value).join('|');
  if (current === expected) return;
  const options = SUPPORTED_LOCALES.map((locale) => {
    const option = document.createElement('option');
    option.value = locale.id;
    option.textContent = locale.nativeName;
    option.dataset.i18nInvariant = '';
    return option;
  });
  select.replaceChildren(...options);
}

const ATTRIBUTE_MARKERS = Object.freeze({
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-title': 'title',
  'data-i18n-aria-label': 'aria-label',
  'data-i18n-alt': 'alt',
});

function interpolate(message, params = {}) {
  return String(message).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name];
    return value == null ? '' : String(value);
  });
}

export function formatMessage(entry, params = {}, locale = DEFAULT_LOCALE) {
  let message = entry;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const count = Number(params.count);
    const category = Number.isFinite(count)
      ? new Intl.PluralRules(normalizeLocale(locale)).select(count)
      : 'other';
    message = entry[category] ?? entry.other ?? entry.one ?? '';
  }
  return interpolate(message ?? '', params);
}

function defaultStorageArea() {
  return getBrowserApi()?.storage?.local || null;
}

function defaultStorageEvents() {
  return getBrowserApi()?.storage?.onChanged || null;
}

function defaultDocument() {
  return globalThis.document || null;
}

export function createI18nRuntime({
  documentRef = defaultDocument(),
  storageArea = defaultStorageArea(),
  storageEvents = defaultStorageEvents(),
  loadMessages = loadLocaleMessages,
} = {}) {
  let locale = DEFAULT_LOCALE;
  let englishMessages = {};
  let englishKeyByMessage = new Map();
  let activeMessages = {};
  let initialized = false;
  let destroyed = false;
  let storageRevision = 0;
  let latestStorageLocale = null;
  let pendingStorageApply = Promise.resolve();
  const subscribers = new Set();
  const messageCache = new Map();

  async function messagesFor(nextLocale) {
    const normalized = normalizeLocale(nextLocale);
    if (!messageCache.has(normalized)) {
      messageCache.set(normalized, Promise.resolve(loadMessages(normalized)).then((messages) => messages || {}));
    }
    return messageCache.get(normalized);
  }

  function t(key, params = {}) {
    const entry = activeMessages[key] ?? englishMessages[key];
    if (entry == null) return String(key || '');
    return formatMessage(entry, params, locale);
  }

  function translateText(value) {
    if (typeof value !== 'string' || locale === DEFAULT_LOCALE) return value;
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    const end = trailing.length ? value.length - trailing.length : value.length;
    const message = value.slice(leading.length, end);
    const key = englishKeyByMessage.get(message);
    return key ? `${leading}${t(key)}${trailing}` : value;
  }

  function localize(root = documentRef) {
    if (!root?.querySelectorAll) return;
    const html = root.documentElement || root.ownerDocument?.documentElement;
    if (html) {
      html.lang = locale;
      html.dir = localeDirection(locale);
    }
    for (const element of root.querySelectorAll('[data-i18n]')) {
      const key = element.getAttribute('data-i18n');
      if (key) element.textContent = t(key);
    }
    for (const [marker, attribute] of Object.entries(ATTRIBUTE_MARKERS)) {
      for (const element of root.querySelectorAll(`[${marker}]`)) {
        const key = element.getAttribute(marker);
        if (key) element.setAttribute(attribute, t(key));
      }
    }
  }

  async function applyLocale(value, { notify = true } = {}) {
    const normalized = normalizeLocale(value);
    englishMessages = await messagesFor(DEFAULT_LOCALE);
    englishKeyByMessage = new Map(
      Object.entries(englishMessages)
        .filter(([, message]) => typeof message === 'string')
        .map(([key, message]) => [message, key]),
    );
    activeMessages = normalized === DEFAULT_LOCALE
      ? englishMessages
      : await messagesFor(normalized);
    locale = normalized;
    localize();
    if (notify) {
      for (const subscriber of subscribers) await subscriber({ locale, direction: localeDirection(locale), t });
    }
    return locale;
  }

  function storageChanged(changes, areaName) {
    if (destroyed || (areaName && areaName !== 'local')) return;
    const changed = changes?.[LOCALE_STORAGE_KEY];
    if (!changed || normalizeLocale(changed.newValue) === locale) return;
    const nextLocale = changed.newValue;
    storageRevision += 1;
    latestStorageLocale = nextLocale;
    pendingStorageApply = pendingStorageApply
      .catch(() => {})
      .then(() => applyLocale(nextLocale));
    return pendingStorageApply;
  }

  async function settleStorageChanges() {
    while (true) {
      const pending = pendingStorageApply;
      await pending;
      if (pending === pendingStorageApply) break;
    }
    if (latestStorageLocale != null && normalizeLocale(latestStorageLocale) !== locale) {
      await applyLocale(latestStorageLocale);
    }
  }

  async function init() {
    if (initialized) return locale;
    initialized = true;
    const startingRevision = storageRevision;
    storageEvents?.addListener?.(storageChanged);
    let storedLocale = DEFAULT_LOCALE;
    try {
      const stored = await storageArea?.get?.(LOCALE_STORAGE_KEY);
      storedLocale = stored?.[LOCALE_STORAGE_KEY] || DEFAULT_LOCALE;
    } catch {
      storedLocale = DEFAULT_LOCALE;
    }
    if (storageRevision !== startingRevision) {
      await settleStorageChanges();
      return locale;
    }
    await applyLocale(storedLocale);
    if (storageRevision !== startingRevision) await settleStorageChanges();
    return locale;
  }

  async function setLocale(value) {
    const normalized = await applyLocale(value);
    try {
      await storageArea?.set?.({ [LOCALE_STORAGE_KEY]: normalized });
    } catch {
      // The active surface still uses the selected locale when persistence is unavailable.
    }
    return normalized;
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') return () => {};
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  function destroy() {
    destroyed = true;
    subscribers.clear();
    storageEvents?.removeListener?.(storageChanged);
  }

  return Object.freeze({
    destroy,
    getLocale: () => locale,
    init,
    localize,
    setLocale,
    subscribe,
    t,
    translateText,
  });
}

const defaultRuntime = createI18nRuntime();

export const initI18n = (...args) => defaultRuntime.init(...args);
export const setLocale = (...args) => defaultRuntime.setLocale(...args);
export const localizeDocument = (...args) => defaultRuntime.localize(...args);
export const subscribeLocale = (...args) => defaultRuntime.subscribe(...args);
export const t = (...args) => defaultRuntime.t(...args);
export const translateUiText = (...args) => defaultRuntime.translateText(...args);
export const getLocale = () => defaultRuntime.getLocale();
