import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as turnRecovery from '../extension/lib/turn-recovery.mjs';

const {
  classifyTurnRecovery,
  hermesGatewayTurnError,
  hermesRequestError,
  latestAssistantAfterUser,
  turnRequestFailureState,
} = turnRecovery;

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');

test('accepted stream failures recover instead of retrying the turn', () => {
  assert.equal(classifyTurnRecovery({ requestAccepted: true }), 'recover');
  assert.equal(classifyTurnRecovery(new Error('socket closed')), 'recover');
});

test('explicitly rejected stream routes may use the non-stream fallback', () => {
  assert.equal(classifyTurnRecovery({ fallbackSafe: true }), 'fallback');
  assert.equal(classifyTurnRecovery({ fallbackSafe: true, requestAccepted: true }), 'recover');
});

test('provider validation failures are rejected requests instead of accepted-turn recovery', () => {
  const error = hermesRequestError({
    status: 400,
    operation: 'Hermes stream',
    body: JSON.stringify({
      error: {
        message: 'reasoning_effort must be one of: no_think, low, high',
      },
    }),
  });

  assert.equal(error.message, 'Hermes stream failed (400): reasoning_effort must be one of: no_think, low, high');
  assert.equal(error.httpStatus, 400);
  assert.equal(error.requestRejected, true);
  assert.equal(error.fallbackSafe, false);
  assert.equal(classifyTurnRecovery(error), 'reject');
});

test('provider rejection details are redacted before reaching either Browser surface', () => {
  const error = hermesRequestError({
    status: 400,
    body: JSON.stringify({ error: { message: 'reasoning_effort is invalid; Bearer private-value token=private-value' } }),
  });

  assert.match(error.message, /reasoning_effort is invalid/);
  assert.match(error.message, /REDACTED/);
  assert.doesNotMatch(error.message, /private-value/);
});

test('provider option rejection keeps gateway health separate and preserves the draft', () => {
  const state = turnRequestFailureState(hermesRequestError({
    status: 400,
    body: '{"error":"reasoning_effort must be one of: no_think, low, high"}',
  }));

  assert.deepEqual(state, {
    kind: 'model-option-rejected',
    title: 'Model option rejected',
    detail: 'Hermes request failed (400): reasoning_effort must be one of: no_think, low, high',
    preserveDraft: true,
    gatewayStatus: 'connected',
  });
});

test('authentication rejection stays on the existing gateway-auth diagnostic path', () => {
  const error = hermesRequestError({ status: 401, body: '{"error":"Unauthorized"}' });

  assert.equal(classifyTurnRecovery(error), 'reject');
  assert.equal(turnRequestFailureState(error), null);
});

test('dashboard provider terminal events stay separate from gateway connectivity', () => {
  const error = hermesGatewayTurnError({
    operation: 'Hermes dashboard stream',
    payload: {
      status: 'error',
      error: 'Invalid parameter: reasoning_effort must be one of low, medium, high.',
      error_surface: {
        layer: 'provider',
        code: 'format_error',
        retryable: false,
      },
    },
  });

  assert.ok(error instanceof Error);
  assert.equal(error.turnFailureLayer, 'provider');
  assert.equal(classifyTurnRecovery(error), 'reject');
  assert.deepEqual(turnRequestFailureState(error), {
    kind: 'model-option-rejected',
    title: 'Model option rejected',
    detail: 'Hermes dashboard stream failed: Invalid parameter: reasoning_effort must be one of low, medium, high.',
    preserveDraft: true,
    gatewayStatus: 'connected',
  });
});

test('dashboard completion shaping ignores success and preserves real gateway failures', () => {
  assert.equal(hermesGatewayTurnError({ payload: { status: 'completed', text: 'Done.' } }), null);

  const gatewayError = hermesGatewayTurnError({
    payload: {
      status: 'error',
      error: 'Dashboard worker crashed.',
      error_surface: { layer: 'gateway', code: 'RuntimeError', retryable: true },
    },
  });
  assert.ok(gatewayError instanceof Error);
  assert.equal(gatewayError.turnFailureLayer, 'gateway');
  assert.equal(classifyTurnRecovery(gatewayError), 'recover');
  assert.equal(turnRequestFailureState(gatewayError), null);
});

test('request-failure UI does not intercept fallback-safe, server, or network failures', () => {
  assert.equal(turnRequestFailureState(hermesRequestError({ status: 404, body: 'missing' })), null);
  assert.equal(turnRequestFailureState(hermesRequestError({ status: 503, body: 'offline' })), null);
  assert.equal(turnRequestFailureState(new Error('socket closed')), null);
});

test('recovery selects the assistant after the latest matching user turn', () => {
  const rows = [
    { role: 'user', content: 'older prompt' },
    { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'same prompt' },
    { role: 'user', content: 'same prompt' },
    { role: 'assistant', content: 'new answer' },
  ];

  assert.equal(latestAssistantAfterUser(rows, 'same prompt'), 'new answer');
});

test('recovery does not return an assistant from before the matching user turn', () => {
  const rows = [
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new prompt' },
  ];

  assert.equal(latestAssistantAfterUser(rows, 'new prompt'), '');
});

test('compression exhaustion preserves the draft and compacts once without replaying an accepted turn', () => {
  assert.equal(typeof turnRecovery.sessionContextFailureRecovery, 'function');
  assert.deepEqual(turnRecovery.sessionContextFailureRecovery(
    new Error('Context length exceeded: request payload too large, and context compression failed after max compression attempts.'),
    { sessionCompress: true },
  ), {
    kind: 'compression-exhausted',
    action: 'compact',
    preserveDraft: true,
    retryTurn: false,
    gatewayStatus: 'degraded',
  });
});

test('compression exhaustion never claims a compact action when Hermes does not advertise the route', () => {
  assert.equal(typeof turnRecovery.sessionContextFailureRecovery, 'function');
  assert.deepEqual(turnRecovery.sessionContextFailureRecovery(
    'request payload too large; max compression attempts reached',
    { sessionCompress: false },
  ), {
    kind: 'compression-exhausted',
    action: 'new-session',
    preserveDraft: true,
    retryTurn: false,
    gatewayStatus: 'degraded',
  });
  assert.equal(turnRecovery.sessionContextFailureRecovery('401 Unauthorized', { sessionCompress: true }), null);
});

test('side panel wires compression exhaustion into bounded compact-or-new-session recovery', () => {
  assert.match(sidepanelSource, /sessionContextFailureRecovery\(error, gatewayCapabilities\)/);
  assert.match(sidepanelSource, /sessionContextFailureRecovery\(streamError, gatewayCapabilities\)[\s\S]{0,120}throw streamError/);
  assert.match(sidepanelSource, /await compactCurrentSessionContext\(\{[\s\S]{0,160}automaticRecovery:\s*true/);
  assert.match(sidepanelSource, /retryTurn/);
});

test('Hermes Web preserves the failed draft and uses the same acknowledged context recovery contract', () => {
  assert.match(appSource, /sessionContextFailureRecovery\(error, gatewayCapabilities\)/);
  assert.match(appSource, /await compactActiveSessionContext\(\{[\s\S]{0,160}automaticRecovery:\s*true/);
  assert.match(appSource, /retryTurn/);
});

test('both Browser surfaces preserve provider-rejected drafts without marking Hermes unreachable', () => {
  assert.match(sidepanelSource, /hermesRequestError\(\{[\s\S]{0,180}status:\s*response\.status[\s\S]{0,180}body:\s*text/);
  const sidepanelRejectionStart = sidepanelSource.lastIndexOf('const requestFailure = turnRequestFailureState(error)');
  const sidepanelRejectionBranch = sidepanelSource.slice(sidepanelRejectionStart, sidepanelSource.indexOf('const diagnostic = classifyGatewayError(error)', sidepanelRejectionStart));
  assert.match(sidepanelRejectionBranch, /Gateway remains connected/);
  assert.match(sidepanelRejectionBranch, /streamView\.update/);
  assert.doesNotMatch(sidepanelRejectionBranch, /addMessage\('system'/);
  assert.match(sidepanelSource, /classifyTurnRecovery\(streamError\)[\s\S]{0,120}=== 'reject'/);
  assert.match(appSource, /hermesRequestError\(\{[\s\S]{0,180}status:\s*response\.status[\s\S]{0,180}body:\s*await response\.text\(\)/);
  assert.match(appSource, /turnRequestFailureState\(error\)[\s\S]{0,700}renderConnectionTruth\(\{\s*status:\s*'online'\s*\}\)/);
});

test('fallback REST and dashboard WS transports retain typed provider failures', () => {
  const fallbackSessionStart = sidepanelSource.indexOf('async function fallbackSessionChat');
  const fallbackCompletionsStart = sidepanelSource.indexOf('async function fallbackChatCompletions');
  const askHermesStart = sidepanelSource.indexOf('async function askHermes');
  assert.match(
    sidepanelSource.slice(fallbackSessionStart, fallbackCompletionsStart),
    /if \(!response\.ok\) throw hermesRequestError\(/,
  );
  assert.match(
    sidepanelSource.slice(fallbackCompletionsStart, askHermesStart),
    /if \(!response\.ok\) throw hermesRequestError\(/,
  );

  const sidepanelDashboardStart = sidepanelSource.indexOf('async function streamRemoteWsChat');
  const sidepanelStreamStart = sidepanelSource.indexOf('async function streamSessionChat');
  const sidepanelDashboard = sidepanelSource.slice(sidepanelDashboardStart, sidepanelStreamStart);
  assert.match(sidepanelDashboard, /WS_EVENTS\.messageComplete[\s\S]*hermesGatewayTurnError/);
  assert.match(sidepanelDashboard, /WS_EVENTS\.error[\s\S]*hermesGatewayTurnError/);

  const webDashboardStart = appSource.indexOf('async function streamDashboardPrompt');
  const webCapabilitiesStart = appSource.indexOf('async function loadGatewayCapabilities');
  const webDashboard = appSource.slice(webDashboardStart, webCapabilitiesStart);
  assert.match(webDashboard, /WS_EVENTS\.messageComplete[\s\S]*hermesGatewayTurnError/);
  assert.match(webDashboard, /WS_EVENTS\.error[\s\S]*hermesGatewayTurnError/);

  const streamCatchStart = sidepanelSource.indexOf('} catch (streamError) {', sidepanelSource.indexOf('async function askHermes'));
  const streamCatchEnd = sidepanelSource.indexOf('const finalAnswer', streamCatchStart);
  const streamCatch = sidepanelSource.slice(streamCatchStart, streamCatchEnd);
  assert.ok(
    streamCatch.indexOf("classifyTurnRecovery(streamError)") < streamCatch.indexOf('isRemoteWsMode()'),
    'request rejection classification must run before remote-dashboard connection diagnostics',
  );
});
