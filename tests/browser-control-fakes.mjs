// Fakes shared by the Hermes Control hardening tests: a Chromium debugger that answers from per-method handlers,
// and the documents, frames and boxes that CDP describes. Not a test file.
export const box = (x, y, w, h) => ({ model: { content: [x, y, x + w, y, x + w, y + h, x, y + h], border: [x, y, x + w, y, x + w, y + h, x, y + h] } });

export const documentOf = (owners = []) => ({
  root: {
    nodeType: 9, nodeName: '#document', backendNodeId: 1, frameId: 'MAIN', documentURL: 'https://example.com/',
    children: [{ nodeType: 1, nodeName: 'BODY', backendNodeId: 2, children: [{ nodeType: 1, nodeName: 'A', backendNodeId: 44 }, ...owners] }],
  },
});
export const sameProcessFrame = (id, url, children = []) => ({
  nodeType: 1, nodeName: 'IFRAME', backendNodeId: id, frameId: `F${id}`,
  contentDocument: { nodeType: 9, nodeName: '#document', backendNodeId: id + 1000, documentURL: url, children },
});
export const crossProcessFrame = (id) => ({ nodeType: 1, nodeName: 'IFRAME', backendNodeId: id, frameId: `OOPIF${id}` });

// What chrome.debugger.getTargets() lists for the frames the browser runs in their own process: a target of type
// "other" whose id is the frame id of the owner element in the DOM, with its real address and no parent.
export const frameTarget = (id, url) => ({ type: 'other', id, url, attached: true, title: url });

// `debuggerTargets` is what getTargets() answers: a list, a function returning one, an Error to throw, or null for an
// API without the call. Chrome refuses the CDP method Target.getTargets to an extension ("Not allowed"), so the fake
// does too: a test that needs the list must go through the extension API.
export function fakeChromium({
  handlers = {}, tab = () => ({ url: 'https://example.com/', title: 'Example', status: 'complete', active: true, windowId: 1 }), onSend,
  debuggerTargets = [],
} = {}) {
  const calls = [];
  const counts = { attach: 0, detach: 0 };
  const defaults = {
    'DOM.getDocument': () => documentOf(),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'MAIN', url: 'https://example.com/' } } }),
    'DOM.getBoxModel': () => box(10, 20, 20, 20),
    'DOM.getNodeForLocation': () => ({ backendNodeId: 44, frameId: 'MAIN' }),
    'DOM.describeNode': () => ({ node: { nodeName: 'A' } }),
    'Runtime.evaluate': () => ({ result: { value: false } }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } }),
    'Page.captureScreenshot': () => ({ data: 'AAAA' }),
    'DOM.resolveNode': () => ({ object: { objectId: 'o' } }),
    'Runtime.callFunctionOn': () => ({ result: { value: false } }),
    'Target.getTargets': () => { throw new Error(JSON.stringify({ code: -32000, message: 'Not allowed' })); },
  };
  const table = { ...defaults, ...handlers };
  const api = {
    tabs: { get: async (id) => tab(id, calls) },
    scripting: { executeScript: async () => [{ result: {} }] },
    debugger: {
      attach: async () => { counts.attach += 1; },
      detach: async () => { counts.detach += 1; },
      sendCommand: async (target, method, params) => {
        calls.push([method, params]);
        onSend?.(method, params, calls);
        const handler = table[method];
        return handler ? handler(params, calls) : {};
      },
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  };
  const targetCalls = { count: 0 };
  if (debuggerTargets !== null) {
    api.debugger.getTargets = async () => {
      targetCalls.count += 1;
      const value = typeof debuggerTargets === 'function' ? debuggerTargets() : debuggerTargets;
      if (value instanceof Error) throw value;
      return value;
    };
  }
  return { api, calls, counts, targetCalls };
}


export const methodsOf = (calls) => calls.map((call) => call[0]);
export const captured = (calls) => calls.some((call) => call[0] === 'Page.captureScreenshot');
export const mouseEvents = (calls) => calls.filter((call) => call[0] === 'Input.dispatchMouseEvent').map((call) => call[1]);
export const openSignal = () => new AbortController().signal;
