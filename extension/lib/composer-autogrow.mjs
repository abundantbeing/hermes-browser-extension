// Sizes the side-panel composer to its text and keeps the caret above the
// controls that sit over the field. Callers own when to follow the caret.

const MIRROR_PROPS = [
  'font', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent',
  'tabSize', 'direction', 'textAlign', 'whiteSpace', 'wordBreak', 'overflowWrap', 'padding',
];

function parsed(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

export function fitComposerHeight(area, computed = null) {
  const view = area.ownerDocument?.defaultView;
  const styles = computed || view.getComputedStyle(area);
  const max = Number.parseFloat(styles.maxHeight);
  const min = parsed(styles.minHeight);
  const borders = parsed(styles.borderTopWidth) + parsed(styles.borderBottomWidth);
  const padding = parsed(styles.paddingTop) + parsed(styles.paddingBottom);
  const borderBox = styles.boxSizing !== 'content-box';
  // height:auto preserves rows, stopping an empty field at its intrinsic size.
  area.style.height = '0px';
  const desired = borderBox ? area.scrollHeight + borders : Math.max(0, area.scrollHeight - padding);
  const content = Math.max(Math.ceil(desired - 0.001), min);
  const capped = Number.isFinite(max) ? Math.min(content, max) : content;
  area.style.height = `${capped}px`;
  area.style.overflowY = Number.isFinite(max) && content > max + 0.5 ? 'auto' : 'hidden';
  return capped;
}

// caretTop is in the textarea's scroll coordinates. A caret already inside the
// visible area above the overlaid controls is left alone, so reading older
// text is not interrupted until the caller asks to follow a new caret.
export function keepCaretInFrame(area, { caretTop, caretHeight = 0, chipClearance = 0, topClearance = 0 }) {
  const caretBottom = caretTop + Math.max(0, caretHeight);
  const visibleTop = area.scrollTop + topClearance;
  const visibleBottom = area.scrollTop + area.clientHeight - chipClearance;
  if (caretTop >= visibleTop && caretBottom <= visibleBottom) return area.scrollTop;
  const room = area.clientHeight - chipClearance - topClearance;
  if (caretBottom > visibleBottom && caretHeight <= room) {
    area.scrollTop = Math.max(0, caretBottom - area.clientHeight + chipClearance);
  }
  if (caretTop < area.scrollTop + topClearance || caretHeight > room) {
    area.scrollTop = Math.max(0, caretTop - topClearance);
  }
  return area.scrollTop;
}

export function measureCaretRect(area) {
  const doc = area.ownerDocument;
  const styles = doc.defaultView.getComputedStyle(area);
  const mirror = doc.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.left = '0';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${area.clientWidth}px`;
  mirror.style.height = 'auto';
  mirror.style.minHeight = '0';
  mirror.style.maxHeight = 'none';
  mirror.style.border = '0';
  mirror.style.margin = '0';
  mirror.style.overflow = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  for (const prop of MIRROR_PROPS) mirror.style[prop] = styles[prop];
  const marker = doc.createElement('span');
  marker.textContent = '\u200b';
  const end = area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd;
  mirror.textContent = String(area.value || '').slice(0, Number.isInteger(end) ? end : String(area.value || '').length);
  mirror.append(marker);
  (area.parentElement || doc.body).append(mirror);
  const rect = { top: marker.offsetTop, height: marker.offsetHeight || parsed(styles.lineHeight) };
  mirror.remove();
  return rect;
}

// True while part of the draft sits below the visible area, i.e. the user has
// scrolled back up and text is passing under the overlaid controls.
export function hasTextBelow(area) {
  return area.scrollHeight - area.clientHeight - area.scrollTop > 1;
}

export function bindComposerFrame(area) {
  const view = area.ownerDocument.defaultView;
  const state = { lastValue: null, geometry: '', applying: false };
  const markTextBelow = () => {
    area.parentElement?.classList.toggle('composer-text-below', hasTextBelow(area));
  };
  const sync = ({ followCaret = false } = {}) => {
    try {
      syncFrame({ followCaret });
    } finally {
      markTextBelow();
    }
  };
  const syncFrame = ({ followCaret = false } = {}) => {
    if (state.applying || !area.clientWidth) return;
    const styles = view.getComputedStyle(area);
    // The outer width stays stable when a scrollbar appears. Height is omitted
    // deliberately: dragging the native handle must not trigger autogrow.
    const geometry = [area.getBoundingClientRect().width, styles.font, styles.lineHeight,
      styles.letterSpacing, styles.wordSpacing, styles.padding, styles.direction,
      styles.minHeight, styles.maxHeight].join('|');
    const textChanged = String(area.value || '') !== state.lastValue;
    const layoutChanged = geometry !== state.geometry;
    if (!textChanged && !layoutChanged && !followCaret) return;
    state.lastValue = String(area.value || '');
    state.geometry = geometry;
    state.applying = true;
    try {
      if (textChanged || layoutChanged) fitComposerHeight(area, styles);
      const caret = measureCaretRect(area);
      keepCaretInFrame(area, {
        caretTop: caret.top,
        caretHeight: caret.height,
        chipClearance: parsed(styles.paddingBottom),
        topClearance: parsed(styles.paddingTop),
      });
    } finally {
      state.applying = false;
    }
  };
  const onLayout = () => sync();
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(onLayout) : null;
  observer?.observe(area);
  const appearance = typeof view.MutationObserver === 'function' ? new view.MutationObserver(onLayout) : null;
  appearance?.observe(area.ownerDocument.documentElement, { attributes: true });
  view.addEventListener('resize', onLayout);
  area.ownerDocument.fonts?.addEventListener('loadingdone', onLayout);
  area.addEventListener('scroll', markTextBelow, { passive: true });
  return {
    sync,
    disconnect() {
      area.removeEventListener('scroll', markTextBelow);
      observer?.disconnect();
      appearance?.disconnect();
      view.removeEventListener('resize', onLayout);
      area.ownerDocument.fonts?.removeEventListener('loadingdone', onLayout);
    },
  };
}
