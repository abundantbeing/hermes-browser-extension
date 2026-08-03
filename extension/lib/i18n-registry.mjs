import arMessages from './locales/ar.mjs';
import daMessages from './locales/da.mjs';
import deMessages from './locales/de.mjs';
import enMessages from './locales/en.mjs';
import esMessages from './locales/es.mjs';
import frMessages from './locales/fr.mjs';
import hiMessages from './locales/hi.mjs';
import idMessages from './locales/id.mjs';
import itMessages from './locales/it.mjs';
import jaMessages from './locales/ja.mjs';
import koMessages from './locales/ko.mjs';
import nlMessages from './locales/nl.mjs';
import plMessages from './locales/pl.mjs';
import ptBrMessages from './locales/pt-BR.mjs';
import ruMessages from './locales/ru.mjs';
import thMessages from './locales/th.mjs';
import trMessages from './locales/tr.mjs';
import ukMessages from './locales/uk.mjs';
import viMessages from './locales/vi.mjs';
import zhCnMessages from './locales/zh-CN.mjs';
import zhTwMessages from './locales/zh-TW.mjs';

export const DEFAULT_LOCALE = 'en';

const LOCALE_DEFINITIONS = [
  {
    id: 'en',
    nativeName: 'English',
    direction: 'ltr',
    browserDirectory: 'en',
    aliases: ['en', 'en-US', 'en-GB'],
    messages: enMessages,
  },
  { id: 'es', nativeName: 'Español', direction: 'ltr', browserDirectory: 'es', aliases: ['es'], messages: esMessages },
  { id: 'pt-BR', nativeName: 'Português (Brasil)', direction: 'ltr', browserDirectory: 'pt_BR', aliases: ['pt', 'pt-BR'], messages: ptBrMessages },
  {
    id: 'zh-CN',
    nativeName: '简体中文',
    direction: 'ltr',
    browserDirectory: 'zh_CN',
    aliases: ['zh', 'zh-CN', 'zh-Hans', 'zh-SG'],
    messages: zhCnMessages,
  },
  { id: 'zh-TW', nativeName: '繁體中文', direction: 'ltr', browserDirectory: 'zh_TW', aliases: ['zh-TW', 'zh-Hant', 'zh-HK', 'zh-MO'], messages: zhTwMessages },
  { id: 'ja', nativeName: '日本語', direction: 'ltr', browserDirectory: 'ja', aliases: ['ja'], messages: jaMessages },
  { id: 'ko', nativeName: '한국어', direction: 'ltr', browserDirectory: 'ko', aliases: ['ko'], messages: koMessages },
  { id: 'fr', nativeName: 'Français', direction: 'ltr', browserDirectory: 'fr', aliases: ['fr'], messages: frMessages },
  { id: 'de', nativeName: 'Deutsch', direction: 'ltr', browserDirectory: 'de', aliases: ['de'], messages: deMessages },
  { id: 'it', nativeName: 'Italiano', direction: 'ltr', browserDirectory: 'it', aliases: ['it'], messages: itMessages },
  { id: 'nl', nativeName: 'Nederlands', direction: 'ltr', browserDirectory: 'nl', aliases: ['nl'], messages: nlMessages },
  { id: 'pl', nativeName: 'Polski', direction: 'ltr', browserDirectory: 'pl', aliases: ['pl'], messages: plMessages },
  { id: 'tr', nativeName: 'Türkçe', direction: 'ltr', browserDirectory: 'tr', aliases: ['tr'], messages: trMessages },
  { id: 'ru', nativeName: 'Русский', direction: 'ltr', browserDirectory: 'ru', aliases: ['ru'], messages: ruMessages },
  { id: 'uk', nativeName: 'Українська', direction: 'ltr', browserDirectory: 'uk', aliases: ['uk'], messages: ukMessages },
  { id: 'hi', nativeName: 'हिन्दी', direction: 'ltr', browserDirectory: 'hi', aliases: ['hi'], messages: hiMessages },
  { id: 'id', nativeName: 'Bahasa Indonesia', direction: 'ltr', browserDirectory: 'id', aliases: ['id'], messages: idMessages },
  { id: 'vi', nativeName: 'Tiếng Việt', direction: 'ltr', browserDirectory: 'vi', aliases: ['vi'], messages: viMessages },
  { id: 'th', nativeName: 'ไทย', direction: 'ltr', browserDirectory: 'th', aliases: ['th'], messages: thMessages },
  { id: 'ar', nativeName: 'العربية', direction: 'rtl', browserDirectory: 'ar', aliases: ['ar'], messages: arMessages },
  { id: 'da', nativeName: 'Dansk', direction: 'ltr', browserDirectory: 'da', aliases: ['da'], messages: daMessages },
];

export const SUPPORTED_LOCALES = Object.freeze(LOCALE_DEFINITIONS.map(({ messages: _messages, ...locale }) => Object.freeze(locale)));

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
  return locale.messages;
}
