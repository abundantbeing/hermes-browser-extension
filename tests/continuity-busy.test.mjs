import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifyGatewayError } from '../extension/lib/common.mjs';
import { gatewayFailureRecoveryPlan, turnRequestFailureState } from '../extension/lib/turn-recovery.mjs';

const rpc = (code, message, data) => Object.assign(new Error(message), { rpcCode: code, code, ...(data ? { data } : {}) });

const BUSY = [
  ['legacy sidecar: 4009 "session busy"', rpc(4009, 'session busy')],
  ['legacy sidecar: 4009 subagent still running', rpc(4009, 'subagent still running — wait for it to finish')],
  ['session authority: 4001 session_busy', rpc(4001, 'session_busy', { reason: 'session_busy' })],
  ['session authority: 4001 admission_conflict', rpc(4001, 'admission_conflict', { reason: 'admission_conflict' })],
];

for (const [name, error] of BUSY) {
  test(`${name} is a per-session condition, not an unreachable gateway`, () => {
    const diagnostic = classifyGatewayError(error, { url: 'http://127.0.0.1:8642' });
    assert.equal(diagnostic.kind, 'session-busy');
    assert.equal(diagnostic.probeStatus, 'connected');
    assert.equal(diagnostic.serverReachable, true);
    assert.equal(diagnostic.deliveryUnknown, false);
    const plan = gatewayFailureRecoveryPlan({ error, diagnostic });
    assert.equal(plan.preserveDraft, true);
    assert.equal(plan.duplicateSendRisk, false, 'the gateway refused it: nothing to duplicate');
    const failure = turnRequestFailureState(error);
    assert.equal(failure.kind, 'session-busy');
    assert.equal(failure.gatewayStatus, 'connected');
    assert.equal(failure.preserveDraft, true);
  });
}

test('other refusals and real outages keep their classification', () => {
  const refused = classifyGatewayError(rpc(4001, 'permission_denied', { reason: 'permission_denied' }));
  assert.notEqual(refused.kind, 'session-busy');
  assert.equal(classifyGatewayError(new Error('Failed to fetch')).probeStatus, 'unreachable');
  assert.equal(classifyGatewayError(new Error('Dashboard connection closed mid-turn.')).probeStatus, 'unreachable');
});

test('the send path never marks the gateway unreachable for a connected diagnostic', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const send = source.slice(source.indexOf('const recoveryPlan = gatewayFailureRecoveryPlan({ error, diagnostic });'));
  const branch = send.slice(0, send.indexOf("addMessage('system', `Hermes Browser Extension warning:"));
  assert.match(branch, /probeStatus === 'degraded'[\s\S]*else if \(diagnostic\.probeStatus !== 'connected'\)[\s\S]*markGatewayUnreachable/);
});
