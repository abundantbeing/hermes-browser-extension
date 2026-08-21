import {
  CONTROLLER_ADAPTER_IDS,
} from './browser-controller-adapter.mjs';
import {
  createChromiumCdpAdapter,
  createFirefoxWebExtensionAdapter,
} from './browser-control-browser-adapters.mjs';
import { createBrowserControlExecutor } from './browser-control-executor.mjs';
import { createBrowserControlApprovalStore } from './browser-control-safety.mjs';
import { createBrowserControlRefStore } from './browser-control-refs.mjs';
import { CONTROLLER_NOOP_CAPABILITY } from './controller-protocol.mjs';
import { withBrowserControlIndicator } from './browser-control-indicators.mjs';


function disabledStatus(reason = 'disabled') {
  return {
    ok: true,
    enabled: false,
    reason,
    capabilities: [CONTROLLER_NOOP_CAPABILITY],
  };
}

export function createBrowserControlRuntime({
  browserApi,
  product = {},
  now = Date.now,
  approvalStore = undefined,
  refStore = undefined,
  artifactClientFactory = undefined,
} = {}) {
  if (!browserApi?.tabs) throw new TypeError('Browser tabs API is required.');
  const engine = String(product?.engine || '').trim();
  const refs = refStore || createBrowserControlRefStore();
  const approvals = approvalStore || createBrowserControlApprovalStore({ now });
  let debuggerDetachHandler = () => {};
  const baseAdapter = engine === 'chromium'
    ? createChromiumCdpAdapter({
      browserApi,
      onDebuggerDetach: (event) => debuggerDetachHandler(event),
    })
    : (engine === 'gecko' ? createFirefoxWebExtensionAdapter({ browserApi }) : null);
  const runtimeAdapter = baseAdapter
    ? withBrowserControlIndicator({ adapter: baseAdapter, tabsApi: browserApi.tabs })
    : null;

  function adapterForEngine() {
    return runtimeAdapter;
  }

  async function status(settings = {}) {
    if (settings?.browserControlEnabled !== true) return disabledStatus('disabled');
    const adapter = adapterForEngine();
    if (!adapter?.contract?.enabled) return disabledStatus('adapter_unavailable');
    return {
      ok: true,
      enabled: true,
      adapterId: adapter.contract.id,
      capabilities: [CONTROLLER_NOOP_CAPABILITY, ...adapter.contract.actions],
      gaps: adapter.contract.gaps || [],
    };
  }

  async function enable() {
    const current = await status({ browserControlEnabled: true });
    return current.enabled ? current : { ...current, ok: false };
  }

  async function disable() {
    refs.clear();
    return disabledStatus('disabled');
  }

  async function executor(settings = {}) {
    const current = await status(settings);
    if (!current.enabled) return null;
    const adapter = adapterForEngine();
    let artifacts = null;
    if (typeof artifactClientFactory === 'function') {
      try {
        artifacts = artifactClientFactory(settings) || null;
      } catch {
        artifacts = null;
      }
    }
    return createBrowserControlExecutor({
      adapter,
      approvals,
      refs,
      artifacts,
      now,
      developerMode: settings?.browserControlDeveloperMode === true,
      cdpPolicy: settings?.browserControlCdpPolicy || null,
    });
  }

  async function execute(frame, context = {}, settings = {}) {
    const active = await executor(settings);
    if (!active) {
      return {
        ok: false,
        error: { code: 'action_disabled', message: 'Browser control is not enabled with the required permission.' },
      };
    }
    return active.execute(frame, { ...context, scope: context.scope });
  }

  function setDebuggerDetachHandler(handler) {
    debuggerDetachHandler = typeof handler === 'function' ? handler : () => {};
  }

  function dispose() {
    debuggerDetachHandler = () => {};
    runtimeAdapter?.dispose?.();
    refs.clear();
    approvals.clear?.();
  }

  return {
    status,
    enable,
    disable,
    executor,
    execute,
    setDebuggerDetachHandler,
    dispose,
    approvals,
    refs,
    adapterId: engine === 'chromium'
      ? CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP
      : (engine === 'gecko' ? CONTROLLER_ADAPTER_IDS.FIREFOX_WEBEXTENSION : CONTROLLER_ADAPTER_IDS.UNSUPPORTED),
  };
}
