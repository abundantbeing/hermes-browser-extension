import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function required(path, label) {
  try {
    return await import(path);
  } catch (error) {
    assert.fail(`${label} is required by the Phase 4 control-broker contract: ${error?.message || error}`);
  }
}

const identity = Object.freeze({
  controllerId: 'controller-fixture',
  browserProfileId: 'browser-profile-fixture',
  hermesSessionId: 'session-fixture',
  product: { id: 'chromium', engine: 'chromium', label: 'Chromium browser' },
});

test('Phase 4 registration preserves one protocol across local API, VPS API, and Cloud gateway transports', async () => {
  const protocol = await required('../extension/lib/controller-protocol.mjs', 'controller-protocol.mjs');
  assert.equal(protocol.CONTROLLER_PROTOCOL_VERSION, 1);
  assert.deepEqual(protocol.CONTROLLER_METHODS, {
    register: 'browser.controller.register',
    command: 'browser.controller.command',
    result: 'browser.controller.result',
    cancel: 'browser.controller.cancel',
  });

  const local = protocol.controllerRegistrationFor({
    family: 'local-api',
    baseUrl: 'http://127.0.0.1:8642',
    identity,
  });
  const vps = protocol.controllerRegistrationFor({
    family: 'remote-api',
    baseUrl: 'https://agent.example.test',
    identity,
  });
  const cloud = protocol.controllerRegistrationFor({
    family: 'cloud-ticket-ws',
    baseUrl: 'https://hermes.example.test',
    identity,
  });

  assert.equal(local.transport, 'api-ticket-ws');
  assert.equal(local.registrationUrl, 'http://127.0.0.1:8642/v1/browser-control/register');
  assert.equal(vps.transport, 'api-ticket-ws');
  assert.equal(vps.registrationUrl, 'https://agent.example.test/v1/browser-control/register');
  assert.equal(cloud.transport, 'gateway-rpc');
  assert.equal(cloud.method, protocol.CONTROLLER_METHODS.register);
  assert.deepEqual(local.payload, vps.payload);
  assert.deepEqual(local.payload, cloud.params);
  assert.deepEqual(local.payload.capabilities, ['controller.noop']);
  assert.equal(local.payload.protocol_version, 1);
  assert.equal(local.payload.session_id, 'session-fixture');
  assert.equal('hermes_session_id' in local.payload, false);
  assert.equal(local.payload.product.label, 'Chromium browser');
  assert.throws(() => protocol.controllerRegistrationFor({
    family: 'unknown',
    baseUrl: 'https://example.test',
    identity,
  }), /unsupported controller transport family/i);
});

test('API controller WebSocket URL carries no credential and preserves secure schemes', async () => {
  const protocol = await required('../extension/lib/controller-protocol.mjs', 'controller-protocol.mjs');
  assert.equal(
    protocol.controllerWebSocketUrl('https://agent.example.test/base'),
    'wss://agent.example.test/base/v1/browser-control/ws',
  );
  assert.equal(
    protocol.controllerWebSocketUrl('http://127.0.0.1:8642'),
    'ws://127.0.0.1:8642/v1/browser-control/ws',
  );
  assert.deepEqual(protocol.controllerWebSocketProtocols('ticket-fixture'), [
    'hermes-browser-control-v1',
    'hermes-browser-control-ticket.ticket-fixture',
  ]);
  assert.throws(() => protocol.controllerWebSocketUrl('file:///tmp/socket'), /http or https/i);
  assert.throws(() => protocol.controllerWebSocketUrl('http://agent.example.test'), /loopback/i);
  assert.throws(() => protocol.controllerWebSocketUrl('https://user:pass@agent.example.test'), /credentials/i);
  assert.throws(() => protocol.controllerWebSocketProtocols(''), /ticket is required/i);
  assert.throws(() => protocol.controllerWebSocketProtocols('ticket with spaces'), /ticket/i);
});

test('API registration endpoint and scope identity fail closed before transport', async () => {
  const protocol = await required('../extension/lib/controller-protocol.mjs', 'controller-protocol.mjs');
  assert.throws(() => protocol.controllerRegistrationFor({
    family: 'local-api', baseUrl: 'http://192.0.2.10:8642', identity,
  }), /loopback/i);
  assert.throws(() => protocol.controllerRegistrationFor({
    family: 'remote-api', baseUrl: 'http://agent.example.test', identity,
  }), /https/i);
  assert.throws(() => protocol.controllerRegistrationFor({
    family: 'remote-api', baseUrl: 'https://user:pass@agent.example.test', identity,
  }), /credentials/i);
  assert.throws(() => protocol.controllerRegistrationFor({
    family: 'local-api', baseUrl: 'http://127.0.0.1:8642', identity: {},
  }), /controller.*browser profile.*session/i);
  assert.throws(() => protocol.controllerRegistrationFor({
    family: 'cloud-ticket-ws', baseUrl: 'https://hermes.example.test',
    identity: { ...identity, product: {} },
  }), /product/i);
});

test('controller runtime supports no-op round trips while all real browser actions remain disabled', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  const runtime = client.createControllerCommandRuntime({
    send: async (frame) => sent.push(frame),
  });

  await runtime.handleFrame({
    method: 'browser.controller.command',
    params: {
      command_id: 'command-noop',
      action: 'controller.noop',
      arguments: { echo: 'phase-4' },
    },
  });

  assert.deepEqual(sent, [{
    method: 'browser.controller.result',
    params: {
      command_id: 'command-noop',
      ok: true,
      result: { echo: 'phase-4' },
    },
  }]);
  assert.deepEqual(runtime.capabilities(), ['controller.noop']);

  await runtime.handleFrame({
    method: 'browser.controller.command',
    params: {
      command_id: 'command-disabled',
      action: 'browser_navigate',
      arguments: { url: 'https://example.test' },
    },
  });
  assert.equal(sent[1].method, 'browser.controller.result');
  assert.equal(sent[1].params.command_id, 'command-disabled');
  assert.equal(sent[1].params.ok, false);
  assert.equal(sent[1].params.error.code, 'action_disabled');
  assert.match(sent[1].params.error.message, /real browser control is disabled/i);
  assert.equal(runtime.pendingCount(), 0);
});

test('controller cancellation aborts only the matching in-flight command and reports a terminal result once', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const runtime = client.createControllerCommandRuntime({
    send: async (frame) => sent.push(frame),
    executeNoop: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  const pending = runtime.handleFrame({
    method: 'browser.controller.command',
    params: {
      command_id: 'command-cancelled',
      action: 'controller.noop',
      arguments: {},
    },
  });
  await didStart;
  await runtime.handleFrame({
    method: 'browser.controller.cancel',
    params: { command_id: 'command-cancelled' },
  });
  await pending;

  const terminal = sent.filter((frame) => frame.method === 'browser.controller.result');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].params.command_id, 'command-cancelled');
  assert.equal(terminal[0].params.ok, false);
  assert.equal(terminal[0].params.error.code, 'cancelled');
  assert.equal(runtime.pendingCount(), 0);
});

test('controller cancellation force-settles even when the executor ignores AbortSignal', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const runtime = client.createControllerCommandRuntime({
    send: async (frame) => sent.push(frame),
    executeNoop: async () => {
      started();
      return new Promise(() => {});
    },
  });

  const pending = runtime.handleFrame({
    method: 'browser.controller.command',
    params: { command_id: 'hung-command', action: 'controller.noop', arguments: {} },
  });
  await didStart;
  await runtime.handleFrame({
    method: 'browser.controller.cancel',
    params: { command_id: 'hung-command' },
  });
  await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancel did not settle')), 100)),
  ]);

  assert.equal(runtime.pendingCount(), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.command_id, 'hung-command');
  assert.equal(sent[0].params.error.code, 'cancelled');
});

test('Cloud Gateway event frames normalize to the same controller command and cancel protocol', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const runtime = client.createControllerCommandRuntime({
    sessionId: 'session-fixture',
    send: async (frame) => sent.push(frame),
    executeNoop: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  const pending = runtime.handleFrame({
    method: 'event',
    params: {
      type: 'browser.controller.command',
      sessionId: 'session-fixture',
      payload: {
        command_id: 'cloud-command',
        action: 'controller.noop',
        arguments: {},
      },
    },
  });
  await didStart;
  await runtime.handleFrame({
    method: 'event',
    params: {
      type: 'browser.controller.cancel',
      session_id: 'session-fixture',
      payload: { command_id: 'cloud-command' },
    },
  });
  await pending;

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'browser.controller.result');
  assert.equal(sent[0].params.command_id, 'cloud-command');
  assert.equal(sent[0].params.session_id, 'session-fixture');
  assert.equal(sent[0].params.ok, false);
  assert.equal(sent[0].params.error.code, 'cancelled');
  assert.equal(runtime.pendingCount(), 0);
});

test('Cloud Gateway controller events require the exact runtime session identity in either field spelling', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  const runtime = client.createControllerCommandRuntime({
    sessionId: 'session-fixture',
    send: async (frame) => sent.push(frame),
  });
  for (const identityFields of [{}, { session_id: 'other-session' }, { sessionId: 'other-session' }]) {
    await runtime.handleFrame({
      method: 'event',
      params: {
        type: 'browser.controller.command',
        ...identityFields,
        payload: {
          command_id: `wrong-${JSON.stringify(identityFields)}`,
          action: 'controller.noop',
          arguments: { should_not_run: true },
        },
      },
    });
  }
  assert.deepEqual(sent, []);
  assert.equal(runtime.pendingCount(), 0);
});

test('duplicate or missing command ids fail closed without replacing pending ownership', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const runtime = client.createControllerCommandRuntime({
    send: async (frame) => sent.push(frame),
    executeNoop: async () => hold,
  });

  const first = runtime.handleFrame({
    method: 'browser.controller.command',
    params: { command_id: 'owned-command', action: 'controller.noop', arguments: {} },
  });
  await Promise.resolve();
  await runtime.handleFrame({
    method: 'browser.controller.command',
    params: { command_id: 'owned-command', action: 'controller.noop', arguments: {} },
  });
  await runtime.handleFrame({
    method: 'browser.controller.command',
    params: { action: 'controller.noop', arguments: {} },
  });

  assert.equal(runtime.pendingCount(), 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].params.command_id, 'owned-command');
  assert.equal(sent[0].params.error.code, 'duplicate_command');
  assert.equal(sent[1].params.command_id, '');
  assert.equal(sent[1].params.error.code, 'invalid_command');

  release({ done: true });
  await first;
  assert.equal(runtime.pendingCount(), 0);
  assert.equal(sent[2].params.ok, true);
});

test('a failed terminal send never permits the same command id to execute twice', async () => {
  const client = await required('../extension/lib/controller-client.mjs', 'controller-client.mjs');
  const sent = [];
  let failNextSend = true;
  let executions = 0;
  const runtime = client.createControllerCommandRuntime({
    send: async (frame) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('fixture socket closed');
      }
      sent.push(frame);
    },
    executeNoop: async () => {
      executions += 1;
      return { executions };
    },
  });
  const frame = {
    method: 'browser.controller.command',
    params: { command_id: 'terminal-send-failed', action: 'controller.noop', arguments: {} },
  };
  await runtime.handleFrame(frame);
  assert.equal(runtime.pendingCount(), 0);
  await runtime.handleFrame(frame);
  assert.equal(executions, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.error.code, 'duplicate_command');
});

test('Phase 4 controller modules remain in the v0.3.0 syntax gates', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.3.1');
  for (const file of [
    'extension/lib/controller-protocol.mjs',
    'extension/lib/controller-client.mjs',
  ]) {
    assert.match(packageJson.scripts['check:js'], new RegExp(file.replaceAll('.', '\\.')));
  }
});
