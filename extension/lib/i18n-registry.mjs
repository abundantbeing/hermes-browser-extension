export const DEFAULT_LOCALE = 'en';

const LOCALE_DEFINITIONS = [
  {
    id: 'en',
    nativeName: 'English',
    direction: 'ltr',
    browserDirectory: 'en',
    aliases: ['en', 'en-US', 'en-GB'],
    load: () => import('./locales/en.mjs'),
  },
  {
    id: 'zh-CN',
    nativeName: '简体中文',
    direction: 'ltr',
    browserDirectory: 'zh_CN',
    aliases: ['zh', 'zh-CN', 'zh-Hans', 'zh-SG'],
    load: () => import('./locales/zh-CN.mjs'),
  },
];

export const SUPPORTED_LOCALES = Object.freeze(LOCALE_DEFINITIONS.map(({ load: _load, ...locale }) => Object.freeze(locale)));

const LOCALE_BY_ID = new Map(LOCALE_DEFINITIONS.map((locale) => [locale.id, locale]));
const ALIAS_TO_ID = new Map();
const RTL_LANGUAGES = new Set(['ar', 'dv', 'fa', 'he', 'ku', 'ps', 'ur']);
for (const locale of LOCALE_DEFINITIONS) {
  for (const alias of locale.aliases) ALIAS_TO_ID.set(alias.toLowerCase(), locale.id);
}

function canonicalCandidate(value) {
  const candidate = String(value || '').trim().replaceAll('_', '-');
  if (!candidate || candidate.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(candidate)) return '';
  try {
    return Intl.getCanonicalLocales(candidate)[0] || '';
  } catch {
    return '';
  }
}

export function normalizeLocale(value) {
  const canonical = canonicalCandidate(value);
  if (!canonical) return DEFAULT_LOCALE;
  const exact = ALIAS_TO_ID.get(canonical.toLowerCase());
  if (exact) return exact;
  const language = canonical.split('-')[0].toLowerCase();
  return ALIAS_TO_ID.get(language) || DEFAULT_LOCALE;
}

export function localeMetadata(value) {
  return LOCALE_BY_ID.get(normalizeLocale(value)) || LOCALE_BY_ID.get(DEFAULT_LOCALE);
}

export function localeDirection(value) {
  const canonical = canonicalCandidate(value);
  const language = canonical.split('-')[0].toLowerCase();
  if (RTL_LANGUAGES.has(language)) return 'rtl';
  return localeMetadata(value).direction;
}

export async function loadLocaleMessages(value) {
  const locale = localeMetadata(value);
  const loaded = await locale.load();
  return loaded.default || loaded.messages || {};
}
