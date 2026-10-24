import assert from 'node:assert/strict';
import test from 'node:test';

async function phase6() {
  try {
    return await import('../extension/lib/browser-control-safety.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control safety module is required: ${error?.message || error}`);
  }
}

test('Phase 6 classifies ordinary reads and writes without trusting caller-supplied risk', async () => {
  const {
    BROWSER_CONTROL_RISKS,
    classifyBrowserControlAction,
  } = await phase6();

  assert.equal(classifyBrowserControlAction({ action: 'browser_snapshot' }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_scroll', arguments: { direction: 'down' } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_click', target: { role: 'button', name: 'Search' } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_hover', target: { role: 'button', name: 'Search' } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_scroll_to', target: { role: 'button', name: 'Search' } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_type', arguments: { text: 'ordinary search terms' }, target: { role: 'textbox', name: 'Search' } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_drag', target: { role: 'slider', name: 'Volume' } }).risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(classifyBrowserControlAction({ action: 'browser_click', arguments: { x: 20, y: 30 } }).risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(classifyBrowserControlAction({ action: 'browser_tab_create', arguments: { url: 'https://example.test/new' } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_tab_group', arguments: { tab_ids: [7, 8] } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_tab_ungroup', arguments: { tab_ids: [7, 8] } }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(classifyBrowserControlAction({ action: 'browser_tab_close', arguments: { tab_id: 7 } }).risk, BROWSER_CONTROL_RISKS.APPROVAL);
  // Switching the tab the person is looking at needs their approval, wherever the current page is.
  const activate = classifyBrowserControlAction({ action: 'browser_tab_activate', arguments: { tab_id: 7 } });
  assert.deepEqual(activate, { risk: BROWSER_CONTROL_RISKS.APPROVAL, reason: 'tab-activate' });
  assert.deepEqual(classifyBrowserControlAction({
    action: 'browser_tab_activate',
    arguments: { tab_id: 7 },
    currentUrl: 'chrome://settings/',
  }), { risk: BROWSER_CONTROL_RISKS.APPROVAL, reason: 'tab-activate' });

  const spoofed = classifyBrowserControlAction({
    action: 'browser_press',
    arguments: { key: 'Enter' },
    claimedRisk: 'safe',
  });
  assert.equal(spoofed.risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(spoofed.reason, 'submission-key');

  for (const key of ['Control+Enter', 'Shift+Return', 'Meta+Enter', 'enter']) {
    assert.equal(
      classifyBrowserControlAction({ action: 'browser_press', arguments: { key } }).reason,
      'submission-key',
      `${key} submits, so it needs approval like Enter`,
    );
  }
  for (const args of [{ key: 'Control+v' }, { key: 'Meta+V' }, { key: 'Control+Shift+v' }, { key: 'Shift+Insert' }, { key: 'v', modifiers: ['Meta'] }, { key: 'Insert', modifiers: ['Shift'] }]) {
    assert.equal(
      classifyBrowserControlAction({ action: 'browser_press', arguments: args }).reason,
      'clipboard-paste',
      `${JSON.stringify(args)} pastes the user's clipboard, so it needs approval`,
    );
  }
  for (const key of ['Control+a', 'Shift+Tab', 'ArrowDown', 'Escape', 'v', 'Control+c']) {
    assert.equal(classifyBrowserControlAction({ action: 'browser_press', arguments: { key } }).risk, BROWSER_CONTROL_RISKS.SAFE, key);
  }
});

test('Phase 6 pauses destructive actions and hard-blocks payment, credential, MFA, and secret handling', async () => {
  const {
    BROWSER_CONTROL_RISKS,
    classifyBrowserControlAction,
  } = await phase6();

  for (const name of ['Delete account', 'Publish post', 'Send message', 'Merge pull request', 'Deploy production']) {
    const decision = classifyBrowserControlAction({ action: 'browser_click', target: { role: 'button', name } });
    assert.equal(decision.risk, BROWSER_CONTROL_RISKS.APPROVAL, name);
  }

  for (const target of [
    { role: 'textbox', name: 'Password', inputType: 'password' },
    { role: 'textbox', name: 'Verification code', autocomplete: 'one-time-code' },
    { role: 'textbox', name: 'Credit card number', autocomplete: 'cc-number' },
    { role: 'textbox', name: 'API token' },
  ]) {
    const decision = classifyBrowserControlAction({
      action: 'browser_type',
      arguments: { text: 'fixture value' },
      target,
    });
    assert.equal(decision.risk, BROWSER_CONTROL_RISKS.BLOCKED, target.name);
    assert.match(decision.reason, /sensitive|credential|payment|mfa/i);
  }

  const embeddedSecret = classifyBrowserControlAction({
    action: 'browser_type',
    arguments: { text: ['sk', 'fixture', '0123456789abcdef'].join('-') },
    target: { role: 'textbox', name: 'Comment' },
  });
  assert.equal(embeddedSecret.risk, BROWSER_CONTROL_RISKS.BLOCKED);
  assert.equal(embeddedSecret.reason, 'secret-text');
});

test('Phase 6 navigation permits ordinary HTTP(S), pauses cross-origin unsaved navigation, and blocks restricted surfaces', async () => {
  const {
    BROWSER_CONTROL_RISKS,
    classifyBrowserControlAction,
    validateBrowserControlUrl,
  } = await phase6();

  assert.deepEqual(validateBrowserControlUrl('https://example.test/docs?q=public'), {
    ok: true,
    url: 'https://example.test/docs?q=public',
    origin: 'https://example.test',
  });
  for (const url of [
    'chrome://settings',
    'moz-extension://fixture/page.html',
    'file:///C:/Users/Jaybo/secret.txt',
    'data:text/html,hello',
    'view-source:https://example.test',
    'https://example.test/account/wallet',
    'https://example.test/docs?api_key=fixture-secret-value',
  ]) {
    const result = validateBrowserControlUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.error, 'restricted_url', url);
  }

  const sameOrigin = classifyBrowserControlAction({
    action: 'browser_navigate',
    arguments: { url: 'https://example.test/next' },
    currentUrl: 'https://example.test/start',
    hasUnsavedContent: true,
  });
  assert.equal(sameOrigin.risk, BROWSER_CONTROL_RISKS.SAFE);

  const crossOrigin = classifyBrowserControlAction({
    action: 'browser_navigate',
    arguments: { url: 'https://other.test/next' },
    currentUrl: 'https://example.test/start',
    hasUnsavedContent: true,
  });
  assert.equal(crossOrigin.risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(crossOrigin.reason, 'cross-origin-unsaved-content');
});

test('Phase 6 blocks reads and mutations on a restricted current page while allowing safe navigation away', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();
  const currentUrl = 'https://example.test/account/wallet';
  for (const action of [
    'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_scroll', 'browser_back',
  ]) {
    const result = classifyBrowserControlAction({
      action,
      arguments: action === 'browser_press' ? { key: 'ArrowDown' } : {},
      target: { role: 'button', name: 'Continue' },
      currentUrl,
    });
    assert.equal(result.risk, BROWSER_CONTROL_RISKS.BLOCKED, action);
    assert.equal(result.reason, 'restricted_current_page', action);
  }
  assert.equal(classifyBrowserControlAction({
    action: 'browser_navigate',
    arguments: { url: 'https://example.test/docs' },
    currentUrl,
  }).risk, BROWSER_CONTROL_RISKS.SAFE);
});

test('Phase 6 approval grants are exact, short-lived, single-use, and action-bound', async () => {
  const { createBrowserControlApprovalStore } = await phase6();
  let now = 1_000;
  const approvals = createBrowserControlApprovalStore({ now: () => now, ttlMs: 5_000, maxEntries: 4 });
  const grant = approvals.grant({
    approvalId: 'approval-1',
    commandId: 'command-1',
    tabId: 7,
    documentGeneration: 3,
    action: 'browser_press',
  });
  assert.equal(grant.ok, true);
  assert.equal(approvals.consume({
    approvalId: 'approval-1',
    commandId: 'command-1',
    tabId: 7,
    documentGeneration: 3,
    action: 'browser_press',
  }).ok, true);
  assert.equal(approvals.consume({
    approvalId: 'approval-1',
    commandId: 'command-1',
    tabId: 7,
    documentGeneration: 3,
    action: 'browser_press',
  }).error, 'approval_missing');

  approvals.grant({ approvalId: 'approval-2', commandId: 'command-2', tabId: 7, documentGeneration: 3, action: 'browser_click' });
  assert.equal(approvals.consume({ approvalId: 'approval-2', commandId: 'other', tabId: 7, documentGeneration: 3, action: 'browser_click' }).error, 'approval_mismatch');
  now += 6_000;
  assert.equal(approvals.consume({ approvalId: 'approval-2', commandId: 'command-2', tabId: 7, documentGeneration: 3, action: 'browser_click' }).error, 'approval_expired');
});

test('Phase 6 approval requests bind controller lease generation nonce and paused state exactly', async () => {
  const { createBrowserControlApprovalStore } = await phase6();
  const approvals = createBrowserControlApprovalStore({ now: () => 1_000 });
  const exact = {
    approvalId: 'approval-scoped',
    approvalNonce: 'nonce-scoped',
    commandId: 'command-scoped',
    controllerId: 'controller-scoped',
    leaseId: 'lease-scoped',
    leaseGeneration: 4,
    tabId: 7,
    documentGeneration: 3,
    action: 'browser_press',
    state: 'paused',
  };
  const waiting = approvals.request(exact);
  assert.equal(approvals.grant({ ...exact, controllerId: 'other-controller' }).error, 'approval_mismatch');
  assert.equal(approvals.grant({ ...exact, leaseGeneration: 5 }).error, 'approval_mismatch');
  assert.equal(approvals.grant(exact).ok, true);
  assert.equal((await waiting).ok, true);
  assert.equal(approvals.consume(exact).ok, true);
  assert.equal((await approvals.request(exact)).error, 'approval_replayed');
});

test('Phase 8 privileged actions pause for approval or demand exact arguments', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();

  assert.equal(classifyBrowserControlAction({ action: 'browser_console' }).risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(classifyBrowserControlAction({ action: 'browser_network_requests' }).risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(classifyBrowserControlAction({ action: 'browser_pdf' }).risk, BROWSER_CONTROL_RISKS.APPROVAL);

  const body = classifyBrowserControlAction({ action: 'browser_response_body' });
  assert.equal(body.risk, BROWSER_CONTROL_RISKS.BLOCKED);
  assert.equal(body.reason, 'request-id-required');
  assert.equal(classifyBrowserControlAction({
    action: 'browser_response_body',
    arguments: { request_id: 'req-1' },
  }).risk, BROWSER_CONTROL_RISKS.APPROVAL);

  const upload = classifyBrowserControlAction({ action: 'browser_upload' });
  assert.equal(upload.risk, BROWSER_CONTROL_RISKS.BLOCKED);
  assert.equal(upload.reason, 'artifact-id-required');
  assert.equal(classifyBrowserControlAction({
    action: 'browser_upload',
    arguments: { artifact_id: 'artifact-1' },
  }).risk, BROWSER_CONTROL_RISKS.APPROVAL);

  const evaluateNoDev = classifyBrowserControlAction({
    action: 'browser_evaluate',
    arguments: { code: '1 + 1' },
  });
  assert.equal(evaluateNoDev.risk, BROWSER_CONTROL_RISKS.BLOCKED);
  assert.equal(evaluateNoDev.reason, 'developer-mode-required');
  const evaluateDev = classifyBrowserControlAction({
    action: 'browser_evaluate',
    arguments: { code: '1 + 1' },
    developerMode: true,
  });
  assert.equal(evaluateDev.risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(evaluateDev.reason, 'evaluate-code');
  assert.equal(classifyBrowserControlAction({
    action: 'browser_evaluate',
    arguments: {},
    developerMode: true,
  }).reason, 'code-required');

  const cdpNoDev = classifyBrowserControlAction({ action: 'browser_cdp', arguments: { method: 'Runtime.getHeapUsage' } });
  assert.equal(cdpNoDev.risk, BROWSER_CONTROL_RISKS.BLOCKED);
  assert.equal(cdpNoDev.reason, 'developer-mode-required');
  assert.equal(classifyBrowserControlAction({
    action: 'browser_cdp',
    arguments: { method: 'Runtime.getHeapUsage' },
    developerMode: true,
  }).reason, 'cdp-command');

  const dialogBenign = classifyBrowserControlAction({
    action: 'browser_dialog',
    arguments: { accept: true, message: 'Continue?' },
  });
  assert.equal(dialogBenign.risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(dialogBenign.reason, 'dialog-action');
  const dialogConsequential = classifyBrowserControlAction({
    action: 'browser_dialog',
    arguments: { accept: true, message: 'Delete all data permanently?' },
  });
  assert.equal(dialogConsequential.risk, BROWSER_CONTROL_RISKS.APPROVAL);
  assert.equal(dialogConsequential.reason, 'dialog-consequence');
});

test('Phase 8 privileged actions stay blocked on restricted pages even in developer mode', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();
  const currentUrl = 'https://example.test/account/wallet';
  for (const action of [
    'browser_console', 'browser_network_requests', 'browser_response_body',
    'browser_pdf', 'browser_upload', 'browser_evaluate', 'browser_cdp', 'browser_dialog',
  ]) {
    const result = classifyBrowserControlAction({
      action,
      arguments: { request_id: 'req-1', artifact_id: 'artifact-1', code: '1', method: 'X' },
      currentUrl,
      developerMode: true,
    });
    assert.equal(result.risk, BROWSER_CONTROL_RISKS.BLOCKED, action);
    assert.equal(result.reason, 'restricted_current_page', action);
  }
});

test('Phase 8 approval grants bind artifact ids so upload approvals are single-artifact', async () => {
  const { createBrowserControlApprovalStore } = await phase6();
  const approvals = createBrowserControlApprovalStore({ now: () => 1_000 });
  const exact = {
    approvalId: 'approval-upload',
    commandId: 'command-upload',
    controllerId: 'controller-upload',
    leaseId: 'lease-upload',
    leaseGeneration: 1,
    tabId: 7,
    documentGeneration: 3,
    action: 'browser_upload',
    state: 'paused',
    binding: 'artifact-42',
  };
  const waiting = approvals.request(exact);
  assert.equal(approvals.grant({ ...exact, binding: 'artifact-43' }).error, 'approval_mismatch');
  assert.equal(approvals.grant(exact).ok, true);
  assert.equal((await waiting).ok, true);
  assert.deepEqual(approvals.consume({ ...exact, binding: 'artifact-41' }), { ok: false, error: 'approval_mismatch' });
  assert.deepEqual(approvals.consume(exact), { ok: true, approvalId: 'approval-upload', binding: 'artifact-42' });
});

// The classifier reads a key request the way the adapter dispatches it: spaces and tabs
// around "+", letter case and the modifiers list change nothing about what is judged.
test('browser_press classifies every spelling of a submit or paste shortcut the adapter would send', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();
  const reasonOf = (args) => classifyBrowserControlAction({ action: 'browser_press', arguments: args, focused: { role: '', name: '', inputType: '' } });

  for (const key of ['Control+ Enter', 'Control+\tEnter', 'Control + Enter', ' Control+Enter ', 'CTRL+ENTER', 'Shift+ Return', 'Meta+  Enter', 'Control+NumpadEnter', 'NumpadEnter']) {
    assert.deepEqual(reasonOf({ key }).reason, 'submission-key', JSON.stringify(key));
  }
  assert.equal(reasonOf({ key: 'Enter', modifiers: ['Control'] }).reason, 'submission-key');
  for (const args of [
    { key: 'Control+ v' }, { key: 'Meta+ v' }, { key: 'Shift+ Insert' }, { key: 'Ctrl + v' }, { key: 'CONTROL+V' },
    { key: 'Control+Shift+ V' }, { key: 'Cmd+\tv' }, { key: 'Command + V' }, { key: ' v', modifiers: ['ctrl'] },
    { key: 'Control+KeyV' }, { key: 'Insert', modifiers: [' shift '] },
  ]) {
    assert.equal(reasonOf(args).reason, 'clipboard-paste', JSON.stringify(args));
  }
  for (const args of [{ key: 'Control+ a' }, { key: 'Shift+ Tab' }, { key: 'Control + c' }, { key: 'Alt+ArrowLeft' }, { key: 'v' }, { key: ' Insert' }]) {
    assert.equal(reasonOf(args).risk, BROWSER_CONTROL_RISKS.SAFE, JSON.stringify(args));
  }
});

test('browser_press fails closed on a key it cannot read', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();
  for (const args of [{}, { key: '' }, { key: '   ' }, { key: 'Hyper+a' }, { key: 'Control+Hyper+Enter' }, { key: 'a', modifiers: ['Hyper'] }, { key: 'Enter', modifiers: ['Mod'] }]) {
    const decision = classifyBrowserControlAction({ action: 'browser_press', arguments: args });
    assert.equal(decision.risk, BROWSER_CONTROL_RISKS.BLOCKED, JSON.stringify(args));
    assert.equal(decision.reason, 'invalid-key');
  }
});

test('Space presses whatever has focus, so it is judged as the click it is', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();
  const press = (key, focused) => classifyBrowserControlAction({ action: 'browser_press', arguments: { key }, focused });

  // A focused button with a consequential label needs the same approval as clicking it.
  for (const key of ['Space', ' ', 'space', 'Shift+Space']) {
    const decision = press(key, { role: 'button', name: 'Delete account', inputType: '' });
    assert.deepEqual(decision, { risk: BROWSER_CONTROL_RISKS.APPROVAL, reason: 'consequential-action' }, key);
  }
  assert.equal(press(' ', { role: 'checkbox', name: 'Subscribe to the newsletter', inputType: 'checkbox' }).reason, 'consequential-action');
  assert.equal(press(' ', { role: 'button', name: 'Pay now', inputType: 'submit' }).reason, 'consequential-action');
  // Harmless controls, text fields and the bare page stay free.
  assert.equal(press(' ', { role: 'button', name: 'Open menu', inputType: '' }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(press(' ', { role: 'textbox', name: 'Send a message to the team', inputType: 'text' }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(press(' ', { role: '', name: '', inputType: '' }).risk, BROWSER_CONTROL_RISKS.SAFE);
  // Other keys are not an activation, whatever has focus.
  assert.equal(press('ArrowDown', { role: 'button', name: 'Delete account', inputType: '' }).risk, BROWSER_CONTROL_RISKS.SAFE);
  assert.equal(press('Control+ ', { role: 'button', name: 'Delete account', inputType: '' }).risk, BROWSER_CONTROL_RISKS.SAFE);
  // Focus that could not be read: Space might activate anything, so it asks.
  assert.deepEqual(press(' ', undefined), { risk: BROWSER_CONTROL_RISKS.APPROVAL, reason: 'activation-key' });
  assert.equal(press('Tab', undefined).risk, BROWSER_CONTROL_RISKS.SAFE);
});

test('a key that types or acts, pressed while an embedded frame has focus, asks first', async () => {
  const { BROWSER_CONTROL_RISKS, classifyBrowserControlAction } = await phase6();
  const inFrame = { role: 'frame', name: 'Payment', inputType: '', inFrame: true };
  const press = (args, focused = inFrame) => classifyBrowserControlAction({ action: 'browser_press', arguments: args, focused });

  for (const args of [{ key: 'a' }, { key: '4' }, { key: 'Backspace' }, { key: 'Delete' }, { key: ' ' }, { key: 'Control+a' }, { key: 'Alt+ArrowLeft' }]) {
    assert.deepEqual(press(args), { risk: BROWSER_CONTROL_RISKS.APPROVAL, reason: 'framed-focus' }, JSON.stringify(args));
  }
  // Moving around, or leaving, writes nothing into the frame.
  for (const key of ['Tab', 'Shift+Tab', 'Escape', 'ArrowDown', 'PageDown', 'Home', 'F5']) {
    assert.equal(press({ key }).risk, BROWSER_CONTROL_RISKS.SAFE, key);
  }
  // Enter and paste keep their own reasons; focus outside a frame is as before.
  assert.equal(press({ key: 'Enter' }).reason, 'submission-key');
  assert.equal(press({ key: 'Control+v' }).reason, 'clipboard-paste');
  assert.equal(press({ key: 'a' }, { role: 'textbox', name: 'Search', inputType: 'text' }).risk, BROWSER_CONTROL_RISKS.SAFE);
});
