import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

import english from '../extension/lib/locales/en.mjs';
import { loadLocaleMessages, SUPPORTED_LOCALES } from '../extension/lib/i18n-registry.mjs';

const root = path.resolve(import.meta.dirname, '..');
const errors = [];
const markerPattern = /data-i18n(?:-placeholder|-title|-aria-label|-alt)?="([^"]+)"/g;
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const protectedTokens = ['Hermes', 'Nous', 'Chrome', 'Chromium', 'Firefox', 'GitHub', 'WebSocket', 'SSE', 'CORS', 'JSON', 'API', 'URL', 'WebUI', 'TUI'];

function placeholderNames(entry) {
  const values = typeof entry === 'string' ? [entry] : Object.values(entry || {});
  return [...new Set(values.flatMap((value) => [...String(value).matchAll(placeholderPattern)].map((match) => match[1])))].sort();
}

function leafStrings(entry) {
  if (typeof entry === 'string') return [entry];
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) return Object.values(entry).flatMap(leafStrings);
  return [];
}

function sameMessageType(left, right) {
  if (typeof left !== typeof right) return false;
  if (left && typeof left === 'object') return !Array.isArray(left) && !Array.isArray(right);
  return true;
}

function collectRuntimeOwnedIds(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const propertyToId = new Map();
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*):\s*\$\('#([^']+)'\)/g)) propertyToId.set(match[1], match[2]);
  const ids = new Set();
  for (const [property, id] of propertyToId) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`els\\.${escaped}\\.(?:textContent|innerText|innerHTML|title|placeholder)\\s*=`).test(source)
      || new RegExp(`els\\.${escaped}\\.setAttribute\\(\\s*['"](?:aria-label|title|placeholder|alt)['"]`).test(source)) ids.add(id);
  }
  return ids;
}

function ownsTranslation(node) {
  let element = node.nodeType === 1 ? node : node.parentElement;
  while (element) {
    if (element.hasAttribute?.('data-i18n')
      || element.hasAttribute?.('data-i18n-runtime')
      || element.hasAttribute?.('data-i18n-invariant')) return true;
    element = element.parentElement;
  }
  return false;
}

function nearestId(node) {
  let element = node.nodeType === 1 ? node : node.parentElement;
  while (element) {
    if (element.id) return element.id;
    element = element.parentElement;
  }
  return '';
}

function visibleCopy(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return Boolean(text && /\p{L}/u.test(text));
}

function validateReverseCoverage(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const runtimeFile = relativePath.replace(/\.html$/, '.js');
  const runtimeIds = fs.existsSync(path.join(root, runtimeFile)) ? collectRuntimeOwnedIds(runtimeFile) : new Set();
  const { document } = parseHTML(source);
  const visit = (node) => {
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (!parent || ['SCRIPT', 'STYLE', 'TEMPLATE', 'OPTION'].includes(parent.tagName)) return;
      const text = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (visibleCopy(text) && !ownsTranslation(node) && !runtimeIds.has(nearestId(node))) {
        errors.push(`${relativePath} has unowned visible text: ${JSON.stringify(text.slice(0, 100))}`);
      }
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    for (const child of node.childNodes || []) visit(child);
  };
  visit(document.documentElement);

  for (const element of document.querySelectorAll('[placeholder], [title], [aria-label], [alt]')) {
    if (ownsTranslation(element) || runtimeIds.has(nearestId(element))) continue;
    for (const attribute of ['placeholder', 'title', 'aria-label', 'alt']) {
      const value = element.getAttribute(attribute);
      if (!visibleCopy(value)) continue;
      const marker = attribute === 'placeholder' ? 'data-i18n-placeholder'
        : attribute === 'title' ? 'data-i18n-title'
          : attribute === 'aria-label' ? 'data-i18n-aria-label'
            : 'data-i18n-alt';
      if (!element.hasAttribute(marker)) errors.push(`${relativePath} has unowned ${attribute}: ${JSON.stringify(value)}`);
    }
  }
}

const englishKeys = Object.keys(english).sort();
for (const locale of SUPPORTED_LOCALES) {
  if (locale.id === 'en') continue;
  let catalog;
  try {
    catalog = await loadLocaleMessages(locale.id);
  } catch (error) {
    errors.push(`${locale.id} catalog failed to load: ${error?.message || String(error)}`);
    continue;
  }
  const localeKeys = Object.keys(catalog).sort();
  const missing = englishKeys.filter((key) => !Object.hasOwn(catalog, key));
  const stale = localeKeys.filter((key) => !Object.hasOwn(english, key));
  if (missing.length) errors.push(`${locale.id} missing keys: ${missing.join(', ')}`);
  if (stale.length) errors.push(`${locale.id} stale keys: ${stale.join(', ')}`);
  for (const key of englishKeys) {
    if (!Object.hasOwn(catalog, key)) continue;
    if (!sameMessageType(english[key], catalog[key])) {
      errors.push(`${locale.id} message type mismatch for ${key}`);
      continue;
    }
    const expected = placeholderNames(english[key]);
    const actual = placeholderNames(catalog[key]);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      errors.push(`${locale.id} placeholder mismatch for ${key}: expected [${expected}], received [${actual}]`);
    }
    const sourceLeaves = leafStrings(english[key]);
    const translatedLeaves = leafStrings(catalog[key]);
    for (let index = 0; index < sourceLeaves.length; index += 1) {
      const source = sourceLeaves[index];
      const translated = translatedLeaves[index] || '';
      for (const token of protectedTokens) {
        if (source.includes(token) && !translated.includes(token)) errors.push(`${locale.id} changed protected token ${token} for ${key}`);
      }
      for (const literal of source.match(/https?:\/\/[^\s)]+|`[^`]+`/g) || []) {
        if (!translated.includes(literal)) errors.push(`${locale.id} changed protected literal ${literal} for ${key}`);
      }
    }
  }
}

for (const relativePath of [
  'extension/sidepanel.html',
  'extension/app.html',
  'extension/request-permissions.html',
  'extension/voice-dictation.html',
]) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  for (const match of source.matchAll(markerPattern)) {
    if (!Object.hasOwn(english, match[1])) errors.push(`${relativePath} references unknown key ${match[1]}`);
  }
  validateReverseCoverage(relativePath);
}

for (const relativePath of ['extension/sidepanel.html', 'extension/app.html']) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const select = source.match(/<select[^>]+data-language-select[\s\S]*?<\/select>/)?.[0] || '';
  if (!select) errors.push(`${relativePath} is missing the language selector`);
  if (!select.includes('<option value="en">English</option>')) errors.push(`${relativePath} is missing the English endonym`);
  if (!select.includes('<option value="zh-CN">简体中文</option>')) errors.push(`${relativePath} is missing the Simplified Chinese endonym`);
  if (/<option[^>]+data-i18n/.test(select)) errors.push(`${relativePath} must keep language endonyms invariant`);
}

if (errors.length) {
  console.error(`i18n validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`i18n OK: ${englishKeys.length} messages, ${SUPPORTED_LOCALES.length} locales, 4 extension surfaces`);
