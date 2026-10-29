// The names the model knows Hermes Control's tools by.
//
// On the wire every action keeps its protocol name (browser_click, browser_tabs, ...). A Hermes
// with extension control in core registers its tools under those same names. Through the Hermes
// Browser Extension plugin they are tab_* instead, because Hermes' own Camofox plugin owns
// browser_navigate, browser_click and the rest, and two plugins cannot share a tool name. Text the
// extension writes for the model (an error's advice, a snapshot's "call browser_snapshot" line)
// names the tool the model actually has, so it follows the route control is connected through.
// companion-plugin/control_schemas.py holds the same table; a test keeps the two equal.

export const PLUGIN_TOOL_NAMES = Object.freeze({
  browser_back: 'tab_back',
  browser_batch: 'tab_batch',
  browser_click: 'tab_click',
  browser_drag: 'tab_drag',
  browser_fill: 'tab_fill',
  browser_hover: 'tab_hover',
  browser_navigate: 'tab_navigate',
  browser_press: 'tab_press',
  browser_screenshot: 'tab_screenshot',
  browser_scroll: 'tab_scroll',
  browser_scroll_to: 'tab_scroll_to',
  browser_select: 'tab_select',
  browser_snapshot: 'tab_snapshot',
  browser_tab_activate: 'tab_activate',
  browser_tab_close: 'tab_close',
  browser_tab_create: 'tab_create',
  browser_tab_group: 'tab_group',
  browser_tab_ungroup: 'tab_ungroup',
  browser_tabs: 'tab_list',
  browser_type: 'tab_type',
});

export const CONTROL_TOOL_FAMILIES = Object.freeze({ core: 'core', plugin: 'plugin' });

let family = CONTROL_TOOL_FAMILIES.core;

/** Set by the controller worker when it connects: 'plugin' through the plugin's route, else 'core'. */
export function setControlToolFamily(value) {
  family = value === CONTROL_TOOL_FAMILIES.plugin ? CONTROL_TOOL_FAMILIES.plugin : CONTROL_TOOL_FAMILIES.core;
  return family;
}

export function controlToolFamily() {
  return family;
}

/** The model-facing name of one wire action, for `forFamily` (default: the connected route's). */
export function controlToolName(action, forFamily = family) {
  const name = String(action || '');
  return forFamily === CONTROL_TOOL_FAMILIES.plugin ? (PLUGIN_TOOL_NAMES[name] || name) : name;
}
