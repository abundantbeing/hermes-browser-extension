import { extractDashboardSessionToken } from './model-discovery.mjs';

// One-click recovery for a gateway process that is still running pre-update
// code. Hermes only rewrites files on disk; the old process keeps its loaded
// modules, so a later turn can import a symbol the stale module never had.
// Restarting the gateway is the only cure, and it interrupts every running
// turn, so callers must put an explicit confirmation in front of this.

export const GATEWAY_RESTART_PATH = '/api/gateway/restart';
// A real restart drains, disconnects every platform adapter, then reconnects
// them all: ~85s measured on a multi-profile install. Wait well past that.
export const GATEWAY_RESTART_WAIT_MS = 180_000;

function withTimeout(fetchFn, url, options, timeoutMs) {
  if (typeof AbortSignal?.timeout !== 'function') return fetchFn(url, options);
  return fetchFn(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function readStatus(fetchFn, base, timeoutMs = 2_500) {
  try {
    const response = await withTimeout(fetchFn, `${base}/api/status`, {
      method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store',
    }, timeoutMs);
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function bootIdOf(status) {
  return String(status?.memory?.boot_id || status?.boot_id || '').trim();
}

function gatewayIsRunning(status) {
  return status?.gateway_running === true && String(status?.gateway_state || 'running') === 'running';
}

/**
 * Poll the dashboard until the gateway is a new, running process.
 *
 * `onProgress({ stage })` reports `stopping` (old process still answering or
 * dashboard unreachable) and `starting` (new process up, gateway not running
 * yet). Without a boot id to compare, only a down-then-up transition proves
 * the old process was replaced rather than still answering.
 */
export async function waitForGatewayReturn({
  baseUrl = '',
  beforeBootId = '',
  fetchFn = globalThis.fetch?.bind(globalThis),
  waitMs = GATEWAY_RESTART_WAIT_MS,
  pollMs = 1_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onProgress = () => {},
  shouldStop = () => false,
  quietStart = false,
} = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const before = String(beforeBootId || '').trim();
  const deadline = Date.now() + Math.max(1_000, Number(waitMs) || GATEWAY_RESTART_WAIT_MS);
  let sawDown = false;
  let lastStage = '';
  const stage = (next) => {
    if (next === lastStage) return;
    lastStage = next;
    try { onProgress({ stage: next }); } catch { /* UI hook only */ }
  };
  // A passive watcher must not announce a restart that has not started yet.
  if (!quietStart) stage('stopping');
  while (Date.now() < deadline) {
    if (shouldStop()) return { ok: false, reason: 'stopped', beforeBootId: before };
    const status = await readStatus(fetchFn, base, 1_500);
    if (!status) {
      sawDown = true;
      stage('stopping');
    } else {
      const now = bootIdOf(status);
      const replaced = before && now ? now !== before : sawDown;
      if (replaced && gatewayIsRunning(status)) return { ok: true, bootId: now };
      if (replaced) stage('starting');
      else if (!gatewayIsRunning(status)) { sawDown = true; stage('stopping'); }
    }
    await sleep(pollMs);
  }
  return { ok: false, reason: 'timeout', beforeBootId: before };
}

/**
 * Restart the local Hermes gateway through the dashboard and wait until a new
 * process is serving. Resolves `{ ok: true }` only after the gateway is
 * replaced and running, so the panel never claims a restart that did not
 * happen.
 *
 * Failure reasons: `no-dashboard`, `no-token`, `rejected`, `unreachable`,
 * `timeout` (carries `beforeBootId` so a later check can still confirm it).
 */
/**
 * Passive watch for a restart nobody clicked for (terminal, Desktop, another
 * client). Baselines the running gateway, stays silent while it is healthy,
 * reports `stopping`/`starting` once it goes down, and resolves `{ ok: true }`
 * when a new process is running. Costs one loopback /api/status per poll and
 * ends as soon as `shouldStop()` is true.
 */
export async function watchGatewayRestart({
  baseUrl = '',
  fetchFn = globalThis.fetch?.bind(globalThis),
  waitMs = 30 * 60_000,
  pollMs = 2_000,
  sleep,
  onProgress = () => {},
  shouldStop = () => false,
} = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base || typeof fetchFn !== 'function') return { ok: false, reason: 'no-dashboard' };
  const baseline = bootIdOf(await readStatus(fetchFn, base));
  return waitForGatewayReturn({
    baseUrl: base, beforeBootId: baseline, fetchFn, waitMs, pollMs, sleep, onProgress, shouldStop, quietStart: true,
  });
}

export async function restartGatewayViaDashboard({
  baseUrl = '',
  profile = '',
  fetchFn = globalThis.fetch?.bind(globalThis),
  waitMs = GATEWAY_RESTART_WAIT_MS,
  pollMs = 1_000,
  sleep,
  onProgress = () => {},
  dashboardToken = '',
} = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base || typeof fetchFn !== 'function') return { ok: false, reason: 'no-dashboard' };

  let token = '';
  try {
    const root = await withTimeout(fetchFn, base, { headers: { Accept: 'text/html' }, cache: 'no-store' }, 2_500);
    token = extractDashboardSessionToken(await root.text()) || String(dashboardToken || '').trim();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!token) return { ok: false, reason: 'no-token' };

  const before = bootIdOf(await readStatus(fetchFn, base));
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  let response;
  try {
    response = await withTimeout(fetchFn, `${base}${GATEWAY_RESTART_PATH}${query}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Hermes-Session-Token': token },
      credentials: 'include',
      cache: 'no-store',
    }, 10_000);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!response.ok) return { ok: false, reason: 'rejected', status: response.status };

  return waitForGatewayReturn({ baseUrl: base, beforeBootId: before, fetchFn, waitMs, pollMs, sleep, onProgress });
}

const RESTART_FAILURE_COPY = {
  'no-dashboard': 'Browser could not find the local Hermes dashboard. Run `hermes gateway restart` in a terminal.',
  'no-token': 'The Hermes dashboard did not accept Browser. Run `hermes gateway restart` in a terminal.',
  rejected: 'Hermes refused the restart request. Run `hermes gateway restart` in a terminal.',
  unreachable: 'Browser could not reach the Hermes dashboard. Run `hermes gateway restart` in a terminal.',
  timeout: 'Hermes is taking longer than usual to come back. Check again, or run `hermes gateway restart` in a terminal.',
};

export function gatewayRestartFailureText(reason = '') {
  return RESTART_FAILURE_COPY[reason] || RESTART_FAILURE_COPY.unreachable;
}

const STAGE_COPY = {
  stopping: 'Stopping the gateway…',
  starting: 'Starting Hermes and reconnecting…',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildCheckmark(doc) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'gateway-restart-check');
  svg.setAttribute('aria-hidden', 'true');
  const ring = doc.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '12'); ring.setAttribute('cy', '12'); ring.setAttribute('r', '10');
  ring.setAttribute('class', 'gateway-restart-check-ring');
  const tick = doc.createElementNS(SVG_NS, 'path');
  tick.setAttribute('d', 'M7 12.5l3.2 3.2L17 8.8');
  tick.setAttribute('class', 'gateway-restart-check-tick');
  svg.append(ring, tick);
  return svg;
}

/**
 * Inline restart control for the "Hermes was updated" failure bubble.
 * Two-step on purpose: a restart interrupts every turn running through this
 * gateway (other agents, Telegram, cron), so one click only arms it.
 *
 * Phases: idle -> armed -> working -> done. If the wait runs out the gateway
 * may still be coming up, so the control becomes `stalled` and `check`
 * re-polls without restarting a second time. The button never silently
 * returns to "Restart Hermes" after a restart was issued.
 */
export function createGatewayRestartAction({
  document: doc = globalThis.document,
  restart,
  check = null,
  watch = null,
  translate = (value) => value,
  onRestarted = () => {},
  now = () => Date.now(),
} = {}) {
  const root = doc.createElement('div');
  root.className = 'gateway-restart-action';

  const progress = doc.createElement('div');
  progress.className = 'gateway-restart-progress';
  progress.hidden = true;
  const track = doc.createElement('span');
  track.className = 'gateway-restart-track';
  track.setAttribute('aria-hidden', 'true');
  const bar = doc.createElement('span');
  bar.className = 'gateway-restart-bar';
  track.append(bar);
  const timer = doc.createElement('span');
  timer.className = 'gateway-restart-timer';
  progress.append(track, timer);

  const success = doc.createElement('div');
  success.className = 'gateway-restart-success';
  success.hidden = true;
  const successText = doc.createElement('span');
  successText.className = 'gateway-restart-success-text';
  success.append(buildCheckmark(doc), successText);

  const note = doc.createElement('p');
  note.className = 'gateway-restart-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');

  const row = doc.createElement('div');
  row.className = 'gateway-restart-buttons';
  const primary = doc.createElement('button');
  primary.type = 'button';
  primary.className = 'secondary tiny gateway-restart-primary';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary tiny gateway-restart-cancel';
  cancel.textContent = translate('Cancel');
  cancel.hidden = true;
  row.append(primary, cancel);
  root.append(progress, success, note, row);

  let phase = 'idle';
  let stage = 'stopping';
  let startedAt = 0;
  let ticker = null;
  let beforeBootId = '';
  let failureNote = '';
  let userDriven = false;
  const createdAt = now();

  const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
  const paintTimer = () => {
    timer.textContent = `${Math.max(0, Math.floor((now() - startedAt) / 1000))}s`;
  };
  const paint = () => {
    root.dataset.phase = phase;
    root.dataset.stage = phase === 'working' ? stage : '';
    cancel.hidden = phase !== 'armed';
    progress.hidden = phase !== 'working';
    success.hidden = phase !== 'done';
    row.hidden = phase === 'done';
    primary.disabled = phase === 'working';
    if (phase === 'idle') {
      primary.textContent = translate('Restart Hermes');
      note.textContent = failureNote;
    } else if (phase === 'armed') {
      primary.textContent = translate('Yes, restart now');
      note.textContent = translate('This briefly interrupts every turn running through this Hermes gateway, including other agents and chats.');
    } else if (phase === 'working') {
      primary.textContent = translate('Restarting…');
      note.textContent = translate(STAGE_COPY[stage] || STAGE_COPY.stopping);
    } else if (phase === 'stalled') {
      primary.textContent = translate('Check again');
      note.textContent = translate(gatewayRestartFailureText('timeout'));
    } else if (phase === 'done') {
      successText.textContent = translate('Hermes restarted');
      note.textContent = '';
    }
  };
  paint();

  const beginWorking = ({ external = false } = {}) => {
    userDriven = !external;
    phase = 'working';
    stage = 'stopping';
    failureNote = '';
    startedAt = now();
    paintTimer();
    stopTicker();
    ticker = setInterval(paintTimer, 1000);
    paint();
  };
  const settle = (result) => {
    stopTicker();
    if (result?.ok) {
      phase = 'done';
      paint();
      try { onRestarted(result); } catch { /* UI hook only */ }
      return;
    }
    if (result?.beforeBootId) beforeBootId = result.beforeBootId;
    if (result?.reason === 'timeout' && typeof check === 'function') {
      phase = 'stalled';
    } else {
      phase = 'idle';
      failureNote = translate(gatewayRestartFailureText(result?.reason));
    }
    paint();
  };
  const onProgress = ({ stage: next } = {}) => {
    if (phase !== 'working' || !STAGE_COPY[next]) return;
    stage = next;
    paint();
  };

  // Passive sync: if Hermes restarts without this button (terminal, Desktop),
  // follow it through to the finished state instead of leaving a stale prompt.
  if (typeof watch === 'function') {
    const abandoned = () => root.isConnected === false && now() - createdAt > 5_000;
    const shouldStop = () => phase === 'done' || userDriven || abandoned();
    void Promise.resolve().then(() => watch({
      shouldStop,
      onProgress: (event = {}) => {
        if (userDriven || phase === 'done' || !STAGE_COPY[event.stage]) return;
        if (phase !== 'working') beginWorking({ external: true });
        onProgress(event);
      },
    })).then((result) => {
      if (userDriven || phase === 'done') return;
      if (result?.ok) settle(result);
      else if (phase === 'working') { stopTicker(); phase = 'idle'; paint(); }
    }).catch(() => {});
  }

  cancel.addEventListener('click', () => { phase = 'idle'; paint(); });
  primary.addEventListener('click', async () => {
    if (phase === 'idle') { phase = 'armed'; paint(); return; }
    if (phase === 'stalled') {
      beginWorking();
      let result;
      try { result = await check({ beforeBootId, onProgress }); } catch { result = { ok: false, reason: 'unreachable' }; }
      settle(result);
      return;
    }
    if (phase !== 'armed') return;
    beginWorking();
    let result;
    try { result = await restart({ onProgress }); } catch { result = { ok: false, reason: 'unreachable' }; }
    settle(result);
  });
  return root;
}
