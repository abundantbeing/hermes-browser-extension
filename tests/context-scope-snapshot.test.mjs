import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resetContextScope,
  resolveContextScopeAction,
  restoreConversationSessionState,
  snapshotConversationSessionState,
} from '../extension/lib/context-scope-transition.mjs';

const identity = { gatewayUrl: 'https://gateway.example', gatewayMode: 'remote-dashboard', activeProfile: 'team-a' };
const initial = { ...identity, sessionId: 'global-a', model: 'model-a' };

for (const change of [
  { activeProfile: 'team-b' },
  { gatewayUrl: 'https://other.example' },
  { gatewayMode: 'remote-api' },
]) {
  test(`snapshot refuses a changed connection identity: ${Object.keys(change)[0]}`, () => {
    const snapshot = snapshotConversationSessionState({ settings: initial });
    const current = { ...initial, ...change, sessionId: 'current-b' };
    const result = restoreConversationSessionState(current, snapshot);
    assert.equal(result.restored, false);
    assert.equal(result.settings, current);
  });
}

test('legacy unowned snapshot cannot restore a session', () => {
  const result = restoreConversationSessionState(initial, { settings: { sessionId: 'unowned' } });
  assert.equal(result.restored, false);
});

test('incomplete stored identity is not proof of snapshot ownership', () => {
  const snapshot = { identity: {}, settings: { sessionId: 'unowned' } };
  assert.equal(restoreConversationSessionState({}, snapshot).restored, false);
});

test('restoration allowlists session fields rather than accepting stored settings', () => {
  const snapshot = snapshotConversationSessionState({ settings: initial });
  Object.assign(snapshot.settings, { activeProfile: 'injected', gatewayUrl: 'https://other.example', contextConsent: true });
  const current = { ...initial, sessionId: 'pinned', contextConsent: false };
  const result = restoreConversationSessionState(current, snapshot);
  assert.equal(result.restored, true);
  assert.equal(result.settings.sessionId, 'global-a');
  assert.equal(result.settings.activeProfile, 'team-a');
  assert.equal(result.settings.gatewayUrl, identity.gatewayUrl);
  assert.equal(result.settings.contextConsent, false);
});

test('restoration preserves newer bindings and merges older session entries', () => {
  const snapshot = snapshotConversationSessionState({ settings: {
    ...initial,
    sessionModelBindings: { old: { modelId: 'old' }, shared: { modelId: 'stale' } },
    sessionModelOptionBindings: { old: { reasoning: 'low' }, shared: { reasoning: 'low' } },
  } });
  const current = { ...initial,
    sessionModelBindings: { recent: { modelId: 'new' }, shared: { modelId: 'updated' } },
    sessionModelOptionBindings: { recent: { reasoning: 'high' }, shared: { reasoning: 'high' } },
  };
  const result = restoreConversationSessionState(current, snapshot);
  assert.deepEqual(result.settings.sessionModelBindings, {
    old: { modelId: 'old' }, recent: { modelId: 'new' }, shared: { modelId: 'updated' },
  });
  assert.equal(result.settings.sessionModelOptionBindings.shared.reasoning, 'high');
  assert.equal(result.settings.sessionModelOptionBindings.old.reasoning, 'low');
  assert.equal(result.settings.sessionModelOptionBindings.recent.reasoning, 'high');
});

for (const id of [null, undefined, '', false, -1, 1.5, Infinity, 'invalid']) {
  test(`invalid tab id ${String(id)} cannot create a pin`, () => {
    assert.equal(resolveContextScopeAction({ targetTab: { id } }).kind, 'noop');
    assert.equal(resetContextScope({ panelMode: 'tab-attached', attachedTabId: id }).mode, 'follow-active');
  });
}

test('numeric browser tab ids remain supported', () => {
  assert.equal(resolveContextScopeAction({ targetTab: { id: 12 } }).scope.pinnedTabId, 12);
  assert.equal(resetContextScope({ panelMode: 'tab-attached', attachedTab: { id: 12, title: 'Owner' } }).pinnedTitle, 'Owner');
});
