// A modal window keeps focus: when something outside it takes focus (a page behind refreshing, a
// control re-rendering), focus comes straight back, so Escape, Tab and Enter still reach the window.

export function holdFocusInside(root, dialog, fallback = () => null) {
  const pullBack = (event) => {
    if (dialog.hidden || dialog.contains(event.target)) return;
    (fallback() || dialog).focus();
  };
  return {
    start: () => root.addEventListener('focusin', pullBack),
    stop: () => root.removeEventListener('focusin', pullBack),
  };
}
