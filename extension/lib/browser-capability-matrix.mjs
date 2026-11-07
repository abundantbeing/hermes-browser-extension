// What each browser can do on each Hermes Browser Extension surface, and why.
//
// One source of truth for the Firefox guide (guides/firefox.md, checked by a guard test) and for the Firefox rows in
// Settings > About & Diagnostics. The Hermes Control rows are derived from the real adapter contract
// (browser-controller-adapter.mjs); every other row is pinned to the manifest, the build profile or the code that
// decides it by tests/browser-capability-matrix.test.mjs, so a row cannot drift from what ships.
//
// A cell says:
//   status   supported | limited | experimental | unavailable
//   cause    what decides it: the browser's API, a permission, the gateway, the transport, or this extension
//   reason   why, in plain words (how it works, when supported)
//   instead  what to do when it is not fully supported
//   checked  code (read from the manifest, build profile, code and tests) | run (seen running in a real browser while
//            the row was written) | unchecked (shared code that was never run in that browser; the status is the
//            best-supported expectation, not an observation)
//
// Pure module: no DOM, no storage, no browser API.

import { CHROMIUM_ACTIONS, FIREFOX_ACTIONS } from './browser-controller-adapter.mjs';

export const CAPABILITY_ENGINES = Object.freeze({ CHROMIUM: 'chromium', FIREFOX: 'firefox' });

export const CAPABILITY_STATUSES = Object.freeze({
  SUPPORTED: 'supported',
  LIMITED: 'limited',
  EXPERIMENTAL: 'experimental',
  UNAVAILABLE: 'unavailable',
});

export const CAPABILITY_CAUSES = Object.freeze({
  NONE: 'none',
  BROWSER_API: 'browser-api',
  PERMISSION: 'permission',
  GATEWAY: 'gateway',
  TRANSPORT: 'transport',
  EXTENSION: 'extension',
});

export const CAPABILITY_CHECKS = Object.freeze({ CODE: 'code', RUN: 'run', UNCHECKED: 'unchecked' });

export const CAPABILITY_SURFACES = Object.freeze([
  Object.freeze({ id: 'side-panel', label: 'Side panel and Firefox sidebar' }),
  Object.freeze({ id: 'assist', label: 'Hermes Assist (drafting in page fields)' }),
  Object.freeze({ id: 'web', label: 'Hermes Web (full tab)' }),
  Object.freeze({ id: 'control', label: 'Hermes Control (acting in tabs you attach)' }),
  Object.freeze({ id: 'menus', label: 'Context menus and shortcuts' }),
]);

const S = CAPABILITY_STATUSES;
const C = CAPABILITY_CAUSES;
const K = CAPABILITY_CHECKS;

const cell = (status, cause, reason, instead = '', checked = K.CODE) => Object.freeze({
  status, cause, reason, instead, checked,
});

// How much of a row's Hermes Control actions a browser's adapter offers, read from the adapter contract itself.
function statusFromActions(actions, offered) {
  const present = actions.filter((action) => offered.includes(action)).length;
  if (present === actions.length) return S.SUPPORTED;
  return present === 0 ? S.UNAVAILABLE : S.LIMITED;
}

const POINTER_KEYBOARD_ACTIONS = Object.freeze([
  'browser_click', 'browser_drag', 'browser_fill', 'browser_hover', 'browser_press',
  'browser_scroll_to', 'browser_select', 'browser_type',
]);
const READ_ACTIONS = Object.freeze(['browser_snapshot']);
const NAVIGATE_ACTIONS = Object.freeze(['browser_navigate', 'browser_back', 'browser_scroll']);
const TAB_ACTIONS = Object.freeze(['browser_tabs', 'browser_tab_create', 'browser_tab_activate', 'browser_tab_close']);
const SCREENSHOT_ACTIONS = Object.freeze(['browser_screenshot']);
const GROUP_ACTIONS = Object.freeze(['browser_tab_group', 'browser_tab_ungroup']);
const BATCH_ACTIONS = Object.freeze(['browser_batch']);

export const UNDESCRIBED_ADAPTER_GAP = 'The adapter for this browser does not offer this action.';

// A browser's cell for a Hermes Control row. Its status comes from the adapter contract (CHROMIUM_ACTIONS,
// FIREFOX_ACTIONS): all actions offered is supported unless a caveat is stated, none is unavailable, some is limited.
// A row that gains or loses an action without saying why still renders, with a generic reason a test rejects.
function controlCell(actions, offered, { supported, caveat, gap }) {
  const status = statusFromActions(actions, offered);
  if (status === S.SUPPORTED) {
    return caveat ? cell(S.LIMITED, caveat.cause, caveat.reason, caveat.instead) : supported;
  }
  const stated = gap || caveat;
  return stated
    ? cell(status, stated.cause, stated.reason, stated.instead)
    : cell(status, C.EXTENSION, UNDESCRIBED_ADAPTER_GAP);
}

function controlRow({ id, label, actions, chromium = {}, firefox = {} }) {
  return Object.freeze({
    id,
    surface: 'control',
    label,
    actions: Object.freeze([...actions]),
    chromium: controlCell(actions, CHROMIUM_ACTIONS, chromium),
    firefox: controlCell(actions, FIREFOX_ACTIONS, firefox),
  });
}

const row = (id, surface, label, chromium, firefox) => Object.freeze({ id, surface, label, chromium, firefox });

export const BROWSER_CAPABILITY_ROWS = Object.freeze([
  row(
    'side-panel.panel',
    'side-panel',
    'Hermes in the browser side',
    cell(S.SUPPORTED, C.BROWSER_API, "Chromium's Side Panel API (declared as side_panel)."),
    cell(S.SUPPORTED, C.BROWSER_API, "Firefox's own sidebar (declared as sidebar_action); the Chromium side panel API does not exist there.", '', K.CODE),
  ),
  row(
    'side-panel.per-tab',
    'side-panel',
    'Side panel tied to one tab',
    cell(S.SUPPORTED, C.BROWSER_API, 'Settings can attach the panel to one tab or keep it open across tabs.'),
    cell(
      S.UNAVAILABLE,
      C.BROWSER_API,
      'Firefox keeps an add-on sidebar open on every tab of the window, and giving it a panel per tab reloads it and ends chats in progress.',
      'The sidebar stays open across tabs; the toolbar button closes it.',
    ),
  ),
  row(
    'side-panel.chat',
    'side-panel',
    'Chat, attachments and page context',
    cell(S.SUPPORTED, C.GATEWAY, 'Talks to your Hermes gateway and reads the page with the extension content script.'),
    cell(S.SUPPORTED, C.GATEWAY, 'Same code as Chromium: your Hermes gateway and the extension content script.', '', K.UNCHECKED),
  ),
  row(
    'side-panel.wake-word',
    'side-panel',
    'Wake word in the side panel',
    cell(S.SUPPORTED, C.BROWSER_API, "Hermes's own wake engine on the gateway, or a local listener in a hidden extension page."),
    cell(
      S.LIMITED,
      C.BROWSER_API,
      "Firefox has no offscreen documents, so the local listener cannot run. Hermes's own wake engine runs only on a local gateway on this computer, not on remote or cloud connections.",
      "Connect to a local gateway to use Hermes wake, or start the chat from the panel.",
    ),
  ),
  row(
    'side-panel.dictation',
    'side-panel',
    'Voice dictation in the composer',
    cell(S.SUPPORTED, C.BROWSER_API, "Hermes's own transcription when the gateway has it, and the browser's speech recognition otherwise."),
    cell(
      S.LIMITED,
      C.BROWSER_API,
      "Firefox has no browser speech recognition, so dictation works only through Hermes's own transcription (a gateway with audio transcription, or the dashboard on this computer).",
      "Type instead, or turn on audio transcription on your Hermes gateway.",
      K.RUN,
    ),
  ),
  row(
    'assist.field-drafts',
    'assist',
    'Assist circle and drafts in page fields',
    cell(S.SUPPORTED, C.NONE, 'A content script on every web page, placed next to the focused field.'),
    cell(S.SUPPORTED, C.NONE, 'The same content script, declared for Firefox too; its draft host appears next to a focused field.', '', K.RUN),
  ),
  row(
    'assist.write-back',
    'assist',
    'Writing a reviewed draft into the field',
    cell(S.SUPPORTED, C.NONE, 'You review the draft first. Ordinary fields are replaced in place; editors that manage their own text get a preview and Copy.'),
    cell(S.SUPPORTED, C.NONE, 'Same code as Chromium: you review the draft first; editors that manage their own text get a preview and Copy.', '', K.UNCHECKED),
  ),
  row(
    'assist.panel-route',
    'assist',
    'Assist drafts that open the side panel',
    cell(S.SUPPORTED, C.BROWSER_API, 'Opens the side panel next to the page and hands the draft to it.'),
    cell(
      S.EXPERIMENTAL,
      C.BROWSER_API,
      'Firefox lets an extension open its sidebar only from a user action. A click relayed from the page to the background worker has not been tested, and when Firefox refuses and no sidebar is open, Hermes stops the draft and asks you to open the sidebar or run in the background.',
      'Open the sidebar first (Ctrl+Shift+H or the toolbar button), then draft. Or choose Run in background.',
      K.UNCHECKED,
    ),
  ),
  row(
    'assist.background-drafts',
    'assist',
    'Drafts that need no open panel',
    cell(S.SUPPORTED, C.GATEWAY, "The extension's background worker asks your gateway for the draft and hands it back to the page."),
    cell(S.SUPPORTED, C.GATEWAY, 'Same code as Chromium: the background worker asks your gateway for the draft.', '', K.UNCHECKED),
  ),
  row(
    'web.open',
    'web',
    'Open Hermes Web from the panel',
    cell(S.SUPPORTED, C.GATEWAY, 'Opens the Webapp your own gateway serves (webapp.enabled), or the address you set for a remote one.'),
    cell(S.SUPPORTED, C.GATEWAY, 'Same code as Chromium: opens the Webapp your gateway serves, in a normal tab.', '', K.UNCHECKED),
  ),
  row(
    'web.sign-in',
    'web',
    'Signed-in Hermes Web launch',
    cell(
      S.SUPPORTED,
      C.GATEWAY,
      'On this computer, a loopback Hermes Web address on a gateway with the extension pairing routes mints a one-use sign-in; otherwise run hermes webapp once. A remote Web address opens with account sign-in instead; neither automatic sign-in nor hermes webapp applies there.',
    ),
    cell(
      S.SUPPORTED,
      C.GATEWAY,
      'Same code as Chromium: one-use sign-in only on loopback with pairing routes (otherwise run hermes webapp once on this computer); a remote Web address uses account sign-in instead.',
      '',
      K.UNCHECKED,
    ),
  ),
  row(
    'web.full-tab',
    'web',
    'The extension chat in a full tab',
    cell(S.UNAVAILABLE, C.EXTENSION, 'The full-page chat view was retired; the side panel is the supported surface.', 'Use Hermes Web for a full page.'),
    cell(S.UNAVAILABLE, C.EXTENSION, 'The full-page chat view was retired; the sidebar is the supported surface.', 'Use Hermes Web for a full page.'),
  ),
  row(
    'control.attach',
    'control',
    'Hermes Control: attach tabs, scope and approvals',
    cell(S.SUPPORTED, C.GATEWAY, 'Needs a Hermes with Hermes Control (the extension plugin on current Hermes). Acts only in tabs you attach; risky actions wait for your approval.'),
    cell(S.SUPPORTED, C.GATEWAY, 'Same attach, scope, approval and restricted-page rules as Chromium, on a smaller set of actions.'),
  ),
  controlRow({
    id: 'control.read-page',
    label: 'Hermes Control: reading the page',
    actions: READ_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.BROWSER_API, "Reads the page's accessibility tree through the debugger API.") },
    firefox: {
      caveat: {
        cause: C.BROWSER_API,
        reason: 'Firefox has no accessibility tree for extensions: Hermes reads the top page text and its list of controls with a content script, and nothing inside frames.',
        instead: 'Ask Hermes to work from the page text; copy anything inside a frame into the chat.',
      },
    },
  }),
  controlRow({
    id: 'control.navigate',
    label: 'Hermes Control: navigate, back and scroll',
    actions: NAVIGATE_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.BROWSER_API, 'Tabs and debugger APIs.') },
    firefox: {
      supported: cell(S.SUPPORTED, C.BROWSER_API, 'Tabs and scripting APIs.'),
      caveat: {
        cause: C.BROWSER_API,
        reason: 'Firefox scroll calls move a fixed distance in the page and ignore the amount argument Chromium honors.',
        instead: 'Repeat scroll for larger moves, or ask the person to scroll manually.',
      },
    },
  }),
  controlRow({
    id: 'control.tabs',
    label: 'Hermes Control: list, open, switch and close tabs',
    actions: TAB_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.BROWSER_API, 'Tabs API; only tabs you attached and tabs Hermes opened. Switching and closing ask you first.') },
    firefox: { supported: cell(S.SUPPORTED, C.BROWSER_API, 'Tabs API; only tabs you attached and tabs Hermes opened. Switching and closing ask you first.') },
  }),
  controlRow({
    id: 'control.screenshot',
    label: 'Hermes Control: screenshots',
    actions: SCREENSHOT_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.BROWSER_API, 'Captured through the debugger API, including a single element.') },
    firefox: {
      caveat: {
        cause: C.PERMISSION,
        reason: 'Firefox allows a capture only with all-sites access, which is optional and asked for from a click. Only the whole visible tab can be captured, and it must be the tab the window shows.',
        instead: 'Click Allow screenshots on Firefox in Settings, or have Hermes read the page text.',
      },
    },
  }),
  controlRow({
    id: 'control.pointer-keyboard',
    label: 'Hermes Control: clicks, typing and key presses',
    actions: POINTER_KEYBOARD_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.BROWSER_API, 'Real (trusted) input sent through the debugger API; Chrome shows its debugging banner while a tab is attached.') },
    firefox: {
      gap: {
        cause: C.BROWSER_API,
        reason: 'Firefox has no debugger API, so an extension cannot send trusted clicks, typing or key presses, and Hermes does not imitate them with page events.',
        instead: 'Hermes can read the page and open addresses; do the click or typing yourself, or use a Chromium browser for the task.',
      },
    },
  }),
  row(
    'control.frames',
    'control',
    'Hermes Control: controls inside frames',
    cell(S.LIMITED, C.BROWSER_API, 'Controls in same-site frames of an attached page. Frames from other sites run in their own process and are not read or acted on.', 'Open the framed page in its own tab.'),
    cell(S.UNAVAILABLE, C.BROWSER_API, 'Frame control needs the debugger API, which Firefox does not have; the page text Hermes reads leaves out frames.', 'Open the framed page in its own tab.'),
  ),
  controlRow({
    id: 'control.tab-groups',
    label: 'Hermes Control: tab groups',
    actions: GROUP_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.BROWSER_API, 'Groups the tabs Hermes opened so you can see them together.') },
    firefox: {
      gap: {
        cause: C.EXTENSION,
        reason: 'Firefox has the tabs.group call, but the Firefox adapter does not offer grouping yet.',
        instead: 'Hermes still opens and closes its own tabs; they are just not grouped.',
      },
    },
  }),
  controlRow({
    id: 'control.batch',
    label: 'Hermes Control: action batches',
    actions: BATCH_ACTIONS,
    chromium: { supported: cell(S.SUPPORTED, C.EXTENSION, 'Runs several steps in a row, each one judged and approved like a single action.') },
    firefox: {
      gap: {
        cause: C.EXTENSION,
        reason: 'The Firefox adapter does not offer batches yet, and most steps in a batch (clicks, typing) are unavailable there anyway.',
        instead: 'Hermes runs the steps one at a time.',
      },
    },
  }),
  row(
    'menus.context-menu',
    'menus',
    'Right-click menu',
    cell(S.SUPPORTED, C.BROWSER_API, 'A Hermes submenu on pages, selections, fields, links, images, video and audio. Ask, summarize, rewrite and your own items.'),
    cell(S.SUPPORTED, C.BROWSER_API, 'The same submenu, on the same kinds of target, through the contextMenus permission.', '', K.RUN),
  ),
  row(
    'menus.toolbar-button',
    'menus',
    'Toolbar button',
    cell(S.SUPPORTED, C.BROWSER_API, 'Opens the side panel.'),
    cell(S.SUPPORTED, C.BROWSER_API, 'Opens the sidebar, and closes it again when it is already open.'),
  ),
  row(
    'menus.open-shortcut',
    'menus',
    'Open shortcut: Alt+H',
    cell(S.SUPPORTED, C.BROWSER_API, 'Alt+H runs the toolbar button. Change it on the browser extension shortcuts page.', '', K.RUN),
    cell(S.SUPPORTED, C.BROWSER_API, 'Alt+H runs the toolbar button. Change it on about:addons under Manage Extension Shortcuts.', '', K.RUN),
  ),
  row(
    'menus.sidebar-shortcut',
    'menus',
    'Sidebar shortcut: Ctrl+Shift+H',
    cell(S.UNAVAILABLE, C.BROWSER_API, 'Chromium has no sidebar command, so the manifest entry registers nothing there.', 'Use Alt+H.', K.RUN),
    cell(S.SUPPORTED, C.BROWSER_API, 'Ctrl+Shift+H (Command+Shift+H on macOS) opens the sidebar.', '', K.RUN),
  ),
]);

const STATUS_RANK = Object.freeze({
  [S.UNAVAILABLE]: 0,
  [S.EXPERIMENTAL]: 1,
  [S.LIMITED]: 2,
  [S.SUPPORTED]: 3,
});

export function capabilityEngineOf(product) {
  const engine = String(product?.engine || '').trim();
  if (engine === 'gecko') return CAPABILITY_ENGINES.FIREFOX;
  if (engine === 'chromium') return CAPABILITY_ENGINES.CHROMIUM;
  return '';
}

export function capabilityMessageKey(rowId, part) {
  return `browser_limits.${String(rowId).replace(/[.-]/g, '_')}.${part}`;
}

function viewOf(source, engine) {
  const picked = source[engine];
  return Object.freeze({
    id: source.id,
    surface: source.surface,
    label: source.label,
    status: picked.status,
    cause: picked.cause,
    reason: picked.reason,
    instead: picked.instead,
    checked: picked.checked,
  });
}

export function capabilityRowsFor(engine) {
  if (!Object.values(CAPABILITY_ENGINES).includes(engine)) return [];
  return BROWSER_CAPABILITY_ROWS.map((source) => viewOf(source, engine));
}

// The rows where this browser does less than Chromium, worst first: what to tell a person before a task starts.
export function capabilityLimitsFor(engine) {
  if (!Object.values(CAPABILITY_ENGINES).includes(engine)) return [];
  const own = capabilityRowsFor(engine);
  const reference = capabilityRowsFor(CAPABILITY_ENGINES.CHROMIUM);
  return own
    .filter((entry, index) => STATUS_RANK[entry.status] < STATUS_RANK[reference[index].status] && entry.status !== S.SUPPORTED)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
}

const STATUS_WORD = Object.freeze({
  [S.SUPPORTED]: 'Supported',
  [S.LIMITED]: 'Limited',
  [S.EXPERIMENTAL]: 'Experimental',
  [S.UNAVAILABLE]: 'Unavailable',
});
const CAUSE_WORD = Object.freeze({
  [C.NONE]: 'Extension code',
  [C.BROWSER_API]: 'Browser API',
  [C.PERMISSION]: 'Permission',
  [C.GATEWAY]: 'Gateway',
  [C.TRANSPORT]: 'Transport',
  [C.EXTENSION]: 'Not offered by the extension',
});

export const CAPABILITY_DOCS_START = '<!-- capability-matrix:start (generated by npm run sync:capabilities) -->';
export const CAPABILITY_DOCS_END = '<!-- capability-matrix:end -->';

const mark = (entry) => `${STATUS_WORD[entry.status]}${entry.checked === K.UNCHECKED ? ' †' : ''}`;
const escapeCell = (text) => String(text).replace(/\|/g, '\\|');

// The tables guides/firefox.md carries. Generated, so the guide and the module cannot disagree.
export function capabilityDocsBlock() {
  const lines = [CAPABILITY_DOCS_START, ''];
  for (const surface of CAPABILITY_SURFACES) {
    lines.push(`### ${surface.label}`, '');
    lines.push('| Feature | Chromium | Firefox | Why on Firefox | Decided by | Instead |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const source of BROWSER_CAPABILITY_ROWS.filter((entry) => entry.surface === surface.id)) {
      const chromium = viewOf(source, CAPABILITY_ENGINES.CHROMIUM);
      const firefox = viewOf(source, CAPABILITY_ENGINES.FIREFOX);
      lines.push(`| ${escapeCell(source.label)} | ${mark(chromium)} | ${mark(firefox)} | ${escapeCell(firefox.reason)} | ${CAUSE_WORD[firefox.cause]} | ${escapeCell(firefox.instead || '-')} |`);
    }
    lines.push('');
  }
  const chromiumLimits = capabilityRowsFor(CAPABILITY_ENGINES.CHROMIUM).filter((entry) => entry.status !== S.SUPPORTED);
  lines.push('### What is not fully supported on Chromium', '');
  lines.push('| Feature | Chromium | Why | Instead |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of chromiumLimits) {
    lines.push(`| ${escapeCell(entry.label)} | ${mark(entry)} | ${escapeCell(entry.reason)} | ${escapeCell(entry.instead || '-')} |`);
  }
  lines.push('', CAPABILITY_DOCS_END);
  return lines.join('\n');
}
