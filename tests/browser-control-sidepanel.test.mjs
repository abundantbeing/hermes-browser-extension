import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const [html, source, css] = await Promise.all([
  readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8'),
  readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8'),
]);

test('Phase 6 Hermes Control card is target-locked inside Browser Behavior after Active Tab', () => {
  const browserBehavior = html.indexOf('id="browserBehaviorTitle"');
  const activeTab = html.indexOf('id="statusCard"');
  const controlCard = html.indexOf('id="browserControlCard"');
  const promptContext = html.indexOf('class="settings-control-group"');
  assert.ok(browserBehavior >= 0 && activeTab > browserBehavior);
  assert.ok(controlCard > activeTab && controlCard < promptContext);
  assert.match(html, /id="browserControlEnableButton"/);
  assert.match(html, /id="browserControlScopeInput"/);
  assert.match(html, /id="browserControlStayButton"/);
  assert.match(html, /id="browserControlFollowButton"/);
  assert.match(html, /id="browserControlDetachButton"/);
});

test('Phase 6 live control strip stays above conversation and owns pause stop and approval decisions', () => {
  const strip = html.indexOf('id="browserControlStrip"');
  const messages = html.indexOf('id="messages"');
  assert.ok(strip >= 0 && strip < messages);
  for (const id of [
    'browserControlPauseButton',
    'browserControlStopButton',
    'browserControlApproveButton',
    'browserControlRejectButton',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  // Pause and Stop are compact icon-only glyphs; Stop only renders while an action is running or queued.
  assert.match(html, /id="browserControlPauseButton"[^>]*icon-only/);
  assert.match(html, /id="browserControlStopButton"[^>]*hidden/);
  assert.match(html, /id="browserControlStopButton"[^>]*icon-only/);
});

test('Phase 6 enable and detach use install-declared debugger access without runtime permission prompts', () => {
  assert.match(source, /browserControlEnableButton.*addEventListener\('click'/s);
  assert.doesNotMatch(source, /permissions\?\.request\(\{\s*permissions:\s*\['debugger'\]\s*\}\)/s);
  assert.doesNotMatch(source, /permissions\?\.remove\(\{\s*permissions:\s*\['debugger'\]\s*\}\)/s);
  assert.match(html, /granted when this extension or update was installed/i);
  assert.match(source, /HERMES_CONTROLLER_LEASE_ACQUIRE/);
  assert.match(source, /HERMES_CONTROLLER_DETACH/);
  assert.match(source, /browserControlEnabled:\s*true/);
  assert.match(source, /browserControlEnabled:\s*false/);
});

test('Phase 6 visible controls call trusted worker pause stop and exact approval messages', () => {
  for (const type of [
    'HERMES_CONTROLLER_PAUSE',
    'HERMES_CONTROLLER_RESUME',
    'HERMES_CONTROLLER_STOP',
    'HERMES_CONTROLLER_APPROVAL_GRANT',
    'HERMES_CONTROLLER_APPROVAL_REJECT',
  ]) assert.match(source, new RegExp(type));
  assert.match(source, /pendingApproval\.approvalId/);
  assert.match(source, /pendingApproval\.approvalNonce/);
  assert.match(source, /pendingApproval\.controllerId/);
  assert.match(source, /pendingApproval\.leaseId/);
  assert.match(source, /pendingApproval\.leaseGeneration/);
  assert.match(source, /pendingApproval\.documentGeneration/);
});

test('Phase 6 Stay Follow uses tab activation only for Follow and never raises a browser window', () => {
  assert.match(source, /followTargetTabId/);
  assert.match(source, /tabs\.update\(targetTabId,\s*\{\s*active:\s*true\s*\}\)/s);
  assert.doesNotMatch(source, /windows\.update\([^)]*focused:\s*true/s);
});

test('Phase 6 control UI reuses theme tokens, stays square, and has reduced-motion-safe feedback', () => {
  assert.match(css, /\.browser-control-card\s*\{/);
  assert.match(css, /\.browser-control-strip\s*\{/);
  assert.match(css, /\.browser-control-card[\s\S]*?border-radius:\s*var\(--radius\)/);
  assert.match(css, /\.browser-control-action:active[\s\S]*?scale\(0\.97\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?\.browser-control-action/s);
});

test('Hermes Control settings use a readable single-column hierarchy with proportional controls', () => {
  assert.match(html, /class="browser-control-config"[\s\S]*?class="browser-control-field"[\s\S]*?class="browser-control-view"/);
  assert.match(css, /\.browser-control-config\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.browser-control-view\s*>\s*div\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.browser-control-card-head p[\s\S]*?font:\s*calc\(11px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.45/s);
  assert.match(css, /\.browser-control-action\s*\{[^}]*min-height:\s*38px/s);
  assert.match(css, /\.browser-control-card-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test('Phase 6 approval reason remains fully readable in narrow Browser panels', () => {
  assert.match(css, /\.browser-control-strip-copy span\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /@media \(max-width:\s*560px\)[\s\S]*?\.browser-control-strip\s*\{[^}]*grid-template-columns:\s*8px minmax\(0,\s*1fr\)[^}]*\}[^}]*\.[\s\S]*?grid-column:\s*2/s);
});

test('startup Connect button uses the theme primary tokens so it stays readable in every theme and mode', () => {
  const button = css.match(/body\.startup-active \.topbar #startupConnectButton:not\(\[hidden\]\)\s*\{[^}]*\}/)?.[0] || '';
  assert.match(button, /background:\s*var\(--hermes-primary-bg\)/);
  assert.match(button, /color:\s*var\(--hermes-primary-fg\)/);
  assert.match(button, /border-color:\s*var\(--hermes-primary-border\)/);
  assert.doesNotMatch(button, /#[0-9a-fA-F]{3,6}/);
  assert.doesNotMatch(button, /var\(--hermes-accent\)/);
});
