import assert from 'node:assert/strict';
import test from 'node:test';

async function indicatorsModule() {
  try {
    return await import('../extension/lib/browser-control-indicators.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control indicator contract is required: ${error?.message || error}`);
  }
}

test('Phase 6 adapter indicator emits bounded start and finish messages without action arguments', async () => {
  const { withBrowserControlIndicator } = await indicatorsModule();
  const messages = [];
  const adapter = withBrowserControlIndicator({
    adapter: {
      contract: { enabled: true, actions: ['browser_click'] },
      async targetBounds() { return { x: 10.4, y: 20.6, width: 100.2, height: 40.8, backendDOMNodeId: 999 }; },
      async execute(_action, args) { return { clicked: true, leaked: args.text }; },
    },
    tabsApi: {
      async sendMessage(tabId, message) { messages.push({ tabId, message: structuredClone(message) }); },
    },
  });
  const result = await adapter.execute('browser_click', { ref: '@e1', text: 'private fixture' }, { scope: { tabId: 33 } });
  assert.equal(result.clicked, true);
  assert.deepEqual(messages, [
    { tabId: 33, message: { type: 'HERMES_BROWSER_CONTROL_INDICATOR', phase: 'start', action: 'browser_click', targetRect: { x: 10, y: 21, width: 100, height: 41 } } },
    { tabId: 33, message: { type: 'HERMES_BROWSER_CONTROL_INDICATOR', phase: 'finish', action: 'browser_click' } },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /private fixture|@e1|arguments|ref|backendDOMNodeId/);
});

test('Phase 6 screenshot suspends every extension overlay during capture and restores cleanup sequencing', async () => {
  const { withBrowserControlIndicator } = await indicatorsModule();
  const phases = [];
  const adapter = withBrowserControlIndicator({
    adapter: {
      contract: { enabled: true, actions: ['browser_screenshot'] },
      async execute() { phases.push('capture'); return { dataUrl: 'data:image/png;base64,AA==' }; },
    },
    tabsApi: {
      async sendMessage(_tabId, message) { phases.push(message.phase); },
    },
    minimumVisibleMs: 0,
  });
  await adapter.execute('browser_screenshot', {}, { scope: { tabId: 36 } });
  assert.deepEqual(phases, ['start', 'suspend', 'capture', 'resume', 'finish']);
});

test('Phase 6 adapter indicator finishes after failure and never replaces the real action error', async () => {
  const { withBrowserControlIndicator } = await indicatorsModule();
  const phases = [];
  const adapter = withBrowserControlIndicator({
    adapter: {
      contract: { enabled: true, actions: ['browser_press'] },
      async execute() { throw new Error('action failed'); },
    },
    tabsApi: {
      async sendMessage(_tabId, message) {
        phases.push(message.phase);
        if (message.phase === 'finish') throw new Error('content script gone');
      },
    },
  });
  await assert.rejects(() => adapter.execute('browser_press', { key: 'Enter' }, { scope: { tabId: 34 } }), /action failed/);
  assert.deepEqual(phases, ['start', 'finish']);
});

test('Phase 6 indicator remains perceptible for fast successful actions without delaying the mutation itself', async () => {
  let now = 1_000;
  let actionFinishedAt = 0;
  const waits = [];
  const phases = [];
  const { withBrowserControlIndicator } = await indicatorsModule();
  const adapter = withBrowserControlIndicator({
    adapter: {
      contract: { enabled: true, actions: ['browser_click'] },
      async execute() {
        actionFinishedAt = now;
        return { clicked: true };
      },
    },
    tabsApi: {
      async sendMessage(_tabId, message) { phases.push({ phase: message.phase, at: now }); },
    },
    now: () => now,
    wait: async (ms) => { waits.push(ms); now += ms; },
    minimumVisibleMs: 180,
  });
  const result = await adapter.execute('browser_click', {}, { scope: { tabId: 35 } });
  assert.equal(result.clicked, true);
  assert.equal(actionFinishedAt, 1_000, 'the browser mutation itself must not wait for presentation timing');
  assert.deepEqual(waits, [180]);
  assert.deepEqual(phases, [
    { phase: 'start', at: 1_000 },
    { phase: 'finish', at: 1_180 },
  ]);
});

test('Phase 6 content script owns a transient theme-aware indicator and receives only known action names', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(source, /HERMES_BROWSER_CONTROL_INDICATOR/);
  assert.match(source, /browser-control-indicator/);
  assert.match(source, /browser_click:\s*'Clicking'/);
  assert.match(source, /message\.phase === 'finish'/);
  assert.match(source, /message\.phase === 'suspend'/);
  assert.match(source, /message\.phase === 'resume'/);
  assert.match(source, /targetRect/);
  assert.match(source, /pointer-events:\s*none/);
  assert.doesNotMatch(source, /message\.arguments|message\.text|message\.ref|backendDOMNodeId/);
});
