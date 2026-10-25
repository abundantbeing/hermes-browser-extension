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

export function fakeChromium({
  handlers = {}, tab = () => ({ url: 'https://example.com/', title: 'Example', status: 'complete', active: true, windowId: 1 }), onSend,
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
  return { api, calls, counts };
}


export const methodsOf = (calls) => calls.map((call) => call[0]);
export const captured = (calls) => calls.some((call) => call[0] === 'Page.captureScreenshot');
export const mouseEvents = (calls) => calls.filter((call) => call[0] === 'Input.dispatchMouseEvent').map((call) => call[1]);
export const openSignal = () => new AbortController().signal;
