import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONTROLLER_HEARTBEAT_ALARM,
  CONTROLLER_LIFECYCLE_STORAGE_KEY,
  CONTROLLER_LIFECYCLE_VERSION,
  CONTROLLER_MAX_BACKOFF_MS,
  CONTROLLER_MAX_COMMANDS_PER_TAB,
  CONTROLLER_MAX_REPLAY_TOMBSTONES,
  CONTROLLER_MIN_BACKOFF_MS,
  CONTROLLER_RECONCILE_ALARM,
  createControllerLifecycle,
} from '../extension/lib/controller-lifecycle.mjs';

test('controller lifecycle backoff is bounded and resets after success', () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  assert.equal(lifecycle.nextBackoffDelay(), CONTROLLER_MIN_BACKOFF_MS);
  const delays = [lifecycle.nextBackoffDelay(), lifecycle.nextBackoffDelay(), lifecycle.nextBackoffDelay()];
  assert.equal(delays[0], 2_000);
  assert.equal(delays[1], 4_000);
  assert.equal(delays[2], 8_000);
  // Bounded: never grows past the cap no matter how many attempts.
  for (let index = 0; index < 20; index += 1) {
    assert.ok(lifecycle.nextBackoffDelay() <= CONTROLLER_MAX_BACKOFF_MS);
  }
  lifecycle.resetBackoff();
  assert.equal(lifecycle.nextBackoffDelay(), CONTROLLER_MIN_BACKOFF_MS);
});

test('controller lifecycle replay tombstones are bounded and survive restart via hydrate', () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  lifecycle.rememberTerminal('command-1');
  lifecycle.rememberTerminal('command-2');
  assert.equal(lifecycle.isReplay('command-1'), true);
  assert.equal(lifecycle.isReplay('command-missing'), false);

  for (let index = 0; index < CONTROLLER_MAX_REPLAY_TOMBSTONES + 50; index += 1) {
    lifecycle.rememberTerminal(`burst-${index}`);
  }
  assert.ok(lifecycle.tombstoneCount() <= CONTROLLER_MAX_REPLAY_TOMBSTONES);
  // Bounded eviction keeps the newest tombstones; the oldest are forgotten.
  assert.equal(lifecycle.isReplay(`burst-${CONTROLLER_MAX_REPLAY_TOMBSTONES + 49}`), true);
  assert.equal(lifecycle.isReplay('command-1'), false);

  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.version, CONTROLLER_LIFECYCLE_VERSION);
  assert.equal(snapshot.generation, 1);
  assert.ok(Array.isArray(snapshot.tombstones));
  assert.equal(snapshot.tombstones.length, CONTROLLER_MAX_REPLAY_TOMBSTONES);

  const restored = createControllerLifecycle({ now: () => 1_000 });
  restored.hydrate(snapshot);
  assert.equal(restored.isReplay(`burst-${CONTROLLER_MAX_REPLAY_TOMBSTONES + 49}`), true);
  // Corrupt / wrong-version hydrate fails closed: tombstones never resurrect.
  assert.deepEqual(restored.hydrate(null), []);
  assert.deepEqual(restored.hydrate({ version: 99, tombstones: ['x'] }), []);
  assert.deepEqual(restored.hydrate({ version: CONTROLLER_LIFECYCLE_VERSION, tombstones: 'nope' }), []);
});

test('controller lifecycle keeps one ordered queue per tab and executes heads in order', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  const terminals = [];
  lifecycle.onTerminal((result) => terminals.push(result));

  const first = lifecycle.enqueueCommand({
    frame: { command_id: 'tab-a-1', action: 'controller.noop', arguments: { step: 1 } },
    tabId: 9,
    ownerGeneration: 1,
  });
  assert.equal(first.ok, true);
  assert.equal(first.position, 0);
  const second = lifecycle.enqueueCommand({
    frame: { command_id: 'tab-a-2', action: 'controller.noop', arguments: { step: 2 } },
    tabId: 9,
    ownerGeneration: 1,
  });
  assert.equal(second.position, 1);
  lifecycle.enqueueCommand({
    frame: { command_id: 'tab-b-1', action: 'controller.noop', arguments: { step: 1 } },
    tabId: 10,
    ownerGeneration: 1,
  });

  assert.equal(lifecycle.queueDepth(9), 2);
  assert.equal(lifecycle.queueDepth(10), 1);
  assert.equal(lifecycle.pendingCount(), 3);

  // Let the async executor run; results must arrive in per-tab FIFO order.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tabA = terminals.filter((result) => result.tabId === 9).map((result) => result.params.result?.step);
  assert.deepEqual(tabA, [1, 2]);
  const tabB = terminals.filter((result) => result.tabId === 10).map((result) => result.params.result?.step);
  assert.deepEqual(tabB, [1]);
  assert.equal(lifecycle.pendingCount(), 0);
});

test('controller lifecycle executes only noop; every real browser action stays disabled', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  const terminals = [];
  lifecycle.onTerminal((result) => terminals.push(result));

  lifecycle.enqueueCommand({
    frame: { command_id: 'real-action', action: 'browser_navigate', arguments: { url: 'https://example.test' } },
    tabId: 3,
    ownerGeneration: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].params.ok, false);
  assert.equal(terminals[0].params.error.code, 'action_disabled');
  assert.match(terminals[0].params.error.message, /disabled/i);
  // The disabled action is tombstoned so it can never execute later.
  assert.equal(lifecycle.isReplay('real-action'), true);
});

test('controller lifecycle cancel-head aborts only the executing head of a tab queue', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  const terminals = [];
  lifecycle.onTerminal((result) => terminals.push(result));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });

  lifecycle.enqueueCommand({
    frame: { command_id: 'head-1', action: 'controller.noop', arguments: {} },
    tabId: 5,
    ownerGeneration: 1,
    execute: () => hold,
  });
  lifecycle.enqueueCommand({
    frame: { command_id: 'head-2', action: 'controller.noop', arguments: {} },
    tabId: 5,
    ownerGeneration: 1,
  });
  await Promise.resolve();
  await Promise.resolve();

  const cancelled = lifecycle.cancelHead(5);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.commandId, 'head-1');
  release({ done: true });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const byCommand = Object.fromEntries(terminals.map((result) => [result.params.command_id, result.params]));
  assert.equal(byCommand['head-1'].error.code, 'cancelled');
  assert.equal(byCommand['head-2'].ok, true);
  assert.equal(lifecycle.queueDepth(5), 0);
});

test('controller lifecycle honors a per-command executor and cancels the exact queued command id', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  const terminals = [];
  lifecycle.onTerminal((result) => terminals.push(result));
  let releaseHead;
  const heldHead = new Promise((resolve) => { releaseHead = resolve; });

  lifecycle.enqueueCommand({
    frame: { command_id: 'exact-head', action: 'controller.noop', arguments: { slot: 'head' } },
    tabId: 6,
    ownerGeneration: 1,
    execute: () => heldHead,
  });
  lifecycle.enqueueCommand({
    frame: { command_id: 'exact-tail', action: 'controller.noop', arguments: { slot: 'tail' } },
    tabId: 6,
    ownerGeneration: 1,
    execute: () => {
      throw new Error('cancelled tail must never execute');
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(lifecycle.cancelCommand('exact-tail'), { ok: true, commandId: 'exact-tail' });
  assert.equal(lifecycle.queueDepth(6), 1);
  releaseHead({ ok: true, result: { held: true } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const byCommand = Object.fromEntries(terminals.map((result) => [result.params.command_id, result.params]));
  assert.equal(byCommand['exact-tail'].error.code, 'cancelled');
  assert.deepEqual(byCommand['exact-head'].result, { held: true });
});

test('controller lifecycle snapshots bounded pending metadata so a fresh worker can terminalize it', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  lifecycle.enqueueCommand({
    frame: {
      command_id: 'persisted-pending',
      action: 'browser_type',
      arguments: { text: 'not-persisted', url: 'https://example.test/?forbidden=yes' },
      frame_id: 0,
      document_generation: 3,
      deadline_at: 9_000,
    },
    tabId: 8,
    ownerGeneration: 1,
    metadata: {
      controllerId: 'controller-metadata',
      browserProfileId: 'profile-metadata',
      leaseId: 'lease-metadata',
      leaseGeneration: 1,
    },
    execute: () => new Promise(() => {}),
  });
  await Promise.resolve();
  const snapshot = lifecycle.snapshot();
  assert.deepEqual(snapshot.pending, [{
    commandId: 'persisted-pending',
    action: 'browser_type',
    controllerId: 'controller-metadata',
    browserProfileId: 'profile-metadata',
    leaseId: 'lease-metadata',
    leaseGeneration: 1,
    tabId: 8,
    frameId: 0,
    documentGeneration: 3,
    deadlineAt: 9_000,
    phase: 'executing',
    terminalStatus: 'open',
  }]);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['not-persisted', 'forbidden=yes', 'arguments', 'url']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const restored = createControllerLifecycle({ now: () => 2_000 });
  const recovered = restored.hydrate(snapshot);
  assert.deepEqual(recovered.pending, snapshot.pending);
  assert.equal(restored.isReplay('persisted-pending'), true);
});

test('controller lifecycle rejects frames from a stale generation terminally and never queues them', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  const terminals = [];
  lifecycle.onTerminal((result) => terminals.push(result));

  const stale = lifecycle.handleInboundFrame({
    frame: { command_id: 'stale-command', action: 'controller.noop', arguments: {} },
    tabId: 7,
    frameGeneration: 0, // older than the current generation 1
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale_generation');
  assert.equal(lifecycle.pendingCount(), 0);
  assert.equal(lifecycle.queueDepth(7), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminals.length, 0);
});

test('controller lifecycle restart terminalizes every pending command and clears queues', async () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  const terminals = [];
  lifecycle.onTerminal((result) => terminals.push(result));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });

  lifecycle.enqueueCommand({
    frame: { command_id: 'restart-pending', action: 'controller.noop', arguments: {} },
    tabId: 2,
    ownerGeneration: 1,
    execute: () => hold,
  });
  lifecycle.enqueueCommand({
    frame: { command_id: 'restart-queued', action: 'controller.noop', arguments: {} },
    tabId: 2,
    ownerGeneration: 1,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(lifecycle.pendingCount(), 2);
  lifecycle.restart();
  assert.equal(lifecycle.pendingCount(), 0);
  assert.equal(lifecycle.queueDepth(2), 0);
  release({ done: true });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const byCommand = Object.fromEntries(terminals.map((result) => [result.params.command_id, result.params]));
  assert.equal(byCommand['restart-pending'].error.code, 'restarted');
  assert.equal(byCommand['restart-queued'].error.code, 'restarted');
  // Restarted commands are tombstoned so they cannot execute later.
  assert.equal(lifecycle.isReplay('restart-pending'), true);
  assert.equal(lifecycle.isReplay('restart-queued'), true);

  // After restart the generation advanced: old-generation frames are rejected.
  const oldFrame = lifecycle.handleInboundFrame({
    frame: { command_id: 'post-restart-old', action: 'controller.noop', arguments: {} },
    tabId: 2,
    frameGeneration: 1,
  });
  assert.equal(oldFrame.error, 'stale_generation');
});

test('controller lifecycle heartbeat/reconcile alarms reconcile without side effects while dormant', () => {
  const lifecycle = createControllerLifecycle({ now: () => 1_000 });
  assert.equal(CONTROLLER_HEARTBEAT_ALARM, 'hermesBrowserControllerHeartbeat');
  assert.equal(CONTROLLER_RECONCILE_ALARM, 'hermesBrowserControllerReconcile');
  // Dormant reconcile: no pending work, no backoff reset, no events.
  const events = [];
  lifecycle.onTerminal((result) => events.push(result));
  lifecycle.markHeartbeat({ at: 2_000 });
  lifecycle.reconcile({ at: 2_000 });
  assert.deepEqual(events, []);
  assert.equal(lifecycle.pendingCount(), 0);
  assert.equal(CONTROLLER_LIFECYCLE_STORAGE_KEY, 'hermesBrowserControllerLifecycle');
  assert.equal(CONTROLLER_LIFECYCLE_VERSION, 1);
  assert.equal(CONTROLLER_MAX_COMMANDS_PER_TAB, 64);
});

test('Phase 5 service worker owns the concrete connector, lifecycle boot, alarms, wake routing, and document generations', () => {
  const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(backgroundSource, /createControllerConnector/);
  assert.match(backgroundSource, /createControllerServiceWorker/);
  assert.match(backgroundSource, /controllerWorker\.boot\(\)/);
  assert.match(backgroundSource, /CONTROLLER_HEARTBEAT_ALARM/);
  assert.match(backgroundSource, /CONTROLLER_RECONCILE_ALARM/);
  assert.match(backgroundSource, /controllerWorker\.reconcile/);
  assert.match(backgroundSource, /CONTROLLER_WORKER_MESSAGES/);
  assert.match(backgroundSource, /controllerWorker\.handleMessage\(message, sender\)/);
  assert.match(backgroundSource, /controllerWorker\.syncSettings\(changes\.hermesBrowserSettings\.newValue\)/);
  assert.equal((backgroundSource.match(/runtime\.onInstalled\.addListener/g) || []).length, 1, 'installed lifecycle has one owner');
  assert.match(contentSource, /HERMES_CONTROLLER_DOCUMENT_READY/);

  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('alarms'), 'alarms permission required for the heartbeat/reconcile alarms');
  const rootManifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(rootManifest.permissions.includes('alarms'), 'root manifest must mirror the alarms permission');
});
