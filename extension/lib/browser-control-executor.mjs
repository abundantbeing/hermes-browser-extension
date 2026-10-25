import {
  BROWSER_CONTROL_RISKS,
  classifyBrowserControlAction,
} from './browser-control-safety.mjs';
import { redactSensitiveText } from './browser-context-protocol.mjs';
import { redactSensitiveTextWithCount } from './content-extraction-core.mjs';
import { hasCredentialBearingUrl } from './redaction.mjs';
import {
  base64ToBytes,
} from './browser-control-artifacts.mjs';
import { MAX_INLINE_SCREENSHOT_CHARS } from './screenshot-limits.mjs';
import { renderControlSnapshot, SNAPSHOT_VIEW_BUDGETS } from './browser-control-snapshot-view.mjs';

const MAX_RESULT_TEXT = 100_000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_ENTRY_CHARS = 2_000;
const MAX_NETWORK_REQUESTS = 100;
const MAX_RESPONSE_BODY_CHARS = 100_000;
const RESPONSE_BODY_MIME_RE = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|javascript|xml|xhtml\+xml|problem\+json))(?:;|$)/i;
const CDP_DENY_METHOD_PREFIXES = ['Browser.', 'Target.', 'SystemInfo.', 'Tracing.', 'Memory.', 'Debugger.'];
const CDP_DENY_METHODS = new Set([
  'Page.close',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.reload',
  'Page.setWebLifecycleState',
  'Runtime.evaluate',
  'Runtime.terminateExecution',
]);

// Actions that change the page and therefore return fresh page state.
const POST_ACTION_ACTIONS = new Set([
  'browser_navigate', 'browser_back', 'browser_click', 'browser_type', 'browser_fill', 'browser_select',
  'browser_press', 'browser_scroll', 'browser_scroll_to', 'browser_hover',
]);
// Probes that only need the tab URL, not the unsaved-content page script.
const URL_ONLY_PROBE_ACTIONS = new Set(['browser_snapshot', 'browser_scroll', 'browser_screenshot', 'browser_back']);
const APPROVALS_RECHECK_ACTIONS = new Set(['browser_click', 'browser_drag', 'browser_fill', 'browser_press', 'browser_select', 'browser_type']);
// The broker cancels a command at 30 s; the approval wait must end first.
const APPROVAL_WAIT_CAP_MS = 28_000;
const APPROVAL_TIMEOUT_MESSAGE = 'Waiting for your approval in the Hermes panel timed out.';
const POST_ACTION_SETTLE_MS = 1_200;
const POST_ACTION_MIN_BUDGET_MS = 250;
const POST_ACTION_DEADLINE_MARGIN_MS = 400;
const GENERATION_POLL_MS = 25;
const GENERATION_MAX_POLLS = 20;

// browser_batch runs a short list of ordinary actions as one command. Tab
// management, screenshots, raw snapshots and the developer actions stay out:
// a mid-batch snapshot would re-mint every ref the later steps rely on, and
// the batch already ends with exactly one snapshot.
const BATCH_MAX_STEPS = 20;
const BATCH_STEP_ACTIONS = new Set([
  'browser_back', 'browser_click', 'browser_drag', 'browser_fill', 'browser_hover', 'browser_navigate',
  'browser_press', 'browser_scroll', 'browser_scroll_to', 'browser_select', 'browser_type',
]);
// No new step starts when less than this is left of the command budget, so the
// closing snapshot always has room.
const BATCH_STEP_RESERVE_MS = 2_000;
// A refused, expired or mismatched approval, or a page that moved away, ends
// the batch even when stop_on_error is off.
const BATCH_FATAL_CODES = new Set([
  'approval_denied', 'approval_cancelled', 'approval_timeout', 'approval_required', 'approval_replayed',
  'approval_mismatch', 'domain_changed', 'stale_document', 'scope_mismatch', 'cancelled',
  'deadline_exceeded', 'deadline_expired', 'controller_paused',
]);

// Adapter errors that carry a model-actionable code keep it; everything else
// is reported as a generic command_error.
const ADAPTER_ERROR_CODES = new Set(['stale_ref', 'navigation_failed', 'tab_hidden', 'restricted_frame', 'not_active_tab', 'restricted_page', 'page_changed']);

const APPROVAL_MESSAGES = Object.freeze({
  'cross-origin-unsaved-content': 'Leave this page while unsaved content may be present?',
  'submission-key': 'Press Enter to submit the current form or message?',
  'activation-key': 'Press Space? It may activate whatever has focus on the page.',
  'framed-focus': 'Press this key inside an embedded frame on the page?',
  'clipboard-paste': 'Paste your clipboard into this page?',
  'consequential-action': 'Run this consequential browser action?',
  'coordinate-click': 'Click these exact viewport coordinates?',
  'drag-action': 'Drag this target to the selected destination?',
  'tab-activate': 'Switch your view to this tab?',
  'tab-close': 'Close this Hermes-owned browser tab?',
  'console-metadata': 'Read console messages from this page?',
  'network-metadata': 'Read network request metadata for this page?',
  'response-body': 'Read the response body for this network request?',
  'pdf-generation': 'Generate a PDF of this page and store it as an artifact?',
  'file-upload': 'Upload the approved artifact to this page?',
  'evaluate-code': 'Run this evaluate code on the page?',
  'cdp-command': 'Send this raw CDP command to the page?',
  'dialog-consequence': 'Approve this page dialog?',
  'dialog-action': 'Handle this page dialog?',
});

// A tab title in an approval card: short enough to read at a glance, ellipsis included.
const TAB_TITLE_MAX_CHARS = 60;

// Whitespace (line breaks included) becomes a space first, then the remaining control
// and format characters (bidi overrides, zero-width marks) are removed, so a page title
// cannot reorder or hide part of the approval sentence.
function tabTitleText(value = '') {
  return compact(String(value ?? '').replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, ''), 500);
}

function truncatedTabTitle(value = '') {
  const title = tabTitleText(value);
  return title.length > TAB_TITLE_MAX_CHARS ? `${title.slice(0, TAB_TITLE_MAX_CHARS - 1).trimEnd()}…` : title;
}

// The host of a URL, with any port, or '' when there is no usable URL.
function tabUrlHost(url = '') {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

// A URL as a title repeats it: without its scheme or trailing slash, lower-cased.
function bareUrlText(value = '') {
  return tabTitleText(value).replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/\/$/, '').toLowerCase();
}

// What a tab-switch approval calls the tab. A loading tab can show its URL as its title,
// and an empty title has nothing to show; then the URL's host stands in. '' when neither exists.
function tabSwitchLabel(title, url) {
  const shown = tabTitleText(title);
  if (shown !== '' && bareUrlText(shown) !== bareUrlText(url)) return truncatedTabTitle(shown);
  const host = tabUrlHost(url);
  return host ? truncatedTabTitle(host) : '';
}

const TIMED_OUT = Symbol('timed-out');

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function compact(value, limit = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function pickResultValue(value = null) {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'value')) return value.value;
  if (Object.hasOwn(value, 'result')) return value.result;
  return value;
}

function safeNetworkUrl(value = '') {
  const url = compact(value, 2_000);
  if (!url) return '';
  if (hasCredentialBearingUrl(url)) {
    try {
      return `${new URL(url).origin}/(omitted by privacy guard)`;
    } catch {
      return '(omitted by privacy guard)';
    }
  }
  return redactSensitiveText(url);
}

function errorOutcome(code, message = '') {
  return {
    ok: false,
    error: {
      code,
      ...(message ? { message } : {}),
    },
  };
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Synchronous SHA-256: the approval store compares keys synchronously, and the
// request must be registered in the same tick the executor builds it.
function sha256Sync(text) {
  const message = new TextEncoder().encode(String(text));
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((message.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (message.length * 8) >>> 0);
  const state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      words[index] = (words[index - 16]
        + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3))
        + words[index - 7]
        + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[index] + words[index]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { state[index] = (state[index] + value) >>> 0; });
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
}

// A short stable fingerprint of text the person is approving. Only the hash is
// stored with the approval, never the text itself.
function fingerprint(text) {
  return sha256Sync(text).slice(0, 32);
}

// What the action is about to put on the page, as a single string to hash.
function approvalValueMaterial(action, args = {}) {
  if (action === 'browser_type') return JSON.stringify(['type', args.text ?? null, args.value ?? null, args.clear ?? null]);
  if (action === 'browser_fill') return JSON.stringify(['fill', args.value ?? null, args.text ?? null]);
  if (action === 'browser_select') return JSON.stringify(['select', args.value ?? null, args.option ?? null, args.index ?? null]);
  if (action === 'browser_press') {
    return JSON.stringify(['press', args.key ?? null, Array.isArray(args.modifiers) ? args.modifiers : null]);
  }
  if (action === 'browser_evaluate') return JSON.stringify(['evaluate', args.code ?? args.expression ?? null]);
  if (action === 'browser_cdp') return JSON.stringify(['cdp', args]);
  return null;
}

// Ties an approval to the exact element and value it was shown for, so a
// grant for one target or one piece of text cannot release a different one.
export function approvalBindingFields(action, args, target, destination) {
  const fields = {};
  if (target?.role || target?.name) {
    fields.targetRole = compact(target.role, 80);
    fields.targetName = compact(target.name, 200);
  }
  if (destination?.role || destination?.name) {
    fields.destination = compact(`${compact(destination.role, 80)}|${compact(destination.name, 200)}`, 280);
  }
  const refs = [target?.ref, destination?.ref].map((ref) => compact(ref, 32)).filter(Boolean);
  if (action === 'browser_upload') {
    fields.binding = compact(args.artifact_id, 200);
  } else {
    const parts = [];
    if (refs.length) parts.push(`ref:${refs.join('>')}`);
    if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) parts.push(`point:${Number(args.x)},${Number(args.y)}`);
    // A switch is bound to the tab it switches to, so a grant covers that tab only.
    if (action === 'browser_tab_activate') parts.push(`tab:${Number(args.tab_id)}`);
    if (parts.length) fields.binding = parts.join(' ');
  }
  const material = approvalValueMaterial(action, args);
  if (material !== null) fields.valueHash = fingerprint(material);
  return fields;
}

function batchStepAction(value) {
  const name = compact(value, 120);
  if (!name) return '';
  return name.startsWith('browser_') ? name : `browser_${name}`;
}

function normalizedScope(value = {}) {
  return {
    controllerId: compact(value.controllerId, 160),
    leaseOwnerId: compact(value.leaseOwnerId, 160),
    leaseId: compact(value.leaseId, 160),
    leaseGeneration: Number(value.leaseGeneration),
    tabId: Number(value.tabId),
    frameId: Math.max(0, Number(value.frameId) || 0),
    documentGeneration: Number(value.documentGeneration),
  };
}

function restrictedPageUrl(url = '', allowLocalDocuments = false) {
  return Boolean(compact(url)) && classifyBrowserControlAction({
    action: 'browser_snapshot', currentUrl: url, allowLocalDocuments,
  }).risk === BROWSER_CONTROL_RISKS.BLOCKED;
}

function pageOrigin(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (['http:', 'https:'].includes(parsed.protocol)) return parsed.origin;
    // Approved local documents: the file itself is the identity. Compare the
    // normalized file path so staying on the same local file passes while
    // navigating to a different local file still trips domain_changed.
    if (parsed.protocol === 'file:') return `file:${parsed.pathname}`;
    return '';
  } catch {
    return '';
  }
}

function frameMatchesScope(frame = {}, scope = {}) {
  return Number(frame.tab_id) === scope.tabId
    && Math.max(0, Number(frame.frame_id) || 0) === scope.frameId
    && Number(frame.document_generation) === scope.documentGeneration
    && Boolean(scope.controllerId)
    && scope.leaseOwnerId === scope.controllerId;
}

function safeResultUrl(value = '') {
  return safeNetworkUrl(value);
}

function safeResultTitle(value = '') {
  return redactSensitiveText(compact(value, 500));
}

// Renders the page into the model-facing view. `refResult` is the output of
// refs.replace for the same nodes, so every ref in the text is actionable.
function safeSnapshotResult(value = {}, refResult = {}, { maxChars, fullText = false } = {}) {
  const view = renderControlSnapshot({
    text: value.text,
    frameText: value.frameText,
    headings: value.headings,
    refs: Array.isArray(refResult.refs) ? refResult.refs : [],
    // The browser may know of more controls than it returned (a child frame cut at its cap).
    element_count: Math.max(Array.isArray(value.nodes) ? value.nodes.length : 0, Math.floor(Number(value.element_count)) || 0),
    truncated: Boolean(value.truncated || refResult.truncated),
  }, { maxChars, fullText });
  return {
    title: safeResultTitle(value.title),
    url: safeResultUrl(value.url),
    text: view.text,
    refs: view.refs,
    truncated: view.truncated,
    element_count: view.element_count,
  };
}

function safeScrollPosition(position = null) {
  if (!position || typeof position !== 'object') return null;
  const numbers = ['scrollX', 'scrollY', 'maxY'].map((key) => Number(position[key]));
  if (!numbers.every(Number.isFinite)) return null;
  return {
    scrollX: numbers[0],
    scrollY: numbers[1],
    maxY: numbers[2],
    atTop: position.atTop === true,
    atBottom: position.atBottom === true,
  };
}

function navigationResult(status, value) {
  const url = safeResultUrl(value?.url);
  const title = safeResultTitle(value?.title);
  return {
    status,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(typeof value?.navigated === 'boolean' ? { navigated: value.navigated } : {}),
    ...(value?.timedOut === true ? { timedOut: true } : {}),
  };
}

function sanitizedActionResult(action, value) {
  if (action === 'browser_type') return { status: 'typed' };
  if (action === 'browser_fill') return { status: 'filled' };
  if (action === 'browser_select') return { status: 'selected' };
  if (action === 'browser_press') return { status: 'pressed' };
  if (action === 'browser_click') return { status: 'clicked', ...(value?.obscured === true ? { obscured: true } : {}) };
  if (action === 'browser_drag') return { status: 'dragged' };
  if (action === 'browser_hover') return { status: 'hovered' };
  if (action === 'browser_scroll') {
    const position = safeScrollPosition(value?.position);
    return { status: 'scrolled', ...(position ? { position } : {}) };
  }
  if (action === 'browser_scroll_to') return { status: 'scrolled-to-target' };
  if (action === 'browser_navigate') {
    return navigationResult(value?.status === 'already-open' ? 'already-open' : 'navigated', value);
  }
  if (action === 'browser_back') return navigationResult('navigated-back', value);
  if (action === 'browser_tab_activate') return { status: 'tab-activated' };
  if (action === 'browser_tab_close') return { status: 'tab-closed' };
  if (action === 'browser_tab_create') {
    const tab = value?.tab || {};
    return { tab: {
      id: Number(tab.id),
      windowId: Number(tab.windowId),
      active: tab.active === true,
      url: compact(tab.url, 2_000),
    } };
  }
  if (action === 'browser_tab_group') return { status: 'tabs-grouped', groupId: Number(value?.groupId) };
  if (action === 'browser_tab_ungroup') return { status: 'tabs-ungrouped' };
  if (action === 'browser_dialog') {
    return {
      status: compact(value?.status, 80) || (value?.accept === true ? 'dialog-accepted' : 'dialog-dismissed'),
    };
  }
  if (action === 'browser_screenshot') {
    const dataUrl = String(value?.dataUrl || '');
    return {
      status: 'captured',
      dataUrl,
    };
  }
  if (action === 'browser_tabs') {
    return {
      tabs: Array.isArray(value?.tabs) ? value.tabs.slice(0, 100).map((tab) => ({
        id: Number(tab?.id),
        active: tab?.active === true,
        title: compact(tab?.title, 500),
        url: compact(tab?.url, 2_000),
      })).filter((tab) => Number.isInteger(tab.id) && tab.id > 0) : [],
    };
  }
  return value && typeof value === 'object' ? { status: compact(value.status || 'completed', 80) } : { status: 'completed' };
}

export function createBrowserControlExecutor({
  adapter,
  approvals,
  refs,
  artifacts = null,
  now = Date.now,
  defaultDeadlineMs = 30_000,
  developerMode = false,
  cdpPolicy = null,
} = {}) {
  if (!adapter?.contract || typeof adapter.execute !== 'function') throw new TypeError('Browser control adapter is required.');
  if (!approvals?.consume) throw new TypeError('Browser control approval store is required.');
  if (!refs?.resolve || !refs?.replace) throw new TypeError('Browser control ref store is required.');
  if (artifacts && (typeof artifacts.upload !== 'function' || typeof artifacts.download !== 'function')) {
    throw new TypeError('Browser control artifact client requires upload and download.');
  }
  const boundedDefaultDeadline = Math.max(1, Number(defaultDeadlineMs) || 1);
  const boundedDeveloperMode = developerMode === true;
  const boundedCdpPolicy = cdpPolicy && typeof cdpPolicy === 'object'
    ? {
      allow: Array.isArray(cdpPolicy.allow) ? cdpPolicy.allow.map((method) => compact(method, 200)).filter(Boolean) : [],
      deny: Array.isArray(cdpPolicy.deny) ? cdpPolicy.deny.map((method) => compact(method, 200)).filter(Boolean) : [],
    }
    : { allow: [], deny: [] };

  async function execute(frame = {}, context = {}) {
    const {
      scope: rawScope = {}, signal: callerSignal, leasedTabIds = [], ownedTabIds = [], currentWindowId = null,
      currentDocumentGeneration = null, snapshotBudget = '', controlHalted = null,
    } = context;
    let scope = normalizedScope(rawScope);
    if (!frameMatchesScope(frame, scope)) return errorOutcome('scope_mismatch', 'The command no longer matches the owned tab document.');

    const action = compact(frame.action, 120);
    const args = frame.arguments && typeof frame.arguments === 'object' ? { ...frame.arguments } : {};
    const ownedTabs = new Set(Array.from(leasedTabIds || []).map(Number).filter((tabId) => Number.isInteger(tabId) && tabId > 0));
    if (!ownedTabs.size) ownedTabs.add(scope.tabId);
    const controllerOwnedTabs = new Set(Array.from(ownedTabIds || []).map(Number).filter((tabId) => Number.isInteger(tabId) && tabId > 0));
    if (!controllerOwnedTabs.size) controllerOwnedTabs.add(scope.tabId);
    // An approval belongs to the command's own tab and lease, which the worker
    // checks when the person answers. A switch names its target in the adapter call only.
    const commandScope = scope;
    if (action === 'browser_tab_activate') {
      const targetTabId = Number(args.tab_id);
      if (!ownedTabs.has(targetTabId)) return errorOutcome('lease_required', 'The target tab is not owned by this controller.');
      scope = { ...scope, tabId: targetTabId };
    }
    if (action === 'browser_tab_close') {
      const targetTabId = Number(args.tab_id);
      if (!controllerOwnedTabs.has(targetTabId)) return errorOutcome('lease_not_owned', 'The target tab is not owned by this controller.');
    }
    if (action === 'browser_tab_group' || action === 'browser_tab_ungroup') {
      const tabIds = [...new Set((Array.isArray(args.tab_ids) ? args.tab_ids : []).map(Number))];
      if (!tabIds.length || tabIds.some((tabId) => !controllerOwnedTabs.has(tabId))) {
        return errorOutcome('lease_not_owned', 'Every grouped tab must be owned by this controller.');
      }
    }
    if (!adapter.contract.enabled || !adapter.contract.actions?.includes(action)) {
      return errorOutcome('unsupported_action', `The active browser adapter does not support ${action || 'this action'}.`);
    }

    const startedAt = Number(now());
    const requestedDeadline = Number(frame.deadline_at);
    const deadlineAt = Number.isFinite(requestedDeadline) && requestedDeadline > 0
      ? requestedDeadline
      : startedAt + boundedDefaultDeadline;
    if (startedAt >= deadlineAt) return errorOutcome('deadline_expired', 'The command deadline expired before execution.');
    if (callerSignal?.aborted) return errorOutcome('cancelled', 'The command was cancelled before execution.');

    const controller = new AbortController();
    let pendingApprovalId = '';
    let terminalCode = '';
    let terminalMessage = '';
    let settleAbort;
    const aborted = new Promise((resolve) => {
      settleAbort = resolve;
    });
    const abort = (code, message) => {
      if (terminalCode) return;
      terminalCode = code;
      terminalMessage = message;
      try {
        controller.abort(new Error(message));
      } catch {
        // Abort delivery is best effort; the terminal race still fails closed.
      }
      settleAbort(errorOutcome(code, message));
    };
    const callerAbort = () => abort('cancelled', 'The command was cancelled.');
    callerSignal?.addEventListener?.('abort', callerAbort, { once: true });
    // A deadline that lands while the human is still deciding is an approval
    // timeout, which the model should relay as such rather than as a failure.
    const timer = setTimeout(
      () => (pendingApprovalId
        ? abort('approval_timeout', APPROVAL_TIMEOUT_MESSAGE)
        : abort('deadline_exceeded', 'The command exceeded its execution deadline.')),
      Math.max(1, deadlineAt - Number(now())),
    );
    let approvalTimer = null;

    // Page state after a mutating action. It never fails the action: whatever
    // goes wrong is reported as snapshot_error next to the action's own status.
    // A batch step settles without reading the page back (`snapshot: false`); the
    // batch then reads it once with `settle: false`.
    async function collectPostActionState({
      action: performed, value: performedValue, settle: wantSettle = true, snapshot: wantSnapshot = true,
    }) {
      const canSettle = wantSettle && typeof adapter.settle === 'function';
      const canSnapshot = wantSnapshot && adapter.contract.actions.includes('browser_snapshot');
      if (!canSettle && !canSnapshot) return {};
      const state = {};
      // The broker gives up on a command at 30 s, so reading the page back ends
      // by the same 28 s cap the approval wait uses, not at the 30 s deadline.
      const postActionDeadline = Math.min(deadlineAt, startedAt + APPROVAL_WAIT_CAP_MS);
      const budgetMs = () => postActionDeadline - Number(now()) - POST_ACTION_DEADLINE_MARGIN_MS;
      if (budgetMs() < POST_ACTION_MIN_BUDGET_MS) {
        return canSnapshot ? { snapshot_error: 'deadline_near' } : {};
      }

      let settled = null;
      const alreadyOpen = performedValue?.status === 'already-open';
      if (canSettle && !alreadyOpen) {
        try {
          settled = await adapter.settle({
            scope,
            signal: controller.signal,
            mode: 'dom',
            timeoutMs: Math.max(1, Math.min(POST_ACTION_SETTLE_MS, budgetMs())),
            // A click that starts a navigation waits for the load, but never past the
            // budget, and a navigate/back that already waited out the load does not wait again.
            loadTimeoutMs: Math.max(1, Math.min(
              budgetMs(),
              performedValue?.timedOut === true ? POST_ACTION_SETTLE_MS : Infinity,
            )),
          }) || null;
        } catch {
          settled = null;
        }
      }
      if (controller.signal.aborted) return state;

      const navigated = performedValue?.navigated === true || settled?.navigated === true;
      let pageUrl = compact(settled?.url || performedValue?.url, 2_000);
      let pageTitle = compact(settled?.title || performedValue?.title, 500);
      if (canSettle || typeof performedValue?.navigated === 'boolean') state.navigated = navigated;
      if (settled?.timedOut === true || performedValue?.timedOut === true) state.timedOut = true;
      if (!canSnapshot) {
        if (pageUrl) state.url = safeResultUrl(pageUrl);
        if (pageTitle) state.title = safeResultTitle(pageTitle);
        return state;
      }

      if (!pageUrl && typeof adapter.inspect === 'function') {
        try {
          pageUrl = compact((await adapter.inspect({
            tabId: scope.tabId, frameId: scope.frameId, signal: controller.signal, light: true,
          }))?.currentUrl, 2_000);
        } catch {
          pageUrl = '';
        }
      }
      const allowLocalDocuments = Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments);
      if (!pageUrl) {
        state.snapshot_error = 'page_unavailable';
      } else if (classifyBrowserControlAction({
        action: 'browser_snapshot', currentUrl: pageUrl, allowLocalDocuments,
      }).risk === BROWSER_CONTROL_RISKS.BLOCKED) {
        // Same gate as browser_snapshot: a restricted page is never read.
        state.snapshot_error = 'restricted_page';
        pageUrl = pageOrigin(pageUrl);
        pageTitle = '';
      }
      if (pageUrl) state.url = safeResultUrl(pageUrl);
      if (pageTitle) state.title = safeResultTitle(pageTitle);
      if (state.snapshot_error) {
        if (navigated) refs.invalidateTab(scope.tabId);
        return state;
      }

      try {
        if (navigated) refs.invalidateTab(scope.tabId);
        const generation = await settledDocumentGeneration(navigated, budgetMs);
        const snapshotScope = { ...scope, documentGeneration: generation };
        const pending = adapter.execute('browser_snapshot', { full: false }, {
          signal: controller.signal,
          scope: snapshotScope,
          target: null,
          destination: null,
          deadlineAt,
          leasedTabIds: [...ownedTabs],
          ownedTabIds: [...controllerOwnedTabs],
          currentWindowId: Number(currentWindowId) || null,
        });
        pending.catch(() => {});
        const raw = await withTimeout(pending, budgetMs());
        if (controller.signal.aborted) return state;
        if (raw === TIMED_OUT) {
          state.snapshot_error = 'snapshot_timeout';
          return state;
        }
        // The page was judged before the debugger attached and the page settled, so it can have moved to a
        // restricted address since. The address the snapshot was read under decides, and a restricted one
        // discards everything read.
        if (restrictedPageUrl(raw?.url, allowLocalDocuments)) {
          state.snapshot_error = 'restricted_page';
          state.url = safeResultUrl(pageOrigin(raw.url));
          delete state.title;
          refs.invalidateTab(scope.tabId);
          return state;
        }
        // The generation may have moved while the snapshot ran; refs must be
        // minted under the one the next command will carry.
        const mintGeneration = readDocumentGeneration(generation);
        const minted = refs.replace({
          ...scope,
          documentGeneration: mintGeneration,
          nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
        });
        if (!minted.ok) {
          state.snapshot_error = 'ref_bind_failed';
          return state;
        }
        const snapshot = safeSnapshotResult(raw, minted, { maxChars: SNAPSHOT_VIEW_BUDGETS.postAction });
        state.snapshot = {
          text: snapshot.text,
          refs: snapshot.refs,
          truncated: snapshot.truncated,
          element_count: snapshot.element_count,
        };
      } catch (error) {
        if (controller.signal.aborted) return state;
        state.snapshot_error = ADAPTER_ERROR_CODES.has(error?.code) ? error.code : 'snapshot_failed';
      }
      return state;
    }

    function readDocumentGeneration(fallback) {
      if (typeof currentDocumentGeneration !== 'function') return fallback;
      try {
        const value = Number(currentDocumentGeneration(scope.tabId, scope.frameId));
        return Number.isInteger(value) && value >= 1 ? value : fallback;
      } catch {
        return fallback;
      }
    }

    // The worker bumps the document generation from tabs.onUpdated and from the
    // content script's document-ready message. After a navigation, wait for
    // those to land and settle so refs are minted under the generation the
    // next command will use. If it never moves, the current value stands.
    async function settledDocumentGeneration(expectChange, budgetMs = () => Infinity) {
      const from = scope.documentGeneration;
      if (typeof currentDocumentGeneration !== 'function') return from;
      let current = readDocumentGeneration(from);
      if (current === from && !expectChange) return current;
      for (let poll = 0; poll < GENERATION_MAX_POLLS && !controller.signal.aborted && budgetMs() > GENERATION_POLL_MS; poll += 1) {
        await new Promise((resolve) => { setTimeout(resolve, GENERATION_POLL_MS); });
        const next = readDocumentGeneration(from);
        if (next === current && current !== from) return current;
        current = next;
      }
      return current;
    }

    // The approval card names the tab a switch would bring forward, read through the
    // adapter. Without a readable title the generic wording stands; either way the
    // approval is bound to the tab id, not to this text.
    async function tabSwitchReason(args) {
      const generic = APPROVAL_MESSAGES['tab-activate'];
      const targetTabId = Number(args.tab_id);
      if (typeof adapter.inspect !== 'function' || !Number.isInteger(targetTabId) || targetTabId <= 0) return generic;
      try {
        const info = await adapter.inspect({
          tabId: targetTabId, frameId: 0, signal: controller.signal, light: true,
        });
        const label = tabSwitchLabel(info?.title, info?.currentUrl);
        return label ? `Switch your view to "${label}"?` : generic;
      } catch {
        return generic;
      }
    }

    // One action under the full rule set: ref resolution, page probe,
    // classification, approval, origin re-check and the adapter call. A batch
    // runs every step through this same path.
    async function runAction(action, args, { approvalId: stepApprovalId = '', approvalNonce: stepApprovalNonce = '', step = null } = {}) {
      let target = null;
      let destination = null;
      if (['browser_click', 'browser_drag', 'browser_fill', 'browser_hover', 'browser_scroll_to', 'browser_select', 'browser_type'].includes(action) && args.ref) {
        const resolved = refs.resolve({ ...scope, ref: args.ref });
        if (!resolved.ok) return errorOutcome(resolved.error, 'The target ref is not valid for this document.');
        target = resolved.target;
      }
      if (action === 'browser_screenshot' && args.ref) {
        const resolved = refs.resolve({ ...scope, ref: args.ref });
        if (!resolved.ok) return errorOutcome(resolved.error, 'The screenshot target ref is not valid for this document.');
        target = resolved.target;
      }
      if (action === 'browser_drag') {
        const resolved = refs.resolve({ ...scope, ref: args.to_ref });
        if (!resolved.ok) return errorOutcome(resolved.error, 'The drag destination ref is not valid for this document.');
        destination = resolved.target;
      }
      if (['browser_drag', 'browser_fill', 'browser_hover', 'browser_scroll_to', 'browser_select', 'browser_type'].includes(action) && !target) {
        return errorOutcome('invalid_ref', 'This action requires an exact target ref.');
      }
      if (action === 'browser_click' && !target && !(Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)))) {
        return errorOutcome('invalid_ref', 'Click requires an exact target ref or approved viewport coordinates.');
      }

      let pageState = {};
      let waitedForApproval = false;
      if (typeof adapter.inspect === 'function' && [
        'browser_back', 'browser_click', 'browser_drag', 'browser_fill', 'browser_hover', 'browser_navigate', 'browser_press',
        'browser_screenshot', 'browser_scroll', 'browser_scroll_to', 'browser_select', 'browser_snapshot', 'browser_type',
        'browser_console', 'browser_network_requests', 'browser_response_body', 'browser_pdf', 'browser_upload',
        'browser_evaluate', 'browser_cdp', 'browser_dialog',
      ].includes(action)) {
        pageState = await adapter.inspect({
          tabId: scope.tabId,
          frameId: scope.frameId,
          signal: controller.signal,
          ...(URL_ONLY_PROBE_ACTIONS.has(action) ? { light: true } : {}),
        }) || {};
      }
      if (controller.signal.aborted) return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');

      const policy = classifyBrowserControlAction({
        action,
        arguments: args,
        target: target || {},
        currentUrl: pageState.currentUrl,
        hasUnsavedContent: pageState.hasUnsavedContent === true,
        // A key press goes to whatever has focus, so the probe's reading of it is judged.
        ...(action === 'browser_press' ? { focused: pageState.focused } : {}),
        developerMode: boundedDeveloperMode,
        allowLocalDocuments: Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments),
      });
      if (policy.risk === BROWSER_CONTROL_RISKS.BLOCKED) {
        return errorOutcome('sensitive_action_blocked', policy.reason || 'This action is blocked.');
      }
      if (policy.risk === BROWSER_CONTROL_RISKS.APPROVAL) {
        const approval = {
          approvalId: stepApprovalId || compact(frame.approval_id || frame.command_id, 160),
          approvalNonce: stepApprovalNonce || compact(frame.approval_nonce || frame.approval_id || frame.command_id, 160),
          commandId: frame.command_id,
          controllerId: commandScope.controllerId,
          leaseId: commandScope.leaseId,
          leaseGeneration: commandScope.leaseGeneration,
          tabId: commandScope.tabId,
          // The document the action will run on: a batch that navigated has moved on
          // from the generation the command arrived with, and the grant checks this one.
          documentGeneration: scope.documentGeneration,
          action,
          state: 'paused',
          ...approvalBindingFields(action, args, target, destination),
        };
        let approvalReason = APPROVAL_MESSAGES[policy.reason] || 'This browser action requires approval.';
        if (step) approvalReason = `Step ${step.number} of ${step.total}: ${approvalReason}`;
        let approvalDetail = '';
        if (action === 'browser_evaluate') {
          const preview = compact(String(args.code ?? args.expression ?? ''), 800);
          approvalReason = `Run this evaluate code on the page?\n\n\`\`\`\n${preview}\n\`\`\``;
          approvalDetail = preview;
        }
        let consumed = approvals.consume(approval);
        if (!consumed.ok) {
          if (action === 'browser_tab_activate') {
            approvalReason = await tabSwitchReason(args);
            // A cancel that landed during the title read must not leave a request behind.
            if (controller.signal.aborted) {
              return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
            }
          }
          pendingApprovalId = approval.approvalId;
          waitedForApproval = true;
          // A batch keeps the steps it already finished, so a step that times out
          // waiting for the person fails on its own instead of aborting the command.
          approvalTimer = setTimeout(
            () => (step
              ? approvals.cancelRequest?.(approval.approvalId, 'approval_timeout')
              : abort('approval_timeout', APPROVAL_TIMEOUT_MESSAGE)),
            Math.max(1, Math.min(deadlineAt, startedAt + APPROVAL_WAIT_CAP_MS) - Number(now())),
          );
          const requested = await approvals.request({
            ...approval,
            reason: approvalReason,
            ...(approvalDetail ? { detail: approvalDetail } : {}),
          });
          clearTimeout(approvalTimer);
          approvalTimer = null;
          if (!requested?.ok) {
            pendingApprovalId = '';
            return errorOutcome(
              requested?.error || 'approval_cancelled',
              requested?.error === 'approval_timeout' ? APPROVAL_TIMEOUT_MESSAGE : 'The approval request was cancelled.',
            );
          }
          if (controller.signal.aborted) {
            approvals.cancelRequest?.(approval.approvalId);
            return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
          }
          consumed = approvals.consume(approval);
          pendingApprovalId = '';
        }
        if (!consumed.ok) return errorOutcome('approval_required', policy.reason || 'This action requires approval.');
      }

      // One probe per action; only a human approval wait leaves room for the page to change.
      if (waitedForApproval && typeof adapter.inspect === 'function' && APPROVALS_RECHECK_ACTIONS.has(action)) {
        const current = await adapter.inspect({
          tabId: scope.tabId,
          frameId: scope.frameId,
          signal: controller.signal,
        }) || {};
        if (controller.signal.aborted) {
          return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
        }
        const beforeOrigin = pageOrigin(pageState.currentUrl);
        const currentOrigin = pageOrigin(current.currentUrl);
        if (!beforeOrigin || !currentOrigin || beforeOrigin !== currentOrigin) {
          return errorOutcome('domain_changed', 'The page origin changed before the action could run.');
        }
        // The same origin can still have moved to a path the policy refuses (a pushState to /checkout), and the
        // approval was for the page as it was, so the whole policy is applied to where the page is now.
        if (restrictedPageUrl(current.currentUrl, Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments))) {
          return errorOutcome('domain_changed', 'The page moved to one Hermes will not act on while waiting for your approval, so the action did not run.');
        }
      }

      // Phase 8 privileged pre-execution gates: raw CDP method policy and
      // approved-artifact download for file uploads.
      let artifact = null;
      if (action === 'browser_cdp') {
        const method = compact(args.method, 200);
        const allowList = boundedCdpPolicy.allow;
        const denyList = boundedCdpPolicy.deny;
        const denied = CDP_DENY_METHODS.has(method)
          || CDP_DENY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))
          || denyList.includes(method);
        if (denied || (allowList.length && !allowList.includes(method))) {
          return errorOutcome('cdp_method_denied', `The raw CDP method ${method || 'unknown'} is not permitted.`);
        }
      }
      if (action === 'browser_upload') {
        if (!artifacts) {
          return errorOutcome('artifact_transport_unavailable', 'No one-shot artifact transport is available for file upload.');
        }
        const downloaded = await artifacts.download({ artifactId: compact(args.artifact_id, 200) });
        if (!downloaded.ok) {
          return errorOutcome(downloaded.error, downloaded.message || 'The approved artifact could not be downloaded.');
        }
        artifact = downloaded.artifact;
      }

      const value = await adapter.execute(action, args, {
        signal: controller.signal,
        scope,
        target,
        destination,
        deadlineAt,
        leasedTabIds: [...ownedTabs],
        ownedTabIds: [...controllerOwnedTabs],
        currentWindowId: Number(currentWindowId) || null,
        allowLocalDocuments: Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments),
        ...(artifact ? { artifact } : {}),
      });
      if (controller.signal.aborted) return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');

      if (action === 'browser_console') {
        const entries = Array.isArray(value?.entries) ? value.entries : [];
        const safe = entries.slice(0, MAX_CONSOLE_ENTRIES).map((entry) => ({
          type: compact(entry?.type, 40) || 'log',
          text: redactSensitiveText(String(entry?.text ?? '')).slice(0, MAX_CONSOLE_ENTRY_CHARS),
        }));
        return { ok: true, result: { entries: safe, truncated: entries.length > MAX_CONSOLE_ENTRIES } };
      }
      if (action === 'browser_network_requests') {
        if (args.include_bodies === true) {
          return errorOutcome('network_bodies_blocked', 'Network response bodies are never included in metadata reads.');
        }
        const requests = Array.isArray(value?.requests) ? value.requests : [];
        const safe = requests.slice(0, MAX_NETWORK_REQUESTS).map((request) => ({
          requestId: compact(request?.requestId, 120),
          method: compact(request?.method, 20),
          status: Number.isFinite(Number(request?.status)) ? Number(request.status) : null,
          mimeType: compact(request?.mimeType, 120),
          resourceType: compact(request?.resourceType, 60),
          size: Number.isFinite(Number(request?.size)) ? Number(request.size) : null,
          url: safeNetworkUrl(request?.url),
        })).filter((request) => request.requestId || request.url);
        return {
          ok: true,
          result: {
            requests: safe,
            truncated: requests.length > MAX_NETWORK_REQUESTS,
            bodiesIncluded: false,
          },
        };
      }
      if (action === 'browser_response_body') {
        const body = String(value?.body ?? value?.text ?? '');
        const mimeType = compact(value?.mimeType, 120);
        if (!RESPONSE_BODY_MIME_RE.test(mimeType)) {
          return errorOutcome('body_mime_not_allowed', 'This response body MIME type is not eligible for reading.');
        }
        if (body.length > MAX_RESPONSE_BODY_CHARS) {
          return errorOutcome('body_too_large', 'The response body exceeds the bounded read cap.');
        }
        const scanned = redactSensitiveTextWithCount(body);
        if (scanned.count > 0) {
          return errorOutcome('body_contains_secrets', 'The response body contains secrets and was not returned.');
        }
        return { ok: true, result: { mimeType, size: body.length, body: scanned.text, truncated: false } };
      }
      if (action === 'browser_pdf') {
        if (!artifacts) {
          return errorOutcome('artifact_transport_unavailable', 'No one-shot artifact transport is available for PDF storage.');
        }
        const bytes = (value?.bytes instanceof Uint8Array || value?.bytes instanceof ArrayBuffer)
          ? value.bytes
          : (value?.base64 ? base64ToBytes(value.base64) : (typeof value?.bytes === 'string' ? value.bytes : null));
        if (!bytes) return errorOutcome('pdf_bytes_missing', 'The PDF action produced no readable bytes.');
        const uploaded = await artifacts.upload({
          name: compact(args.filename || 'page.pdf', 255),
          mimeType: 'application/pdf',
          bytes,
          scope,
          action: 'browser_pdf',
        });
        if (!uploaded.ok) return errorOutcome(uploaded.error, uploaded.message || 'The PDF artifact could not be stored.');
        return { ok: true, result: uploaded.receipt };
      }
      if (action === 'browser_upload') {
        return {
          ok: true,
          result: {
            status: 'uploaded',
            name: artifact?.name || '',
            mimeType: artifact?.mimeType || '',
            size: Number(artifact?.size) || 0,
            checksum: artifact?.checksum || '',
          },
        };
      }
      if (action === 'browser_evaluate') {
        const raw = pickResultValue(value);
        let text = '';
        try {
          text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch {
          text = String(raw);
        }
        const redacted = redactSensitiveText(text);
        const truncated = redacted.length > MAX_RESULT_TEXT;
        return { ok: true, result: { value: redacted.slice(0, MAX_RESULT_TEXT), truncated } };
      }
      if (action === 'browser_cdp') {
        const raw = pickResultValue(value);
        let text = '';
        try {
          text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch {
          text = String(raw);
        }
        return { ok: true, result: { status: 'cdp-command-sent', value: redactSensitiveText(text).slice(0, MAX_RESULT_TEXT) } };
      }

      if (action === 'browser_snapshot') {
        // Same as after an action: the page was judged before it was read, and the address it was read
        // under decides. A page that became restricted meanwhile is dropped, not described.
        if (restrictedPageUrl(value?.url, Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments))) {
          refs.invalidateTab(scope.tabId);
          return errorOutcome('sensitive_action_blocked', 'The page moved to one Hermes will not read, so nothing was read from it.');
        }
        const full = args.full === true;
        const minted = refs.replace({ ...scope, nodes: Array.isArray(value?.nodes) ? value.nodes : [] });
        if (!minted.ok) return errorOutcome(minted.error, 'Could not bind snapshot refs.');
        // The worker's turn-context snapshot is the only caller that sets
        // snapshotBudget (never a model argument); it asks for the small view.
        const turnView = snapshotBudget === 'turn' && !full;
        return {
          ok: true,
          result: safeSnapshotResult(value, minted, {
            maxChars: turnView
              ? SNAPSHOT_VIEW_BUDGETS.turn
              : (full ? SNAPSHOT_VIEW_BUDGETS.full : SNAPSHOT_VIEW_BUDGETS.snapshot),
            fullText: full,
          }),
        };
      }
      if (action === 'browser_screenshot') {
        // Judged like a snapshot: the address the pixels were taken under decides, and a restricted one drops them.
        if (restrictedPageUrl(value?.url, Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments))) {
          return errorOutcome('restricted_page', 'The page moved to one Hermes will not capture, so the screenshot was discarded.');
        }
        const dataUrl = String(value?.dataUrl || '');
        if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_INLINE_SCREENSHOT_CHARS) {
          return errorOutcome('screenshot_too_large', 'The screenshot exceeds the inline Phase 6 transport cap.');
        }
      }
      if (action === 'browser_navigate' || action === 'browser_back') refs.invalidateTab(scope.tabId);
      if (step && POST_ACTION_ACTIONS.has(action)) {
        // Settle only; the batch reads the page once, at the end.
        step.value = value;
        step.state = await collectPostActionState({ action, value, snapshot: false });
        return { ok: true, result: sanitizedActionResult(action, value) };
      }
      if (POST_ACTION_ACTIONS.has(action)) {
        const state = await collectPostActionState({ action, value });
        const result = { ...sanitizedActionResult(action, value), ...state };
        // navigate/back report the page they landed on; a restricted page is
        // never described beyond its origin, whichever step saw its URL.
        const allowLocal = Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments);
        const landedRestricted = restrictedPageUrl(value?.url, allowLocal);
        if (state.snapshot_error === 'restricted_page' || (landedRestricted && !('title' in state))) delete result.title;
        if (landedRestricted && !('url' in state)) result.url = safeResultUrl(pageOrigin(value.url));
        return { ok: true, result };
      }
      if (action === 'browser_tabs') {
        const filtered = { tabs: Array.isArray(value?.tabs) ? value.tabs.filter((tab) => ownedTabs.has(Number(tab?.id))) : [] };
        return { ok: true, result: sanitizedActionResult(action, filtered) };
      }
      return { ok: true, result: sanitizedActionResult(action, value) };
    }

    function outcomeFromError(error) {
      if (controller.signal.aborted) return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
      return errorOutcome(
        ADAPTER_ERROR_CODES.has(error?.code) ? error.code : 'command_error',
        error?.message || 'The browser action failed.',
      );
    }

    // Progress of a running batch, so a deadline that ends the command still
    // tells the model how far it got.
    let batchProgress = null;

    function parseBatch(batchArgs = {}) {
      const list = batchArgs.actions;
      if (!Array.isArray(list) || !list.length) {
        return { error: 'invalid_batch', message: 'browser_batch needs a non-empty actions list.' };
      }
      if (list.length > BATCH_MAX_STEPS) {
        return { error: 'batch_too_large', message: `A batch holds at most ${BATCH_MAX_STEPS} steps.` };
      }
      const steps = [];
      for (const [index, raw] of list.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          return { error: 'invalid_batch', message: `Step ${index + 1} must be an object with an action.` };
        }
        const stepAction = batchStepAction(raw.action);
        if (!BATCH_STEP_ACTIONS.has(stepAction)) {
          return { error: 'batch_action_not_allowed', message: `Step ${index + 1}: ${stepAction || 'a step without an action'} cannot run inside a batch.` };
        }
        if (!adapter.contract.actions.includes(stepAction)) {
          return { error: 'unsupported_action', message: `Step ${index + 1}: the active browser adapter does not support ${stepAction}.` };
        }
        const stepArgs = { ...raw };
        delete stepArgs.action;
        steps.push({ action: stepAction, args: stepArgs });
      }
      return { ok: true, steps, stopOnError: batchArgs.stop_on_error !== false };
    }

    function controlIsHalted() {
      if (typeof controlHalted !== 'function') return false;
      try {
        return controlHalted() === true;
      } catch {
        return true;
      }
    }

    async function runBatch() {
      const parsed = parseBatch(args);
      if (!parsed.ok) return errorOutcome(parsed.error, parsed.message);
      const { steps, stopOnError } = parsed;
      const baseApprovalId = compact(frame.approval_id || frame.command_id, 140);
      const baseApprovalNonce = compact(frame.approval_nonce || frame.approval_id || frame.command_id, 140);
      const batchBudgetMs = () => Math.min(deadlineAt, startedAt + APPROVAL_WAIT_CAP_MS) - Number(now());
      const cancelled = () => errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
      const results = [];
      batchProgress = { total: steps.length, results };
      let completed = 0;
      let stoppedReason = '';
      let navigated = false;
      let timedOut = false;
      let failed = false;
      let halted = false;

      for (const [index, { action: stepAction, args: stepArgs }] of steps.entries()) {
        if (controller.signal.aborted) return cancelled();
        // Pause, a debugger detach or switching control off takes effect between
        // steps; the page is not read back once control has been halted.
        if (index > 0 && controlIsHalted()) {
          stoppedReason = 'controller_paused';
          halted = true;
          break;
        }
        if (index > 0 && batchBudgetMs() < BATCH_STEP_RESERVE_MS) {
          stoppedReason = 'budget_exhausted';
          break;
        }
        // The batch only follows navigations it caused itself; any other move of
        // the document ends it, as it would fail a standalone command.
        if (index > 0 && readDocumentGeneration(scope.documentGeneration) !== scope.documentGeneration) {
          stoppedReason = 'stale_document';
          break;
        }
        const info = { number: index + 1, total: steps.length };
        let outcome;
        try {
          outcome = await runAction(stepAction, stepArgs, {
            approvalId: `${baseApprovalId}:step-${index + 1}`,
            approvalNonce: `${baseApprovalNonce}:step-${index + 1}`,
            step: info,
          });
        } catch (error) {
          outcome = outcomeFromError(error);
        }
        if (controller.signal.aborted) return cancelled();
        if (outcome.ok) {
          completed += 1;
          results.push({ index, action: stepAction, status: compact(outcome.result?.status, 80) || 'completed' });
          if (info.state?.timedOut === true || info.value?.timedOut === true) timedOut = true;
          if (info.state?.navigated === true || info.value?.navigated === true) {
            navigated = true;
            refs.invalidateTab(scope.tabId);
            const generation = await settledDocumentGeneration(true, batchBudgetMs);
            scope = { ...scope, documentGeneration: generation };
          }
          continue;
        }
        failed = true;
        const code = outcome.error?.code || 'command_error';
        results.push({ index, action: stepAction, error: code, ...(outcome.error?.message ? { message: outcome.error.message } : {}) });
        if (stopOnError || BATCH_FATAL_CODES.has(code)) {
          stoppedReason = code;
          break;
        }
      }

      // One read of the page for the whole batch.
      let pageState = {};
      if (!controller.signal.aborted && !halted && !controlIsHalted()) {
        pageState = await collectPostActionState({
          action: 'browser_batch', value: { navigated: false }, settle: false,
        });
      }
      if (controller.signal.aborted) return cancelled();
      const { navigated: unusedNavigated, timedOut: unusedTimedOut, ...pageResult } = pageState;
      void unusedNavigated;
      void unusedTimedOut;
      return {
        ok: true,
        result: {
          status: stoppedReason ? 'stopped' : (failed ? 'completed_with_errors' : 'completed'),
          ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
          steps: results,
          completed,
          remaining: steps.length - results.length,
          navigated,
          ...(timedOut ? { timedOut: true } : {}),
          ...pageResult,
        },
      };
    }

    const operation = (async () => {
      if (action === 'browser_batch') return runBatch();
      return runAction(action, args);
    })().catch(outcomeFromError);

    try {
      const outcome = await Promise.race([operation, aborted]);
      if (batchProgress && outcome && !outcome.ok && outcome.error && batchProgress.results.length) {
        const done = batchProgress.results.filter((entry) => entry.status).length;
        return errorOutcome(
          outcome.error.code,
          `${outcome.error.message || 'The batch stopped.'} ${done} of ${batchProgress.total} steps had completed.`.trim(),
        );
      }
      return outcome;
    } finally {
      clearTimeout(timer);
      if (approvalTimer) clearTimeout(approvalTimer);
      if (pendingApprovalId) approvals.cancelRequest?.(pendingApprovalId);
      callerSignal?.removeEventListener?.('abort', callerAbort);
    }
  }

  return { execute };
}
