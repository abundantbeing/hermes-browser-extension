import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as lifecycle from '../extension/lib/run-control-lifecycle.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const askHermesStart = sidepanelSource.indexOf('async function askHermes(');
const askHermesEnd = sidepanelSource.indexOf('\nasync function ', askHermesStart + 1);
const askHermes = sidepanelSource.slice(askHermesStart, askHermesEnd);

function nestedFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end);
}

test('stale dashboard run controls are recoverable only after their stream is closed', () => {
  assert.equal(typeof lifecycle.canRecoverStaleDashboardRunControl, 'function');
  const running = lifecycle.beginRunControl({ transport: 'dashboard-ws', now: 1 });
  const closed = lifecycle.markRunStreamClosed(running);
  const stopping = lifecycle.requestRunStop(closed, 2);

  assert.equal(lifecycle.canRecoverStaleDashboardRunControl({
    sending: false,
    dashboardTransport: true,
    runControl: closed,
  }), true);
  assert.equal(lifecycle.canRecoverStaleDashboardRunControl({
    sending: true,
    dashboardTransport: true,
    runControl: closed,
  }), false);
  assert.equal(lifecycle.canRecoverStaleDashboardRunControl({
    sending: false,
    dashboardTransport: false,
    runControl: closed,
  }), false);
  assert.equal(lifecycle.canRecoverStaleDashboardRunControl({
    sending: false,
    dashboardTransport: true,
    runControl: running,
  }), false);
  assert.equal(lifecycle.canRecoverStaleDashboardRunControl({
    sending: false,
    dashboardTransport: true,
    runControl: stopping,
  }), false);
});

test('askHermes recovers an inactive Bot Chat writer instead of silently swallowing the draft', () => {
  const guardStart = askHermes.indexOf('const dashboardTransport = usesDashboardWsChatTransport();');
  const sendGuard = askHermes.indexOf('if (sending) return false;');
  const switchGuard = askHermes.indexOf('if (!canSwitchActiveSession({ sending, runControl: activeRunControl }))');
  const recovery = askHermes.indexOf('canRecoverStaleDashboardRunControl({');
  const visibleBlock = askHermes.indexOf("setStatus('warn', 'Hermes is still working'");

  assert.ok(guardStart >= 0, 'dashboard transport is captured before the send guard');
  assert.ok(sendGuard > guardStart, 'sending guard follows the transport decision');
  assert.ok(switchGuard > sendGuard, 'session-switch guard is checked after the sending guard');
  assert.ok(recovery > switchGuard, 'stale dashboard recovery is checked at the blocked-send boundary');
  assert.ok(visibleBlock > recovery, 'a genuinely active/stopping writer produces visible feedback');
  assert.doesNotMatch(askHermes, /if \(sending \|\| !canSwitchActiveSession\(\{ sending, runControl: activeRunControl \}\)\) return false;/);
});

test('dashboard stream session identity is not used as a REST server run identity', () => {
  const onRun = nestedFunction(askHermes, 'onRun: (runId) => {', 'onSteerQueued:');
  assert.match(onRun, /if \(dashboardTransport\) return;/);
  assert.ok(onRun.indexOf('if (dashboardTransport) return;') < onRun.indexOf('activeRunId = runId'));
  assert.ok(onRun.indexOf('activeRunId = runId') < onRun.indexOf('activeRunControl = withRunControlId'));
});
