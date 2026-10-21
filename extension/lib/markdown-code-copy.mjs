// Copy control for fenced markdown blocks. Pure DOM helper — call after
// sanitized markdown is in the tree so DOMPurify never has to allow <button>.

export const CODE_COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="copy"><path d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z"/></svg>';
export const CODE_COPIED_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="check"><path d="M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z"/></svg>';

const COPIED_RESET_MS = 1500;

export function codeTextFromPre(pre) {
  return String(pre?.textContent ?? '');
}

export async function writeClipboardText(text, clipboard = globalThis.navigator?.clipboard) {
  const value = String(text ?? '');
  if (!value) return false;
  if (!clipboard?.writeText) throw new Error('Clipboard API is unavailable');
  await clipboard.writeText(value);
  return true;
}

function setCopyIcon(button, markup) {
  button.innerHTML = markup;
}

function setCopyState(button, { copied, copyLabel, copiedLabel }) {
  const label = copied ? copiedLabel : copyLabel;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.toggle('copied', copied);
  setCopyIcon(button, copied ? CODE_COPIED_ICON : CODE_COPY_ICON);
}

function wrapPreWithCopyControl(pre, {
  document: doc,
  copyText,
  copyLabel,
  copiedLabel,
} = {}) {
  const wrap = doc.createElement('div');
  wrap.className = 'md-code';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'md-code-copy';
  setCopyState(button, { copied: false, copyLabel, copiedLabel });
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = codeTextFromPre(pre);
    if (!text) return;
    try {
      if (typeof copyText === 'function') await copyText(text);
      else await writeClipboardText(text);
      if (button._copyReset) doc.defaultView?.clearTimeout?.(button._copyReset);
      setCopyState(button, { copied: true, copyLabel, copiedLabel });
      button._copyReset = doc.defaultView?.setTimeout?.(() => {
        setCopyState(button, { copied: false, copyLabel, copiedLabel });
        button._copyReset = 0;
      }, COPIED_RESET_MS);
    } catch {
      button.title = copyLabel;
    }
  });
  pre.replaceWith(wrap);
  wrap.append(pre, button);
  return wrap;
}

export function enhanceMarkdownCodeBlocks(root, {
  document: doc = root?.ownerDocument || globalThis.document,
  copyText,
  copyLabel = 'Copy code',
  copiedLabel = 'Copied',
} = {}) {
  if (!root?.querySelectorAll || !doc?.createElement) return 0;
  let count = 0;
  for (const pre of [...root.querySelectorAll('pre')]) {
    if (pre.closest('.md-code')) continue;
    if (!codeTextFromPre(pre)) continue;
    wrapPreWithCopyControl(pre, { document: doc, copyText, copyLabel, copiedLabel });
    count += 1;
  }
  return count;
}
