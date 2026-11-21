import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCloudAgentTabStillMatches,
  normalizeCloudAgentOrigin,
  resolveActiveCloudAgentTab,
  validateCloudAgentTab,
} from '../extension/lib/cloud-agent-tab.mjs';

test('Cloud agent URLs normalize to exact credential-free HTTPS origins', () => {
  assert.equal(normalizeCloudAgentOrigin('https://agent.example.test:9443/chat?x=1#y'), 'https://agent.example.test:9443');
  assert.throws(() => normalizeCloudAgentOrigin('http://agent.example.test'), /HTTPS/);
  assert.throws(() => normalizeCloudAgentOrigin('https://user@agent.example.test'), /username or password/);
});

test('Hermes Cloud requires the active complete non-discarded tab', async () => {
  await assert.rejects(() => resolveActiveCloudAgentTab({
    tabsApi: { query: async () => [{ id: 10, status: 'loading', url: 'https://agent.example.test' }] },
  }), /finish loading/);

  assert.deepEqual(validateCloudAgentTab({
    id: 10,
    windowId: 4,
    status: 'complete',
    discarded: false,
    url: 'https://agent.example.test/chat',
    title: 'My Hermes',
  }), {
    tabId: 10,
    windowId: 4,
    origin: 'https://agent.example.test',
    title: 'My Hermes',
  });
});

test('Hermes Cloud aborts when the leased tab changes origin', async () => {
  await assert.rejects(() => assertCloudAgentTabStillMatches({
    tabsApi: {
      get: async () => ({
        id: 10,
        windowId: 4,
        status: 'complete',
        discarded: false,
        url: 'https://different.example.test',
      }),
    },
    tabId: 10,
    expectedOrigin: 'https://agent.example.test',
  }), /changed origin/i);
});
