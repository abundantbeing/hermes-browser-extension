import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalPrompt } from '../extension/lib/browser-control-executor.mjs';
import { formatBrowserControlApprovalReason } from '../extension/lib/browser-control-ui.mjs';

test('page-changing cards name the action and target, never the typed value', () => {
  const click = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_click',
    target: { role: 'button', name: 'Continue' },
  });
  assert.equal(click.reason, 'Click "Continue"? It may change the page.');
  assert.equal(click.reasonKey, 'browser_control.approval.click');
  assert.deepEqual(click.reasonParams, { name: 'Continue' });

  const fill = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_fill',
    arguments: { value: 'super-secret-password' },
    target: { role: 'textbox', name: 'Username' },
  });
  assert.equal(fill.reason, 'Fill "Username"? It may change the page.');
  assert.equal(fill.reasonKey, 'browser_control.approval.fill');
  assert.doesNotMatch(JSON.stringify(fill), /super-secret-password/);

  const type = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_type',
    arguments: { text: 'token=abc123' },
    target: { name: 'Search' },
  });
  assert.equal(type.reason, 'Type into "Search"? It may change the page.');
  assert.doesNotMatch(JSON.stringify(type), /token=abc123/);

  const unlabelled = approvalPrompt({
    reason: 'unlabelled-target',
    action: 'browser_click',
    target: { role: 'button', name: '' },
  });
  assert.equal(unlabelled.reason, 'Click a control Hermes could not name?');
  assert.equal(unlabelled.reasonKey, 'browser_control.approval.click_unlabelled');
});

test('navigation and tab cards show a redacted URL, not credentials', () => {
  const navigate = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_navigate',
    arguments: { url: 'https://example.test/next' },
  });
  assert.equal(navigate.reason, 'Open https://example.test/next? It may change the page.');
  assert.equal(navigate.reasonKey, 'browser_control.approval.navigate');

  const secret = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_tab_create',
    arguments: { url: 'https://user:hunter2@example.test/private' },
  });
  assert.equal(secret.reasonKey, 'browser_control.approval.tab_create');
  assert.doesNotMatch(secret.reason, /hunter2|user:/);
  assert.doesNotMatch(JSON.stringify(secret.reasonParams), /hunter2|user:/);
  assert.match(secret.reason, /example\.test/);
  assert.match(secret.reason, /omitted by privacy guard|Open a new tab to /);
});

test('key-press page-changing and consequential prompts keep a translatable key', () => {
  const page = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_press',
    arguments: { key: ' ' },
    focused: { role: 'button', name: 'Open menu' },
  });
  assert.equal(page.reason, 'Press Space while "Open menu" (button) has focus? It may change the page.');
  assert.equal(page.reasonKey, 'browser_control.approval.press_page_changing');
  assert.deepEqual(page.reasonParams, { key: 'Space', label: '"Open menu" (button)' });

  const consequential = approvalPrompt({
    reason: 'consequential-action',
    action: 'browser_press',
    arguments: { key: ' ' },
    focused: { role: 'button', name: 'Delete account' },
  });
  assert.equal(consequential.reason, 'Press Space while "Delete account" (button) has focus? It acts like clicking it.');
  assert.equal(consequential.reasonKey, 'browser_control.approval.press_consequential');
});

test('the panel formats a translated preview and batch prefix from keys, not a baked English sentence', () => {
  const messages = {
    'browser_control.approval.click': 'Klick "{name}"?',
    'browser_control.approval.step_prefix': 'Schritt {current} von {total}:',
  };
  const t = (key, params = {}) => String(messages[key] || key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : `{${name}}`
  ));
  const line = formatBrowserControlApprovalReason({
    reason: 'Step 2 of 3: Click "Continue"? It may change the page.',
    reasonKey: 'browser_control.approval.click',
    reasonParams: { name: 'Continue' },
    stepNumber: 2,
    stepTotal: 3,
  }, { t, translateText: (value) => value });
  assert.equal(line, 'Schritt 2 von 3: Klick "Continue"?');
});

test('a page-controlled name cannot reverse the approval warning with a bidi mark', () => {
  const click = approvalPrompt({
    reason: 'page-changing-action',
    action: 'browser_click',
    target: { role: 'button', name: 'Continue\u202E' },
  });
  assert.doesNotMatch(click.reason, /\u202E/);
  assert.doesNotMatch(JSON.stringify(click.reasonParams), /\u202E/);
  assert.equal(click.reasonParams.name, 'Continue');
  assert.match(click.reason, /It may change the page\.$/);
});

test('a background-task approval names the task tab in the translated line', () => {
  const messages = {
    'browser_control.approval.click': 'Klick "{name}"?',
    'browser_control.approval.background_task': 'Hintergrund-Tab {tab}: {reason}',
  };
  const t = (key, params = {}) => String(messages[key] || key).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : `{${name}}`
  ));
  const line = formatBrowserControlApprovalReason({
    controllerId: 'background-test',
    tabId: 21,
    reason: 'Click "Continue"? It may change the page.',
    reasonKey: 'browser_control.approval.click',
    reasonParams: { name: 'Continue' },
  }, { t, translateText: (value) => value });
  assert.equal(line, 'Hintergrund-Tab 21: Klick "Continue"?');
});
