// Copy control for fenced markdown blocks. Pure DOM helper — call after
// sanitized markdown is in the tree so DOMPurify never has to allow <button>.

export const CODE_COPY_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
export const CODE_COPIED_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

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
