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

test('recovery matches accepted multimodal user turns by their text component', () => {
  const rows = [
    { role: 'user', content: [{ type: 'text', text: 'older image prompt' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,old' } }] },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new image prompt\n\n[ATTACHMENTS]' },
    { role: 'assistant', content: 'new generated image answer' },
  ];
  assert.equal(latestAssistantAfterUser(rows, [
    { type: 'text', text: 'new image prompt' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,different-but-same-turn' } },
  ]), 'new generated image answer');
});

test('recovery matches multimodal user turns the server persisted as JSON-serialized content', () => {
  const serialized = JSON.stringify([
    { type: 'text', text: 'paint a boat' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
  ]);
  const rows = [
    { role: 'user', content: serialized },
    { role: 'assistant', content: 'Here is your boat image.' },
  ];
  assert.equal(latestAssistantAfterUser(rows, [{ type: 'text', text: 'paint a boat' }]), 'Here is your boat image.');
});

test('recovery matches nested multimodal parts whose text lives in content arrays', () => {
  const rows = [
    {
      role: 'user',
      content: [
        { type: 'text', content: [{ text: 'summarize' }, { text: ' this file' }] },
        { type: 'file', file: { name: 'notes.txt' } },
      ],
    },
    { role: 'assistant', content: 'summary' },
  ];
  assert.equal(latestAssistantAfterUser(rows, 'summarize this file'), 'summary');
});

test('recovery never misreads JSON-looking user text or JSON without a text component', () => {
  const plain = [
    { role: 'user', content: '{just text}' },
    { role: 'assistant', content: 'ok' },
  ];
  assert.equal(latestAssistantAfterUser(plain, '{just text}'), 'ok');
  const structured = [
    { role: 'user', content: '{"a":1}' },
    { role: 'assistant', content: 'ok' },
  ];
  assert.equal(latestAssistantAfterUser(structured, '{"a":1}'), 'ok');
});

test('recovery polling stays open for slow accepted turns and never replays the prompt', () => {
  const policy = turnRecovery.acceptedTurnRecoveryPolicy({ attempt: 20, elapsedMs: 0 });
  assert.ok(policy.maxDurationMs >= 120_000, 'the recovery window must stay open for slow image turns');
  assert.ok(policy.delayMs <= turnRecovery.ACCEPTED_TURN_RECOVERY_MAX_DELAY_MS, 'the poll gap stays bounded');
  assert.equal(policy.shouldContinue, true);
  // Neither surface passes a short attempts/delay budget to the recovery poller.
  assert.match(sidepanelSource, /recoverAcceptedTurn\(prompt, preparedAttachments, \{ signal: activeAbortController\.signal \}\)/);
  assert.doesNotMatch(sidepanelSource, /recoverAcceptedTurn\([^)]*attempts\s*=/);
  assert.match(appSource, /recoverAcceptedWebTurn\(prompt, \{ signal: activeAbortController\.signal \}\)/);
  assert.doesNotMatch(appSource, /recoverAcceptedWebTurn\([^)]*attempts\s*=/);
});

test('terminal error paths dispose the diffusion placeholder on both surfaces', () => {
  // Side panel: the streaming updater owns an explicit dispose and the turn
  // catch calls it everywhere the stream ends without a final flush.
  assert.match(sidepanelSource, /function dispose\(\) \{[\s\S]*?setToolActivity\(node, null\);/);
  assert.match(sidepanelSource, /return \{ update: updateText, updateText, updateTool, flush, dispose \};/);
  assert.match(sidepanelSource, /if \(error\?\.requestAccepted !== true\) streamView\?\.dispose\?\.\(\);/);
  assert.match(sidepanelSource, /if \(contextRecovery\) \{[\s\S]*?streamView\?\.dispose\?\.\(\);/);
  // Hermes Web: the live-run diffusion card is cleared on the rejected-request
  // and context-recovery error branches, not only on stop/recovery paths.
  const webRequestFailureStart = appSource.indexOf('const requestFailure = turnRequestFailureState(error)');
  const webRequestFailureSegment = appSource.slice(webRequestFailureStart, webRequestFailureStart + 700);
  assert.match(webRequestFailureSegment, /clearLiveRun\(\);/);
  const webContextStart = appSource.indexOf('const contextRecovery = sessionContextFailureRecovery(error, gatewayCapabilities)');
  const webContextSegment = appSource.slice(webContextStart, webContextStart + 260);
  assert.match(webContextSegment, /clearLiveRun\(\);/);
});

test('both surfaces re-fetch the open session history after terminal reconcile', () => {
  // Side panel: after settleActiveRunTerminal, a race-guarded quiet refresh
  // re-reads the session history so late image/tool results are not missing.
  assert.match(sidepanelSource, /await settleActiveRunTerminal\(\);[\s\S]*?void refreshActiveSessionHistoryQuietly\(runControlGeneration\)\.catch/);
  assert.match(sidepanelSource, /async function refreshActiveSessionHistoryQuietly\(expectedGeneration = runControlGeneration\)/);
  assert.match(sidepanelSource, /isUnsavedBrowserDraftSession\(\{ sessionId, sessions: availableSessions \}\)\) return false;/);
  assert.match(sidepanelSource, /return commitFetchedSessionMessages\(result, \{ sessionId \}\);/);
  // Hermes Web: same discipline after settleWebRunTerminal, on both the REST
  // and dashboard transports.
  assert.match(appSource, /await settleWebRunTerminal\(\);[\s\S]*?void refreshWebActiveSessionHistoryQuietly\(runControlGeneration\)\.catch/);
  assert.match(appSource, /async function refreshWebActiveSessionHistoryQuietly\(expectedGeneration = runControlGeneration\)/);
  assert.match(appSource, /preserveUserImageAttachments\(refreshed, activeMessages\)/);
  assert.match(appSource, /WS_METHODS\.sessionHistory,\s*\{\s*session_id: sessionId,\s*profile: settings\.activeProfile \|\| ''/);
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

test('Hermes Web recovers accepted local stream turns without replaying and preserves generated image sources', () => {
  assert.match(appSource, /async function recoverAcceptedWebTurn/);
  assert.match(appSource, /acceptedTurnRecoveryPolicy/);
  assert.match(appSource, /resolvedGeneratedImageSourcesFromMessages/);
  assert.match(appSource, /requestAccepted/);
  assert.match(appSource, /revealSources/);
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

  const sidepanelDashboardStart = sidepanelSource.indexOf('async function streamDashboardWsChat');
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
  const recoveryIndex = streamCatch.indexOf("const recoveryAction = classifyTurnRecovery(streamError)");
  const dashboardBranchIndex = streamCatch.indexOf('dashboardTransport');
  assert.ok(
    recoveryIndex >= 0 && dashboardBranchIndex > recoveryIndex,
    'request rejection classification must run before dashboard-transport fallback suppression',
  );
});
