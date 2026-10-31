// One reading of a browser_press request. The classifier (what needs approval) and the
// adapter (what is dispatched) both take their key and modifiers from here, so a spelling
// the adapter understands can never be one the classifier does not.

import { controlToolName } from './control-tool-names.mjs';

function compact(value, limit = 2_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export const KEY_ALIASES = Object.freeze({
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  // Spellings people and models use for the same keys. Anything not listed here is refused rather than sent:
  // an unknown name has no key code, so the browser would take it as no key at all and the press would be
  // reported as done.
  numpadenter: { key: 'Enter', code: 'NumpadEnter', windowsVirtualKeyCode: 13, text: '\r' },
  spacebar: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  del: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ins: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  pgup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pgdn: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  pgdown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  'page up': { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  'page down': { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  'up arrow': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  'down arrow': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  'left arrow': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  'right arrow': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
});

// Read when the error is made: the typing tool's name follows the route control is connected through.
const keyHelp = () => `Use a single character, or one of Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space or F1 to F12, optionally with Control, Alt, Shift or Meta (for example Control+A). To type text, use ${controlToolName('browser_type')}.`;

// A key name for a message: bounded, with control and formatting characters taken out.
function shownKey(value, limit = 30) {
  return compact(String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' '), limit);
}

export const MODIFIER_NAMES = Object.freeze({
  alt: 'alt', option: 'alt', ctrl: 'ctrl', control: 'ctrl', meta: 'meta', cmd: 'meta', command: 'meta', shift: 'shift',
});

const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });

export function keyDescriptor(value = '') {
  const raw = String(value ?? '');
  if (!compact(raw, 80) && raw !== ' ') throw new Error(`No key was given to press. ${keyHelp()}`);
  const key = raw === ' ' ? raw : compact(raw, 80);
  const alias = KEY_ALIASES[key.toLowerCase()];
  if (alias) return { ...alias };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const alphanumeric = /^[a-z0-9]$/i.test(key);
    return {
      key,
      code: /^[a-z]$/i.test(key) ? `Key${upper}` : (/^[0-9]$/.test(key) ? `Digit${key}` : key),
      ...(alphanumeric ? { windowsVirtualKeyCode: upper.charCodeAt(0) } : {}),
      text: key,
    };
  }
  // The names the browser gives a physical key (KeyV, Digit4) are the character on it.
  const physical = /^(?:key([a-z])|digit([0-9]))$/i.exec(key);
  if (physical) return keyDescriptor((physical[1] || physical[2]).toLowerCase());
  const functionKey = /^f([1-9]|1[0-2])$/i.exec(key);
  if (functionKey) return { key: key.toUpperCase(), code: key.toUpperCase(), windowsVirtualKeyCode: 111 + Number(functionKey[1]) };
  // Not a key Hermes can send. A name the browser does not know is dispatched as no key at all, and the press would
  // still be reported as done, so it is refused with the name it could not understand.
  if (Object.hasOwn(MODIFIER_NAMES, key.toLowerCase())) {
    throw new Error(`"${shownKey(key)}" is a modifier, not a key to press by itself. Press it together with a key, for example ${shownKey(key)}+Tab. ${keyHelp()}`);
  }
  throw new Error(`Hermes could not understand the key "${shownKey(key)}". ${keyHelp()}`);
}

// "Control+a", "Meta+a", "Shift+Tab", "Control++": the last part is the key,
// everything before it is a modifier.
export function parseKeyCombo(value = '') {
  const raw = String(value ?? '');
  if (raw === ' ' || !raw.includes('+') || raw.trim() === '+') return { key: raw, modifiers: [] };
  const parts = raw.split('+');
  const last = parts.pop();
  const key = last === '' ? '+' : last;
  const modifiers = parts.filter(Boolean).map(canonicalModifier);
  return { key, modifiers };
}

function canonicalModifier(value) {
  const name = MODIFIER_NAMES[compact(value, 20).toLowerCase()];
  if (!name) throw new Error(`Unsupported key modifier: ${shownKey(value, 20) || 'missing'}. Modifiers are Control, Alt, Shift and Meta.`);
  return name;
}

export function modifierMask(values = []) {
  return [...new Set(Array.isArray(values) ? values : [])]
    .reduce((mask, value) => mask | (MODIFIER_BITS[MODIFIER_NAMES[compact(value, 20).toLowerCase()]] || 0), 0);
}

// The key and modifiers a browser_press request dispatches. Throws on anything the
// adapter would refuse (no key, an unknown modifier), so a caller that classifies first
// treats a request that cannot be read as one that cannot be sent.
export function resolveKeyPress(args = {}) {
  const combo = parseKeyCombo(args?.key);
  const listed = Array.isArray(args?.modifiers) ? args.modifiers.map(canonicalModifier) : [];
  const names = [...new Set([...combo.modifiers, ...listed])];
  const descriptor = keyDescriptor(combo.key);
  return {
    descriptor,
    modifiers: names,
    mask: names.reduce((mask, name) => mask | MODIFIER_BITS[name], 0),
    // The part of the request that names the key, as the browser will see it.
    keyName: String(descriptor.key).toLowerCase(),
    codeName: String(descriptor.code).toLowerCase(),
  };
}

// Enter in any spelling, with any modifiers: it submits a form or sends a message.
export function isSubmissionKey(resolved) {
  return ['enter', 'return', 'numpadenter'].includes(resolved.keyName)
    || ['enter', 'numpadenter'].includes(resolved.codeName);
}

// Ctrl/Cmd+V, Ctrl/Cmd+Shift+V and Shift+Insert insert the person's clipboard.
export function isPasteShortcut(resolved) {
  const names = new Set(resolved.modifiers);
  const commandKey = names.has('ctrl') || names.has('meta');
  if ((resolved.keyName === 'v' || resolved.codeName === 'keyv') && commandKey) return true;
  return (resolved.keyName === 'insert' || resolved.codeName === 'insert') && names.has('shift');
}

// Space with no command modifier clicks a focused button or toggles a focused control.
export function isSpaceActivation(resolved) {
  if (resolved.mask & 7) return false;
  return resolved.keyName === ' ' || resolved.codeName === 'space';
}

const NAVIGATION_KEYS = new Set([
  'tab', 'escape', 'home', 'end', 'pageup', 'pagedown', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

// Keys that only move focus or the viewport and write nothing: Tab, Escape, arrows, Home/End, Page keys and
// function keys, without Ctrl, Alt or Meta (Shift is fine, as in Shift+Tab).
export function isNavigationKey(resolved) {
  if (resolved.mask & 7) return false;
  return NAVIGATION_KEYS.has(resolved.keyName) || /^f([1-9]|1[0-2])$/.test(resolved.keyName);
}

// Keys that put a character in a field or take content out of it: a printable character (Space included),
// Backspace and Delete (with any modifier: Ctrl+Backspace deletes a word, Shift+Delete cuts), and the shortcuts
// that cut or change what is typed (Ctrl/Cmd+X, Z, Y). Paste is judged on its own.
export function isEditingKey(resolved) {
  const commandKey = (resolved.mask & 6) !== 0;
  if (['backspace', 'delete'].includes(resolved.keyName)) return true;
  if (commandKey) return ['x', 'z', 'y'].includes(resolved.keyName);
  if ((resolved.mask & 1) !== 0) return false;
  return resolved.descriptor.text !== undefined && !isSubmissionKey(resolved);
}

// Ctrl/Cmd+C and Ctrl+Insert copy the selection to the clipboard; the page is unchanged.
export function isCopyShortcut(resolved) {
  const names = new Set(resolved.modifiers);
  if (names.has('shift') || names.has('alt')) return false;
  if ((names.has('ctrl') || names.has('meta')) && resolved.keyName === 'c') return true;
  return names.has('ctrl') && resolved.keyName === 'insert';
}
