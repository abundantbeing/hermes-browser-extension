import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  LOCALE_STORAGE_KEY,
  createI18nRuntime,
  formatMessage,
  localeDirection,
  normalizeLocale,
  populateLanguageSelect,
} from '../extension/lib/i18n.mjs';
import { SUPPORTED_LOCALES } from '../extension/lib/i18n-registry.mjs';

test('ships the exact 21-locale registry with endonyms, aliases, and Arabic RTL', () => {
  assert.deepEqual(
    SUPPORTED_LOCALES.map((locale) => locale.id),
    ['en', 'es', 'pt-BR', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'it', 'nl', 'pl', 'tr', 'ru', 'uk', 'hi', 'id', 'vi', 'th', 'ar', 'da'],
  );
  assert.equal(normalizeLocale('ZH_hant'), 'zh-TW');
  assert.equal(normalizeLocale('pt-PT'), 'pt-BR');
  assert.equal(normalizeLocale('da-DK'), 'da');
  assert.equal(localeDirection('ar-EG'), 'rtl');
  assert.equal(SUPPORTED_LOCALES.find((locale) => locale.id === 'th')?.nativeName, 'ไทย');
  assert.equal(SUPPORTED_LOCALES.find((locale) => locale.id === 'da')?.nativeName, 'Dansk');
});

test('populates the shared language selector with all 21 invariant endonyms', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ dataset: {}, value: '', textContent: '' }),
  };
  try {
    const select = {
      options: [{ value: 'en' }],
      replaceChildren(...options) { this.options = options; },
    };
    populateLanguageSelect(select);
    assert.equal(select.options.length, 21);
    assert.deepEqual(select.options.slice(0, 5).map(({ value }) => value), ['en', 'es', 'pt-BR', 'zh-CN', 'zh-TW']);
    assert.equal(select.options.find(({ value }) => value === 'th')?.textContent, 'ไทย');
    assert.equal(select.options.find(({ value }) => value === 'ar')?.textContent, 'العربية');
    assert.equal(select.options.find(({ value }) => value === 'da')?.textContent, 'Dansk');
    assert.ok(select.options.every((option) => Object.hasOwn(option.dataset, 'i18nInvariant')));
  } finally {
    globalThis.document = previousDocument;
  }
});

function createSharedStorage(initial = {}) {
  const state = { ...initial };
  const listeners = new Set();
  return {
    area: {
      async get(key) {
        return { [key]: state[key] };
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          const oldValue = state[key];
          state[key] = value;
          changes[key] = { oldValue, newValue: value };
        }
        for (const listener of listeners) listener(changes, 'local');
      },
    },
    events: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
    },
  };
}

const catalogs = {
  en: {
    'settings.language.label': 'Language',
    'settings.language.description': 'Choose the interface language.',
    'tasks.summary': '{complete} complete · {active} active',
    'items.count': { one: '{count} item', other: '{count} items' },
  },
  'zh-CN': {
    'settings.language.label': '语言',
    'settings.language.description': '选择界面语言。',
    'tasks.summary': '已完成 {complete} · 进行中 {active}',
    'items.count': { other: '{count} 项' },
  },
};

const loadMessages = async (locale) => catalogs[locale] || catalogs.en;

test('normalizes supported BCP 47 aliases and rejects malformed locales', () => {
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-hans'), 'zh-CN');
  assert.equal(normalizeLocale('ZH_cn'), 'zh-CN');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('../../zh-CN'), 'en');
  assert.equal(normalizeLocale('not-a-real-locale'), 'en');
});

test('formats named parameters and locale plural categories without producing markup', () => {
  assert.equal(formatMessage('{name} <b>{count}</b>', { name: 'Hermes', count: 2 }, 'en'), 'Hermes <b>2</b>');
  assert.equal(formatMessage({ one: '{count} item', other: '{count} items' }, { count: 1 }, 'en'), '1 item');
  assert.equal(formatMessage({ one: '{count} item', other: '{count} items' }, { count: 3 }, 'en'), '3 items');
  assert.equal(localeDirection('zh-CN'), 'ltr');
  assert.equal(localeDirection('ar'), 'rtl');
});

test('synchronizes two open extension documents without translating runtime or user truth', async () => {
  const shared = createSharedStorage({ [LOCALE_STORAGE_KEY]: 'en' });
  const first = parseHTML(`<!doctype html><html lang="en"><body>
    <span data-i18n="settings.language.label">Language</span>
    <label><span data-i18n="settings.language.description">Choose the interface language.</span><select><option>English</option><option>简体中文</option></select></label>
    <strong id="runtimeTitle">User session title</strong>
    <p class="message-content">Settings</p>
    <input data-i18n-placeholder="settings.language.description" placeholder="Choose the interface language.">
  </body></html>`);
  const second = parseHTML(`<!doctype html><html lang="en"><body><span data-i18n="settings.language.label">Language</span></body></html>`);

  const runtimeA = createI18nRuntime({
    documentRef: first.document,
    storageArea: shared.area,
    storageEvents: shared.events,
    loadMessages,
  });
  const runtimeB = createI18nRuntime({
    documentRef: second.document,
    storageArea: shared.area,
    storageEvents: shared.events,
    loadMessages,
  });

  await Promise.all([runtimeA.init(), runtimeB.init()]);
  const runtimeBSynchronized = new Promise((resolve) => {
    const unsubscribe = runtimeB.subscribe(({ locale }) => {
      if (locale !== 'zh-CN') return;
      unsubscribe();
      resolve();
    });
  });
  await runtimeA.setLocale('zh-CN');
  await runtimeBSynchronized;

  assert.equal(first.document.querySelector('[data-i18n]').textContent, '语言');
  assert.equal(second.document.querySelector('[data-i18n]').textContent, '语言');
  assert.equal(runtimeA.translateText('Language'), '语言');
  assert.equal(runtimeA.translateText('Jon’s Settings'), 'Jon’s Settings');
  assert.equal(first.document.querySelector('input').placeholder, '选择界面语言。');
  assert.equal(first.document.querySelector('#runtimeTitle').textContent, 'User session title');
  assert.equal(first.document.querySelector('.message-content').textContent, 'Settings');
  assert.deepEqual([...first.document.querySelectorAll('option')].map((option) => option.textContent), ['English', '简体中文']);
  assert.equal(first.document.documentElement.lang, 'zh-CN');
  assert.equal(first.document.documentElement.dir, 'ltr');
  assert.equal(runtimeA.t('tasks.summary', { complete: 2, active: 1 }), '已完成 2 · 进行中 1');
  assert.equal(runtimeA.t('unknown.key'), 'unknown.key');

  const runtimeASynchronized = new Promise((resolve) => {
    const unsubscribe = runtimeA.subscribe(({ locale }) => {
      if (locale !== 'en') return;
      unsubscribe();
      resolve();
    });
  });
  await runtimeB.setLocale('en');
  await runtimeASynchronized;
  assert.equal(first.document.querySelector('[data-i18n]').textContent, 'Language');
  assert.equal(second.document.querySelector('[data-i18n]').textContent, 'Language');
  assert.equal(first.document.querySelector('#runtimeTitle').textContent, 'User session title');

  runtimeA.destroy();
  runtimeB.destroy();
});

test('a locale storage event during initialization wins over the stale storage snapshot', async () => {
  let resolveGet;
  let resolveChangedLocale;
  const listeners = new Set();
  const runtime = createI18nRuntime({
    storageArea: {
      get() {
        return new Promise((resolve) => { resolveGet = resolve; });
      },
      async set() {},
    },
    storageEvents: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
    },
    loadMessages: async (locale) => {
      if (locale !== 'zh-CN') return catalogs.en;
      return new Promise((resolve) => { resolveChangedLocale = () => resolve(catalogs['zh-CN']); });
    },
  });

  const initializing = runtime.init();
  assert.equal(listeners.size, 1);
  for (const listener of listeners) {
    listener({ [LOCALE_STORAGE_KEY]: { oldValue: 'en', newValue: 'zh-CN' } }, 'local');
  }
  resolveGet({ [LOCALE_STORAGE_KEY]: 'en' });

  const initializedFromStaleSnapshot = await Promise.race([
    initializing.then(() => true),
    new Promise((resolve) => globalThis.setTimeout(() => resolve(false), 0)),
  ]);
  assert.equal(initializedFromStaleSnapshot, false);

  resolveChangedLocale();
  await initializing;

  assert.equal(runtime.getLocale(), 'zh-CN');
  runtime.destroy();
});
