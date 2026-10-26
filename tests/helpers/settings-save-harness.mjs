import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createHermesClient } from '../../extension/lib/hermes-client.mjs';

const extensionUrl = new URL('../../extension/', import.meta.url);
const html = readFileSync(new URL('sidepanel.html', extensionUrl), 'utf8');
const source = readFileSync(new URL('sidepanel.js', extensionUrl), 'utf8');

export const sidepanelHtml = html;
export const sidepanelSource = source;

// The functions of sidepanel.js that are plain top-level declarations, by name.
function topLevelFunctions() {
  const found = new Map();
  const head = /^(?:async )?function\*? ([A-Za-z0-9_$]+)\(/gm;
  let match;
  while ((match = head.exec(source))) {
    const end = source.indexOf('\n}\n', match.index);
    found.set(match[1], source.slice(match.index, end + 2));
  }
  return found;
}

function importedNames() {
  const specs = [];
  const pattern = /import\s*\{([\s\S]*?)\}\s*from\s*'(\.\/lib\/[^']+)';/g;
  let match;
  while ((match = pattern.exec(source))) {
    const names = match[1].split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [imported, local] = part.split(/\s+as\s+/);
      return [imported.trim(), (local || imported).trim()];
    });
    specs.push({ specifier: match[2], names });
  }
  return specs;
}

// Runs the real saveSettingsFromForm() from sidepanel.js against the real
// #settingsForm markup. Everything it reaches that touches the network, the
// service worker or the rest of the panel is a recorded stub; the form
// reading, normalisation and persistence code is the shipped code.
export async function createSettingsSaveHarness({ settings: initial = {}, storage = {} } = {}) {
  const dom = new JSDOM(html, { url: 'chrome-extension://hermes/sidepanel.html' });
  const { document } = dom.window;

  const calls = [];
  const record = (name, value) => (...args) => {
    calls.push({ name, args });
    return typeof value === 'function' ? value(...args) : value;
  };
  const store = { ...storage };
  const browserApi = {
    storage: {
      local: {
        get: async (key) => (typeof key === 'string' ? { [key]: structuredClone(store[key]) } : structuredClone(store)),
        set: async (patch) => { Object.assign(store, structuredClone(patch)); },
      },
    },
  };

  const imported = new Map();
  for (const { specifier, names } of importedNames()) {
    let module;
    try {
      module = await import(new URL(specifier, extensionUrl).href);
    } catch {
      continue;
    }
    for (const [name, local] of names) if (name in module) imported.set(local, module[name]);
  }

  const functions = topLevelFunctions();
  const target = {
    document,
    browserApi,
    availableModels: [],
    settings: { ...imported.get('DEFAULT_SETTINGS'), ...initial },
    connectionController: { cancel: record('connectionController.cancel') },
    remoteWsConnection: null,
    profileWsConnection: null,
    activeDashboardWsConnection: null,
    activeConversationTransport: 'rest',
    liveSessionRows: new Map(),
    liveDiscoveredSessions: [],
    desktopDashboardUrl: 'cached-dashboard',
    trustedDashboardTabId: 7,
    botModeRosterGeneration: 0,
    botModeRoster: [{ name: 'someone' }],
    customThemeStoreState: { ok: true, status: 'empty', themes: [] },
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    // Stubs for what Save triggers beyond writing settings.
    renderBotModeRoster: record('renderBotModeRoster'),
    refreshContextConsentPrincipal: record('refreshContextConsentPrincipal', async () => undefined),
    currentContextConsentIdentity: record('currentContextConsentIdentity', () => null),
    persistContextConsentDecision: record('persistContextConsentDecision', async () => ({})),
    panelAppearancePreferences: () => ({}),
    applyAppearanceSettings: record('applyAppearanceSettings'),
    setWakeWordEnabled: record('setWakeWordEnabled', async () => undefined),
    maybeRenameCurrentSessionTitle: record('maybeRenameCurrentSessionTitle', async () => undefined),
    syncSettingsForm: record('syncSettingsForm'),
    // The Hermes Web sign-in the panel keeps: Save only tells it what the setting now says.
    webappCredentials: null,
    webappGatewayTicketSource: null,
    webappListeners: new Map(),
    lastWebappCaptureAt: 0,
    WEBAPP_CAPTURE_THROTTLE_MS: 4000,
    applyWebappCredentialPreference: record('applyWebappCredentialPreference', async () => undefined),
    updateConnectionPrompt: record('updateConnectionPrompt'),
    getAgentPorts: () => target.settings.agentPorts || imported.get('DEFAULT_SETTINGS')?.agentPorts || [8642],
  };
  const compiled = new Map();
  const scope = new Proxy(target, {
    has: (obj, key) => typeof key === 'string' && (key in obj || imported.has(key) || functions.has(key)),
    get: (obj, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in obj) return obj[key];
      if (imported.has(key)) return imported.get(key);
      if (functions.has(key)) {
        if (!compiled.has(key)) {
          // eslint-disable-next-line no-new-func
          compiled.set(key, new Function('scope', `with (scope) { return (${functions.get(key)}); }`)(scope));
        }
        return compiled.get(key);
      }
      return undefined;
    },
    set: (obj, key, value) => { obj[key] = value; return true; },
  });

  const elsSource = source.slice(source.indexOf('const els = {'), source.indexOf('\n};', source.indexOf('const els = {')) + 3);
  // eslint-disable-next-line no-new-func
  target.els = new Function('document', '$', `${elsSource}; return els;`)(document, (selector) => document.querySelector(selector));

  const save = scope.saveSettingsFromForm;
  const client = createHermesClient({
    fetchImpl: async (url, init) => { calls.push({ name: 'fetch', args: [url, init] }); return { ok: true }; },
    getConnection: () => target.settings,
  });

  return {
    els: target.els,
    document,
    calls,
    store,
    scope: target,
    save,
    fn: (name) => scope[name],
    client,
    callsTo: (name) => calls.filter((call) => call.name === name),
    close: () => dom.window.close(),
  };
}
