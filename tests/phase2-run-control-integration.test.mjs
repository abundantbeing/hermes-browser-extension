import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const web = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
const caps = readFileSync(new URL('../extension/lib/capabilities.mjs', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const webHtml = readFileSync(new URL('../extension/app.html', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('../extension/lib/run-control-lifecycle.mjs', import.meta.url), 'utf8');

test('both Browser surfaces bind Stop to the shared terminal lifecycle', () => {
  for (const source of [panel, web]) {
    assert.match(source, /run-control-lifecycle\.mjs/);
    assert.match(source, /beginRunControl\(/);
    assert.match(source, /acknowledgeStopRequest\(/);
    assert.match(source, /waitForTerminalStatus\(/);
    assert.match(source, /markRunTerminal\(/);
    assert.match(source, /shouldAutoFlushQueuedTurn\(queuedTurn, (?:settledRunControl|activeRunControl)\)/);
  }
});

test('Stop transport is split and local stream abort happens only after terminal confirmation', () => {
  for (const source of [panel, web]) {
    const stopStart = source.indexOf(source === panel ? 'async function stopCurrentTurn' : 'async function stopActiveRun');
    const stopEnd = source.indexOf('\nfunction ', stopStart + 1);
    const stop = source.slice(stopStart, stopEnd);
    assert.match(stop, /WS_METHODS\.sessionInterrupt/);
    assert.match(stop, /\/v1\/runs\/\$\{encodeURIComponent\(stopRunId\)\}\/stop/);
    assert.match(source, /\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}/);
    assert.ok(source.indexOf('activeRunControl = markRunTerminal(activeRunControl, result.status)') < source.indexOf('activeAbortController?.abort()'));
    assert.doesNotMatch(stop, /Browser closed the local stream/);
  }
});

test('control acknowledgement and terminal reconciliation use separate timeouts', () => {
  for (const source of [panel, web]) {
    assert.match(source, /RUN_CONTROL_REQUEST_TIMEOUT_MS/);
    assert.match(source, /RUN_TERMINAL_CONFIRM_TIMEOUT_MS/);
    assert.match(source, /terminal confirmation timed out/i);
  }
  assert.match(lifecycle, /controlRequestController/);
  assert.match(lifecycle, /RUN_CONTROL_REQUEST_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(lifecycle, /RUN_TERMINAL_CONFIRM_TIMEOUT_MS\s*=\s*30_000/);
});

test('stream-finally paths cannot clear run identity or flush queue while Stop is unconfirmed', () => {
  for (const source of [panel, web]) {
    assert.match(source, /markRunStreamClosed\(activeRunControl\)/);
    assert.match(source, /activeRunControl\?\.phase === RUN_CONTROL_PHASES\.TERMINAL/);
    assert.match(source, /activeRunControl\.writerLease !== 'released'|activeRunControl\.writerLease === 'released'/);
  }
});

test('run Stop capability remains fail-closed without explicit feature or endpoint advertisement', () => {
  assert.match(caps, /runStop:\s*advertisedFeature/);
  assert.match(caps, /runStatus:\s*advertisedFeature/);
  assert.doesNotMatch(caps, /runStop:\s*inferredFeature/);
});

test('REST Stop requires explicitly advertised stop and status capabilities', () => {
  for (const source of [panel, web]) {
    assert.match(source, /!gatewayCapabilities\.runStop \|\| !gatewayCapabilities\.runStatus/);
  }
});

test('post-stream tails re-check generation and preserve failed or cancelled terminal status', () => {
  for (const source of [panel, web]) {
    assert.match(source, /runControlGenerationMatches\(turnRunControlGeneration, runControlGeneration\)/);
    assert.match(source, /streamTerminalStatus/);
    assert.match(source, /\['completed', 'failed', 'cancelled'\]/);
  }
});

test('stale Stop and status responses reconcile terminal state instead of stranding the writer', () => {
  for (const source of [panel, web]) {
    assert.match(source, /runStopFailureTerminalStatus\(\{ httpStatus: response\.status, payload \}\)/);
    assert.match(source, /expectedGeneration/);
  }
  assert.match(lifecycle, /runControlGenerationMatches/);
});

test('Stop response and failure settlement are generation-guarded before mutating lifecycle state', () => {
  for (const [source, functionName] of [[panel, 'stopCurrentTurn'], [web, 'stopActiveRun']]) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf('\nfunction ', start + 1);
    const stop = source.slice(start, end);
    const responseIndex = stop.indexOf('const response = await runControlRequestWithTimeout');
    const staleIndex = stop.indexOf('const staleTerminal = runStopFailureTerminalStatus');
    const failureIndex = stop.indexOf('activeRunControl = markStopRequestFailed');
    assert.match(stop, /const stopRunId = String\(activeRunId \|\| ''\)/);
    assert.ok(responseIndex >= 0 && staleIndex > responseIndex);
    assert.ok(stop.lastIndexOf('if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;', staleIndex) > responseIndex);
    assert.ok(stop.lastIndexOf('if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;', failureIndex) > staleIndex);
  }
});

test('all live stream callbacks reject stale generations before touching active run or message state', () => {
  for (const source of [panel, web]) {
    const callbackGuards = source.match(/if \(!runControlGenerationMatches\(turnRunControlGeneration, runControlGeneration\)\) return;/g) || [];
    assert.ok(callbackGuards.length >= 4, `expected at least four callback guards, got ${callbackGuards.length}`);
  }
});

test('both surfaces deny new-chat and session switches while a run owns the writer', () => {
  const functions = [
    [panel, 'beginHermesBrowserDraft'],
    [panel, 'openHermesSession'],
    [web, 'beginHermesWebDraft'],
    [web, 'openSession'],
  ];
  for (const [source, functionName] of functions) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf('\nfunction ', start + 1);
    const body = source.slice(start, end);
    assert.ok(start >= 0, `missing ${functionName}`);
    assert.match(body, /canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)/);
    assert.match(body, /return false/);
  }
});

test('unconfirmed runs expose safe retry and queue-discard recovery without a writer-release button', () => {
  assert.match(panelHtml, /id="retryRunStatusButton"/);
  assert.match(panelHtml, /id="discardHeldQueueButton"/);
  assert.match(webHtml, /id="webRetryRunStatusButton"/);
  assert.match(webHtml, /id="webDiscardHeldQueueButton"/);
  assert.doesNotMatch(panelHtml, /release writer/i);
  assert.doesNotMatch(webHtml, /release writer/i);
  assert.match(panel, /retryActiveRunTerminalStatus/);
  assert.match(web, /retryWebRunTerminalStatus/);
});

test('Hermes Web acquires writer ownership before awaiting draft-session creation', () => {
  const sender = web.match(/async function sendPrompt\([\s\S]*?\n\}/)?.[0] || '';
  const createIndex = sender.indexOf('await createSession()');
  const sendingIndex = sender.indexOf('setSending(true)');
  assert.match(sender, /if \(sending \|\| !canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)\)/);
  assert.ok(sender.indexOf('++runControlGeneration') < createIndex);
  assert.ok(sender.indexOf('activeRunControl = beginRunControl') < createIndex);
  assert.ok(createIndex < sendingIndex);
});

test('manual Side Panel compaction cannot rotate the session while a run owns the writer', () => {
  const compact = panel.match(/async function compactCurrentSessionContext\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(compact, /!automaticRecovery && !canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)/);
  assert.ok(compact.indexOf('canSwitchActiveSession') < compact.indexOf('/compress'));
});

test('Side Panel WebSocket streams accept only events scoped to the exact live session', () => {
  for (const functionName of ['streamRemoteWsChat', 'runRemoteInlineBackground']) {
    const body = panel.match(new RegExp(`(?:async )?function ${functionName}\\([\\s\\S]*?\\n\\}`))?.[0] || '';
    assert.match(body, /event\.sessionId === (?:sessionId|session\.liveId)/);
    assert.doesNotMatch(body, /!event\.sessionId/);
    assert.match(body, /WS_EVENTS\.error, \(event\) => \{\s*if \(!for(?:This)?Session\(event\)\) return;/);
  }
});

test('Side Panel terminal reconciliation never creates a successor session to inspect an old run', () => {
  const reconcile = panel.match(/async function reconcileActiveRunTerminal\([\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(reconcile, /ensureRemoteWsSession/);
  assert.match(reconcile, /dashboardSessionId \|\| reconciliationRunId/);
  assert.match(reconcile, /active Dashboard session is unavailable for terminal reconciliation/i);
});

test('Stop falls back to local cancellation only while REST has no server run identity', () => {
  for (const [source, functionName] of [[panel, 'stopCurrentTurn'], [web, 'stopActiveRun']]) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf('\nfunction ', start + 1);
    const stop = source.slice(start, end);
    assert.match(stop, /if \(!stopRunId\) \{[\s\S]*?activeAbortController\?\.abort\(\);[\s\S]*?markRunTerminal\(activeRunControl, 'cancelled'\);[\s\S]*?return true;/);
    assert.ok(stop.indexOf('if (!stopRunId) {') < stop.indexOf('/v1/runs/${encodeURIComponent(stopRunId)}/stop'));
  }
});

test('Side Panel rejects alternate send reentry and exposes Stop only after preflight installs local cancellation', () => {
  const sender = panel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const sessionIndex = sender.indexOf('await ensureHermesSession()');
  const modelLockIndex = sender.indexOf('await ensureActiveSessionModelLockOrThrow()');
  const abortIndex = sender.indexOf('activeAbortController = new AbortController()');
  const sendingIndex = sender.indexOf('sending = true');
  assert.match(sender, /if \(sending \|\| !canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)\) return false;/);
  assert.ok(sender.indexOf('activeRunControl = beginRunControl') < sessionIndex);
  assert.ok(sessionIndex < modelLockIndex && modelLockIndex < abortIndex && abortIndex < sendingIndex);
});

test('Hermes Web reconnect recovery resumes the durable Dashboard session and adopts its fresh live id', () => {
  const recovery = web.match(/async function resumeDashboardRecoverySession\([\s\S]*?\n\}/)?.[0] || '';
  const reconcile = web.match(/async function reconcileWebRunTerminal\([\s\S]*?\n\}/)?.[0] || '';
  const stop = web.match(/async function stopActiveRun\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(recovery, /storedSessionId:\s*durableSessionId/);
  assert.doesNotMatch(recovery, /sessionCreate|createParams/);
  assert.match(recovery, /identity\.storedId !== durableSessionId/);
  assert.match(recovery, /dashboardLiveSessionId = identity\.liveId/);
  assert.match(reconcile, /resumeDashboardRecoverySession\(connection/);
  assert.match(stop, /resumeDashboardRecoverySession\(connection/);
});

test('completed reconciliation suppresses false Send failed output after a premature REST stream close', () => {
  const submitStart = web.indexOf("els.composer.addEventListener('submit'");
  const submitEnd = web.indexOf("els.prompt.addEventListener('keydown'", submitStart);
  const submit = web.slice(submitStart, submitEnd);
  assert.match(submit, /activeRunControl\?\.phase === RUN_CONTROL_PHASES\.TERMINAL/);
  assert.match(submit, /activeRunControl\?\.terminalStatus === 'completed'/);
  assert.ok(submit.indexOf("terminalStatus === 'completed'") < submit.indexOf('Send failed:'));
});

test('Dashboard chat streams have bounded completion timers on both Browser surfaces', () => {
  const sideStream = panel.match(/async function streamRemoteWsChat\([\s\S]*?\n\}/)?.[0] || '';
  const webStream = web.match(/async function streamDashboardPrompt\([\s\S]*?\n\}/)?.[0] || '';
  for (const stream of [sideStream, webStream]) {
    assert.match(stream, /setTimeout\(\(\) => finish\(reject, new Error\([^)]*timed out/i);
    assert.match(stream, /clearTimeout\(timer\)/);
  }
});
