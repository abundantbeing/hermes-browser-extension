// ============================================================
// Hermes Browser Extension — 轻量国际化 (i18n)
// 设计：词典 key = 英文原文。默认英文时零成本；切中文时按 key 查表替换。
// - 静态 HTML：元素加 data-i18n="英文原文" / data-i18n-title / data-i18n-placeholder
// - 动态 JS 文本：setLanguage 后由 MutationObserver 自动整段匹配翻译
// ============================================================

import { ZH_DICTIONARY } from './i18n-zh.mjs';

const LANGUAGE_STORAGE_KEY = 'hermesBrowserLanguage';
const SUPPORTED_LANGUAGES = Object.freeze(['en', 'zh']);

let currentLanguage = 'en';
let observer = null;

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'en';
}

/** 翻译单个字符串：命中词典返回译文，否则返回原文。 */
export function t(key) {
  if (currentLanguage === 'zh' && typeof key === 'string' && key) {
    return ZH_DICTIONARY[key] || key;
  }
  return key;
}

/** 读取当前语言（同步缓存值）。 */
export function getLanguage() {
  return currentLanguage;
}

/** 持久化 + 应用语言，返回实际生效的语言。 */
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

/** 从 storage 加载语言并应用（初始化时调用一次）。 */
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

/** 翻译单个元素（data-i18n 及其属性变体）。 */
function localizeElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
  if (element.hasAttribute('data-i18n')) {
    const key = element.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== key) {
      if (element.childElementCount === 0) {
        element.textContent = translated;
      } else {
        // 含子元素（如 <li>text <code>x</code> tail</li>）：只替换命中的直接文本子节点
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

/** 是否应该跳过文本节点（用户内容/输入区不翻译）。 */
function shouldSkipTextNode(node) {
  const parent = node.parentElement;
  if (!parent) return true;
  if (parent.closest?.('.message-content, .transcript, textarea, input, [contenteditable="true"], .composer, .user-message, .assistant-message')) return true;
  // 跳过已经翻译过的节点，避免死循环
  if (parent.hasAttribute?.('data-i18n')) return true;
  return false;
}

/** 翻译整棵子树。 */
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

/** 监听 DOM 变化：新插入的 data-i18n 元素 / 可整段匹配的文本自动翻译。 */
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
          // 纯文本子节点整段匹配
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
