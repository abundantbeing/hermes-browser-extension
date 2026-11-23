import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
const base = new URL('../extension/lib/', import.meta.url);
const { createBrowserControlExecutor } = await import(new URL('browser-control-executor.mjs', base));
const { createBrowserControlApprovalStore } = await import(new URL('browser-control-safety.mjs', base));
const { createBrowserControlRefStore } = await import(new URL('browser-control-refs.mjs', base));
const scope = { controllerId: 'background-test', leaseOwnerId: 'background-test', leaseId: 'lease', leaseGeneration: 1, tabId: 7, frameId: 0, documentGeneration: 1 };
const drive = 'https://drive.google.com/drive/u/1/folders/test';
function setup(label, url) {
  let clicks = 0, notifications = 0;
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: label, backendDOMNodeId: 12 }] });
  const adapter = { contract: { enabled: true, actions: ['browser_click', 'browser_snapshot'] },
    inspect: async () => ({ currentUrl: url }),
    execute: async (action) => action === 'browser_snapshot' ? { nodes: [], url } : { clicks: ++clicks },
  };
  const executor = createBrowserControlExecutor({ adapter, refs, approvals });
  const result = executor.execute({ command_id: 'cmd', action: 'browser_click', arguments: { ref: '@e1' }, tab_id: 7, frame_id: 0, document_generation: 1 }, { scope, backgroundTask: true, onDownloadApproval: () => notifications++ });
  return { result, approvals, clicks: () => clicks, notifications: () => notifications };
}
for (const label of ['Descargar', 'Download']) {
  test(`background Drive ${label} waits for a user and only executes after approval`, async () => {
    const b = setup(label, drive);
    await nextTurn();
    assert.equal(b.clicks(), 0); assert.equal(b.notifications(), 1);
    const [request] = b.approvals.pending();
    assert.equal(request.controllerId, 'background-test');
    assert.equal(b.approvals.grant(request).ok, true);
    assert.equal((await b.result).ok, true); assert.equal(b.clicks(), 1);
  });
}
test('decline leaves the page untouched', async () => {
  const b = setup('Descargar', drive);
  await nextTurn();
  b.approvals.cancelRequest(b.approvals.pending()[0].approvalId, 'approval_denied');
  assert.equal((await b.result).error.code, 'approval_denied'); assert.equal(b.clicks(), 0);
});
for (const [label, url] of [['Send message', drive], ['Download', 'https://example.test/']]) {
  test(`${label} at ${url} retains the background restriction`, async () => {
    const b = setup(label, url);
    assert.equal((await b.result).error.code, 'approval_required');
    assert.equal(b.notifications(), 0); assert.equal(b.clicks(), 0);
  });
}
