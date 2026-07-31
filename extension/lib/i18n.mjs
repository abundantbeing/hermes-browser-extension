// ============================================================
// Hermes Browser Extension — lightweight runtime i18n
// Design: dictionary keys are the English originals. English is
// zero-cost by default; switching to another language replaces
// matching keys with their translations.
// - Static HTML: elements carry data-i18n="English original" /
//   data-i18n-title / data-i18n-placeholder / data-i18n-aria-label
// - Dynamic JS text: after setLanguage, a MutationObserver
//   auto-translates inserted nodes by whole-string dictionary match
// ============================================================

import { ZH_DICTIONARY } from './i18n-zh.mjs';

const LANGUAGE_STORAGE_KEY = 'hermesBrowserLanguage';
const SUPPORTED_LANGUAGES = Object.freeze(['en', 'zh']);

let currentLanguage = 'en';
let observer = null;

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'en';
}

/** Translate a single string: dictionary hit returns the translation, otherwise the original. */
export function t(key) {
  if (currentLanguage === 'zh' && typeof key === 'string' && key) {
    return ZH_DICTIONARY[key] || key;
  }
  return key;
}

/** Current language (cached value). */
export function getLanguage() {
  return currentLanguage;
}

/** Persist and apply the language; returns the effective language. */
export async function setLanguage(language) {
  const normalized = normalizeLanguage(language);
  currentLanguage = normalized;
  try {
    await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: normalized });
  } catch {
    // storage unavailable in test environments — cache still applies
  }
  if (typeof document !== 'undefined') applyI18n(document);
  return normalized;
}

/** Load the language from storage and apply it (call once at startup). */
export async function initI18n(root = document) {
  let stored = 'en';
  try {
    const result = await chrome.storage.local.get(LANGUAGE_STORAGE_KEY);
    stored = result[LANGUAGE_STORAGE_KEY] || 'en';
  } catch {
    // storage unavailable — keep default
  }
  currentLanguage = normalizeLanguage(stored);
  applyI18n(root);
  startI18nObserver();
  return currentLanguage;
}

/** Localize a single element (data-i18n and its attribute variants). */
function localizeElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
  if (element.hasAttribute('data-i18n')) {
    const key = element.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== key) {
      if (element.childElementCount === 0) {
        element.textContent = translated;
      } else {
        // Element has children (e.g. <li>text <code>x</code> tail</li>):
        // only replace the direct text child that matches the key.
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() === key) {
            child.textContent = translated;
          }
        }
      }
    }
  }
  if (element.hasAttribute('data-i18n-title')) {
    element.title = t(element.getAttribute('data-i18n-title'));
  }
  if (element.hasAttribute('data-i18n-placeholder')) {
    element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
  }
  if (element.hasAttribute('data-i18n-aria-label')) {
    element.setAttribute('aria-label', t(element.getAttribute('data-i18n-aria-label')));
  }
  if (element.hasAttribute('data-i18n-alt')) {
    element.setAttribute('alt', t(element.getAttribute('data-i18n-alt')));
  }
  if (element.hasAttribute('data-i18n-value')) {
    element.value = t(element.getAttribute('data-i18n-value'));
  }
}

/** Whether a text node should be skipped (user content / input areas stay untranslated). */
function shouldSkipTextNode(node) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (parent.closest?.('.message-content, .transcript, textarea, input, [contenteditable="true"], .composer, .user-message, .assistant-message')) return true;
  // Skip nodes already handled through data-i18n to avoid double translation
  if (parent.hasAttribute?.('data-i18n')) return true;
  return false;
}

/** Localize a whole subtree. */
export function applyI18n(root = document) {
  if (!root || typeof document === 'undefined' || typeof NodeFilter === 'undefined') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      localizeElement(node);
    } else if (currentLanguage === 'zh' && !shouldSkipTextNode(node)) {
      const raw = node.textContent;
      if (raw && raw === raw.trim() && ZH_DICTIONARY[raw]) {
        node.textContent = ZH_DICTIONARY[raw];
      }
    }
  }
}

/** Watch DOM mutations: auto-localize inserted data-i18n elements and whole-string text nodes. */
export function startI18nObserver() {
  if (observer) return observer;
  observer = new MutationObserver((mutations) => {
    if (currentLanguage !== 'zh') return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          localizeElement(node);
          if (node.children?.length) {
            const elements = node.querySelectorAll?.('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-alt], [data-i18n-value]');
            if (elements) for (const el of elements) localizeElement(el);
          }
          // Whole-string match on direct text children
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE && !shouldSkipTextNode(child)) {
              const raw = child.textContent;
              if (raw && raw === raw.trim() && ZH_DICTIONARY[raw]) child.textContent = ZH_DICTIONARY[raw];
            }
          }
        } else if (node.nodeType === Node.TEXT_NODE && !shouldSkipTextNode(node)) {
          const raw = node.textContent;
          if (raw && raw === raw.trim() && ZH_DICTIONARY[raw]) node.textContent = ZH_DICTIONARY[raw];
        }
      }
    }
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch {
    observer = null;
  }
  return observer;
}

export function stopI18nObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}
