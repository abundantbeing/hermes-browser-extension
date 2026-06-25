const statusEl = document.getElementById('permissionStatus');
const allowButton = document.getElementById('allowMicrophoneButton');
const settingsButton = document.getElementById('openMicrophoneSettingsButton');
const closeButton = document.getElementById('closePermissionButton');

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

async function microphonePermissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    return permission.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

function microphoneSettingsUrl() {
  const site = encodeURIComponent(`chrome-extension://${chrome.runtime.id}/`);
  return `chrome://settings/content/siteDetails?site=${site}`;
}

async function openMicrophoneSettings() {
  const url = microphoneSettingsUrl();
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function requestMicrophonePermission() {
  allowButton.disabled = true;
  setStatus('Opening Chromium microphone permission prompt…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    stopStream(stream);
    const state = await microphonePermissionState();
    if (state === 'granted' || state === 'unknown') {
      setStatus('Microphone access is enabled. Return to the Hermes side panel and click the mic again, or use the Hermes Voice Dictation tab if sidepanel capture is still blocked.');
      return;
    }
    setStatus(`Microphone permission state: ${state}. If Chromium shows this as blocked, open microphone settings and set Microphone to Allow for Hermes Browser Extension.`);
  } catch (error) {
    setStatus(`Microphone permission was not granted.\n\n${error?.message || String(error)}\n\nClick Open microphone settings, set Microphone to Allow for Hermes Browser Extension, return here, and try again.`);
  } finally {
    allowButton.disabled = false;
  }
}

allowButton?.addEventListener('click', requestMicrophonePermission);
settingsButton?.addEventListener('click', openMicrophoneSettings);
closeButton?.addEventListener('click', () => window.close());

(async () => {
  const state = await microphonePermissionState();
  if (state === 'granted') {
    setStatus('Microphone access is already enabled for Hermes Browser Extension.');
    return;
  }
  setStatus('Click Allow microphone to request access. Chromium requires this request to happen from a visible extension page.');
})();
