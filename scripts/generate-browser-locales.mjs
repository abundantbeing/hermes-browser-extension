import fs from 'node:fs';
import path from 'node:path';

import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';

const root = path.resolve(import.meta.dirname, '..');
const checkOnly = process.argv.includes('--check');
const generatedContentBridgePath = path.join(root, 'extension/lib/i18n-content.js');
const NATIVE_MESSAGE_KEYS = Object.freeze({
  extensionName: 'manifest.extension_name',
  extensionShortName: 'manifest.extension_short_name',
  extensionDescription: 'manifest.extension_description',
  openExtension: 'manifest.open_extension',
  openSidebar: 'manifest.open_sidebar',
});

function chromeMessageName(key) {
  return `runtime_${key}`.replace(/[^A-Za-z0-9_]/g, '_');
}

function stringMessage(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  return entry.other ?? entry.one ?? Object.values(entry).find((value) => typeof value === 'string') ?? '';
}

function serializeMessages(locale, runtimeMessages) {
  const native = Object.fromEntries(Object.entries(NATIVE_MESSAGE_KEYS).map(([name, key]) => [name, stringMessage(runtimeMessages[key])]));
  const missingNative = Object.entries(native).filter(([, message]) => !message).map(([name]) => name);
  if (missingNative.length) throw new Error(`Missing browser-native copy for ${locale.id}: ${missingNative.join(', ')}`);
  const messages = {};
  for (const [name, message] of Object.entries(native)) {
    messages[name] = { message, description: `Hermes Browser ${name}` };
  }
  for (const [key, entry] of Object.entries(runtimeMessages).sort(([left], [right]) => left.localeCompare(right))) {
    messages[chromeMessageName(key)] = {
      message: stringMessage(entry),
      description: `Runtime interface message ${key}`,
    };
  }
  return `${JSON.stringify(messages, null, 2)}\n`;
}

const mismatches = [];
const runtimeCatalogs = {};
for (const locale of SUPPORTED_LOCALES) {
  const runtimeMessages = await loadLocaleMessages(locale.id);
  runtimeCatalogs[locale.id] = runtimeMessages;
  const expected = serializeMessages(locale, runtimeMessages);
  for (const base of ['_locales', 'extension/_locales']) {
    const filePath = path.join(root, base, locale.browserDirectory, 'messages.json');
    if (checkOnly) {
      const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      if (actual !== expected) mismatches.push(path.relative(root, filePath));
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, expected);
  }
}

function contentBridgeSource() {
  const helperSource = fs.readFileSync(path.join(root, 'extension/content-inline-helper.js'), 'utf8');
  const english = runtimeCatalogs.en || {};
  const eligibleKeys = Object.entries(english)
    .filter(([, message]) => typeof message === 'string' && helperSource.includes(message))
    .map(([key]) => key);
  const catalogs = Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [
    locale.id,
    Object.fromEntries(eligibleKeys.map((key) => {
      const englishMessage = english[key];
      const translated = runtimeCatalogs[locale.id]?.[key];
      return [englishMessage, typeof translated === 'string' ? translated : englishMessage];
    })),
  ]));
  const aliases = Object.fromEntries(SUPPORTED_LOCALES.flatMap((locale) => locale.aliases.map((alias) => [
    alias.replaceAll('_', '-').toLowerCase(),
    locale.id,
  ])));
  return `(() => {\n  const browserApi = globalThis.hermesBrowserApi;\n  const STORAGE_KEY = 'hermesBrowserLocale';\n  const catalogs = Object.freeze(${JSON.stringify(catalogs)});\n  const aliases = Object.freeze(${JSON.stringify(aliases)});\n  let locale = 'en';\n  let storageRevision = 0;\n  const subscribers = new Set();\n\n  function normalize(value) {\n    const raw = String(value || '').replace(/_/g, '-');\n    let candidate = raw;\n    try { [candidate] = Intl.getCanonicalLocales(raw); } catch { return 'en'; }\n    const aliased = aliases[candidate.toLowerCase()];\n    if (aliased) return aliased;\n    const exact = Object.keys(catalogs).find((id) => id.toLowerCase() === candidate.toLowerCase());\n    if (exact) return exact;\n    const base = candidate.split('-')[0].toLowerCase();\n    return aliases[base] || Object.keys(catalogs).find((id) => id.toLowerCase() === base) || 'en';\n  }\n\n  function translateText(value) {\n    if (typeof value !== 'string' || locale === 'en') return value;\n    const leading = value.match(/^\\s*/)?.[0] || '';\n    const trailing = value.match(/\\s*$/)?.[0] || '';\n    const end = trailing.length ? value.length - trailing.length : value.length;\n    const message = value.slice(leading.length, end);\n    return catalogs[locale]?.[message] ? leading + catalogs[locale][message] + trailing : value;\n  }\n\n  function storageChanged(changes, areaName) {\n    if (areaName && areaName !== 'local' || !changes?.[STORAGE_KEY]) return;\n    storageRevision += 1;\n    const next = normalize(changes[STORAGE_KEY].newValue);\n    if (next === locale) return;\n    locale = next;\n    for (const subscriber of subscribers) subscriber({ locale, translateText });\n  }\n\n  async function initialize() {\n    const startingRevision = storageRevision;\n    browserApi.storage.onChanged.addListener(storageChanged);\n    const stored = await browserApi.storage.local.get(STORAGE_KEY).catch(() => ({}));\n    if (storageRevision === startingRevision) locale = normalize(stored?.[STORAGE_KEY]);\n    return locale;\n  }\n\n  const ready = initialize();\n  globalThis.HermesI18nContent = Object.freeze({\n    getLocale: () => locale,\n    ready,\n    subscribe(subscriber) {\n      if (typeof subscriber !== 'function') return () => {};\n      subscribers.add(subscriber);\n      return () => subscribers.delete(subscriber);\n    },\n    translateText,\n  });\n})();\n`;
}

const expectedContentBridge = contentBridgeSource();
if (checkOnly) {
  const actual = fs.existsSync(generatedContentBridgePath) ? fs.readFileSync(generatedContentBridgePath, 'utf8') : '';
  if (actual !== expectedContentBridge) mismatches.push(path.relative(root, generatedContentBridgePath));
} else {
  fs.writeFileSync(generatedContentBridgePath, expectedContentBridge);
}

if (mismatches.length) {
  console.error(`Browser locale packs are stale or missing:\n${mismatches.map((file) => `- ${file}`).join('\n')}\nRun npm run generate:browser-locales.`);
  process.exit(1);
}

console.log(`${checkOnly ? 'Verified' : 'Generated'} ${SUPPORTED_LOCALES.length} browser-native locale packs and the Hermes Assist bridge.`);
