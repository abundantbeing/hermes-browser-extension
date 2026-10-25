import {
  controllerAdapterContractFor,
} from './browser-controller-adapter.mjs';
import { isRestrictedUrl, privacySafeTabForPrompt } from './browser-context-protocol.mjs';
import { resolveKeyPress } from './browser-control-keys.mjs';
import { FRAME_TEXT_SHARE, MAX_FRAME_NODES, frameChainReadable, frameUrlReadable, readableChildFrames } from './browser-control-frames.mjs';
import { MAX_INLINE_SCREENSHOT_CHARS } from './screenshot-limits.mjs';

const CDP_VERSION = '1.3';
const DEFAULT_IDLE_DETACH_MS = 60_000;
const EXPECTED_DETACH_GRACE_MS = 1_000;
const LOAD_TIMEOUT_MS = 8_000;
const LOAD_POLL_MS = 100;
const LOAD_START_GRACE_MS = 600;
const DOM_QUIET_MS = 150;
const DOM_SETTLE_CAP_MS = 1_200;
const HIDDEN_CAPTURE_TIMEOUT_MS = 5_000;
const SCROLL_SETTLE_MS = 120;
const SCROLL_MIN_PX = 100;
const SCROLL_MAX_PX = 5_000;
const SCROLL_VIEWPORT_FRACTION = 0.85;
const COMPACT_TEXT_LIMIT = 6_000;
const FULL_TEXT_LIMIT = 100_000;
const MAX_SNAPSHOT_HEADINGS = 100;
const MAX_SNAPSHOT_LANDMARKS = 30;
const NOT_ATTACHED_RE = /not attached|detached while handling/i;
const DETACHED_WHILE_HANDLING_RE = /detached while handling/i;
// Chrome can answer an in-flight command with "Detached while handling command"
// a moment before it delivers onDetach; wait this long for the event.
const DETACH_EVENT_GRACE_MS = 75;
const STALE_NODE_RE = /could not find node|no node with given id|node with given id|node is detached|does not belong to the document|no node found for given backend id|could not find object/i;
const STALE_REF_MESSAGE = 'That element is gone \u2014 use the refs in the latest result or call browser_snapshot.';
const ACTIONABLE_AX_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'dialog', 'gridcell', 'link', 'listbox',
  'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem', 'image', 'img', 'figure', 'graphics-symbol',
]);
const INPUT_AX_ROLES = new Set([
  'checkbox', 'combobox', 'listbox', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox',
]);
const IMAGE_AX_ROLES = new Set(['image', 'img', 'figure', 'graphics-symbol']);
const LANDMARK_AX_ROLES = new Set([
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
]);
const MAC_EDIT_COMMANDS = Object.freeze({
  a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo',
});
const CLEAR_FIELD_FUNCTION = `function() {
  if (typeof this.focus === 'function') this.focus();
  const tag = String(this.tagName || '').toUpperCase();
  if ((tag === 'INPUT' || tag === 'TEXTAREA') && typeof this.select === 'function') {
    this.select();
    return true;
  }
  if (this.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}`;
// Scrolls the nearest scrollable ancestor of the node (or the window) without
// input events; used when the tab is hidden and a wheel event would never be
// acknowledged.
const SCROLL_NODE_FUNCTION = `function(deltaX, deltaY) {
  const scrollable = (node, axis) => {
    const style = getComputedStyle(node);
    return axis === 'y'
      ? /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
      : /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
  };
  let node = this.nodeType === 1 ? this : this.parentElement;
  while (node && node !== document.documentElement && node !== document.body) {
    if ((deltaY && scrollable(node, 'y')) || (deltaX && scrollable(node, 'x'))) {
      node.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
      return true;
    }
    node = node.parentElement;
  }
  window.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
  return false;
}`;
const CONTAINS_NODE_FUNCTION = 'function(node) { return this === node || this.contains(node); }';
// Input.dispatchMouseEvent modifier bits.
const CDP_MODIFIER_CTRL = 2;
const CDP_MODIFIER_META = 4;

// Ctrl-click (Windows, Linux) and Cmd-click (macOS) open a link in a background
// tab. Takes the platform string, from navigator.userAgentData or navigator.platform.
export function backgroundTabModifierFor(platform = '') {
  return /^mac/i.test(String(platform || '')) ? CDP_MODIFIER_META : CDP_MODIFIER_CTRL;
}

function hostPlatformFromNavigator() {
  const nav = globalThis.navigator;
  return String(nav?.userAgentData?.platform || nav?.platform || '');
}

// Runs in the page on the node a click lands on, so it stays self-contained: the
// click path sends its source with Function.prototype.toString. True when the click
// would open a new tab: the closest link (an a, or an area with an href) targets another
// browsing context (anything but the keywords _self, _top, _parent or empty, which keep
// it in its own tab), or the closest button or input is a submit whose form (or
// formtarget) names one. A link or form with no target attribute takes the document's
// <base target>.
export function clickTargetOpensNewTab(node) {
  const opensElsewhere = (value) => {
    const name = String(value ?? '').trim().toLowerCase();
    return name !== '' && name !== '_self' && name !== '_top' && name !== '_parent';
  };
  const tagOf = (element) => String(element.localName || element.tagName || '').toLowerCase();
  // A node directly under a shadow root has no parentElement, so the walk continues at the host.
  const parentOf = (element) => {
    if (element.parentElement) return element.parentElement;
    const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
    return root && root.nodeType === 11 && root.host ? root.host : null;
  };
  const targetOf = (element) => {
    const own = element.getAttribute('target');
    if (own !== null) return own;
    return node?.ownerDocument?.querySelector('base[target]')?.getAttribute('target') ?? null;
  };
  let link = null;
  let control = null;
  const start = node && node.nodeType === 1 ? node : (node ? parentOf(node) : null);
  for (let current = start; current; current = parentOf(current)) {
    const tag = tagOf(current);
    if (!link && (tag === 'a' || (tag === 'area' && current.getAttribute('href') !== null))) link = current;
    if (!control && (tag === 'button' || tag === 'input')) control = current;
  }
  if (link) return opensElsewhere(targetOf(link));
  if (!control || !control.form) return false;
  const declared = String(control.getAttribute('type') || '').trim().toLowerCase();
  const submits = tagOf(control) === 'button'
    ? (declared === '' || declared === 'submit')
    : (declared === 'submit' || declared === 'image');
  if (!submits) return false;
  return opensElsewhere(control.getAttribute('formtarget') || targetOf(control.form));
}

const CLICK_OPENS_NEW_TAB_FUNCTION = `function() { return (${clickTargetOpensNewTab.toString()})(this); }`;
const SCROLL_POSITION_EXPRESSION = `(() => {
  const root = document.scrollingElement || document.documentElement;
  const maxY = Math.max(0, Math.round(root.scrollHeight - window.innerHeight));
  const scrollY = Math.round(window.scrollY);
  return { scrollX: Math.round(window.scrollX), scrollY, maxY, atTop: scrollY <= 0, atBottom: scrollY >= maxY - 1 };
})()`;

function quietWindowExpression(quietMs, capMs) {
  const quiet = Math.max(1, Math.round(Number(quietMs) || DOM_QUIET_MS));
  const cap = Math.max(quiet, Math.round(Number(capMs) || DOM_SETTLE_CAP_MS));
  return `new Promise((resolve) => {
  let quietTimer = null;
  let capTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish(true), ${quiet});
  });
  const finish = (quiet) => {
    observer.disconnect();
    clearTimeout(quietTimer);
    clearTimeout(capTimer);
    resolve(quiet);
  };
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  quietTimer = setTimeout(() => finish(true), ${quiet});
  capTimer = setTimeout(() => finish(false), ${cap});
})`;
}

function abortError(signal) {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new Error('Browser action cancelled.');
}

function assertNotAborted(signal) {
  const error = abortError(signal);
  if (error) throw error;
}

function compact(value, limit = 2_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function boundedScreenshot(dataUrl = '') {
  const value = String(dataUrl || '');
  if (!value.startsWith('data:image/png;base64,') || value.length > MAX_INLINE_SCREENSHOT_CHARS) {
    throw new Error('screenshot_too_large');
  }
  return { dataUrl: value };
}

function privacySafeLeasedTabs(tabs = [], leasedTabIds = []) {
  const allowed = new Set(Array.from(leasedTabIds || []).map(Number));
  return tabs
    .filter((tab) => allowed.has(Number(tab?.id)))
    .map(privacySafeTabForPrompt);
}

function tabIdFrom(scope = {}) {
  const tabId = Number(scope.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('A valid leased tab id is required.');
  return tabId;
}

function debuggerConflict(error) {
  const message = String(error?.message || error || '');
  if (!/another debugger|already attached|debugger is attached/i.test(message)) return error;
  const conflict = new Error(`Another debugger controls this tab: ${message}`);
  conflict.code = 'debugger_conflict';
  return conflict;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Hover and drag need the tab on screen; Chromium cannot deliver them to a
// background tab. Clicks, typing and scrolling work there, so the advice says so.
function hiddenTabError() {
  return codedError(
    'tab_hidden',
    "This tab is in the background, so hover and drag can't run there. Ask the user to bring it to the front with Show tab in Hermes Control, or use click, type or scroll, which work in background tabs.",
  );
}

// A screenshot of a background tab can still succeed, so a capture that times out
// says only that it did not finish; it never claims screenshots cannot run.
function hiddenScreenshotError() {
  return codedError(
    'tab_hidden',
    'This tab is in the background, so the screenshot did not finish. Ask the user to bring it to the front with Show tab in Hermes Control, then try again.',
  );
}

// Firefox can only photograph the tab its window is showing. When the leased tab is not that
// tab, a capture would be of someone else's page, so none is taken.
function notActiveTabError() {
  return codedError(
    'not_active_tab',
    "The leased tab is not the tab the window is showing, so a screenshot would capture a different page and was not taken. Ask the user to bring it to the front with Show tab in Hermes Control, then try again.",
  );
}

// Rejects with makeError() when the promise has not settled in time. The
// original promise is left to settle on its own.
function withTimeout(promise, ms, makeError, setTimer, clearTimer) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(makeError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimer(timer));
}

function defaultSleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function comparableUrl(value = '') {
  const raw = String(value || '').trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

// A request for the page the tab already shows is not a navigation. A request
// that names a different fragment is: hash-routed apps keep their whole route
// there, so "#/settings" and "#/home" are different pages.
function isSamePage(requested = '', current = '') {
  if (comparableUrl(requested) !== comparableUrl(current)) return false;
  const fragment = (value) => {
    try {
      return new URL(String(value || '').trim()).hash.replace(/^#/, '');
    } catch {
      return '';
    }
  };
  const wanted = fragment(requested);
  return !wanted || wanted === fragment(current);
}

function tabSummary(tab = {}) {
  return {
    url: compact(tab?.url || tab?.pendingUrl, 2_000),
    title: compact(tab?.title, 500),
  };
}

function boundedMs(value, fallback, max = 30_000) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), max) : fallback;
}

// Resolves once a tab finishes loading. CDP lifecycle events (when a session
// feeds `subscribe`) end the wait early; polling tabs.get is the backstop and
// the only path for adapters without a debugger.
function createLoadWaiter({
  browserApi, now = Date.now, sleep = defaultSleep, subscribe = () => () => {},
} = {}) {
  function watchLoad(tabId) {
    let loaded = false;
    let wake = () => {};
    const woken = new Promise((resolve) => { wake = resolve; });
    let mainFrameId = '';
    const unsubscribe = subscribe(tabId, (method, params = {}) => {
      const frameMatches = !mainFrameId || String(params?.frameId || '') === mainFrameId;
      if (method === 'Page.loadEventFired' || (method === 'Page.frameStoppedLoading' && frameMatches)) {
        loaded = true;
        wake();
      }
    });
    async function wait({
      signal, timeoutMs = LOAD_TIMEOUT_MS, startUrl = '', sawLoading = false, graceMs = LOAD_START_GRACE_MS,
      frameId = '',
    } = {}) {
      mainFrameId = String(frameId || '');
      const startedAt = Number(now()) || 0;
      const deadline = startedAt + Math.max(1, Number(timeoutMs) || LOAD_TIMEOUT_MS);
      const baseline = startUrl ? comparableUrl(startUrl) : '';
      let seenLoading = sawLoading === true;
      for (;;) {
        assertNotAborted(signal);
        if (loaded) return { timedOut: false };
        const tab = await browserApi.tabs.get(tabId);
        assertNotAborted(signal);
        if (loaded) return { timedOut: false };
        if (tab?.status === 'loading') {
          seenLoading = true;
        } else if (seenLoading
          || (baseline && comparableUrl(tab?.url || tab?.pendingUrl) !== baseline)
          || (Number(now()) || 0) - startedAt >= graceMs) {
          return { timedOut: false };
        }
        if ((Number(now()) || 0) >= deadline) return { timedOut: true };
        await Promise.race([sleep(LOAD_POLL_MS), woken]);
      }
    }
    return { wait, dispose: unsubscribe };
  }
  async function waitForLoad(tabId, options = {}) {
    const watch = watchLoad(tabId);
    try {
      return await watch.wait(options);
    } finally {
      watch.dispose();
    }
  }
  return { watchLoad, waitForLoad };
}

function axValue(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return value.value;
  return value;
}

function axProperty(properties = [], name = '') {
  const found = properties.find((property) => property?.name === name);
  return found ? axValue(found.value) : undefined;
}

function axFlag(value) {
  return value === true || value === 'true';
}

// Flags only: values of form fields are never read into the snapshot.
function axStateFlags(node, properties, role) {
  const flags = {};
  if (axFlag(axProperty(properties, 'protected'))) flags.inputType = 'password';
  if (axFlag(axProperty(properties, 'disabled'))) flags.disabled = true;
  if (axFlag(axProperty(properties, 'focused'))) flags.focused = true;
  const editable = axProperty(properties, 'editable');
  if (editable && editable !== 'false') flags.editable = true;
  const checked = axProperty(properties, 'checked');
  if (checked !== undefined) flags.checked = checked === 'mixed' ? 'mixed' : axFlag(checked);
  const expanded = axProperty(properties, 'expanded');
  if (expanded !== undefined) flags.expanded = axFlag(expanded);
  const selected = axProperty(properties, 'selected');
  if (selected !== undefined) flags.selected = axFlag(selected);
  if (INPUT_AX_ROLES.has(role) && compact(axValue(node.value), 1)) flags.hasValue = true;
  return flags;
}

// Chrome exposes what is typed into a field as StaticText children of the field
// itself. Those nodes are the field's value, so the page text skips everything
// below a text field, an editable region, or a protected (password) field.
const VALUE_HOLDER_AX_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'textarea', 'textfield']);

function fieldValueNodeIds(rawNodes = []) {
  const byId = new Map();
  for (const node of rawNodes) {
    if (node && node.nodeId !== undefined) byId.set(String(node.nodeId), node);
  }
  const hidden = new Set();
  const stack = [];
  for (const node of rawNodes) {
    if (!node) continue;
    const properties = Array.isArray(node.properties) ? node.properties : [];
    const editable = axProperty(properties, 'editable');
    const holdsValue = VALUE_HOLDER_AX_ROLES.has(compact(axValue(node.role), 80).toLowerCase())
      || (editable && editable !== 'false')
      || axFlag(axProperty(properties, 'protected'));
    if (holdsValue) stack.push(...(Array.isArray(node.childIds) ? node.childIds : []));
  }
  while (stack.length) {
    const id = String(stack.pop());
    if (hidden.has(id)) continue;
    hidden.add(id);
    const child = byId.get(id);
    if (Array.isArray(child?.childIds)) stack.push(...child.childIds);
  }
  return hidden;
}

// A tab's real UI is often inside a child frame: YouTube's live chat is a separate `live_chat` frame, and a
// paywall or an embedded app is another. `Accessibility.getFullAXTree` without a frameId only describes the main
// frame, so `trees` carries one `{ frameId, tree }` per frame read, the main frame first with an empty frameId. A
// child frame's nodes keep the CDP id of the frame they came from, and the ref store turns it into a stable short
// key. When child frames are read, part of the text, element and ref budgets is held back for them, so a long page
// of its own cannot leave a chat composer without a ref or its messages without room.
function chromiumSnapshot(trees, tab = {}, { full = false } = {}) {
  const segments = Array.isArray(trees) ? trees : [{ frameId: '', tree: trees }];
  const textLimit = full ? FULL_TEXT_LIMIT : COMPACT_TEXT_LIMIT;
  const hasFrames = segments.length > 1;
  const mainTextLimit = hasFrames ? Math.floor(textLimit * (1 - FRAME_TEXT_SHARE)) : textLimit;
  const nodes = [];
  const headings = [];
  const landmarks = [];
  const mainText = [];
  const frameText = [];
  let textLength = 0;
  let elementCount = 0;
  let cut = false;
  for (const [index, segment] of segments.entries()) {
    const frameId = compact(segment?.frameId || '', 160);
    const segmentNodes = Array.isArray(segment?.tree?.nodes) ? segment.tree.nodes : [];
    const valueNodeIds = fieldValueNodeIds(segmentNodes);
    // The main frame may use its share; each child frame an equal part of what is left, so one heavy frame
    // (an ad, a long chat) leaves room for the next.
    const allowance = index === 0
      ? mainTextLimit
      : textLength + Math.floor((textLimit - textLength) / (segments.length - index));
    const lines = frameId ? frameText : mainText;
    let keptInFrame = 0;
    for (const node of segmentNodes) {
      if (!node || node.ignored === true) continue;
      const role = compact(axValue(node.role), 80).toLowerCase();
      const name = compact(axValue(node.name), 500);
      const properties = Array.isArray(node.properties) ? node.properties : [];
      if (name && ['statictext', 'heading', 'paragraph'].includes(role)
        && !valueNodeIds.has(String(node.nodeId))
        && lines[lines.length - 1] !== name && textLength < allowance) {
        lines.push(name);
        textLength += name.length + 1;
      }
      if (name && role === 'heading' && headings.length < MAX_SNAPSHOT_HEADINGS) {
        const level = Number(axProperty(properties, 'level'));
        headings.push({ level: Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2, name: name.slice(0, 200) });
      }
      if (name && LANDMARK_AX_ROLES.has(role) && landmarks.length < MAX_SNAPSHOT_LANDMARKS) {
        landmarks.push({ role, name: name.slice(0, 200) });
      }
      const backendDOMNodeId = Number(node.backendDOMNodeId);
      if (!ACTIONABLE_AX_ROLES.has(role) || !Number.isInteger(backendDOMNodeId) || backendDOMNodeId <= 0) continue;
      // Compact view drops unlabeled images but keeps every input, so an unnamed
      // password field still gets a ref and the sensitive treatment.
      if (!full && !name && IMAGE_AX_ROLES.has(role)) continue;
      // Counted before the per-frame cap, so the true number of controls survives to the page view.
      elementCount += 1;
      if (frameId && keptInFrame >= MAX_FRAME_NODES) {
        cut = true;
        continue;
      }
      keptInFrame += 1;
      const autocomplete = compact(axProperty(properties, 'autocomplete'), 120);
      nodes.push({
        role,
        name,
        backendDOMNodeId,
        ...(autocomplete ? { autocomplete } : {}),
        ...(frameId ? { frameId } : {}),
        ...axStateFlags(node, properties, role),
      });
    }
  }
  return {
    title: compact(tab.title, 500),
    url: compact(tab.url || tab.pendingUrl),
    text: mainText.join('\n').slice(0, textLimit),
    ...(frameText.length ? { frameText: frameText.join('\n').slice(0, textLimit) } : {}),
    nodes,
    headings,
    landmarks,
    element_count: elementCount,
    ...(cut ? { truncated: true } : {}),
    full,
  };
}

function quadCenter(model = {}) {
  const quad = Array.isArray(model?.model?.content) ? model.model.content : [];
  if (quad.length < 8) throw new Error('The target element has no clickable box.');
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
  };
}

function quadRect(model = {}) {
  const quad = model?.model?.border || model?.model?.content || [];
  if (!Array.isArray(quad) || quad.length < 8) throw new Error('The target has no measurable box.');
  const xs = [Number(quad[0]), Number(quad[2]), Number(quad[4]), Number(quad[6])];
  const ys = [Number(quad[1]), Number(quad[3]), Number(quad[5]), Number(quad[7])];
  if (![...xs, ...ys].every(Number.isFinite)) throw new Error('The target box is invalid.');
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function keyEventFields(args = {}) {
  const resolved = resolveKeyPress(args);
  const { descriptor } = resolved;
  const modifiers = resolved.mask;
  // Characters are typed only without Alt/Ctrl/Meta; otherwise it is a shortcut.
  const typed = (modifiers & 7) === 0 && descriptor.text !== undefined;
  const shiftedLetter = typed && (modifiers & 8) !== 0 && /^[a-z]$/.test(descriptor.text);
  const text = shiftedLetter ? descriptor.text.toUpperCase() : descriptor.text;
  const base = { ...descriptor, ...(shiftedLetter ? { key: text } : {}) };
  delete base.text;
  const command = modifiers & 4 ? MAC_EDIT_COMMANDS[resolved.keyName] : '';
  return {
    down: {
      type: typed ? 'keyDown' : 'rawKeyDown',
      ...base,
      modifiers,
      ...(typed ? { text, unmodifiedText: descriptor.text } : {}),
      ...(command ? { commands: [command] } : {}),
    },
    up: { type: 'keyUp', ...base, modifiers },
  };
}

function pointForArgs(args = {}) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Valid viewport coordinates are required.');
  return { x, y };
}

// The clip of Page.captureScreenshot is in document coordinates, while DOM.getBoxModel answers in the viewport's
// (what is in view, scaled by a pinch zoom). The box is moved into the document by where the visual viewport is.
function screenshotClip(box = {}, zoom = 1, view = {}) {
  const quad = Array.isArray(box?.model?.content) ? box.model.content.map(Number) : [];
  if (quad.length < 8 || quad.some((value) => !Number.isFinite(value))) throw new Error('The screenshot target has no visible box.');
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const scale = Number(view.scale) > 0 ? Number(view.scale) : 1;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: (Number(view.pageX) || 0) + x / scale,
    y: (Number(view.pageY) || 0) + y / scale,
    width: Math.max(1, (Math.max(...xs) - x) / scale),
    height: Math.max(1, (Math.max(...ys) - y) / scale),
    scale: Math.max(0.25, Math.min(Number(zoom) || 1, 4)),
  };
}

function scrollDirection(direction = '') {
  const normalized = compact(direction, 20).toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'up' || normalized === 'page_up') return { axis: 'y', sign: -1 };
  if (normalized === 'down' || normalized === 'page_down') return { axis: 'y', sign: 1 };
  if (normalized === 'left') return { axis: 'x', sign: -1 };
  if (normalized === 'right') return { axis: 'x', sign: 1 };
  throw new Error(`Unsupported scroll direction: ${normalized || 'missing'}.`);
}

function pageProbe(mode, direction = '') {
  if (mode === 'inspect') {
    const dirtyText = [...document.querySelectorAll('input, textarea')].some((element) => {
      if (element.type === 'password') return false;
      return String(element.value ?? '') !== String(element.defaultValue ?? '');
    });
    const dirtyChecks = [...document.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
      .some((element) => element.checked !== element.defaultChecked);
    // What has keyboard focus, so a Space press can be judged as the click it is. An
    // element inside an open shadow root is followed; an embedded frame is reported as one.
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    let focused = { role: '', name: '', inputType: '' };
    if (active && active !== document.body && active !== document.documentElement) {
      const tag = String(active.tagName || '').toUpperCase();
      const inputType = String(active.type || '').toLowerCase();
      const embeds = ['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME'].includes(tag);
      const inputRole = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio' }[inputType] || 'textbox';
      const role = active.getAttribute('role')
        || (embeds ? 'frame' : ({ A: 'link', BUTTON: 'button', INPUT: inputRole, SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' }[tag]
          || (active.isContentEditable ? 'textbox' : 'generic')));
      const labelled = [...(active.labels || [])].map((label) => label.innerText).join(' ');
      // A button's label is its value; what is typed into any other field is never read, so it cannot reach a card.
      const labelFromValue = tag === 'INPUT' && ['button', 'submit', 'reset'].includes(inputType) ? active.value : '';
      const name = String(active.getAttribute('aria-label') || labelled || labelFromValue || (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable ? '' : active.innerText) || active.title || active.alt || active.placeholder || active.name || '')
        .replace(/\s+/g, ' ').trim().slice(0, 200);
      const autocomplete = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ? String(active.autocomplete || '').trim().slice(0, 80) : '';
      focused = {
        role,
        name,
        inputType: tag === 'INPUT' || tag === 'BUTTON' ? inputType : '',
        ...(autocomplete ? { autocomplete } : {}),
        ...(embeds ? { inFrame: true } : {}),
      };
    }
    return { hasUnsavedContent: dirtyText || dirtyChecks, focused };
  }
  if (mode === 'scroll') {
    const deltas = {
      up: [0, -600],
      down: [0, 600],
      left: [-600, 0],
      right: [600, 0],
    };
    const [left, top] = deltas[String(direction || '').toLowerCase()] || [0, 0];
    window.scrollBy({ left, top, behavior: 'auto' });
    return { ok: true };
  }
  if (mode === 'snapshot') {
    const roles = new Set([
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IMG', 'FIGURE',
    ]);
    const candidates = [...document.querySelectorAll('a,button,input,select,textarea,summary,img,figure,[role],[tabindex],[class*="clickable"],[class*="thumb"],[class*="card"]')]
      .filter((element) => roles.has(element.tagName) || element.getAttribute('role') || element.tabIndex >= 0 || element.classList?.contains('clickable-image') || window.getComputedStyle(element).cursor === 'pointer' || window.getComputedStyle(element).cursor === 'zoom-in')
      .slice(0, 500);
    const nodes = candidates.map((element) => ({
      role: element.getAttribute('role')
        || ({ A: 'link', BUTTON: 'button', INPUT: element.type === 'checkbox' ? 'checkbox' : 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', IMG: 'image', FIGURE: 'image' }[element.tagName] || (window.getComputedStyle(element).cursor === 'pointer' || window.getComputedStyle(element).cursor === 'zoom-in' ? 'button' : 'generic')),
      name: String(element.getAttribute('aria-label') || element.alt || element.title || element.innerText || element.placeholder || element.name || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      inputType: String(element.type || ''),
      autocomplete: String(element.autocomplete || ''),
    }));
    return {
      title: document.title,
      url: location.href,
      text: String(document.body?.innerText || '').slice(0, 100_000),
      nodes,
    };
  }
  return { ok: false };
}

// `light` reads only the tab URL; the unsaved-content page script is skipped for
// read-only actions that never leave the page.
async function inspectPage(browserApi, scope, signal, { light = false } = {}) {
  assertNotAborted(signal);
  const tabId = tabIdFrom(scope);
  const tab = await browserApi.tabs.get(tabId);
  assertNotAborted(signal);
  const currentUrl = compact(tab?.url || tab?.pendingUrl);
  // Only for approval wording (a tab switch names its tab). A restricted page's title is never read out.
  const title = isRestrictedUrl(currentUrl) ? '' : compact(tab?.title, 500);
  if (light || isRestrictedUrl(currentUrl)) return { currentUrl, hasUnsavedContent: false, title };
  let hasUnsavedContent = false;
  let focused = null;
  if (browserApi.scripting?.executeScript) {
    try {
      const response = await browserApi.scripting.executeScript({
        target: { tabId, frameIds: [Math.max(0, Number(scope.frameId) || 0)] },
        func: pageProbe,
        args: ['inspect'],
      });
      hasUnsavedContent = response?.[0]?.result?.hasUnsavedContent === true;
      const read = response?.[0]?.result?.focused;
      if (read && typeof read === 'object') {
        focused = {
          role: compact(read.role, 80),
          name: compact(read.name, 200),
          inputType: compact(read.inputType, 40),
          ...(compact(read.autocomplete, 80) ? { autocomplete: compact(read.autocomplete, 80) } : {}),
          ...(read.inFrame === true ? { inFrame: true } : {}),
        };
      }
    } catch {
      // Inspection is a conservative enhancement; the action policy still runs.
    }
  }
  return { currentUrl, hasUnsavedContent, title, ...(focused ? { focused } : {}) };
}

function createChromiumCdpAdapter({
  browserApi,
  onDebuggerDetach = () => {},
  idleMs = DEFAULT_IDLE_DETACH_MS,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
  now = Date.now,
  sleep = defaultSleep,
  hostPlatform = hostPlatformFromNavigator(),
} = {}) {
  if (!browserApi?.tabs) throw new TypeError('Chromium tabs API is required.');
  const backgroundTabModifier = backgroundTabModifierFor(hostPlatform);
  const contract = controllerAdapterContractFor({
    product: { id: 'chromium', engine: 'chromium' },
    capabilities: { apis: {
      debugger: Boolean(browserApi.debugger),
      scripting: Boolean(browserApi.scripting),
      tabs: Boolean(browserApi.tabs),
    } },
    controlEnabled: true,
  });
  const debuggerApi = browserApi.debugger;
  const idleDetachMs = boundedMs(idleMs, DEFAULT_IDLE_DETACH_MS, 3_600_000);
  // One persistent debugger session per tab: tabId -> { enabled, lastUsed, idleTimer }.
  const sessions = new Map();
  const inflight = new Map();
  const recovering = new Map();
  const detaching = new Map();
  const activeOperations = new Map();
  const expectedDetaches = new Map();
  const eventWaiters = new Map();
  // Counts the times a tab's debugger was let go on purpose (Pause, releasing the tab, Turn off) or taken away
  // (the Chrome bar's Cancel, DevTools). An operation remembers the count it started under, and one that sees
  // it move stops instead of attaching again to finish what the person ended.
  const releaseEpochs = new Map();
  const bumpReleaseEpoch = (tabId) => releaseEpochs.set(tabId, (releaseEpochs.get(tabId) || 0) + 1);

  function requireDebugger() {
    if (!debuggerApi?.attach || !debuggerApi?.sendCommand || !debuggerApi?.detach) {
      throw new Error('The Chromium debugger API is unavailable.');
    }
  }

  function dropSession(tabId) {
    const session = sessions.get(tabId);
    if (session?.idleTimer) clearTimer(session.idleTimer);
    sessions.delete(tabId);
  }

  // Detach on purpose. The marker keeps our own detach from being reported as an
  // external one until both the detach promise and Chrome's onDetach event
  // have been seen (the event may arrive after the promise resolves).
  async function detachTarget(tabId) {
    const previous = expectedDetaches.get(tabId);
    if (previous?.timer) clearTimer(previous.timer);
    const marker = { eventSeen: false, settled: false, timer: null };
    expectedDetaches.set(tabId, marker);
    let detached = false;
    try {
      await debuggerApi.detach({ tabId });
      detached = true;
    } catch {
      // A completed/failed command must not be replaced by detach cleanup noise.
    }
    marker.settled = true;
    if (marker.eventSeen || !detached) {
      if (expectedDetaches.get(tabId) === marker) expectedDetaches.delete(tabId);
    } else {
      marker.timer = setTimer(() => {
        if (expectedDetaches.get(tabId) === marker) expectedDetaches.delete(tabId);
      }, EXPECTED_DETACH_GRACE_MS);
      marker.timer?.unref?.();
    }
    return detached;
  }

  function trackDetach(tabId) {
    const pending = detachTarget(tabId).finally(() => {
      if (detaching.get(tabId) === pending) detaching.delete(tabId);
    });
    detaching.set(tabId, pending);
    return pending;
  }

  function detachSession(tabId) {
    if (!sessions.has(tabId)) return detaching.get(tabId) || Promise.resolve(false);
    dropSession(tabId);
    return trackDetach(tabId);
  }

  const detachListener = (debuggee = {}, reason = '') => {
    const tabId = Number(debuggee?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    const marker = expectedDetaches.get(tabId);
    if (marker) {
      marker.eventSeen = true;
      if (marker.settled) {
        if (marker.timer) clearTimer(marker.timer);
        expectedDetaches.delete(tabId);
      }
      return;
    }
    dropSession(tabId);
    bumpReleaseEpoch(tabId);
    onDebuggerDetach({
      tabId,
      reason: compact(reason, 120) || 'unknown',
      recoverable: false,
    });
  };
  debuggerApi?.onDetach?.addListener?.(detachListener);

  const eventListener = (source = {}, method = '', params = {}) => {
    const waiters = eventWaiters.get(Number(source?.tabId));
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      try {
        waiter(String(method || ''), params || {});
      } catch {
        // A faulty waiter must not break event delivery to others.
      }
    }
  };
  debuggerApi?.onEvent?.addListener?.(eventListener);

  function subscribeTab(tabId, handler) {
    const waiters = eventWaiters.get(tabId) || new Set();
    waiters.add(handler);
    eventWaiters.set(tabId, waiters);
    return () => {
      waiters.delete(handler);
      if (!waiters.size && eventWaiters.get(tabId) === waiters) eventWaiters.delete(tabId);
    };
  }

  async function attachTab(tabId) {
    try {
      await debuggerApi.attach({ tabId }, CDP_VERSION);
      return;
    } catch (error) {
      if (debuggerConflict(error) === error) throw error;
      // After a worker restart (or a missed detach event) the attachment may be
      // our own. Detach only succeeds for our own attachment, so DevTools or
      // another extension still surfaces as a conflict.
      if (!await detachTarget(tabId)) throw debuggerConflict(error);
    }
    try {
      await debuggerApi.attach({ tabId }, CDP_VERSION);
    } catch (error) {
      throw debuggerConflict(error);
    }
  }

  async function ensureSession(tabId) {
    const existing = sessions.get(tabId);
    if (existing) {
      existing.lastUsed = Number(now()) || 0;
      return existing;
    }
    const pending = inflight.get(tabId);
    if (pending) return pending;
    const attach = (async () => {
      await detaching.get(tabId);
      await attachTab(tabId);
      const session = { attached: true, enabled: new Set(), enabling: new Map(), lastUsed: Number(now()) || 0, idleTimer: null };
      sessions.set(tabId, session);
      return session;
    })().finally(() => {
      if (inflight.get(tabId) === attach) inflight.delete(tabId);
    });
    inflight.set(tabId, attach);
    return attach;
  }

  function scheduleIdleDetach(tabId, session) {
    if (session.idleTimer) clearTimer(session.idleTimer);
    session.idleTimer = setTimer(() => {
      session.idleTimer = null;
      if (sessions.get(tabId) !== session) return;
      if ((activeOperations.get(tabId) || 0) > 0) {
        scheduleIdleDetach(tabId, session);
        return;
      }
      detachSession(tabId).catch(() => {});
    }, idleDetachMs);
    session.idleTimer?.unref?.();
  }

  function rawSend(tabId, method, params) {
    return debuggerApi.sendCommand({ tabId }, method, params);
  }

  function mapNodeError(method, error) {
    if ((method.startsWith('DOM.') || method === 'Runtime.callFunctionOn')
      && STALE_NODE_RE.test(String(error?.message || error || ''))) {
      return codedError('stale_ref', STALE_REF_MESSAGE);
    }
    return error;
  }

  // Re-attaches a session whose attachment went stale and enables the domains it
  // had. Concurrent callers share one recovery.
  function recoverSession(tabId, session) {
    const running = recovering.get(tabId);
    if (running) return running;
    const recovery = (async () => {
      const previouslyEnabled = [...session.enabled];
      dropSession(tabId);
      const next = await ensureSession(tabId);
      session.replacedBy = next;
      for (const domain of previouslyEnabled) {
        await rawSend(tabId, `${domain}.enable`, {});
        next.enabled.add(domain);
      }
      return next;
    })().finally(() => {
      if (recovering.get(tabId) === recovery) recovering.delete(tabId);
    });
    recovering.set(tabId, recovery);
    return recovery;
  }

  async function sendWithRetry(tabId, method, params, signal) {
    assertNotAborted(signal);
    const session = await ensureSession(tabId);
    assertNotAborted(signal);
    try {
      const result = await rawSend(tabId, method, params);
      assertNotAborted(signal);
      return result;
    } catch (error) {
      if (abortError(signal)) throw abortError(signal);
      // Only a stale cache entry is retried; an external detach already dropped
      // the session and must not be silently re-attached.
      const failure = String(error?.message || error || '');
      if (!NOT_ATTACHED_RE.test(failure)) throw mapNodeError(method, error);
      if (DETACHED_WHILE_HANDLING_RE.test(failure) && sessions.get(tabId) === session) {
        // The user cancelling the infobar or opening DevTools answers the command
        // first and reports the detach right after. Let that report land, or the
        // retry would undo the user's choice and orphan the new attachment.
        await sleep(DETACH_EVENT_GRACE_MS);
        assertNotAborted(signal);
      }
      if (sessions.get(tabId) === session) {
        await recoverSession(tabId, session);
      } else if (recovering.has(tabId) || session.replacedBy) {
        // A concurrent command found the same stale session first and is
        // re-attaching it; join that recovery instead of failing.
        await (recovering.get(tabId) || Promise.resolve());
      } else {
        throw mapNodeError(method, error);
      }
      assertNotAborted(signal);
      try {
        const result = await rawSend(tabId, method, params);
        assertNotAborted(signal);
        return result;
      } catch (retryError) {
        throw mapNodeError(method, retryError);
      }
    }
  }

  async function withSession(scope, signal, operation) {
    assertNotAborted(signal);
    requireDebugger();
    const tabId = tabIdFrom(scope);
    const epoch = releaseEpochs.get(tabId) || 0;
    const stillAttachedByChoice = () => {
      if ((releaseEpochs.get(tabId) || 0) === epoch) return;
      throw codedError('debugger_detached', 'The debugger was detached, so Hermes stopped this action.');
    };
    activeOperations.set(tabId, (activeOperations.get(tabId) || 0) + 1);
    try {
      await ensureSession(tabId);
      assertNotAborted(signal);
      stillAttachedByChoice();
      const send = (method, params = {}) => {
        stillAttachedByChoice();
        return sendWithRetry(tabId, method, params, signal);
      };
      const enable = async (...domains) => {
        for (const domain of domains) {
          stillAttachedByChoice();
          const session = sessions.get(tabId) || await ensureSession(tabId);
          if (session.enabled.has(domain)) continue;
          // Concurrent first uses share one enable round trip.
          let pending = session.enabling.get(domain);
          if (!pending) {
            pending = send(`${domain}.enable`)
              .then(() => { sessions.get(tabId)?.enabled.add(domain); })
              .finally(() => { session.enabling.delete(domain); });
            session.enabling.set(domain, pending);
          }
          await pending;
        }
      };
      return await operation({ send, enable, tabId });
    } finally {
      const remaining = (activeOperations.get(tabId) || 1) - 1;
      if (remaining > 0) activeOperations.set(tabId, remaining);
      else activeOperations.delete(tabId);
      const session = sessions.get(tabId);
      if (session) {
        session.lastUsed = Number(now()) || 0;
        scheduleIdleDetach(tabId, session);
      }
    }
  }

  const { watchLoad, waitForLoad } = createLoadWaiter({ browserApi, now, sleep, subscribe: subscribeTab });

  // Whether Hermes still has a debugger attached to the tab. A command that was running when the person
  // detached it (the Chrome banner's Cancel, DevTools, Turn off, Pause) must not attach again to go on reading.
  const attached = (tabId) => sessions.has(tabId) || recovering.has(tabId) || inflight.has(tabId);

  // Whether a failed read ends the whole read: the command was cancelled, or the attachment is gone.
  const readEnded = (error, signal, tabId) => Boolean(abortError(signal))
    || !attached(tabId)
    || NOT_ATTACHED_RE.test(String(error?.message || error || ''))
    || error?.code === 'debugger_conflict'
    || error?.code === 'debugger_detached';

  // The accessibility tree of every frame Hermes may read in the tab, the main frame first. Each entry keeps the
  // CDP id of the frame it came from so its nodes can be ref'd and acted on.
  async function collectAxTrees({ send, tabId, signal }) {
    let children = [];
    try {
      children = readableChildFrames((await send('Page.getFrameTree'))?.frameTree);
    } catch (error) {
      // A tab that cannot report its frame tree still describes its main frame.
      if (readEnded(error, signal, tabId)) throw error;
    }
    const trees = [{ frameId: '', tree: await send('Accessibility.getFullAXTree') }];
    for (const frame of children) {
      assertNotAborted(signal);
      if (!attached(tabId)) throw codedError('debugger_detached', 'The debugger was detached, so Hermes stopped reading the page.');
      try {
        const tree = await send('Accessibility.getFullAXTree', { frameId: frame.id });
        // An empty or trivial child frame (an ad slot, a tracker) adds nothing.
        if ((Array.isArray(tree?.nodes) ? tree.nodes.length : 0) > 1) trees.push({ frameId: frame.id, tree });
      } catch (error) {
        // A frame that vanished or runs out of process is left out; losing the attachment is not that.
        if (readEnded(error, signal, tabId)) throw error;
      }
    }
    return trees;
  }

  async function nodeCenter(send, backendNodeId) {
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    return quadCenter(await send('DOM.getBoxModel', { backendNodeId }));
  }

  // Reports whether another element covers the click point, given the node under it
  // (see checkedHit). A failed check must never block the click, so every error
  // except cancellation is ignored.
  async function pointIsObscured(send, signal, backendNodeId, hitNodeId) {
    if (!Number.isInteger(hitNodeId) || hitNodeId <= 0 || hitNodeId === backendNodeId) return false;
    try {
      const targetObject = String((await send('DOM.resolveNode', { backendNodeId }))?.object?.objectId || '');
      const hitObject = String((await send('DOM.resolveNode', { backendNodeId: hitNodeId }))?.object?.objectId || '');
      if (!targetObject || !hitObject) return false;
      const contained = await send('Runtime.callFunctionOn', {
        objectId: targetObject,
        functionDeclaration: CONTAINS_NODE_FUNCTION,
        arguments: [{ objectId: hitObject }],
        returnByValue: true,
      });
      return contained?.result?.value === false;
    } catch (error) {
      if (abortError(signal)) throw error;
      return false;
    }
  }

  // Where a frame stands in the page, from what the browser itself reports (never from page script, which a
  // page can answer for): the addresses of the documents from the outermost child frame down to it, and the
  // element that owns the innermost one (0 for the page itself).
  function frameTreePath(tree, frameId, trail = []) {
    if (tree?.frame?.id === frameId) return trail;
    for (const child of Array.isArray(tree?.childFrames) ? tree.childFrames : []) {
      const found = frameTreePath(child, frameId, [...trail, child.frame]);
      if (found) return found;
    }
    return null;
  }

  // The documents above a node, read from the live DOM including the documents of its frames. A node that is
  // not in any document of the page (gone, or in a frame that runs in another process) has no path.
  async function documentPathOfNode(send, backendNodeId) {
    const document = await send('DOM.getDocument', { depth: -1, pierce: true });
    const stack = document?.root ? [{ node: document.root, urls: [], owner: 0 }] : [];
    while (stack.length) {
      const { node, urls, owner } = stack.pop();
      if (Number(node?.backendNodeId) === backendNodeId) return { urls, owner };
      const children = [
        ...(Array.isArray(node?.children) ? node.children : []),
        ...(Array.isArray(node?.shadowRoots) ? node.shadowRoots : []),
        ...(Array.isArray(node?.pseudoElements) ? node.pseudoElements : []),
        ...(node?.templateContent ? [node.templateContent] : []),
      ];
      for (const child of children) stack.push({ node: child, urls, owner });
      if (node?.contentDocument) {
        stack.push({
          node: node.contentDocument,
          urls: [...urls, String(node.contentDocument.documentURL || '')],
          owner: Number(node.backendNodeId) || -1,
        });
      }
    }
    return null;
  }

  function restrictedFrameError(reason) {
    return codedError('restricted_frame', reason || 'The frame this control is in is on a page Hermes will not act on.');
  }

  // Before any action on a control in a child frame: the frame must still be on pages Hermes may act on, and so
  // must every frame above it. A frame readable when the page was snapshotted can have moved since (a checkout
  // path pushed into its history keeps its controls), and the executor's probe only describes the page itself.
  // Returns the element that owns each target's frame (0 for the page itself, undefined for no target), which
  // the click, hover and drag hit tests compare against what is actually under the pointer.
  async function assertFramedTargetsReadable(send, enable, signal, { target, destination }) {
    const owners = {};
    for (const [key, node] of [['target', target], ['destination', destination]]) {
      if (!node) continue;
      owners[key] = 0;
      if (!node.frameId) continue;
      const backendNodeId = Number(node.backendDOMNodeId);
      let path = null;
      if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
        await enable('DOM');
        try {
          path = await documentPathOfNode(send, backendNodeId);
        } catch (error) {
          if (abortError(signal)) throw error;
        }
      }
      // A node that is in no document is either gone (its frame was replaced since the snapshot) or unplaceable.
      // Gone is a stale ref; anything the browser still knows but cannot place counts as restricted.
      if (!path && Number.isInteger(backendNodeId) && backendNodeId > 0) {
        try {
          await send('DOM.describeNode', { backendNodeId });
        } catch (error) {
          if (abortError(signal)) throw error;
          if (error?.code === 'stale_ref' || STALE_NODE_RE.test(String(error?.message || error || ''))) {
            throw codedError('stale_ref', STALE_REF_MESSAGE);
          }
        }
      }
      // Unknown counts as restricted.
      if (!path || !frameChainReadable(path.urls)) throw restrictedFrameError();
      owners[key] = path.owner;
    }
    return owners;
  }

  // Elements that embed another document. A frame that Chrome runs in its own process (a cross-site
  // iframe) is missing from Page.getFrameTree, but its owner element is still in the DOM, so this is the source
  // that cannot miss one.
  const FRAME_OWNER_NAMES = new Set(['IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'FENCEDFRAME', 'PORTAL']);

  // Whether the browser describes a node as embedding a document, whatever its tag: the names above are only a
  // floor, and a node that carries a frame id or a content document of its own is an owner too.
  function embedsFrame(node) {
    return FRAME_OWNER_NAMES.has(String(node?.nodeName || '').toUpperCase())
      || Boolean(node?.frameId) || Boolean(node?.contentDocument);
  }

  const framePathUrls = (path) => path.map((frame) => `${frame.url || ''}${frame.urlFragment || ''}`);

  // The owner elements of every frame on the page that Hermes may not read (see frameUrlReadable), from the live
  // DOM, which lists the owners of frames in other processes too. A frame in the same process is judged by its
  // document's address (the fragment included); one in its own process has no document in the DOM, so it counts
  // unless the frame tree proves it readable.
  async function unreadableFrameOwners(send, signal) {
    const document = await send('DOM.getDocument', { depth: -1, pierce: true });
    let tree = null;
    try {
      tree = (await send('Page.getFrameTree'))?.frameTree || null;
    } catch (error) {
      if (abortError(signal)) throw error;
    }
    const owners = [];
    const stack = document?.root ? [document.root] : [];
    while (stack.length) {
      const node = stack.pop();
      if (Number(node?.nodeType) !== 9 && embedsFrame(node)) {
        let readable = false;
        if (node.contentDocument) {
          readable = frameUrlReadable(String(node.contentDocument.documentURL || ''));
        } else {
          const owned = String(node.frameId || '');
          const path = owned && tree ? frameTreePath(tree, owned) : null;
          readable = Boolean(path) && frameChainReadable(framePathUrls(path));
        }
        if (!readable) owners.push(Number(node.backendNodeId) || 0);
      }
      for (const list of [node?.children, node?.shadowRoots, node?.pseudoElements]) {
        if (Array.isArray(list)) stack.push(...list);
      }
      if (node?.templateContent) stack.push(node.templateContent);
      if (node?.contentDocument) stack.push(node.contentDocument);
    }
    return owners;
  }

  // Where the visual viewport is in the document, and how big: the part of the page that is in view. Null when the
  // browser cannot say.
  async function readViewport(send, signal) {
    try {
      const viewport = (await send('Page.getLayoutMetrics'))?.cssVisualViewport;
      const width = Number(viewport?.clientWidth);
      const height = Number(viewport?.clientHeight);
      if (!(width > 0 && height > 0)) return null;
      return {
        pageX: Number(viewport?.pageX) || 0,
        pageY: Number(viewport?.pageY) || 0,
        scale: Number(viewport?.scale) > 0 ? Number(viewport.scale) : 1,
        width,
        height,
      };
    } catch (error) {
      if (abortError(signal)) throw error;
      return null;
    }
  }

  // The part of the document a screenshot covers, in document coordinates: the clip, or what is in view. Null when
  // it cannot be told.
  function screenshotRegion(clip, view) {
    if (clip) return { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
    return view ? { x: view.pageX, y: view.pageY, width: view.width, height: view.height } : null;
  }

  // Whether the element's box overlaps a region of the document. The box is in viewport coordinates, which become
  // document coordinates through where the viewport is; since it is not certain whether a pinch zoom scales those
  // boxes, both readings are tried and either overlapping counts. An element that is not rendered has no pixels;
  // any other failure to measure it counts as overlapping.
  async function ownerInDocumentRegion(send, signal, backendNodeId, region, view) {
    if (!region || !view || !backendNodeId) return true;
    try {
      const box = quadRect(await send('DOM.getBoxModel', { backendNodeId }));
      return [...new Set([1, view.scale])].some((scale) => {
        const left = view.pageX + box.x / scale;
        const top = view.pageY + box.y / scale;
        return left < region.x + region.width && left + box.width / scale > region.x
          && top < region.y + region.height && top + box.height / scale > region.y;
      });
    } catch (error) {
      if (abortError(signal)) throw error;
      return !/could not compute box model/i.test(String(error?.message || ''));
    }
  }

  // Whether the element's box overlaps the region, so its pixels are in the screenshot. An element that is not
  // rendered has no pixels; any other failure to measure it counts as overlapping.
  async function ownerInRegion(send, signal, backendNodeId, region) {
    if (!region || !backendNodeId) return true;
    try {
      const box = quadRect(await send('DOM.getBoxModel', { backendNodeId }));
      return box.x < region.x + region.width && box.x + box.width > region.x
        && box.y < region.y + region.height && box.y + box.height > region.y;
    } catch (error) {
      if (abortError(signal)) throw error;
      return !/could not compute box model/i.test(String(error?.message || ''));
    }
  }

  // A screenshot is pixels of the whole page, frames included, so it follows the rule snapshots follow: a frame
  // Hermes may not read (a payment or sign-in frame) that shows in the captured region withholds the screenshot.
  // A page whose frames cannot be checked is treated the same way.
  async function assertScreenshotFramesReadable(send, signal, clip) {
    const withheld = () => restrictedFrameError(
      'A screenshot was withheld because this page embeds a frame Hermes will not capture (for example a payment or sign-in frame). Use browser_snapshot to read the page instead.',
    );
    let owners;
    try {
      owners = await unreadableFrameOwners(send, signal);
    } catch (error) {
      if (abortError(signal)) throw error;
      throw withheld();
    }
    if (!owners.length) return;
    const view = await readViewport(send, signal);
    const region = screenshotRegion(clip, view);
    for (const backendNodeId of owners) {
      if (await ownerInDocumentRegion(send, signal, backendNodeId, region, view)) throw withheld();
    }
  }

  // The node under a viewport point, which is where a pointer action actually lands. The frame it is in must be
  // on pages Hermes may act on (a restricted frame laid over the control is such a frame), and for a control
  // with a known frame it must be the control's own frame, since a click on a covered control lands in
  // whatever covers it. When the node is itself the element that embeds a frame, the pointer lands inside that
  // frame, so the frame it owns is judged too, and one that cannot be found in the frame tree (a frame in its
  // own process) is refused. When the browser names no frame (or no node), the node is placed through the DOM,
  // and with nothing to place the point is refused only when a frame Hermes may not read could be under it,
  // or when that cannot be told. Returns the hit node id, or 0 when unknown.
  async function checkedHit(send, enable, signal, point, expectedOwner) {
    await enable('DOM');
    let hit = null;
    try {
      hit = await send('DOM.getNodeForLocation', {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: true,
      });
    } catch (error) {
      if (abortError(signal)) throw error;
    }
    const hitNodeId = Number(hit?.backendNodeId);
    const hitId = Number.isInteger(hitNodeId) && hitNodeId > 0 ? hitNodeId : 0;
    let tree = null;
    try {
      tree = (await send('Page.getFrameTree'))?.frameTree || null;
    } catch (error) {
      if (abortError(signal)) throw error;
    }
    const hitFrameId = String(hit?.frameId || '');
    if (!hitFrameId) {
      // The browser did not say which frame the point is in (a tab in the background, a node the page just
      // re-rendered, or no hit at all). Ask the DOM instead of refusing every page that has a frame: a node it
      // can place is judged by the documents above it, like a control is; with nothing to place, the point is
      // refused only when a frame Hermes may not read could be under it.
      let placed = null;
      if (hitId) {
        try {
          placed = await documentPathOfNode(send, hitId);
        } catch (error) {
          if (abortError(signal)) throw error;
        }
      }
      if (placed) {
        let described = null;
        try {
          described = (await send('DOM.describeNode', { backendNodeId: hitId }))?.node || null;
        } catch (error) {
          if (abortError(signal)) throw error;
        }
        if (!described) throw restrictedFrameError('Hermes could not tell what is under that point.');
        if (embedsFrame(described)) {
          const owned = String(described.frameId || '');
          const ownedPath = owned && tree ? frameTreePath(tree, owned) : null;
          if (!ownedPath || !frameChainReadable(framePathUrls(ownedPath))) {
            throw restrictedFrameError('The pointer would land in a frame Hermes cannot read.');
          }
        }
        if (!frameChainReadable(placed.urls)) throw restrictedFrameError();
        if (expectedOwner !== undefined && placed.owner !== expectedOwner) {
          throw restrictedFrameError('The control is covered by content from another frame.');
        }
        return hitId;
      }
      let unreadableAtPoint = true;
      try {
        const owners = await unreadableFrameOwners(send, signal);
        const here = { x: point.x - 0.5, y: point.y - 0.5, width: 1, height: 1 };
        unreadableAtPoint = false;
        for (const owner of owners) {
          if (await ownerInRegion(send, signal, owner, here)) { unreadableAtPoint = true; break; }
        }
      } catch (error) {
        if (abortError(signal)) throw error;
        unreadableAtPoint = true;
      }
      if (unreadableAtPoint) throw restrictedFrameError('Hermes could not tell which frame is under that point.');
      return hitId;
    }
    if (hitId) {
      let described = null;
      try {
        described = (await send('DOM.describeNode', { backendNodeId: hitId }))?.node || null;
      } catch (error) {
        if (abortError(signal)) throw error;
      }
      if (!described) throw restrictedFrameError('Hermes could not tell what is under that point.');
      if (embedsFrame(described)) {
        const owned = String(described.frameId || '');
        const ownedPath = owned && tree ? frameTreePath(tree, owned) : null;
        if (!ownedPath || !frameChainReadable(framePathUrls(ownedPath))) {
          throw restrictedFrameError('The pointer would land in a frame Hermes cannot read.');
        }
      }
    }
    if (tree?.frame?.id === hitFrameId) {
      if (expectedOwner !== undefined && expectedOwner !== 0) throw restrictedFrameError('The control is covered by content from another frame.');
      return hitId;
    }
    const path = tree ? frameTreePath(tree, hitFrameId) : null;
    if (!path || !frameChainReadable(framePathUrls(path))) throw restrictedFrameError();
    if (expectedOwner !== undefined) {
      let owner = -1;
      try {
        owner = Number((await send('DOM.getFrameOwner', { frameId: hitFrameId }))?.backendNodeId) || -1;
      } catch (error) {
        if (abortError(signal)) throw error;
      }
      if (owner !== expectedOwner) throw restrictedFrameError('The control is covered by content from another frame.');
    }
    return hitId;
  }

  // Whether a click on this node would open a new tab (see clickTargetOpensNewTab).
  // A failed check is "no": the click then goes out exactly as it always did.
  async function clickOpensNewTab(send, signal, backendNodeId) {
    if (!(Number.isInteger(backendNodeId) && backendNodeId > 0)) return false;
    try {
      const resolved = await send('DOM.resolveNode', { backendNodeId });
      const objectId = String(resolved?.object?.objectId || '');
      if (!objectId) return false;
      const checked = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: CLICK_OPENS_NEW_TAB_FUNCTION,
        returnByValue: true,
      });
      return checked?.result?.value === true;
    } catch (error) {
      if (abortError(signal)) throw error;
      return false;
    }
  }

  async function readScrollPosition(send, signal) {
    try {
      const evaluated = await send('Runtime.evaluate', {
        expression: SCROLL_POSITION_EXPRESSION,
        returnByValue: true,
      });
      const value = evaluated?.result?.value;
      if (!value || typeof value !== 'object') return null;
      return {
        scrollX: Number(value.scrollX) || 0,
        scrollY: Number(value.scrollY) || 0,
        maxY: Number(value.maxY) || 0,
        atTop: value.atTop === true,
        atBottom: value.atBottom === true,
      };
    } catch (error) {
      if (abortError(signal)) throw error;
      return null;
    }
  }

  async function pageIsHidden(send, signal) {
    try {
      const evaluated = await send('Runtime.evaluate', {
        expression: "document.visibilityState === 'hidden'",
        returnByValue: true,
      });
      return evaluated?.result?.value === true;
    } catch (error) {
      if (abortError(signal)) throw error;
      return false;
    }
  }

  async function scrollWithoutWheel(send, signal, backendNodeId, deltaX, deltaY) {
    if (backendNodeId > 0) {
      try {
        const resolved = await send('DOM.resolveNode', { backendNodeId });
        const objectId = String(resolved?.object?.objectId || '');
        if (objectId) {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: SCROLL_NODE_FUNCTION,
            arguments: [{ value: deltaX }, { value: deltaY }],
            returnByValue: true,
          });
          return;
        }
      } catch (error) {
        if (abortError(signal)) throw error;
      }
    }
    await send('Runtime.evaluate', {
      expression: `window.scrollBy({left:${deltaX},top:${deltaY},behavior:'auto'})`,
      returnByValue: true,
    });
  }

  async function performScroll({ send, enable }, args, target, signal, framing = {}) {
    const { axis, sign } = scrollDirection(args.direction);
    let metrics = {};
    try {
      metrics = await send('Page.getLayoutMetrics') || {};
    } catch (error) {
      if (abortError(signal)) throw error;
    }
    const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
    const viewportWidth = Number(viewport.clientWidth) || 1_024;
    const viewportHeight = Number(viewport.clientHeight) || 768;
    const requested = Number(args.amount);
    const amount = Number.isFinite(requested) && requested > 0
      ? Math.min(SCROLL_MAX_PX, Math.max(SCROLL_MIN_PX, Math.round(requested)))
      : Math.round((axis === 'x' ? viewportWidth : viewportHeight) * SCROLL_VIEWPORT_FRACTION);
    const deltaX = axis === 'x' ? sign * amount : 0;
    const deltaY = axis === 'y' ? sign * amount : 0;
    let point = { x: viewportWidth / 2, y: viewportHeight / 2 };
    const backendNodeId = Number(target?.backendDOMNodeId);
    const hasNode = Number.isInteger(backendNodeId) && backendNodeId > 0;
    if (hasNode) {
      await enable('DOM');
      point = await nodeCenter(send, backendNodeId);
    }
    // A hidden tab never produces frames, so Chrome would hold the wheel event
    // until the tab is shown again and the action would hang. Scroll through
    // the page instead.
    // The wheel is delivered to whatever is under its point, so that point is judged like a click's: a frame
    // Hermes may not read (or one that cannot be told) under it gets no wheel, and the page is scrolled itself.
    let wheelAllowed = true;
    const hidden = await pageIsHidden(send, signal);
    if (!hidden) {
      try {
        await checkedHit(send, enable, signal, point, hasNode ? framing.target : undefined);
      } catch (error) {
        if (error?.code !== 'restricted_frame') throw error;
        wheelAllowed = false;
      }
    }
    if (!wheelAllowed || hidden) {
      await scrollWithoutWheel(send, signal, hasNode ? backendNodeId : 0, deltaX, deltaY);
    } else {
      try {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: Math.round(point.x), y: Math.round(point.y), deltaX, deltaY,
        });
      } catch (error) {
        if (abortError(signal)) throw error;
        await scrollWithoutWheel(send, signal, 0, deltaX, deltaY);
      }
    }
    await sleep(SCROLL_SETTLE_MS);
    assertNotAborted(signal);
    const position = await readScrollPosition(send, signal);
    return { status: 'scrolled', ...(position ? { position } : {}) };
  }

  async function navigate(args, scope, signal) {
    const tabId = tabIdFrom(scope);
    const requested = String(args.url || '');
    const before = await browserApi.tabs.get(tabId);
    assertNotAborted(signal);
    const beforeUrl = compact(before?.url || before?.pendingUrl, 2_000);
    if (requested && isSamePage(requested, beforeUrl)) {
      return { ...tabSummary(before), status: 'already-open', navigated: false };
    }
    return withSession(scope, signal, async ({ send, enable }) => {
      await enable('Page');
      const watch = watchLoad(tabId);
      try {
        const started = await send('Page.navigate', { url: requested });
        if (started?.errorText) {
          throw codedError('navigation_failed', `Navigation failed: ${compact(started.errorText, 200)}`);
        }
        const waited = await watch.wait({ signal, startUrl: beforeUrl, frameId: started?.frameId });
        const after = await browserApi.tabs.get(tabId);
        return { ...tabSummary(after), status: 'navigated', navigated: true, timedOut: waited.timedOut };
      } finally {
        watch.dispose();
      }
    });
  }

  async function goBack(scope, signal) {
    const tabId = tabIdFrom(scope);
    const before = await browserApi.tabs.get(tabId);
    assertNotAborted(signal);
    return withSession(scope, signal, async ({ send, enable }) => {
      await enable('Page');
      const history = await send('Page.getNavigationHistory');
      const previous = history?.entries?.[Number(history.currentIndex) - 1];
      if (!previous?.id) throw new Error('No previous page is available.');
      const watch = watchLoad(tabId);
      try {
        await send('Page.navigateToHistoryEntry', { entryId: previous.id });
        const waited = await watch.wait({ signal, startUrl: before?.url || before?.pendingUrl });
        const after = await browserApi.tabs.get(tabId);
        return { ...tabSummary(after), status: 'navigated-back', navigated: true, timedOut: waited.timedOut };
      } finally {
        watch.dispose();
      }
    });
  }

  // Runs a press and its release. A Stop, a detach or a failure after the button went down must not leave it
  // down (a drag in progress, a hold-on-mousedown control firing), so the release is sent again, straight to the
  // browser and without the cancellation check, whenever the normal release did not complete. A release for a
  // button that is not down does nothing.
  async function pressAndRelease(session, position, modifierFields, press, release) {
    let down = false;
    try {
      down = true;
      await press();
      await release();
      down = false;
    } finally {
      if (down) {
        const at = position?.at || position;
        await rawSend(session.tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1, ...modifierFields,
        }).catch(() => {});
      }
    }
  }

  // The address the tab has now, refused when it is a page Hermes will not capture.
  async function screenshotPageAddress(tabId, signal, allowLocalDocuments) {
    const tab = await browserApi.tabs.get(tabId);
    assertNotAborted(signal);
    const url = compact(tab?.url || tab?.pendingUrl, 2_000);
    if (isRestrictedUrl(url, { allowLocalDocuments })) {
      throw codedError('restricted_page', 'This page is one Hermes will not capture, so no screenshot was taken or kept.');
    }
    return url;
  }

  async function runWithSession(action, args, scope, signal, target, destination, { allowLocalDocuments = false } = {}) {
    return withSession(scope, signal, async (session) => {
      const { send, enable } = session;
      const framing = action === 'browser_snapshot' ? {} : await assertFramedTargetsReadable(send, enable, signal, { target, destination });
      if (action === 'browser_snapshot') {
        await enable('Accessibility');
        const trees = await collectAxTrees({ send, tabId: session.tabId, signal });
        const tab = await browserApi.tabs.get(session.tabId);
        assertNotAborted(signal);
        return chromiumSnapshot(trees, tab, { full: args.full === true });
      }
      if (action === 'browser_click') {
        let point;
        const backendNodeId = Number(target?.backendDOMNodeId);
        let obscured = false;
        let hitNodeId = 0;
        if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
          await enable('DOM');
          point = await nodeCenter(send, backendNodeId);
          hitNodeId = await checkedHit(send, enable, signal, point, framing.target);
          obscured = await pointIsObscured(send, signal, backendNodeId, hitNodeId);
        } else {
          point = pointForArgs(args);
          hitNodeId = await checkedHit(send, enable, signal, point, undefined);
        }
        // A link that opens a new tab gets the background-tab modifier, so Chrome opens
        // it behind the tab the person is looking at. The click lands on whatever is under
        // the point, so the referenced node and the node under the point are both checked.
        const opensNewTab = await clickOpensNewTab(send, signal, backendNodeId)
          || (hitNodeId !== backendNodeId && await clickOpensNewTab(send, signal, hitNodeId));
        const modifiers = opensNewTab ? backgroundTabModifier : 0;
        const modifierFields = modifiers ? { modifiers } : {};
        // Chrome holds a mouseMoved until the next frame, which a hidden tab
        // never draws; the press and release are delivered regardless.
        const hidden = await pageIsHidden(send, signal);
        // The checks above ran page script, which can move things. The frame under the point is judged again as
        // the last step before the pointer moves, and once more before it presses, with nothing of ours running
        // in the page in between.
        await checkedHit(send, enable, signal, point, backendNodeId > 0 ? framing.target : undefined);
        if (!hidden) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 });
          await checkedHit(send, enable, signal, point, backendNodeId > 0 ? framing.target : undefined);
        }
        await pressAndRelease(session, point, modifierFields, async () => {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1, ...modifierFields });
        }, async () => {
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1, ...modifierFields });
        });
        return { status: 'clicked', ...(obscured ? { obscured: true } : {}) };
      }
      if (action === 'browser_hover' || action === 'browser_scroll_to' || action === 'browser_drag') {
        const sourceNodeId = Number(target?.backendDOMNodeId);
        if (!Number.isInteger(sourceNodeId) || sourceNodeId <= 0) throw new Error('The source ref has no DOM node.');
        await enable('DOM');
        const sourcePoint = await nodeCenter(send, sourceNodeId);
        if (action === 'browser_scroll_to') return { status: 'scrolled-to-target' };
        if (await pageIsHidden(send, signal)) throw hiddenTabError();
        await checkedHit(send, enable, signal, sourcePoint, framing.target);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sourcePoint, button: 'none', buttons: 0 });
        if (action === 'browser_hover') return { status: 'hovered' };
        const destinationNodeId = Number(destination?.backendDOMNodeId);
        if (!Number.isInteger(destinationNodeId) || destinationNodeId <= 0) throw new Error('The destination ref has no DOM node.');
        const destinationPoint = await nodeCenter(send, destinationNodeId);
        await checkedHit(send, enable, signal, destinationPoint, framing.destination);
        // Scrolling to the destination can move the source, so its point is read again (without scrolling back,
        // which could undo the destination's scroll) and judged right before the press. A source that is now
        // covered by another element is not pressed: the approval was for the source ref, not for what sits there.
        const pressPoint = quadCenter(await send('DOM.getBoxModel', { backendNodeId: sourceNodeId }));
        const pressHit = await checkedHit(send, enable, signal, pressPoint, framing.target);
        if (await pointIsObscured(send, signal, sourceNodeId, pressHit)) {
          throw new Error('The drag source moved or was covered after scrolling to the destination, so nothing was pressed. Take a new snapshot and try again.');
        }
        if (Math.abs(pressPoint.x - sourcePoint.x) > 0.5 || Math.abs(pressPoint.y - sourcePoint.y) > 0.5) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pressPoint, button: 'none', buttons: 0 });
        }
        const held = { at: pressPoint };
        await pressAndRelease(session, held, {}, async () => {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pressPoint, button: 'left', buttons: 1, clickCount: 1 });
          held.at = destinationPoint;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...destinationPoint, button: 'left', buttons: 1 });
        }, async () => {
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destinationPoint, button: 'left', buttons: 0, clickCount: 1 });
        });
        return { status: 'dragged' };
      }
      if (action === 'browser_type') {
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error('The target ref has no DOM node.');
        await enable('DOM');
        await send('DOM.focus', { backendNodeId });
        const resolved = await send('DOM.resolveNode', { backendNodeId });
        const objectId = String(resolved?.object?.objectId || '');
        // Replace by default: select what is there so the insert overwrites it.
        if (objectId && args.clear !== false) {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: CLEAR_FIELD_FUNCTION,
            returnByValue: true,
          });
        }
        await send('Input.insertText', { text: String(args.text ?? '') });
        if (objectId) {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function(){this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));}',
            returnByValue: true,
          });
        }
        return { status: 'typed' };
      }
      if (action === 'browser_fill') {
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error('The target ref has no DOM node.');
        const fillValue = String(args.value ?? args.text ?? '');
        await enable('DOM');
        await send('DOM.focus', { backendNodeId });
        const resolved = await send('DOM.resolveNode', { backendNodeId });
        const objectId = String(resolved?.object?.objectId || '');
        if (objectId) {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function(val) {
              const proto = Object.getPrototypeOf(this);
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              if (setter) {
                setter.call(this, val);
              } else {
                this.value = val;
              }
              this.dispatchEvent(new Event('input', { bubbles: true }));
              this.dispatchEvent(new Event('change', { bubbles: true }));
              this.dispatchEvent(new Event('blur', { bubbles: true }));
            }`,
            arguments: [{ value: fillValue }],
            returnByValue: true,
          });
        }
        return { status: 'filled' };
      }
      if (action === 'browser_select') {
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error('The target ref has no DOM node.');
        const selectValue = String(args.value ?? args.option ?? '');
        const selectIndex = Number.isInteger(Number(args.index)) ? Number(args.index) : null;
        await enable('DOM');
        await send('DOM.focus', { backendNodeId });
        const resolved = await send('DOM.resolveNode', { backendNodeId });
        const objectId = String(resolved?.object?.objectId || '');
        if (objectId) {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function(val, idx) {
              if (this.tagName === 'SELECT') {
                if (idx !== null && idx >= 0 && idx < this.options.length) {
                  this.selectedIndex = idx;
                } else if (val) {
                  let matched = false;
                  for (let i = 0; i < this.options.length; i++) {
                    if (this.options[i].value === val || this.options[i].text === val) {
                      this.selectedIndex = i;
                      matched = true;
                      break;
                    }
                  }
                  if (!matched) this.value = val;
                }
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
                this.dispatchEvent(new Event('blur', { bubbles: true }));
              }
            }`,
            arguments: [{ value: selectValue }, { value: selectIndex }],
            returnByValue: true,
          });
        }
        return { status: 'selected' };
      }
      if (action === 'browser_press') {
        const { down, up } = keyEventFields(args);
        await send('Input.dispatchKeyEvent', down);
        await send('Input.dispatchKeyEvent', up);
        return { status: 'pressed' };
      }
      if (action === 'browser_scroll') return performScroll(session, args, target, signal, framing);
      if (action === 'browser_screenshot') {
        // The executor judged the page before the debugger attached; the frame checks and the capture itself take
        // several round trips, so the tab's own address is read again around the capture.
        const before = await screenshotPageAddress(session.tabId, signal, allowLocalDocuments);
        let clip;
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
          await enable('DOM');
          await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          const targetBox = await send('DOM.getBoxModel', { backendNodeId });
          const view = await readViewport(send, signal);
          if (!view) throw new Error('Hermes could not tell where the page is scrolled to, so no screenshot was taken. Try again.');
          clip = screenshotClip(targetBox, args.zoom, view);
        }
        await enable('DOM');
        await assertScreenshotFramesReadable(send, signal, clip);
        const hidden = await pageIsHidden(send, signal);
        const capture = send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          ...(clip ? { clip } : {}),
        });
        // A hidden tab may never produce the frame a capture waits for.
        const captured = await (hidden
          ? withTimeout(capture, HIDDEN_CAPTURE_TIMEOUT_MS, () => hiddenScreenshotError(), setTimer, clearTimer)
          : capture);
        // A frame can move to a restricted page while the capture runs; the pixels are dropped if so.
        await assertScreenshotFramesReadable(send, signal, clip);
        // The page can have moved to a restricted address, or to another page, since: the pixels are dropped.
        const after = await screenshotPageAddress(session.tabId, signal, allowLocalDocuments);
        if (comparableUrl(after) !== comparableUrl(before)) {
          throw codedError('page_changed', 'The page changed while the screenshot was taken, so it was discarded. Try again.');
        }
        return { ...boundedScreenshot(`data:image/png;base64,${String(captured?.data || '')}`), url: after };
      }
      throw new Error(`Action ${action} is not implemented by the Chromium adapter.`);
    });
  }

  async function execute(action, args = {}, {
    scope = {}, signal, target = null, destination = null, leasedTabIds = [], ownedTabIds = [], currentWindowId = null,
    allowLocalDocuments = false,
  } = {}) {
    if (!contract.actions.includes(action)) throw new Error(`Action ${action} is not supported by the Chromium adapter.`);
    assertNotAborted(signal);
    const tabId = tabIdFrom(scope);
    if (action === 'browser_tabs') {
      const tabs = await browserApi.tabs.query({});
      return { tabs: privacySafeLeasedTabs(tabs, leasedTabIds) };
    }
    if (action === 'browser_tab_activate') {
      const targetTabId = Number(args.tab_id);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) throw new Error('A valid tab id is required.');
      return browserApi.tabs.update(targetTabId, { active: true });
    }
    if (action === 'browser_tab_create') {
      const windowId = Number(currentWindowId) || Number((await browserApi.tabs.get(tabId))?.windowId) || null;
      const tab = await browserApi.tabs.create({
        url: String(args.url || ''),
        // Hermes never takes the person's view: a tab it opens starts in the background.
        active: false,
        ...(windowId ? { windowId } : {}),
      });
      return { tab };
    }
    if (action === 'browser_tab_close') {
      const targetTabId = Number(args.tab_id);
      if (!ownedTabIds.includes(targetTabId)) throw new Error('The target tab is not owned by this controller.');
      await browserApi.tabs.remove(targetTabId);
      return { status: 'tab-closed' };
    }
    if (action === 'browser_tab_group' || action === 'browser_tab_ungroup') {
      const tabIds = [...new Set((Array.isArray(args.tab_ids) ? args.tab_ids : []).map(Number))];
      if (!tabIds.length || tabIds.some((tabIdValue) => !ownedTabIds.includes(tabIdValue))) {
        throw new Error('Every grouped tab must be owned by this controller.');
      }
      if (action === 'browser_tab_group') {
        if (typeof browserApi.tabs.group !== 'function') throw new Error('Native tab grouping is unavailable.');
        return { groupId: await browserApi.tabs.group({ tabIds }) };
      }
      if (typeof browserApi.tabs.ungroup !== 'function') throw new Error('Native tab ungrouping is unavailable.');
      await browserApi.tabs.ungroup(tabIds);
      return { status: 'tabs-ungrouped' };
    }
    if (action === 'browser_navigate') return navigate(args, scope, signal);
    if (action === 'browser_back') return goBack(scope, signal);
    return runWithSession(action, args, scope, signal, target, destination, { allowLocalDocuments });
  }

  // Waits for the page to react to an action. Never throws: any failure is
  // reported as timedOut so a successful action is never turned into an error.
  async function settle({
    scope = {}, signal, mode = 'dom', timeoutMs, loadTimeoutMs,
  } = {}) {
    let url = '';
    let title = '';
    let navigated = mode === 'navigation';
    let timedOut = false;
    try {
      const tabId = tabIdFrom(scope);
      assertNotAborted(signal);
      const before = await browserApi.tabs.get(tabId);
      const startUrl = before?.url || before?.pendingUrl || '';
      const loadOptions = { signal, startUrl, sawLoading: before?.status === 'loading' };
      // `timeoutMs` bounds the quiet-window wait. A page that is loading is
      // given the load budget instead, so a slow navigation is not read half
      // way through (its refs would be minted before the new document is ready).
      const loadBudgetMs = Math.min(LOAD_TIMEOUT_MS, boundedMs(loadTimeoutMs, LOAD_TIMEOUT_MS));
      if (mode === 'navigation' || before?.status === 'loading') {
        navigated = true;
        const waited = await waitForLoad(tabId, {
          ...loadOptions,
          timeoutMs: mode === 'navigation' ? boundedMs(timeoutMs, LOAD_TIMEOUT_MS) : loadBudgetMs,
          startUrl: mode === 'navigation' ? '' : startUrl,
          graceMs: 0,
        });
        timedOut = waited.timedOut;
      } else {
        const capMs = boundedMs(timeoutMs, DOM_SETTLE_CAP_MS, 5_000);
        const quiet = await quietWindow(scope, signal, capMs);
        timedOut = !quiet;
        const after = await browserApi.tabs.get(tabId);
        if (after?.status === 'loading' || comparableUrl(after?.url || after?.pendingUrl) !== comparableUrl(startUrl)) {
          navigated = true;
          const waited = await waitForLoad(tabId, {
            ...loadOptions,
            timeoutMs: loadBudgetMs,
            sawLoading: after?.status === 'loading',
            graceMs: 0,
          });
          timedOut = waited.timedOut;
        }
      }
      ({ url, title } = tabSummary(await browserApi.tabs.get(tabId)));
    } catch {
      timedOut = true;
      try {
        ({ url, title } = tabSummary(await browserApi.tabs.get(tabIdFrom(scope))));
      } catch {
        // The tab may be gone; the caller still gets a bounded result.
      }
    }
    return { navigated, url, title, timedOut };
  }

  // Resolves true when the page stayed quiet, false when the cap was hit or the
  // wait failed (for example because a navigation destroyed the context).
  async function quietWindow(scope, signal, capMs) {
    let timer = null;
    try {
      const evaluation = withSession(scope, signal, async ({ send, enable }) => {
        await enable('Page');
        const result = await send('Runtime.evaluate', {
          expression: quietWindowExpression(DOM_QUIET_MS, capMs),
          awaitPromise: true,
          returnByValue: true,
        });
        return result?.result?.value === true;
      });
      evaluation.catch(() => {});
      const hardCap = new Promise((resolve) => {
        timer = setTimer(() => resolve(false), capMs + 300);
        timer?.unref?.();
      });
      return await Promise.race([evaluation, hardCap]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimer(timer);
    }
  }

  async function releaseTab(tabId) {
    const normalized = Number(tabId);
    if (!Number.isInteger(normalized) || normalized <= 0) return false;
    bumpReleaseEpoch(normalized);
    if (inflight.has(normalized)) await inflight.get(normalized).catch(() => {});
    if (sessions.has(normalized) || detaching.has(normalized)) return detachSession(normalized);
    // Nothing is recorded here, but a service worker that was restarted since
    // the attach left the debugger attached. Detach only works for our own
    // attachment, so DevTools or another extension is never touched.
    return trackDetach(normalized);
  }

  // Detaches debugger attachments this worker instance does not know about: the
  // idle timers of a suspended or restarted service worker are gone, and nothing
  // else would ever remove Chrome's "is debugging this browser" bar.
  async function sweepOrphans() {
    if (typeof debuggerApi?.getTargets !== 'function') return 0;
    let targets = [];
    try {
      targets = await debuggerApi.getTargets();
    } catch {
      return 0;
    }
    let released = 0;
    for (const target of Array.isArray(targets) ? targets : []) {
      const tabId = Number(target?.tabId);
      if (target?.attached !== true || !Number.isInteger(tabId) || tabId <= 0) continue;
      if (sessions.has(tabId) || inflight.has(tabId) || detaching.has(tabId) || activeOperations.has(tabId)) continue;
      if (await trackDetach(tabId)) released += 1;
    }
    return released;
  }

  async function releaseAll() {
    for (const tabId of sessions.keys()) bumpReleaseEpoch(tabId);
    const released = await Promise.all([...sessions.keys()].map((tabId) => detachSession(tabId)));
    return released.filter(Boolean).length;
  }

  return {
    contract,
    inspect: ({ tabId, frameId, signal, light } = {}) => inspectPage(browserApi, { tabId, frameId }, signal, { light: light === true }),
    async targetBounds({ scope = {}, signal, target = null } = {}) {
      const backendNodeId = Number(target?.backendDOMNodeId);
      if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
      return withSession(scope, signal, async ({ send, enable }) => {
        await enable('DOM');
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
        return quadRect(await send('DOM.getBoxModel', { backendNodeId }));
      });
    },
    execute,
    settle,
    releaseTab,
    releaseAll,
    sweepOrphans,
    dispose() {
      debuggerApi?.onDetach?.removeListener?.(detachListener);
      debuggerApi?.onEvent?.removeListener?.(eventListener);
      eventWaiters.clear();
      expectedDetaches.clear();
      return releaseAll();
    },
  };
}

function createFirefoxWebExtensionAdapter({ browserApi, now = Date.now, sleep = defaultSleep } = {}) {
  if (!browserApi?.tabs || !browserApi?.scripting) throw new TypeError('Firefox tabs and scripting APIs are required.');
  const contract = controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { debugger: false, scripting: true, tabs: true } },
    controlEnabled: true,
  });

  const { waitForLoad } = createLoadWaiter({ browserApi, now, sleep });

  // Firefox has no browser_click here (FIREFOX_GAPS: trusted input is unavailable), so
  // the Chromium click path and its new-tab modifier do not apply to this adapter.
  async function script(scope, signal, mode, direction = '') {
    assertNotAborted(signal);
    const response = await browserApi.scripting.executeScript({
      target: { tabId: tabIdFrom(scope), frameIds: [Math.max(0, Number(scope.frameId) || 0)] },
      func: pageProbe,
      args: [mode, direction],
    });
    assertNotAborted(signal);
    return response?.[0]?.result || {};
  }

  // The leased tab, only when the window is showing it and its page is one Hermes may read.
  async function visibleLeasedTab(tabId, allowLocalDocuments = false) {
    const tab = await browserApi.tabs.get(tabId);
    const shown = (await browserApi.tabs.query({ active: true, windowId: tab?.windowId }))?.[0];
    if (!tab?.active || shown?.id !== tabId) throw notActiveTabError();
    if (isRestrictedUrl(tab.url || '', { allowLocalDocuments })) {
      throw codedError('restricted_page', 'This page is one Hermes will not capture.');
    }
    return tab;
  }

  async function execute(action, args = {}, {
    scope = {}, signal, leasedTabIds = [], ownedTabIds = [], currentWindowId = null, allowLocalDocuments = false,
  } = {}) {
    if (!contract.actions.includes(action)) throw new Error(`Action ${action} is not supported by the Firefox adapter.`);
    assertNotAborted(signal);
    const tabId = tabIdFrom(scope);
    if (action === 'browser_snapshot') return script(scope, signal, 'snapshot');
    if (action === 'browser_scroll') return script(scope, signal, 'scroll', String(args.direction || ''));
    if (action === 'browser_navigate') return browserApi.tabs.update(tabId, { url: String(args.url || '') });
    if (action === 'browser_back') {
      if (typeof browserApi.tabs.goBack !== 'function') throw new Error('Firefox back navigation is unavailable.');
      await browserApi.tabs.goBack(tabId);
      return { status: 'navigated-back' };
    }
    if (action === 'browser_screenshot') {
      // captureVisibleTab photographs the WINDOW's active tab, whichever tab that is. The
      // leased tab must be that tab, on a page Hermes may read, before and after the capture.
      const before = await visibleLeasedTab(tabId, allowLocalDocuments);
      assertNotAborted(signal);
      const dataUrl = await browserApi.tabs.captureVisibleTab(before.windowId, { format: 'png' });
      assertNotAborted(signal);
      const after = await visibleLeasedTab(tabId, allowLocalDocuments).catch(() => null);
      if (!after || after.url !== before.url) {
        throw codedError('not_active_tab', 'The tab changed while the screenshot was taken, so it was discarded. Try again.');
      }
      return { ...boundedScreenshot(dataUrl), url: after.url };
    }
    if (action === 'browser_tabs') {
      const tabs = await browserApi.tabs.query({});
      return { tabs: privacySafeLeasedTabs(tabs, leasedTabIds) };
    }
    if (action === 'browser_tab_activate') {
      const targetTabId = Number(args.tab_id);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) throw new Error('A valid tab id is required.');
      return browserApi.tabs.update(targetTabId, { active: true });
    }
    if (action === 'browser_tab_create') {
      const windowId = Number(currentWindowId) || Number((await browserApi.tabs.get(tabId))?.windowId) || null;
      const tab = await browserApi.tabs.create({
        url: String(args.url || ''),
        // Hermes never takes the person's view: a tab it opens starts in the background.
        active: false,
        ...(windowId ? { windowId } : {}),
      });
      return { tab };
    }
    if (action === 'browser_tab_close') {
      const targetTabId = Number(args.tab_id);
      if (!ownedTabIds.includes(targetTabId)) throw new Error('The target tab is not owned by this controller.');
      await browserApi.tabs.remove(targetTabId);
      return { status: 'tab-closed' };
    }
    throw new Error(`Action ${action} is not implemented by the Firefox adapter.`);
  }

  // Same contract as the Chromium adapter; Firefox has no debugger session, so
  // settling polls the tab status and releasing is a no-op.
  async function settle({ scope = {}, signal, timeoutMs } = {}) {
    let summary = { url: '', title: '' };
    let timedOut = false;
    let navigated = false;
    try {
      const tabId = tabIdFrom(scope);
      const before = await browserApi.tabs.get(tabId);
      navigated = before?.status === 'loading';
      if (navigated) {
        const waited = await waitForLoad(tabId, {
          signal, sawLoading: true, graceMs: 0, timeoutMs: boundedMs(timeoutMs, LOAD_TIMEOUT_MS),
        });
        timedOut = waited.timedOut;
      }
      summary = tabSummary(await browserApi.tabs.get(tabId));
    } catch {
      timedOut = true;
    }
    return { navigated, ...summary, timedOut };
  }

  return {
    contract,
    inspect: ({ tabId, frameId, signal, light } = {}) => inspectPage(browserApi, { tabId, frameId }, signal, { light: light === true }),
    execute,
    settle,
    releaseTab: async () => false,
  };
}

export {
  createChromiumCdpAdapter,
  createFirefoxWebExtensionAdapter,
};
