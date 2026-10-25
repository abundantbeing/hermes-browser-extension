import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const caps = readFileSync(new URL('../extension/lib/capabilities.mjs', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('../extension/lib/run-control-lifecycle.mjs', import.meta.url), 'utf8');

test('the Side Panel binds Stop to the shared terminal lifecycle', () => {
  for (const source of [panel]) {
    assert.match(source, /run-control-lifecycle\.mjs/);
    assert.match(source, /beginRunControl\(/);
    assert.match(source, /acknowledgeStopRequest\(/);
    assert.match(source, /waitForTerminalStatus\(/);
    assert.match(source, /markRunTerminal\(/);
    assert.match(source, /shouldAutoFlushQueuedTurn\(queuedTurn, (?:settledRunControl|activeRunControl)\)/);
  }
});

test('Stop transport is split and local stream abort happens only after terminal confirmation', () => {
  for (const source of [panel]) {
    const stopStart = source.indexOf('async function stopCurrentTurn');
    const stopEnd = source.indexOf('\nfunction ', stopStart + 1);
    const stop = source.slice(stopStart, stopEnd);
    assert.match(stop, /interruptGatewaySession\(/);
    assert.match(stop, /\/v1\/runs\/\$\{encodeURIComponent\(stopRunId\)\}\/stop/);
    assert.match(source, /\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}/);
    assert.ok(source.indexOf('activeRunControl = markRunTerminal(activeRunControl, result.status)') < source.indexOf('activeAbortController?.abort()'));
    assert.doesNotMatch(stop, /Browser closed the local stream/);
  }
});

test('control acknowledgement and terminal reconciliation use separate timeouts', () => {
  for (const source of [panel]) {
    assert.match(source, /RUN_CONTROL_REQUEST_TIMEOUT_MS/);
    assert.match(source, /RUN_TERMINAL_CONFIRM_TIMEOUT_MS/);
    assert.match(source, /terminal confirmation timed out/i);
  }
  assert.match(lifecycle, /controlRequestController/);
  assert.match(lifecycle, /RUN_CONTROL_REQUEST_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(lifecycle, /RUN_TERMINAL_CONFIRM_TIMEOUT_MS\s*=\s*30_000/);
});

test('stream-finally paths cannot clear run identity or flush queue while Stop is unconfirmed', () => {
  for (const source of [panel]) {
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
  for (const source of [panel]) {
    assert.match(source, /!gatewayCapabilities\.runStop \|\| !gatewayCapabilities\.runStatus/);
  }
});

test('post-stream tails re-check generation and preserve failed or cancelled terminal status', () => {
  for (const source of [panel]) {
    assert.match(source, /runControlGenerationMatches\(turnRunControlGeneration, runControlGeneration\)/);
    assert.match(source, /streamTerminalStatus/);
    assert.match(source, /\['completed', 'failed', 'cancelled'\]/);
  }
});

test('stale Stop and status responses reconcile terminal state instead of stranding the writer', () => {
  for (const source of [panel]) {
    assert.match(source, /runStopFailureTerminalStatus\(\{ httpStatus: response\.status, payload \}\)/);
    assert.match(source, /expectedGeneration/);
  }
  assert.match(lifecycle, /runControlGenerationMatches/);
});

test('Stop response and failure settlement are generation-guarded before mutating lifecycle state', () => {
  for (const [source, functionName] of [[panel, 'stopCurrentTurn']]) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf('\nfunction ', start + 1);
    const stop = source.slice(start, end);
    const responseIndex = stop.indexOf('const response = await runControlRequestWithTimeout');
    const staleIndex = stop.indexOf('const staleTerminal = runStopFailureTerminalStatus');
    const failureIndex = stop.indexOf('activeRunControl = markStopRequestFailed');
    assert.match(stop, /let stopRunId = String\(activeRunId \|\| ''\)/);
    assert.ok(responseIndex >= 0 && staleIndex > responseIndex);
    assert.ok(stop.lastIndexOf('if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;', staleIndex) > responseIndex);
    assert.ok(stop.lastIndexOf('if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;', failureIndex) > staleIndex);
  }
});

test('all live stream callbacks reject stale generations before touching active run or message state', () => {
  for (const source of [panel]) {
    const callbackGuards = source.match(/if \(!runControlGenerationMatches\(turnRunControlGeneration, runControlGeneration\)\) return;/g) || [];
    assert.ok(callbackGuards.length >= 4, `expected at least four callback guards, got ${callbackGuards.length}`);
  }
});

test('new-chat and session switches stay allowed while a run is live (gateway owns the run)', () => {
  const functions = [
    [panel, 'beginHermesBrowserDraft'],
    [panel, 'openHermesSession'],
  ];
  for (const [source, functionName] of functions) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf('\nfunction ', start + 1);
    const body = source.slice(start, end);
    assert.ok(start >= 0, `missing ${functionName}`);
    assert.doesNotMatch(body, /canSwitchActiveSession\(/, `${functionName} must not block on a live run`);
  }
});

test('a finishing run mirrors its reply only into the session it started in', () => {
  assert.match(panel, /const runSessionId = String\(settings\.sessionId \|\| ''\)\.trim\(\);/);
  assert.match(panel, /if \(String\(settings\.sessionId \|\| ''\)\.trim\(\) === runSessionId\) \{\s*messages\.push\(\{ role: 'assistant'/);
});


test('unconfirmed runs expose safe retry and queue-discard recovery without a writer-release button', () => {
  assert.match(panelHtml, /id="retryRunStatusButton"/);
  assert.match(panelHtml, /id="discardHeldQueueButton"/);
  assert.doesNotMatch(panelHtml, /release writer/i);
  assert.match(panel, /retryActiveRunTerminalStatus/);
});

test('manual Side Panel compaction cannot rotate the session while a run owns the writer', () => {
  const compact = panel.match(/async function compactCurrentSessionContext\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(compact, /!automaticRecovery && !canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)/);
  assert.ok(compact.indexOf('canSwitchActiveSession') < compact.indexOf('/compress'));
});

test('Side Panel WebSocket streams accept only events scoped to the exact live session', () => {
  for (const functionName of ['streamDashboardWsChat', 'runRemoteInlineBackground']) {
    const body = [
      panel.match(new RegExp(`(?:async )?function ${functionName}\\([\\s\\S]*?\\n\\}`))?.[0] || '',
      functionName === 'streamDashboardWsChat'
        ? panel.match(/async function streamDashboardWsChatAttempt\([\s\S]*?\n\}/)?.[0] || ''
        : '',
    ].join('\n');
    if (functionName === 'streamDashboardWsChat') {
      assert.match(body, /matchesDashboardSessionEvent\(event, sessionIds\)/);
    } else {
      assert.match(body, /event\.sessionId === (?:sessionId|session\.liveId)/);
    }
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

test('Stop without a server run identity is held as unconfirmed instead of claiming success', () => {
  for (const [source, functionName] of [[panel, 'stopCurrentTurn']]) {
    const start = source.indexOf(`async function ${functionName}`);
    const end = source.indexOf('\nfunction ', start + 1);
    const stop = source.slice(start, end);
    const restStopIndex = stop.lastIndexOf('/v1/runs/${encodeURIComponent(stopRunId)}/stop');
    const block = stop.slice(stop.indexOf('if (!stopRunId) {'), restStopIndex);
    assert.match(block, /activeAbortController\?\.abort\(\);/);
    assert.match(block, /resolveActiveRunIdFromSession\(\)/);
    assert.match(block, /markRunUnconfirmed\(activeRunControl, RUN_UNCONFIRMED_REASONS\.RUN_ID_UNKNOWN/);
    assert.match(block, /return false;/);
    assert.doesNotMatch(block, /markRunTerminal\(activeRunControl, 'cancelled'\)/);
    assert.doesNotMatch(block, /return true;/);
    assert.ok(stop.indexOf('if (!stopRunId) {') < restStopIndex);
  }
});

test('Side Panel rejects alternate send reentry and exposes Stop only after preflight installs local cancellation', () => {
  const sender = panel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const sessionIndex = sender.indexOf('await ensureHermesSession()');
  const modelLockIndex = sender.indexOf('await ensureActiveSessionModelLockOrThrow()');
  const abortIndex = sender.indexOf('activeAbortController = new AbortController()');
  const sendingIndex = sender.indexOf('sending = true');
  assert.match(sender, /if \(sending\) return false;/);
  assert.match(sender, /if \(!canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)\)/);
  assert.match(sender, /canRecoverStaleDashboardRunControl\(\{ sending, dashboardTransport, runControl: activeRunControl \}\)/);
  assert.match(sender, /setStatus\('warn', 'Hermes is still working'/);
  assert.ok(sender.indexOf('activeRunControl = beginRunControl') < sessionIndex);
  assert.ok(sessionIndex < modelLockIndex && modelLockIndex < abortIndex && abortIndex < sendingIndex);
});

test('Dashboard chat streams have bounded completion timers in the Side Panel', () => {
  const sideStream = [
    panel.match(/async function streamDashboardWsChat\([\s\S]*?\n\}/)?.[0] || '',
    panel.match(/async function streamDashboardWsChatAttempt\([\s\S]*?\n\}/)?.[0] || '',
  ].join('\n');
  for (const stream of [sideStream]) {
    assert.match(stream, /createDashboardStreamWatchdog/);
    assert.match(stream, /watchdog\.ping\(\)/);
    assert.match(stream, /watchdog\.stop\(\)/);
    assert.match(stream, /client\.on\('\*'/);
  }
});

test('local dashboard-ws advertises and routes active-run steering', () => {
  const dashboardCapabilities = caps.match(/export function dashboardWsGatewayCapabilities[\s\S]*?\n\}/)?.[0] || '';
  const canSteer = panel.match(/function canSteerActiveRun\(\)[\s\S]*?\n\}/)?.[0] || '';
  const sender = panel.match(/async function sendSteerText\([\s\S]*?\n\}/)?.[0] || '';

  assert.match(dashboardCapabilities, /runSteer:\s*true/);
  assert.match(canSteer, /usesDashboardWsChatTransport\(\)/);
  assert.match(canSteer, /gatewayCapabilities\.runSteer/);
  assert.match(sender, /if \(usesDashboardWsChatTransport\(\)\)/);
  assert.match(sender, /WS_METHODS\.sessionSteer/);
  assert.match(sender, /session_id: sessionId/);
  assert.match(sender, /text: steerText/);
});
