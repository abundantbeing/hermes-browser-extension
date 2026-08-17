import assert from 'node:assert/strict';
import test from 'node:test';

async function refsModule() {
  try {
    return await import('../extension/lib/browser-control-refs.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control refs module is required: ${error?.message || error}`);
  }
}

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
  tabId: 7,
  frameId: 0,
  documentGeneration: 3,
});

test('Phase 6 snapshots mint stable bounded refs without exposing sensitive field values', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore({ maxRefsPerDocument: 3, maxDocuments: 2 });
  const snapshot = refs.replace({
    ...scope,
    nodes: [
      { role: 'heading', name: 'Welcome' },
      { role: 'textbox', name: 'Search', value: 'public query', backendDOMNodeId: 11 },
      { role: 'textbox', name: 'Password', value: 'never-return-this', inputType: 'password', backendDOMNodeId: 12 },
      { role: 'button', name: 'Continue', backendDOMNodeId: 13 },
    ],
  });

  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.refs.map((item) => item.ref), ['@e1', '@e2', '@e3']);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.refs[1].name, 'Search');
  assert.equal('value' in snapshot.refs[1], false);
  assert.equal(snapshot.refs[2].name, 'Sensitive field');
  assert.equal(snapshot.refs[2].sensitive, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /never-return-this|public query/);

  const repeated = refs.replace({
    ...scope,
    nodes: [
      { role: 'heading', name: 'Welcome' },
      { role: 'textbox', name: 'Search', backendDOMNodeId: 11 },
    ],
  });
  assert.deepEqual(repeated.refs.map((item) => item.ref), ['@e1', '@e2']);
});

test('Phase 6 ref resolution requires exact controller, lease, tab, frame, and document generation', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Search', backendDOMNodeId: 44 }] });

  const exact = refs.resolve({ ...scope, ref: '@e1' });
  assert.equal(exact.ok, true);
  assert.equal(exact.target.backendDOMNodeId, 44);

  for (const mismatch of [
    { controllerId: 'controller-2' },
    { leaseOwnerId: 'foreign-owner' },
    { leaseId: 'lease-2' },
    { tabId: 8 },
    { frameId: 2 },
    { documentGeneration: 4 },
  ]) {
    const result = refs.resolve({ ...scope, ...mismatch, ref: '@e1' });
    assert.equal(result.ok, false, JSON.stringify(mismatch));
    assert.equal(result.error, 'stale_ref_scope', JSON.stringify(mismatch));
  }
  assert.deepEqual(refs.resolve({ ...scope, ref: '@e99' }), { ok: false, error: 'unknown_ref' });
});

test('Phase 6 navigation invalidates only affected ref scopes and bounds retained documents', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore({ maxDocuments: 2 });
  refs.replace({ ...scope, tabId: 7, nodes: [{ role: 'button', name: 'A' }] });
  refs.replace({ ...scope, tabId: 8, nodes: [{ role: 'button', name: 'B' }] });
  assert.equal(refs.documentCount(), 2);

  assert.equal(refs.invalidateTab(7), 1);
  assert.equal(refs.resolve({ ...scope, tabId: 7, ref: '@e1' }).error, 'stale_ref_scope');
  assert.equal(refs.resolve({ ...scope, tabId: 8, ref: '@e1' }).ok, true);

  refs.replace({ ...scope, tabId: 9, nodes: [{ role: 'button', name: 'C' }] });
  refs.replace({ ...scope, tabId: 10, nodes: [{ role: 'button', name: 'D' }] });
  assert.equal(refs.documentCount(), 2);
  assert.equal(refs.resolve({ ...scope, tabId: 8, ref: '@e1' }).error, 'stale_ref_scope');
});
