import { mintTicketInPage, wsTicketUrl } from './dashboard-bridge.mjs';
import { buildDashboardWsUrlWithCredential, createGatewayClient, WS_EVENTS, WS_METHODS } from './gateway-ws.mjs';
import { extractDashboardSessionToken } from './model-discovery.mjs';
import {
  WAKE_MESSAGES,
  WAKE_STORAGE_KEYS,
  isLoopbackDashboardUrl,
  normalizeWakeStatus,
  normalizeWakeWordSettings,
} from './wake-word.mjs';
import { getBrowserApi } from './browser-api.mjs';

const LOCAL_DASHBOARD_URL = 'http://127.0.0.1:9119';
const NATIVE_WAKE_SESSION_ID = 'hermes-browser-wake';
const WAKE_REPLY_TIMEOUT_MS = 3 * 60 * 1000;

function runtimeVersion(chromeApi) {
  return chromeApi.runtime?.getManifest?.()?.version || '0.0.0';
}

function wakeListenerPath(chromeApi) {
  const serviceWorker = String(chromeApi.runtime?.getManifest?.()?.background?.service_worker || '');
  return serviceWorker.startsWith('extension/') ? 'extension/wake-listener.html' : 'wake-listener.html';
}

function publicState(state = {}) {
  return {
    enabled: Boolean(state.enabled),
    state: String(state.state || 'off'),
    mode: String(state.mode || 'off'),
    phrase: String(state.phrase || 'hey hermes'),
    provider: String(state.provider || ''),
    detail: String(state.detail || ''),
    updatedAt: Number(state.updatedAt || Date.now()),
  };
}

export function createWakeBackgroundController({
  chromeApi = getBrowserApi(),
  openPanel,
  gatewayClientFactory = createGatewayClient,
  fetchFn = globalThis.fetch?.bind(globalThis),
} = {}) {
  let currentSettings = normalizeWakeWordSettings({});
  let state = publicState({ state: 'off', mode: 'off' });
  let nativeClient = null;
  let nativeOffs = [];
  let nativeKeepalive = null;
  let replyTimer = null;
  const claimedTurnIds = new Set();
  let configuring = null;
  let configurationGeneration = 0;

  async function publish(next = {}) {
    state = publicState({ ...state, ...next, updatedAt: Date.now() });
    await chromeApi.storage.local.set({ [WAKE_STORAGE_KEYS.state]: state });
    chromeApi.runtime.sendMessage({ type: WAKE_MESSAGES.localState, ...state }).catch(() => null);
    return state;
  }

  function clearReplyTimer() {
    if (replyTimer) globalThis.clearTimeout(replyTimer);
    replyTimer = null;
  }

  function clearNativeConnection() {
    if (nativeKeepalive) globalThis.clearInterval(nativeKeepalive);
    nativeKeepalive = null;
    for (const off of nativeOffs.splice(0)) off?.();
    nativeClient?.close?.();
    nativeClient = null;
  }

  async function ensureOffscreenDocument() {
    if (!chromeApi.offscreen?.createDocument || !chromeApi.runtime?.getContexts) {
      return { ok: false, reason: 'offscreen-unavailable' };
    }
    const path = wakeListenerPath(chromeApi);
    const url = chromeApi.runtime.getURL(path);
    const contexts = await chromeApi.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (!contexts?.length) {
      await chromeApi.offscreen.createDocument({
        url: path,
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: 'Listen locally for an explicitly enabled wake phrase and speak wake-turn replies.',
      });
    }
    return { ok: true };
  }

  async function stopBrowserFallback() {
    await chromeApi.runtime.sendMessage({ type: WAKE_MESSAGES.configure, enabled: false }).catch(() => null);
    if (!chromeApi.offscreen?.closeDocument || !chromeApi.runtime?.getContexts) return;
    const path = wakeListenerPath(chromeApi);
    const url = chromeApi.runtime.getURL(path);
    const contexts = await chromeApi.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (contexts?.length) await chromeApi.offscreen.closeDocument();
  }

  async function configureBrowserFallback() {
    clearNativeConnection();
    const offscreen = await ensureOffscreenDocument();
    if (!offscreen.ok) {
      return publish({
        enabled: true,
        state: 'unavailable',
        mode: 'browser-local',
        phrase: currentSettings.phrase,
        provider: '',
        detail: 'Always-on browser wake listening requires Chromium offscreen-document support.',
      });
    }
    await publish({
      enabled: true,
      state: 'arming',
      mode: 'browser-local',
      phrase: currentSettings.phrase,
      provider: 'browser-local',
      detail: 'Preparing the browser-local wake listener…',
    });
    chromeApi.runtime.sendMessage({
      type: WAKE_MESSAGES.configure,
      enabled: true,
      phrase: currentSettings.phrase,
      language: 'en-US',
    }).catch((error) => publish({
      state: 'unavailable',
      detail: error?.message || String(error),
    }));
    return state;
  }

  async function localDashboardTab(baseUrl = LOCAL_DASHBOARD_URL) {
    if (!isLoopbackDashboardUrl(baseUrl) || !chromeApi.tabs?.query) return null;
    const origin = new URL(baseUrl).origin;
    const tabs = await chromeApi.tabs.query({});
    return (tabs || []).find((tab) => {
      try {
        return tab?.id != null
          && !tab.discarded
          && tab.status === 'complete'
          && new URL(String(tab.url || '')).origin === origin;
      } catch {
        return false;
      }
    }) || null;
  }

  async function mintLocalTicket(baseUrl = LOCAL_DASHBOARD_URL) {
    const tab = await localDashboardTab(baseUrl);
    if (!tab?.id || !chromeApi.scripting?.executeScript) return { ok: false, reason: 'no-local-dashboard-tab' };
    const [injection] = await chromeApi.scripting.executeScript({
      target: { tabId: tab.id },
      func: mintTicketInPage,
      args: [wsTicketUrl(baseUrl)],
    });
    return injection?.result || { ok: false, reason: 'no-ticket-result' };
  }

  async function localDashboardCredential(baseUrl = LOCAL_DASHBOARD_URL) {
    try {
      const response = await fetchFn?.(`${baseUrl.replace(/\/+$/, '')}/`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
        redirect: 'error',
        headers: { Accept: 'text/html' },
      });
      if (response?.ok) {
        const token = extractDashboardSessionToken(await response.text());
        if (token) return { ok: true, name: 'token', value: token };
      }
    } catch {
      // Gated dashboards do not expose the loopback token; try a browser ticket.
    }
    const minted = await mintLocalTicket(baseUrl).catch((error) => ({ ok: false, reason: error?.message || String(error) }));
    if (minted.ok && minted.ticket) return { ok: true, name: 'ticket', value: minted.ticket };
    return { ok: false, reason: minted.reason || 'dashboard-auth-unavailable' };
  }

  async function resumeNative() {
    if (!nativeClient) return;
    try {
      await nativeClient.request(WS_METHODS.wakeResume, {});
      await publish({ state: 'listening', detail: `Listening locally for “${state.phrase}”.` });
    } catch (error) {
      await publish({ state: 'degraded', detail: error?.message || String(error) });
    }
  }

  async function openWakeSurface() {
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    await openPanel?.(tab || null, { allowFallback: true });
  }

  async function queueWakeTurn(text, mode) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return false;
    clearReplyTimer();
    const turn = {
      id: globalThis.crypto?.randomUUID?.() || `wake-${Date.now()}`,
      text: cleanText,
      mode,
      speakReplies: currentSettings.speakReplies,
      createdAt: Date.now(),
    };
    await chromeApi.storage.local.set({ [WAKE_STORAGE_KEYS.turn]: turn });
    await publish({ state: 'processing', detail: 'Wake command captured.' });
    const turnReadyMessage = { type: WAKE_MESSAGES.turnReady, turn };
    const delivered = await chromeApi.runtime.sendMessage(turnReadyMessage)
      .then((result) => result?.accepted === true)
      .catch(() => false);
    if (!delivered) {
      await publish({ state: 'processing', detail: 'Wake command captured. Opening Hermes…' });
      await openWakeSurface();
      await chromeApi.runtime.sendMessage(turnReadyMessage).catch(() => null);
    }
    replyTimer = globalThis.setTimeout(async () => {
      if (mode === 'native') await resumeNative();
      else await chromeApi.runtime.sendMessage({ type: WAKE_MESSAGES.resumeLocal }).catch(() => null);
    }, WAKE_REPLY_TIMEOUT_MS);
    replyTimer?.unref?.();
    return true;
  }

  async function handleNativeWake() {
    if (!nativeClient) return;
    await publish({ state: 'capturing', detail: 'Wake phrase heard. Listening for your command…' });
    try {
      await nativeClient.request(WS_METHODS.voiceToggle, { action: 'on' });
      await nativeClient.request(WS_METHODS.voiceRecord, { action: 'start', session_id: NATIVE_WAKE_SESSION_ID });
    } catch (error) {
      await publish({ state: 'degraded', detail: error?.message || String(error) });
      await resumeNative();
    }
  }

  async function handleNativeTranscript(event = {}) {
    const payload = event?.payload || {};
    if (payload.stop_phrase || payload.no_speech_limit) {
      await resumeNative();
      return;
    }
    const text = String(payload.text || '').trim();
    if (!text) return;
    try {
      await nativeClient?.request(WS_METHODS.wakePause, {});
    } catch {
      // The recorder may already have paused or resumed the detector.
    }
    await queueWakeTurn(text, 'native');
  }

  async function tryNativeWake() {
    const baseUrl = LOCAL_DASHBOARD_URL;
    const credential = await localDashboardCredential(baseUrl);
    if (!credential.ok) return { ok: false, reason: credential.reason || 'dashboard-auth-unavailable' };
    const client = gatewayClientFactory({
      clientName: 'hermes-browser-wake',
      clientVersion: runtimeVersion(chromeApi),
      requestTimeoutMs: 180_000,
      readyTimeoutMs: 30_000,
    });
    nativeOffs = [
      client.on(WS_EVENTS.wakeDetected, handleNativeWake),
      client.on(WS_EVENTS.voiceTranscript, handleNativeTranscript),
      client.on('close', () => {
        if (currentSettings.enabled) configureBrowserFallback().catch(() => null);
      }),
    ];
    nativeClient = client;
    try {
      await client.connect(buildDashboardWsUrlWithCredential(baseUrl, credential.name, credential.value));
      const status = normalizeWakeStatus(await client.request(WS_METHODS.wakeStatus, {}));
      if (!status.available) throw new Error(status.hint || 'Hermes native wake word is unavailable.');
      const started = await client.request(WS_METHODS.wakeStart, {
        surface: 'gui',
        persist: true,
        session_id: NATIVE_WAKE_SESSION_ID,
      });
      if (!started?.started) {
        const owner = String(started?.owner_surface || '').trim();
        throw new Error(started?.reason === 'owned'
          ? `Wake-word microphone is already owned${owner ? ` by ${owner}` : ''}.`
          : String(started?.reason || 'Hermes refused to start the wake listener.'));
      }
      nativeKeepalive = globalThis.setInterval(() => {
        nativeClient?.request(WS_METHODS.wakeStatus, {}).catch(() => null);
      }, 20_000);
      nativeKeepalive?.unref?.();
      return { ok: true, started, status };
    } catch (error) {
      for (const off of nativeOffs.splice(0)) off?.();
      client.close();
      if (nativeClient === client) nativeClient = null;
      return { ok: false, reason: error?.message || String(error) };
    }
  }

  async function configure(settings = {}) {
    currentSettings = normalizeWakeWordSettings(settings);
    const generation = ++configurationGeneration;
    clearReplyTimer();
    if (!currentSettings.enabled) {
      if (nativeClient) {
        await nativeClient.request(WS_METHODS.wakeStop, { persist: true }).catch(() => null);
      }
      clearNativeConnection();
      await stopBrowserFallback();
      return publish({ enabled: false, state: 'off', mode: 'off', phrase: currentSettings.phrase, provider: '', detail: 'Wake word is off.' });
    }
    await publish({ enabled: true, state: 'arming', mode: 'selecting', phrase: currentSettings.phrase, detail: 'Selecting the safest wake listener…' });
    if (currentSettings.preferNative) {
      await stopBrowserFallback();
      await publish({ state: 'arming', mode: 'native', detail: 'Starting Hermes’ native wake engine…' });
      tryNativeWake().then(async (native) => {
        if (generation !== configurationGeneration || !currentSettings.enabled) {
          if (native.ok) clearNativeConnection();
          return;
        }
        if (native.ok) {
          const phrase = String(native.started?.phrase || native.status?.phrase || currentSettings.phrase);
          await publish({
            enabled: true,
            state: 'listening',
            mode: 'native',
            phrase,
            provider: String(native.started?.provider || native.status?.provider || 'hermes-native'),
            detail: `Hermes native wake engine is listening for “${phrase}”.`,
          });
          return;
        }
        if (currentSettings.browserFallback) await configureBrowserFallback();
        else await publish({ state: 'unavailable', mode: 'native', detail: native.reason });
      }).catch(async (error) => {
        if (generation !== configurationGeneration || !currentSettings.enabled) return;
        if (currentSettings.browserFallback) await configureBrowserFallback();
        else await publish({ state: 'unavailable', mode: 'native', detail: error?.message || String(error) });
      });
      return state;
    }
    return configureBrowserFallback();
  }

  function configureSerialized(settings = {}) {
    const task = (configuring || Promise.resolve()).catch(() => null).then(() => configure(settings));
    configuring = task;
    task.then(
      () => { if (configuring === task) configuring = null; },
      () => { if (configuring === task) configuring = null; },
    );
    return task;
  }

  async function setEnabled(enabled, settings = {}) {
    const stored = await chromeApi.storage.local.get('hermesBrowserSettings');
    const merged = { ...(stored?.hermesBrowserSettings || {}), ...settings, wakeWordEnabled: Boolean(enabled) };
    await chromeApi.storage.local.set({ hermesBrowserSettings: merged });
    return configureSerialized(merged);
  }

  async function handleLocalState(message = {}) {
    if (state.mode !== 'browser-local' && message.mode !== 'browser-local') return state;
    return publish({
      enabled: currentSettings.enabled,
      state: message.state || state.state,
      mode: 'browser-local',
      phrase: currentSettings.phrase,
      provider: message.provider || 'browser-local',
      detail: message.detail || state.detail,
    });
  }

  async function handleReply(message = {}) {
    clearReplyTimer();
    const text = String(message.text || '').trim();
    try {
      if (state.mode === 'native') {
        if (currentSettings.speakReplies && text) await nativeClient?.request(WS_METHODS.voiceTts, { text });
        await resumeNative();
      } else {
        if (currentSettings.speakReplies && text) {
          await chromeApi.runtime.sendMessage({ type: WAKE_MESSAGES.speak, text }).catch(() => null);
        } else {
          await chromeApi.runtime.sendMessage({ type: WAKE_MESSAGES.resumeLocal }).catch(() => null);
        }
      }
    } catch (error) {
      if (state.mode === 'native') await resumeNative();
      else await chromeApi.runtime.sendMessage({ type: WAKE_MESSAGES.resumeLocal }).catch(() => null);
      await publish({ state: 'degraded', detail: error?.message || String(error) });
    }
    return { ok: true };
  }

  async function claimWakeTurn(message = {}) {
    const turnId = String(message.turnId || '').trim();
    if (!turnId || claimedTurnIds.has(turnId)) return { claimed: false };
    claimedTurnIds.add(turnId);
    const stored = await chromeApi.storage.local.get(WAKE_STORAGE_KEYS.turn);
    if (String(stored?.[WAKE_STORAGE_KEYS.turn]?.id || '') !== turnId) {
      claimedTurnIds.delete(turnId);
      return { claimed: false };
    }
    if (claimedTurnIds.size > 100) claimedTurnIds.delete(claimedTurnIds.values().next().value);
    await chromeApi.storage.local.remove(WAKE_STORAGE_KEYS.turn);
    return { claimed: true, surface: String(message.surface || '') };
  }

  async function handleMessage(message = {}) {
    if (message.type === WAKE_MESSAGES.getState) return state;
    if (message.type === WAKE_MESSAGES.claimTurn) return claimWakeTurn(message);
    if (message.type === WAKE_MESSAGES.setEnabled) return setEnabled(message.enabled, message.settings);
    if (message.type === WAKE_MESSAGES.localDetected) return queueWakeTurn(message.text, 'browser-local');
    if (message.type === WAKE_MESSAGES.localState) return handleLocalState(message);
    if (message.type === WAKE_MESSAGES.turnReply) return handleReply(message);
    return null;
  }

  async function restore() {
    const stored = await chromeApi.storage.local.get('hermesBrowserSettings');
    return configureSerialized(stored?.hermesBrowserSettings || {});
  }

  return { configure: configureSerialized, handleMessage, restore, state: () => state };
}
