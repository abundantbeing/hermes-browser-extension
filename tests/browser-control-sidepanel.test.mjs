import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const [html, source, css] = await Promise.all([
  readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8'),
  readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8'),
]);

test('Phase 6 Hermes Control card is target-locked inside the Permissions pane after Active Tab', () => {
  const pane = html.indexOf('data-settings-pane="permissions"');
  const nextPane = html.indexOf('data-settings-pane="assist"');
  const activeTab = html.indexOf('id="statusCard"');
  const controlCard = html.indexOf('id="browserControlCard"');
  const consent = html.indexOf('id="browserContextConsentControl"');
  assert.ok(pane >= 0 && nextPane > pane);
  assert.ok(activeTab > pane && activeTab < nextPane, 'Active Tab status lives in Permissions');
  assert.ok(controlCard > activeTab && controlCard < consent && controlCard < nextPane);
  assert.match(html, /id="browserControlEnableButton"/);
  assert.match(html, /id="browserControlScopeInput"/);
  // Settings has no tooltips, so only the Hermes Control window's Show tab button carries the help key.
  assert.doesNotMatch(html, /id="browserControlShowTabButton"[^>]*data-control-help=/);
  assert.match(html, /id="browserControlDetachButton"/);
  assert.doesNotMatch(html, /browserControlStayButton|browserControlFollowButton|browser-control-view|While Hermes works/);
});

test('composer launcher opens centered control management outside the conversation', () => {
  const strip = html.indexOf('id="browserControlStrip"');
  const messages = html.indexOf('id="messages"');
  const dialog = html.indexOf('<dialog id="browserControlDialog"');
  assert.ok(dialog > messages && strip > dialog);
  assert.match(html, /id="browserControlMenuButton"[\s\S]*?<\/button>\s*<button id="sendButton"/);
  assert.match(html, /id="browserControlMenuButton"[^>]*hidden[^>]*aria-haspopup="dialog"/);
  assert.match(html, /id="browserControlOffButton"[^>]*data-i18n="browser_control.turn_off"/);
  assert.match(css, /\.browser-control-dialog::backdrop/);
  assert.match(source, /browserControlDialogUi\?\.render/);
  for (const id of [
    'browserControlPauseButton',
    'browserControlStopButton',
    'browserControlApproveButton',
    'browserControlRejectButton',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  // The centered dialog has readable action labels; Stop only renders while working.
  assert.match(html, /id="browserControlPauseLabel"/);
  assert.match(html, /id="browserControlStopButton"[^>]*hidden/);
  // Show tab is the first control in the strip's action row, so the buttons that come and go after
  // it (Attach, Stop, Approve) cannot move it sideways between ATTACH and ACTIVE.
  assert.match(html, /<div class="browser-control-strip-actions">\s*<button id="browserControlDialogShowTabButton" class="browser-control-action secondary"[^>]*\shidden[^>]*data-control-help="show-tab"/);
  assert.match(html, /id="browserControlDialogShowTabButton"[\s\S]*?id="browserControlAuthorizeButton"[\s\S]*?id="browserControlAttachButton"[\s\S]*?id="browserControlOffButton"[\s\S]*?id="browserControlPauseButton"[\s\S]*?id="browserControlStopButton"/);
});

test('Phase 6 enable and detach use install-declared debugger access without runtime permission prompts', () => {
  assert.match(source, /browserControlEnableButton.*addEventListener\('click'/s);
  assert.doesNotMatch(source, /permissions\?\.request\(\{\s*permissions:\s*\['debugger'\]\s*\}\)/s);
  assert.doesNotMatch(source, /permissions\?\.remove\(\{\s*permissions:\s*\['debugger'\]\s*\}\)/s);
  assert.match(html, /grants this extension debugger access when it is installed or updated/i);
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

test('Hermes Control never switches the tab on its own: status refresh is read-only and only the Show tab click moves a tab', () => {
  const refreshStart = source.indexOf('async function refreshBrowserControlStatus()');
  const refreshEnd = source.indexOf('\nfunction scheduleBrowserControlPoll()', refreshStart);
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart, 'refreshBrowserControlStatus is present');
  assert.doesNotMatch(source.slice(refreshStart, refreshEnd), /tabs\.update|windows\.update|followTargetTabId/);

  const handlerStart = source.indexOf('async function showBrowserControlTab()');
  const handlerEnd = source.indexOf('\n}\n', handlerStart) + 3;
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'the Show tab handler is present');
  const moves = [...source.matchAll(/\b(?:tabs|windows)\.update\(/g)].map((match) => match.index);
  assert.equal(moves.length, 2, 'the panel has exactly one tab move and one window focus');
  for (const index of moves) {
    assert.ok(index > handlerStart && index < handlerEnd, `a tab or window update at ${index} sits outside the Show tab handler`);
  }
  assert.match(source.slice(handlerStart, handlerEnd), /browserApi\.tabs\.update\(tabId,\s*\{\s*active:\s*true\s*\}\)/);
  assert.match(source.slice(handlerStart, handlerEnd), /browserApi\.windows\.update\(targetWindowId,\s*\{\s*focused:\s*true\s*\}\)/);
  assert.match(source.slice(handlerStart, handlerEnd), /toast_show_tab_failed/);
  assert.doesNotMatch(source.slice(handlerStart, handlerEnd), /browserControlStatus\s*=\s*null|refreshBrowserControlStatus|browser_control\.error_attach_reconnecting/);
  assert.match(source, /\[els\.browserControlShowTabButton, els\.browserControlDialogShowTabButton\]/);
});

test('Show tab draws the tab it switched to from that tab\'s real target, so the strip never flashes reconnecting', () => {
  const handlerStart = source.indexOf('async function showBrowserControlTab()');
  const handlerEnd = source.indexOf('\n}\n', handlerStart) + 3;
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'the Show tab handler is present');
  const handler = source.slice(handlerStart, handlerEnd);
  // The new tab is leased, so its target is resolved with the same message and candidate the status refresh uses.
  assert.match(handler, /browserControlStatus\?\.leasedTabIds\?\.some\(/);
  assert.match(handler, /browserControlCandidate\(\{[\s\S]*?scope: \{ mode: CONTEXT_SCOPE_MODES\.ACTIVE_TAB \}/);
  // Its own try/catch: a failed resolve leaves the target empty and never fails the switch.
  assert.match(handler, /try \{\s*nextTarget = await browserControlMessage\('HERMES_CONTROLLER_TARGET_RESOLVE', candidate\);\s*\} catch \{\s*nextTarget = null;\s*\}/);
  // The active tab and its target are set together, and only then does the panel draw.
  assert.match(handler, /browserControlActiveTab = nextActiveTab;\s*browserControlCurrentTarget = nextTarget;\s*renderBrowserControl\(\);\s*\}\s*$/);
  assert.equal(handler.match(/renderBrowserControl\(\)/g)?.length, 1, 'the handler draws once, after the target is known');
  assert.ok(handler.indexOf('HERMES_CONTROLLER_TARGET_RESOLVE') < handler.indexOf('renderBrowserControl()'));
  // Never a status refresh or a null status here: that is what made the strip show RECONNECTING.
  assert.doesNotMatch(handler, /refreshBrowserControlStatus|browserControlStatus\s*=/);
});

test('Show tab takes its target from a fresh status read, falling back to the rendered target if that read fails', () => {
  const handlerStart = source.indexOf('async function showBrowserControlTab()');
  const handlerEnd = source.indexOf('\n}\n', handlerStart) + 3;
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'the Show tab handler is present');
  const handler = source.slice(handlerStart, handlerEnd);
  // The status is read at press time, in its own try/catch, and the target follows the strip's own rule.
  assert.match(handler, /try \{\s*const freshStatus = await browserControlMessage\('HERMES_CONTROLLER_STATUS'\);\s*const shownTab = await activeTab\(\)\.catch\(\(\) => browserControlActiveTab\);/);
  assert.match(handler, /tabId = showTabTargetId\(\{\s*status: freshStatus && typeof freshStatus === 'object' \? freshStatus : \(browserControlStatus \|\| \{\}\),\s*activeTabId: shownTab\?\.id,\s*\}\);/);
  // On failure the rendered target stands; a null target still does nothing.
  assert.match(handler, /\} catch \{\s*tabId = browserControlShowTabId;\s*\}\s*if \(!Number\.isInteger\(tabId\) \|\| tabId <= 0\) return;/);
  // The fresh read happens before anything moves, and the shared status is never reassigned here.
  assert.ok(handler.indexOf('HERMES_CONTROLLER_STATUS') < handler.indexOf('browserApi.tabs.update(tabId'));
  assert.doesNotMatch(handler, /browserControlStatus\s*=(?!=)/);
});

test('Phase 6 control UI reuses theme tokens, stays square, and has reduced-motion-safe feedback', () => {
  assert.match(css, /\.browser-control-card\s*\{/);
  assert.match(css, /\.browser-control-strip\s*\{/);
  assert.match(css, /\.browser-control-card[\s\S]*?border-radius:\s*var\(--radius\)/);
  assert.match(css, /\.browser-control-action:active[\s\S]*?scale\(0\.97\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?\.browser-control-action/s);
});

test('Hermes Control settings use a readable single-column hierarchy with proportional controls', () => {
  assert.match(html, /class="browser-control-config"[\s\S]*?class="browser-control-field"/);
  assert.match(css, /\.browser-control-config\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(css, /browser-control-view/);
  assert.match(css, /\.browser-control-card-head p[\s\S]*?font:\s*calc\(11px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.45/s);
  assert.match(css, /\.browser-control-action\s*\{[^}]*min-height:\s*38px/s);
  assert.match(css, /\.browser-control-card-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test('Hermes Control shows its status as a light in the title row, after the heading and before the close button', () => {
  const titlebar = html.indexOf('class="browser-control-titlebar"');
  const heading = html.indexOf('id="browserControlDialogTitle"');
  const light = html.indexOf('id="browserControlLight"');
  const close = html.indexOf('id="browserControlDismissButton"');
  const strip = html.indexOf('id="browserControlStrip"');
  assert.ok(titlebar > 0 && heading > titlebar && light > heading && close > light && strip > close);
  assert.doesNotMatch(html, /THIS TAB IS READY|browser-control-live-indicator/);
  assert.match(html, /id="browserControlLight"[^>]*tabindex="0"/);
  assert.match(html, /id="browserControlLight"[^>]*data-control-help="status"/);
  assert.match(source, /browserControlLightState\(view, \{ paused \}\)/);
  assert.match(source, /dataset\.attention = String\(view\.attention === true\)/);
});

test('Phase 6 approval reason remains fully readable in narrow Browser panels', () => {
  assert.match(css, /\.browser-control-strip-copy span\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /@media \(max-width:\s*560px\)[\s\S]*?\.browser-control-strip\s*\{[^}]*grid-template-columns:\s*32px minmax\(0,\s*1fr\)[^}]*\}[^}]*\.[\s\S]*?grid-column:\s*2/s);
});

test('local document approval does not leak attach failures as uncaught rejections', () => {
  const handler = source.match(/localDocumentApproveButton\?\.addEventListener\('click', async \(\) => \{[\s\S]*?\n {2}\}\);/)?.[0] || '';
  assert.match(handler, /try \{/);
  assert.match(handler, /attachBrowserControlToCurrentTab\(\)/);
  assert.match(handler, /catch \(error\)/);
  assert.match(handler, /t\('browser_control\.toast_attach_failed'\)/);
});

test('startup Connect button uses the theme primary tokens so it stays readable in every theme and mode', () => {
  const button = css.match(/body\.startup-active \.startup-actions #startupConnectButton:not\(\[hidden\]\)\s*\{[^}]*\}/)?.[0] || '';
  assert.match(button, /background:\s*var\(--hermes-primary-bg\)/);
  assert.match(button, /color:\s*var\(--hermes-primary-fg\)/);
  assert.match(button, /border-color:\s*var\(--hermes-primary-border\)/);
  assert.doesNotMatch(button, /#[0-9a-fA-F]{3,6}/);
  assert.doesNotMatch(button, /var\(--hermes-accent\)/);
});
