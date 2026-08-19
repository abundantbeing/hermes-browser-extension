import {
  controllerAdapterContractFor,
} from './browser-controller-adapter.mjs';
import { isRestrictedUrl, privacySafeTabForPrompt } from './browser-context-protocol.mjs';

const CDP_VERSION = '1.3';
const MAX_INLINE_SCREENSHOT_CHARS = 1_500_000;
const ACTIONABLE_AX_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'dialog', 'gridcell', 'link', 'listbox',
  'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem', 'image', 'img', 'figure', 'graphics-symbol',
]);

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

function cdpTarget(scope = {}) {
  return { tabId: tabIdFrom(scope) };
}

function debuggerConflict(error) {
  const message = String(error?.message || error || '');
  if (!/another debugger|already attached|debugger is attached/i.test(message)) return error;
  const conflict = new Error(`Another debugger controls this tab: ${message}`);
  conflict.code = 'debugger_conflict';
  return conflict;
}

async function withDebugger(debuggerApi, scope, signal, operation, cleanupTabs = new Set()) {
  assertNotAborted(signal);
  if (!debuggerApi?.attach || !debuggerApi?.sendCommand || !debuggerApi?.detach) {
    throw new Error('The Chromium debugger API is unavailable.');
  }
  const target = cdpTarget(scope);
  let attached = false;
  try {
    try {
      await debuggerApi.attach(target, CDP_VERSION);
    } catch (error) {
      throw debuggerConflict(error);
    }
    attached = true;
    assertNotAborted(signal);
    const send = async (method, params = {}) => {
      assertNotAborted(signal);
      const result = await debuggerApi.sendCommand(target, method, params);
      assertNotAborted(signal);
      return result;
    };
    return await operation(send, target);
  } finally {
    if (attached) {
      cleanupTabs.add(target.tabId);
      try {
        await debuggerApi.detach(target);
      } catch {
        // A completed/failed command must not be replaced by detach cleanup noise.
      } finally {
        globalThis.queueMicrotask(() => cleanupTabs.delete(target.tabId));
      }
    }
  }
}

function axValue(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return value.value;
  return value;
}

function chromiumSnapshot(tree = {}, tab = {}) {
  const rawNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const nodes = [];
  const text = [];
  for (const node of rawNodes) {
    if (!node || node.ignored === true) continue;
    const role = compact(axValue(node.role), 80).toLowerCase();
    const name = compact(axValue(node.name), 500);
    if (name && ['statictext', 'heading', 'paragraph'].includes(role)) text.push(name);
    const backendDOMNodeId = Number(node.backendDOMNodeId);
    if (!ACTIONABLE_AX_ROLES.has(role) || !Number.isInteger(backendDOMNodeId) || backendDOMNodeId <= 0) continue;
    const properties = Array.isArray(node.properties) ? node.properties : [];
    const autocomplete = compact(axValue(properties.find((property) => property?.name === 'autocomplete')?.value), 120);
    nodes.push({
      role,
      name,
      backendDOMNodeId,
      ...(autocomplete ? { autocomplete } : {}),
    });
  }
  return {
    title: compact(tab.title, 500),
    url: compact(tab.url || tab.pendingUrl),
    text: text.join('\n').slice(0, 100_000),
    nodes,
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

function keyDescriptor(value = '') {
  const key = compact(value, 80);
  if (!key) throw new Error('A key is required.');
  const aliases = {
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
    Return: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  };
  return { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...(aliases[key] || {}) };
}

function modifierMask(values = []) {
  const bits = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, shift: 8 };
  return [...new Set(Array.isArray(values) ? values : [])]
    .reduce((mask, value) => mask | (bits[compact(value, 20).toLowerCase()] || 0), 0);
}

function pointForArgs(args = {}) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Valid viewport coordinates are required.');
  return { x, y };
}

function screenshotClip(box = {}, zoom = 1) {
  const quad = Array.isArray(box?.model?.content) ? box.model.content.map(Number) : [];
  if (quad.length < 8 || quad.some((value) => !Number.isFinite(value))) throw new Error('The screenshot target has no visible box.');
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
    scale: Math.max(0.25, Math.min(Number(zoom) || 1, 4)),
  };
}

function directionDelta(direction = '') {
  const normalized = compact(direction, 20).toLowerCase();
  if (normalized === 'up') return { deltaX: 0, deltaY: -600 };
  if (normalized === 'left') return { deltaX: -600, deltaY: 0 };
  if (normalized === 'right') return { deltaX: 600, deltaY: 0 };
  if (normalized === 'down') return { deltaX: 0, deltaY: 600 };
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
    return { hasUnsavedContent: dirtyText || dirtyChecks };
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

async function inspectPage(browserApi, scope, signal) {
  assertNotAborted(signal);
  const tabId = tabIdFrom(scope);
  const tab = await browserApi.tabs.get(tabId);
  assertNotAborted(signal);
  const currentUrl = compact(tab?.url || tab?.pendingUrl);
  if (isRestrictedUrl(currentUrl)) return { currentUrl, hasUnsavedContent: false };
  let hasUnsavedContent = false;
  if (browserApi.scripting?.executeScript) {
    try {
      const response = await browserApi.scripting.executeScript({
        target: { tabId, frameIds: [Math.max(0, Number(scope.frameId) || 0)] },
        func: pageProbe,
        args: ['inspect'],
      });
      hasUnsavedContent = response?.[0]?.result?.hasUnsavedContent === true;
    } catch {
      // Inspection is a conservative enhancement; the action policy still runs.
    }
  }
  return { currentUrl, hasUnsavedContent };
}

function createChromiumCdpAdapter({ browserApi, onDebuggerDetach = () => {} } = {}) {
  if (!browserApi?.tabs) throw new TypeError('Chromium tabs API is required.');
  const contract = controllerAdapterContractFor({
    product: { id: 'chromium', engine: 'chromium' },
    capabilities: { apis: {
      debugger: Boolean(browserApi.debugger),
      scripting: Boolean(browserApi.scripting),
      tabs: Boolean(browserApi.tabs),
    } },
    controlEnabled: true,
  });
  const cleanupTabs = new Set();
  const detachListener = (debuggee = {}, reason = '') => {
    const tabId = Number(debuggee?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    if (cleanupTabs.delete(tabId)) return;
    onDebuggerDetach({
      tabId,
      reason: compact(reason, 120) || 'unknown',
      recoverable: false,
    });
  };
  browserApi.debugger?.onDetach?.addListener?.(detachListener);

  async function execute(action, args = {}, {
    scope = {}, signal, target = null, destination = null, leasedTabIds = [], ownedTabIds = [], currentWindowId = null,
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
        active: args.active !== false,
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

    return withDebugger(browserApi.debugger, scope, signal, async (send) => {
      if (action === 'browser_snapshot') {
        await send('Accessibility.enable');
        const tree = await send('Accessibility.getFullAXTree');
        const tab = await browserApi.tabs.get(tabId);
        assertNotAborted(signal);
        return chromiumSnapshot(tree, tab);
      }
      if (action === 'browser_click') {
        let point;
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
          await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          point = quadCenter(await send('DOM.getBoxModel', { backendNodeId }));
        } else {
          point = pointForArgs(args);
        }
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        return { status: 'clicked' };
      }
      if (action === 'browser_hover' || action === 'browser_scroll_to' || action === 'browser_drag') {
        const sourceNodeId = Number(target?.backendDOMNodeId);
        if (!Number.isInteger(sourceNodeId) || sourceNodeId <= 0) throw new Error('The source ref has no DOM node.');
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: sourceNodeId });
        const sourcePoint = quadCenter(await send('DOM.getBoxModel', { backendNodeId: sourceNodeId }));
        if (action === 'browser_scroll_to') return { status: 'scrolled-to-target' };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sourcePoint });
        if (action === 'browser_hover') return { status: 'hovered' };
        const destinationNodeId = Number(destination?.backendDOMNodeId);
        if (!Number.isInteger(destinationNodeId) || destinationNodeId <= 0) throw new Error('The destination ref has no DOM node.');
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: destinationNodeId });
        const destinationPoint = quadCenter(await send('DOM.getBoxModel', { backendNodeId: destinationNodeId }));
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...sourcePoint, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...destinationPoint, button: 'left' });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destinationPoint, button: 'left', clickCount: 1 });
        return { status: 'dragged' };
      }
      if (action === 'browser_type') {
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error('The target ref has no DOM node.');
        await send('DOM.focus', { backendNodeId });
        await send('Input.insertText', { text: String(args.text ?? '') });
        const resolved = await send('DOM.resolveNode', { backendNodeId });
        const objectId = String(resolved?.object?.objectId || '');
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
        const key = { ...keyDescriptor(args.key), modifiers: modifierMask(args.modifiers) };
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        return { status: 'pressed' };
      }
      if (action === 'browser_scroll') {
        const { deltaX, deltaY } = directionDelta(args.direction);
        await send('Runtime.evaluate', {
          expression: `window.scrollBy({left:${deltaX},top:${deltaY},behavior:'auto'})`,
          returnByValue: true,
        });
        return { status: 'scrolled' };
      }
      if (action === 'browser_navigate') {
        await send('Page.navigate', { url: String(args.url || '') });
        return { url: String(args.url || '') };
      }
      if (action === 'browser_back') {
        const history = await send('Page.getNavigationHistory');
        const previous = history?.entries?.[Number(history.currentIndex) - 1];
        if (!previous?.id) throw new Error('No previous page is available.');
        await send('Page.navigateToHistoryEntry', { entryId: previous.id });
        return { status: 'navigated-back' };
      }
      if (action === 'browser_screenshot') {
        let clip;
        const backendNodeId = Number(target?.backendDOMNodeId);
        if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
          await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          clip = screenshotClip(await send('DOM.getBoxModel', { backendNodeId }), args.zoom);
        }
        const captured = await send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          ...(clip ? { clip } : {}),
        });
        return boundedScreenshot(`data:image/png;base64,${String(captured?.data || '')}`);
      }
      throw new Error(`Action ${action} is not implemented by the Chromium adapter.`);
    }, cleanupTabs);
  }

  return {
    contract,
    inspect: ({ tabId, frameId, signal } = {}) => inspectPage(browserApi, { tabId, frameId }, signal),
    async targetBounds({ scope = {}, signal, target = null } = {}) {
      const backendNodeId = Number(target?.backendDOMNodeId);
      if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
      return withDebugger(browserApi.debugger, scope, signal, async (send) => {
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
        return quadRect(await send('DOM.getBoxModel', { backendNodeId }));
      }, cleanupTabs);
    },
    execute,
    dispose() {
      browserApi.debugger?.onDetach?.removeListener?.(detachListener);
      cleanupTabs.clear();
    },
  };
}

function createFirefoxWebExtensionAdapter({ browserApi } = {}) {
  if (!browserApi?.tabs || !browserApi?.scripting) throw new TypeError('Firefox tabs and scripting APIs are required.');
  const contract = controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { debugger: false, scripting: true, tabs: true } },
    controlEnabled: true,
  });

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

  async function execute(action, args = {}, {
    scope = {}, signal, leasedTabIds = [], ownedTabIds = [], currentWindowId = null,
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
      const tab = await browserApi.tabs.get(tabId);
      assertNotAborted(signal);
      const dataUrl = await browserApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      assertNotAborted(signal);
      return boundedScreenshot(dataUrl);
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
        active: args.active !== false,
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

  return {
    contract,
    inspect: ({ tabId, frameId, signal } = {}) => inspectPage(browserApi, { tabId, frameId }, signal),
    execute,
  };
}

export {
  createChromiumCdpAdapter,
  createFirefoxWebExtensionAdapter,
};
