import {
  contextAccountingSnapshot,
  contextCompactionState,
  contextMeterDisplay,
  estimateTokens,
  groupSessionsForMenu,
  normalizeHermesSessions,
  normalizeHermesSkills,
  normalizeToolActivity,
  renderMarkdown,
  shouldAutoOpenSessionGroup,
  skillSuggestionsForInput,
} from './lib/common.mjs';
import { createHermesClient } from './lib/hermes-client.mjs';
import { migrateConnectionSettings, normalizeConnectionMode } from './lib/connection-modes.mjs';
import { fullTabEntryPathForPage, parseFullTabHandoff } from './lib/surface-protocol.mjs';
import {
  APPEARANCE_THEMES,
  normalizeAppearanceTheme,
  normalizeColorMode,
  resolveColorMode,
} from './lib/appearance-themes.mjs';
import { discoverModelsFromRegistry } from './lib/model-discovery.mjs';
import { extractMediaTags, resolveImageSource, resolvedGeneratedImageSources, stripGeneratedImageEchoes } from './lib/image-render.mjs';
import { readHermesSse } from './lib/fulltab-runtime.mjs';
import { createDiffusionCanvas } from './lib/diffusion-canvas.mjs';
import {
  MODEL_REASONING_EFFORTS,
  modelRuntimeCapabilities,
  modelRuntimeOptionsPayload as buildModelRuntimeOptionsPayload,
  normalizeModelRuntimeOptions,
} from './lib/model-runtime-options.mjs';
import { extractSelectedWebSkills } from './lib/web-skill-selection.mjs';
import {
  WEB_COMMANDS,
  parseWebCommand,
  webComposerSuggestionMode,
  webCommandSuggestions,
} from './lib/web-commands.mjs';
import { artifactActionState, describeArtifact, toFileUrl } from './lib/web-artifacts.mjs';
import { isRenderableAssistantMessage, shouldPreserveImageGenerationRun } from './lib/web-run-state.mjs';
import { thinkingIndicatorMarkup } from './lib/web-thinking-indicator.mjs';
import { createImageViewerState, imageViewerReducer } from './lib/image-viewer.mjs';

const $ = (selector) => document.querySelector(selector);
const handoff = parseFullTabHandoff(globalThis.location.search);

const els = {
  shell: $('.web-shell'),
  sessionRail: $('#sessionRail'),
  navToggle: $('#navToggle'),
  inspectorToggle: $('#inspectorToggle'),
  drawerScrim: $('#drawerScrim'),
  sessionSearch: $('#sessionSearch'),
  sessionList: $('#sessionList'),
  sessionCount: $('#sessionCount'),
  sessionTitle: $('#sessionTitle'),
  railVisibilityToggle: $('#railVisibilityToggle'),

  copySessionId: $('#copySessionId'),
  sessionActionsMenu: $('#sessionActionsMenu'),
  messageList: $('#messageList'),
  loadingState: $('#loadingState'),
  emptyState: $('#emptyState'),
  errorState: $('#errorState'),
  errorTitle: $('#errorTitle'),
  errorDetail: $('#errorDetail'),
  connectionTruth: $('#connectionTruth'),
  connectionDot: $('#connectionDot'),
  connectionLabel: $('#connectionLabel'),
  modelLabel: $('#modelLabel'),
  modelPickerButton: $('#modelPickerButton'),
  modelPicker: $('#modelPicker'),
  modelSearch: $('#modelSearch'),
  modelProviderList: $('#modelProviderList'),
  modelList: $('#modelList'),
  modelOptionsList: $('#modelOptionsList'),
  refreshModels: $('#refreshModels'),
  profileLabel: $('#profileLabel'),
  railAgentGlyph: $('#railAgentGlyph'),
  railAgentLabel: $('#railAgentLabel'),
  composerSessionLabel: $('#composerSessionLabel'),
  composerModelControl: $('#composerModelControl'),
  composerModelName: $('#composerModelName'),
  composerRuntimeMeta: $('#composerRuntimeMeta'),
  returnToPageButton: $('#returnToPageButton'),
  handoffDetail: $('#handoffDetail'),
  contextMode: $('#contextMode'),
  contextSource: $('#contextSource'),
  contextWindowCard: $('#contextWindowCard'),
  contextWindowMeter: $('#contextWindowMeter'),
  contextWindowPercent: $('#contextWindowPercent'),
  contextWindowFill: $('#contextWindowFill'),
  contextWindowDetail: $('#contextWindowDetail'),
  diagConnection: $('#diagConnection'),
  diagGateway: $('#diagGateway'),
  diagSession: $('#diagSession'),
  diagModel: $('#diagModel'),
  diagProfile: $('#diagProfile'),
  copyDiagnostics: $('#copyDiagnostics'),
  newChatButton: $('#newChatButton'),
  composer: $('#fullTabComposer'),
  prompt: $('#fullTabPrompt'),
  commandMenuButton: $('#commandMenuButton'),
  skillMenu: $('#skillMenu'),
  composerDropOverlay: $('#composerDropOverlay'),
  send: $('#fullTabSend'),
  stopRun: $('#stopRun'),
  composerStatus: $('#composerStatus'),
  conversationScroll: $('#conversationScroll'),
  toolActivityList: $('#toolActivityList'),
  settingsButton: $('#settingsButton'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  closeSettings: $('#closeSettings'),
  settingsColorMode: $('#settingsColorMode'),
  settingsTheme: $('#settingsTheme'),
  settingsTextSize: $('#settingsTextSize'),
  settingsProfile: $('#settingsProfile'),
  settingsGatewayUrl: $('#settingsGatewayUrl'),
  settingsApiKey: $('#settingsApiKey'),
  settingsThemeGrid: $('#settingsThemeGrid'),
  imageLightbox: $('#imageLightbox'),
  imageLightboxCanvas: $('#imageLightboxCanvas'),
  imageLightboxImage: $('#imageLightboxImage'),
  imageZoomLabel: $('#imageZoomLabel'),
  zoomImageIn: $('[data-action="zoom-image-in"]'),
  zoomImageOut: $('[data-action="zoom-image-out"]'),
  resetImageZoom: $('[data-action="reset-image-zoom"]'),
  closeImageLightbox: $('[data-action="close-image-lightbox"]'),
  settingsColorModeButtons: Array.from(document.querySelectorAll('[data-color-mode]')),
  settingsTextSizeButtons: Array.from(document.querySelectorAll('[data-text-size]')),
  quickAttach: $('#quickAttach'),
  quickVoice: $('#quickVoice'),
  quickModel: $('#quickModel'),
  attachButton: $('#attachButton'),
  attachMenu: $('#attachMenu'),
  attachmentInput: $('#attachmentInput'),
  imageAttachmentInput: $('#imageAttachmentInput'),
  attachmentList: $('#attachmentList'),
  voiceButton: $('#voiceButton'),
  queueDraft: $('#queueDraft'),
  steerDraft: $('#steerDraft'),
};

let settings = {};
let sessions = [];
let activeSessionId = handoff.sessionId;
let activeMessages = [];
let availableModels = [];
let selectedModelProvider = '';
let sending = false;
let activeAbortController = null;
let activeRunId = '';
let attachments = [];
let queuedTurn = null;
let availableSkills = [];
let modelsRefreshing = false;
let dragDepth = 0;
let latestRuntime = {};
let liveRun = null;
let imageViewerState = createImageViewerState();
let imagePanGesture = null;
const HERMES_WEB_SESSION_SOURCE = 'hermes_web';
const openSessionGroups = new Set();
const closedSessionGroups = new Set();
const VOICE_DRAFT_STORAGE_KEY = 'hermesVoiceDraft';

const client = createHermesClient({
  getConnection: () => settings,
});

function connectionModeLabel(mode) {
  if (mode === 'cloud') return 'Hermes Cloud';
  if (mode === 'remote') return 'Remote gateway';
  return 'Local gateway';
}


function gatewayOrigin(value = '') {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return 'not configured';
  }
}

function sessionTitle(session = {}) {
  return String(session.title || session.name || session.id || 'Untitled session');
}

function sessionTimestamp(session = {}) {
  const value = session.lastActive || session.updated_at || session.updatedAt || session.modified_at || session.created_at || session.createdAt;
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function isOwnedHermesWebSession(session = {}) {
  return String(session.source || '').toLowerCase() === 'api_server'
    && /^hermes-web-/i.test(String(session.id || ''));
}

async function migrateOwnedHermesWebSessionSources(rows = []) {
  const migrations = rows.filter(isOwnedHermesWebSession);
  if (!migrations.length) return rows;
  const migrated = await Promise.all(migrations.map(async (session) => {
    try {
      const response = await client.fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ source: HERMES_WEB_SESSION_SOURCE }),
      });
      const payload = await client.readJson(response);
      if (!response.ok) return session;
      return normalizeHermesSessions({ data: [payload.session || payload] })[0] || session;
    } catch {
      return session;
    }
  }));
  const byId = new Map(migrated.map((session) => [session.id, session]));
  return rows.map((session) => byId.get(session.id) || session);
}

function visibleHermesWebSessions(rows = []) {
  return rows.filter((session) => Number(session.messageCount || 0) > 0);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('');
  if (content && typeof content === 'object') return String(content.text || content.content || '');
  return '';
}

function requestedModelLabel() {
  const binding = settings.sessionModelBindings?.[activeSessionId] || {};
  const provider = binding.provider || settings.provider || '';
  const model = binding.rawModelId || binding.modelId || settings.model || 'Gateway default';
  return [provider, model].filter(Boolean).join(' · ');
}

function renderConnectionTruth({ status = 'idle' } = {}) {
  const mode = normalizeConnectionMode(settings.connectionMode);
  const label = connectionModeLabel(mode);
  const model = requestedModelLabel();
  const profile = settings.activeProfile || 'Default profile';
  els.connectionLabel.textContent = label;
  els.railAgentGlyph.dataset.connectionMode = mode;
  els.railAgentLabel.textContent = label;
  els.modelLabel.textContent = model;
  els.profileLabel.textContent = profile;
  els.connectionDot.className = `truth-dot ${status === 'online' ? 'online' : status === 'error' ? 'error' : ''}`.trim();
  els.contextMode.textContent = mode === 'cloud' || settings.connectionTransport === 'remote-dashboard' ? 'Chat only' : 'Inherited safely';
  els.contextSource.textContent = mode === 'cloud' || settings.connectionTransport === 'remote-dashboard'
    ? 'Cloud/dashboard context disabled'
    : handoff.sourceTabId ? `Browser tab ${handoff.sourceTabId} handoff` : 'No browser context attached';
  els.diagConnection.textContent = `${label} · ${settings.connectionTransport || settings.gatewayMode || 'unknown transport'}`;
  els.diagGateway.textContent = gatewayOrigin(settings.gatewayUrl);
  els.diagSession.textContent = activeSessionId || 'none';
  els.diagModel.textContent = model;
  els.diagProfile.textContent = profile;
}

function applySessionVisibility() {
  const visible = settings.webSessionsVisible !== false;
  els.shell.classList.toggle('sessions-hidden', !visible);
  els.railVisibilityToggle.setAttribute('aria-pressed', String(!visible));
  els.railVisibilityToggle.setAttribute('aria-label', visible ? 'Collapse sessions' : 'Show sessions');
  els.railVisibilityToggle.title = visible ? 'Collapse sessions' : 'Show sessions';
  els.railVisibilityToggle.textContent = visible ? '◀' : '▶';
}

function persistSessionVisibility(partial) {
  settings = { ...settings, ...partial };
  applySessionVisibility();
  const active = sessions.find((session) => session.id === activeSessionId) || { title: settings.webSessionTitle || 'New Hermes Web chat' };
  els.sessionTitle.textContent = sessionTitle(active);
  els.composerSessionLabel.textContent = activeSessionId || 'Shared session';
  renderSessions(els.sessionSearch.value);
  chrome.storage.local.set({ hermesBrowserSettings: settings }).catch((error) => {
    els.composerStatus.textContent = `Session rail save failed: ${error?.message || String(error)}`;
  });
}

function renderSessions(query = '') {
  const groups = groupSessionsForMenu(sessions, activeSessionId, query);
  const searching = Boolean(String(query || '').trim());
  els.sessionList.replaceChildren();
  els.sessionCount.textContent = String(groups.reduce((total, group) => total + group.sessions.length, 0));
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'session-list-empty';
    empty.textContent = sessions.length ? 'No sessions match this search.' : 'Canonical session history is unavailable for this connection.';
    els.sessionList.append(empty);
    return;
  }
  for (const group of groups) {
    if (shouldAutoOpenSessionGroup(group, groups, closedSessionGroups)) openSessionGroups.add(group.label);
    const isOpen = searching || openSessionGroups.has(group.label);
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = `session-group-toggle${isOpen ? ' open' : ''}`;
    heading.setAttribute('aria-expanded', String(isOpen));
    const label = document.createElement('span');
    label.textContent = `${isOpen ? '▾' : '▸'} ${group.label}`;
    const count = document.createElement('strong');
    count.textContent = String(group.sessions.length);
    heading.append(label, count);
    heading.addEventListener('click', () => {
      if (openSessionGroups.has(group.label)) {
        openSessionGroups.delete(group.label);
        closedSessionGroups.add(group.label);
      } else {
        openSessionGroups.add(group.label);
        closedSessionGroups.delete(group.label);
      }
      renderSessions(els.sessionSearch.value);
    });
    els.sessionList.append(heading);
    if (!isOpen) continue;
    for (const session of group.sessions) {
      const row = document.createElement('div');
      row.className = `session-row ${session.selected ? 'active' : ''}`.trim();
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'session-row-open';
      open.setAttribute('role', 'listitem');
      const title = document.createElement('strong');
      title.textContent = sessionTitle(session);
      const age = document.createElement('span');
      age.textContent = session.selected ? 'Current session' : sessionTimestamp(session);
      open.append(title, age);
      open.addEventListener('click', () => openSession(session.id));
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'session-row-rename';
      rename.title = 'Rename session';
      rename.setAttribute('aria-label', `Rename ${sessionTitle(session)}`);
      rename.textContent = '✎';
      rename.addEventListener('click', (event) => {
        event.stopPropagation();
        promptRenameHermesWebSession(session);
      });
      row.append(open, rename);
      els.sessionList.append(row);
    }
  }
}

function localGatewayConnected() {
  return normalizeConnectionMode(settings.connectionMode) === 'local';
}

function runtimeTelemetryForSession(session = {}) {
  return {
    session_id: String(session.id || ''),
    model: String(session.model || ''),
    provider: String(session.provider || ''),
    last_prompt_tokens: Number(session.lastPromptTokens || 0),
    context_length: Number(session.contextLength || 0),
    threshold_tokens: Number(session.thresholdTokens || 0),
    usage_percent: Number(session.usagePercent || 0),
    compression_count: Number(session.compressionCount || 0),
    compression_count_known: Boolean(session.compressionCountKnown),
    source: 'persisted-session',
  };
}

function compactTokenLabel(value = 0) {
  const tokens = Math.max(0, Number(value || 0));
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}m`;
  if (tokens >= 1_000) return `${Math.round((tokens / 1_000) * 10) / 10}k`;
  return String(Math.round(tokens));
}

function renderContextWindow() {
  const session = sessions.find((item) => item.id === activeSessionId) || {};
  const model = effectiveModel();
  const transcript = activeMessages.map((message) => messageText(message.content)).join('\n');
  const pendingAttachmentText = attachments
    .map((item) => item.kind === 'image' ? `[image attachment: ${item.name}]` : item.text || item.name)
    .join('\n');
  const accounting = contextAccountingSnapshot({
    localPromptTokens: estimateTokens(transcript),
    draftTokens: estimateTokens(`${els.prompt?.value || ''}\n${pendingAttachmentText}`),
    runtime: latestRuntime,
    usage: latestRuntime?.usage || latestRuntime?.token_usage || {},
    session,
    modelContextTokens: model.contextTokens,
  });
  const display = contextMeterDisplay({ accounting, runtimeLabel: latestRuntime?.model || model.label, modelContextTokens: model.contextTokens });
  const compaction = contextCompactionState({ accounting, runtime: latestRuntime, session });
  const percent = Math.min(100, display.percent || 0);
  els.contextWindowMeter.textContent = display.compactLabel;
  els.contextWindowPercent.textContent = compaction.thresholdPercent
    ? `${display.percentLabel} · compacts ${compaction.thresholdPercent}%`
    : display.percentLabel;
  const compactionCount = compaction.compressionCount
    ? ` Compacted ${compaction.compressionCount}×.`
    : '';
  const threshold = compaction.thresholdTokens
    ? ` Trigger: ${compactTokenLabel(compaction.thresholdTokens)} tokens.`
    : '';
  els.contextWindowDetail.textContent = `${compaction.detail}${threshold}${compactionCount}`;
  els.contextWindowCard.title = display.title;
  els.contextWindowFill.style.width = `${percent}%`;
  els.contextWindowCard.dataset.contextState = compaction.state === 'over-limit'
    ? 'critical'
    : compaction.state === 'due' || percent >= 75
      ? 'warning'
      : 'normal';
}

function artifactActionButton(label, action, artifact) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => action(artifact).catch((error) => {
    els.composerStatus.textContent = `Artifact action failed: ${error?.message || String(error)}`;
  }));
  return button;
}

async function openArtifact(artifact) {
  const target = artifact.kind === 'local' ? toFileUrl(artifact.source) : artifact.source;
  if (!target) throw new Error('This artifact does not expose an openable URL.');
  await chrome.tabs.create({ url: target, active: true });
}

async function downloadArtifact(artifact) {
  const target = artifact.kind === 'local' ? toFileUrl(artifact.source) : artifact.source;
  if (!target) throw new Error('This artifact does not expose a downloadable URL.');
  await chrome.downloads.download({ url: target, filename: artifact.name, saveAs: true });
}

function renderArtifactCard(artifact) {
  const card = document.createElement('section');
  card.className = 'artifact-card';
  const head = document.createElement('div');
  head.className = 'artifact-card-head';
  const kind = document.createElement('span');
  kind.className = 'artifact-card-kind';
  kind.textContent = artifact.extension.toUpperCase();
  const copy = document.createElement('div');
  copy.className = 'artifact-card-copy';
  const name = document.createElement('strong');
  name.textContent = artifact.name;
  const source = document.createElement('small');
  source.textContent = artifact.kind === 'remote' ? 'Downloadable gateway artifact' : 'Local gateway artifact';
  copy.append(name, source);
  head.append(kind, copy);
  card.append(head);
  const state = artifactActionState(artifact, { localGateway: localGatewayConnected() });
  if (state.canOpen || state.canDownload) {
    const actions = document.createElement('div');
    actions.className = 'artifact-card-actions';
    if (state.canOpen) actions.append(artifactActionButton('Open', openArtifact, artifact));
    if (state.canDownload) actions.append(artifactActionButton('Download', downloadArtifact, artifact));
    card.append(actions);
  } else {
    const note = document.createElement('p');
    note.textContent = state.unavailableReason;
    card.append(note);
  }
  return card;
}

function clearLiveRun() {
  liveRun?.animation?.stop?.();
  liveRun = null;
}

function renderImageViewerState() {
  if (!els.imageLightboxImage) return;
  const { scale, x, y } = imageViewerState;
  els.imageLightboxImage.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  els.imageLightboxCanvas?.toggleAttribute('data-zoomed', scale > 1);
  if (els.imageZoomLabel) els.imageZoomLabel.textContent = `${Math.round(scale * 100)}%`;
  if (els.zoomImageOut) els.zoomImageOut.disabled = scale <= 1;
  if (els.resetImageZoom) els.resetImageZoom.disabled = scale <= 1 && x === 0 && y === 0;
}

function updateImageViewer(action) {
  imageViewerState = imageViewerReducer(imageViewerState, action);
  renderImageViewerState();
}

function resetImageViewer() {
  imagePanGesture = null;
  imageViewerState = createImageViewerState();
  renderImageViewerState();
}

function openImageLightbox(source = '', alt = 'Generated by Hermes') {
  if (!source || !els.imageLightbox || !els.imageLightboxImage) return;
  resetImageViewer();
  els.imageLightboxImage.src = source;
  els.imageLightboxImage.alt = alt;
  if (!els.imageLightbox.open) els.imageLightbox.showModal();
}

function loadGeneratedImage(source = '') {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Generated image could not be decoded for the final reveal.'));
    image.src = source;
  });
}

function beginFinalImageReveal(sources = []) {
  const run = liveRun;
  const imageSources = Array.isArray(sources) ? sources.filter(Boolean) : [sources].filter(Boolean);
  if (!run?.image || !imageSources.length || run.revealPromise) return run?.revealPromise || null;
  run.revealSources = imageSources;
  run.revealPending = true;
  run.revealPromise = Promise.all(imageSources.map((source) => loadGeneratedImage(source)))
    .then((images) => {
      if (liveRun !== run || !run.animation?.reveal) return undefined;
      return run.animation.reveal(images);
    })
    .catch((error) => {
      console.warn('[Hermes Web] final image reveal skipped:', error);
    })
    .finally(() => {
      if (liveRun === run) run.revealPending = false;
    });
  return run.revealPromise;
}

function renderLiveRun() {
  if (!sending || !liveRun) return;
  liveRun.animation?.stop?.();
  const card = document.createElement('article');
  const thinking = liveRun.phase === 'THINKING';
  card.className = `web-live-run${thinking ? ' thinking' : ''}`;
  const copy = document.createElement('div');
  copy.className = 'web-live-run-copy';
  const phase = document.createElement('small');
  phase.textContent = liveRun.phase || 'LIVE RUN';
  const detail = document.createElement('p');
  detail.textContent = liveRun.detail || 'Preparing a response';
  if (thinking) {
    const sequence = document.createElement('div');
    sequence.className = 'web-live-run-thinking';
    sequence.innerHTML = thinkingIndicatorMarkup();
    copy.append(phase, sequence, detail);
  } else {
    const indicator = document.createElement('span');
    indicator.className = 'web-live-run-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = liveRun.title || 'Hermes is thinking';
    copy.append(phase, title, detail);
    card.append(indicator);
  }
  card.append(copy);
  if (liveRun.image) {
    const preview = document.createElement('div');
    const imageCount = Math.max(1, Number(liveRun.revealSources?.length || liveRun.imageCount || 1));
    preview.className = `web-live-run-image${imageCount > 1 ? ' multi' : ''}`;
    const canvases = Array.from({ length: imageCount }, () => {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', 'Hermes image generation in progress');
      preview.append(canvas);
      return canvas;
    });
    card.append(preview);
    const animations = canvases.map((canvas, index) => createDiffusionCanvas(canvas, {
      aspectRatio: liveRun.aspectRatio || 'landscape',
      seed: `${liveRun.seed || activeRunId || Date.now()}:${index}`,
      maxFps: 36,
    }));
    liveRun.animation = {
      start: () => animations.forEach((animation) => animation.start()),
      stop: () => animations.forEach((animation) => animation.stop()),
      reveal: (images = []) => Promise.all(animations.map((animation, index) => animation.reveal(images[index] || images[0]))),
    };
    liveRun.animation.start();
  }
  els.messageList.append(card);
}

function renderMessages(messages = []) {
  activeMessages = messages;
  els.messageList.replaceChildren();
  const visible = messages.filter((message) => {
    const role = String(message.role || '').toLowerCase();
    return ['user', 'assistant', 'system'].includes(role) && (role !== 'assistant' || isRenderableAssistantMessage(message));
  });
  const hasLiveRun = Boolean(sending && liveRun);
  els.emptyState.hidden = visible.length > 0 || hasLiveRun;
  els.messageList.hidden = visible.length === 0 && !hasLiveRun;
  for (const message of visible) {
    const role = String(message.role || 'system').toLowerCase();
    const article = document.createElement('article');
    article.className = `web-message ${role}`;
    const roleNode = document.createElement('div');
    roleNode.className = 'web-message-role';
    roleNode.textContent = role === 'assistant' ? 'Hermes' : role;
    const content = document.createElement('div');
    content.className = 'web-message-content';
    const rawText = messageText(message.content);
    const tagged = extractMediaTags(rawText);
    const media = resolvedGeneratedImageSources(rawText);
    const displayText = stripGeneratedImageEchoes(tagged.text, media);
    if (displayText) content.innerHTML = renderMarkdown(displayText);
    const deferMediaGroup = role === 'assistant'
      && liveRun?.image
      && liveRun?.revealPending
      && media.some((source) => liveRun?.revealSources?.includes(source));
    if (media.length && !deferMediaGroup) {
      const group = document.createElement('section');
      group.className = `generated-media-group${media.length > 1 ? ' multiple' : ''}`;
      group.setAttribute('aria-label', `${media.length} generated image${media.length === 1 ? '' : 's'}`);
      for (const source of media) {
        const figure = document.createElement('figure');
        figure.className = 'generated-media';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'generated-media-open';
        open.setAttribute('aria-label', 'Open generated image');
        const image = document.createElement('img');
        image.src = source;
        image.alt = 'Generated by Hermes';
        image.loading = 'lazy';
        const inspect = document.createElement('span');
        inspect.className = 'generated-image-inspect';
        inspect.setAttribute('aria-hidden', 'true');
        inspect.textContent = '⌕';
        open.append(image, inspect);
        open.addEventListener('click', () => openImageLightbox(source, image.alt));
        figure.append(open);
        group.append(figure);
      }
      content.append(group);
    }
    for (const item of tagged.media.filter((entry) => !resolveImageSource(entry.source))) {
      content.append(renderArtifactCard(describeArtifact(item.source)));
    }
    article.append(roleNode, content);
    els.messageList.append(article);
  }
  renderLiveRun();
  renderContextWindow();
  requestAnimationFrame(() => { els.conversationScroll.scrollTop = els.conversationScroll.scrollHeight; });
}

function effectiveModel() {
  const binding = settings.sessionModelBindings?.[activeSessionId] || settings.extensionPreferredModel || {};
  const selected = availableModels.find((model) => model.id === settings.model)
    || availableModels.find((model) => model.rawModelId === binding.rawModelId && (!binding.provider || model.provider === binding.provider));
  return {
    id: selected?.id || settings.model || binding.modelId || '',
    model: selected?.rawModelId || binding.rawModelId || binding.modelId || settings.model || '',
    provider: selected?.provider || binding.provider || settings.provider || '',
    label: selected?.label || selected?.rawModelId || binding.rawModelId || settings.model || 'Gateway default',
    contextTokens: Number(selected?.contextTokens || binding.contextTokens || settings.modelContextTokens || 0),
    reasoning: selected?.reasoning ?? binding.reasoning,
    fast: selected?.fast ?? binding.fast,
  };
}

function activeModelRuntimeOptions() {
  const scoped = activeSessionId ? settings.sessionModelOptionBindings?.[activeSessionId] : null;
  return normalizeModelRuntimeOptions(scoped || settings.extensionPreferredModelOptions || {
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    fastMode: settings.fastMode,
  });
}

function modelOptionsPayload() {
  return buildModelRuntimeOptionsPayload(activeModelRuntimeOptions());
}

function renderComposerRuntimeControl() {
  if (!els.composerModelControl) return;
  const model = effectiveModel();
  const options = activeModelRuntimeOptions();
  const effort = options.reasoningEffort === 'xhigh' ? 'Max' : options.reasoningEffort;
  els.composerModelName.textContent = model.label || 'Gateway default';
  els.composerRuntimeMeta.textContent = [
    options.thinkingEnabled ? `${effort} reasoning` : 'Thinking off',
    options.fastMode ? 'Fast mode' : 'Standard',
  ].join(' · ');
  els.composerModelControl.title = `${model.label || 'Gateway default'} · ${els.composerRuntimeMeta.textContent}. Change model and runtime options.`;
}

function renderModelRuntimeOptions() {
  if (!els.modelOptionsList) return;
  const options = activeModelRuntimeOptions();
  const capabilities = modelRuntimeCapabilities(effectiveModel());
  els.modelOptionsList.replaceChildren();

  const heading = document.createElement('p');
  heading.className = 'model-options-heading';
  heading.textContent = 'Runtime options';
  els.modelOptionsList.append(heading);

  if (capabilities.reasoning) {
    const effort = document.createElement('div');
    effort.className = 'model-effort-options';
    for (const option of MODEL_REASONING_EFFORTS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.runtimeEffort = option.value;
      button.className = `model-runtime-option${options.reasoningEffort === option.value ? ' selected' : ''}`;
      button.setAttribute('aria-pressed', String(options.reasoningEffort === option.value));
      button.textContent = option.label;
      effort.append(button);
    }
    els.modelOptionsList.append(effort);
  }

  const toggles = document.createElement('div');
  toggles.className = 'model-runtime-toggles';
  if (capabilities.thinking) {
    const thinking = document.createElement('button');
    thinking.type = 'button';
    thinking.dataset.runtimeToggle = 'thinking';
    thinking.className = `model-runtime-toggle${options.thinkingEnabled ? ' selected' : ''}`;
    thinking.setAttribute('aria-pressed', String(options.thinkingEnabled));
    thinking.textContent = `Thinking ${options.thinkingEnabled ? 'On' : 'Off'}`;
    toggles.append(thinking);
  }
  if (capabilities.fast) {
    const fast = document.createElement('button');
    fast.type = 'button';
    fast.dataset.runtimeToggle = 'fast';
    fast.className = `model-runtime-toggle${options.fastMode ? ' selected' : ''}`;
    fast.setAttribute('aria-pressed', String(options.fastMode));
    fast.textContent = `Fast mode ${options.fastMode ? 'On' : 'Off'}`;
    toggles.append(fast);
  }
  if (toggles.childElementCount) els.modelOptionsList.append(toggles);

  if (!capabilities.reasoning || !capabilities.fast) {
    const unavailable = document.createElement('p');
    unavailable.className = 'model-options-note';
    unavailable.textContent = 'Only controls supported by the selected model are shown.';
    els.modelOptionsList.append(unavailable);
  }
  renderComposerRuntimeControl();
}

async function setModelRuntimeOptions(partial = {}) {
  const options = normalizeModelRuntimeOptions({ ...activeModelRuntimeOptions(), ...partial });
  const sessionBindings = { ...(settings.sessionModelOptionBindings || {}) };
  if (activeSessionId) sessionBindings[activeSessionId] = options;
  settings = {
    ...settings,
    thinkingEnabled: options.thinkingEnabled,
    reasoningEffort: options.reasoningEffort,
    fastMode: options.fastMode,
    extensionPreferredModelOptions: options,
    sessionModelOptionBindings: sessionBindings,
  };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  renderModelRuntimeOptions();
  renderComposerRuntimeControl();
  els.composerStatus.textContent = `Runtime options: ${options.thinkingEnabled ? options.reasoningEffort === 'xhigh' ? 'Max reasoning' : `${options.reasoningEffort} reasoning` : 'thinking off'}${options.fastMode ? ' · fast mode' : ''}`;
}

function modelProviderName(model = {}) {
  return String(model.providerLabel || model.provider || 'Hermes').trim() || 'Hermes';
}

function groupModelsForPicker(query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const groups = new Map();
  for (const model of availableModels) {
    const haystack = `${modelProviderName(model)} ${model.label || ''} ${model.rawModelId || ''}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const provider = modelProviderName(model);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  return [...groups.entries()].map(([provider, models]) => ({ provider, models }));
}

function renderModelPicker(query = '') {
  const needle = String(query).trim();
  const current = effectiveModel();
  const allGroups = groupModelsForPicker();
  const matchingGroups = groupModelsForPicker(needle);
  const selectedProvider = modelProviderName(availableModels.find((model) => model.id === current.id) || {});
  if (!selectedModelProvider || !allGroups.some((group) => group.provider === selectedModelProvider)) {
    selectedModelProvider = selectedProvider && allGroups.some((group) => group.provider === selectedProvider)
      ? selectedProvider
      : allGroups[0]?.provider || '';
  }

  els.modelProviderList.replaceChildren();
  for (const group of needle ? matchingGroups : allGroups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-provider-option ${group.provider === selectedModelProvider ? 'selected' : ''}`.trim();
    button.setAttribute('aria-pressed', String(group.provider === selectedModelProvider));
    const label = document.createElement('span');
    label.textContent = group.provider;
    const count = document.createElement('small');
    count.textContent = String(group.models.length);
    button.append(label, count);
    button.addEventListener('click', () => {
      selectedModelProvider = group.provider;
      els.modelSearch.value = '';
      renderModelPicker();
      els.modelSearch.focus();
    });
    els.modelProviderList.append(button);
  }

  els.modelList.replaceChildren();
  const groupsToRender = needle
    ? matchingGroups
    : matchingGroups.filter((group) => group.provider === selectedModelProvider);
  for (const group of groupsToRender) {
    const heading = document.createElement('p');
    heading.className = 'model-group-heading';
    heading.textContent = `${group.provider} · ${group.models.length} models`;
    els.modelList.append(heading);
    for (const model of group.models) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-choice ${model.id === current.id ? 'selected' : ''}`.trim();
      const copy = document.createElement('span');
      const provider = document.createElement('small');
      const label = document.createElement('strong');
      const selected = document.createElement('em');
      provider.textContent = modelProviderName(model);
      label.textContent = model.label || model.rawModelId;
      selected.textContent = model.id === current.id ? '✓' : '';
      copy.append(provider, label);
      button.append(copy, selected);
      button.addEventListener('click', () => selectModel(model));
      els.modelList.append(button);
    }
  }
  if (!els.modelList.childElementCount) els.modelList.textContent = 'No models found.';
  renderModelRuntimeOptions();
}

async function loadModels({ refresh = false } = {}) {
  const result = await discoverModelsFromRegistry({ apiFetch: client.fetch, readJsonResponse: client.readJson, refresh });
  if (!result.ok) throw new Error(result.error || 'Model discovery failed.');
  availableModels = result.models;
  const current = effectiveModel();
  els.modelLabel.textContent = current.label;
  renderModelPicker(els.modelSearch.value);
  renderComposerRuntimeControl();
  renderContextWindow();
  return availableModels;
}

function setModelRefreshState(refreshing) {
  modelsRefreshing = Boolean(refreshing);
  els.refreshModels.disabled = modelsRefreshing;
  els.refreshModels.classList.toggle('model-refreshing', modelsRefreshing);
  els.refreshModels.setAttribute('aria-busy', String(modelsRefreshing));
}

async function refreshModelsFromPicker() {
  setModelRefreshState(true);
  try {
    const models = await loadModels({ refresh: true });
    els.composerStatus.textContent = `${models.length} models loaded and synced`;
  } finally {
    setModelRefreshState(false);
  }
}

async function loadSkills({ quiet = false } = {}) {
  try {
    const response = await client.fetch('/v1/skills', { method: 'GET' });
    const payload = await client.readJson(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Skills list failed (${response.status}).`);
    availableSkills = normalizeHermesSkills(payload);
    renderComposerSuggestions();
    if (!quiet) els.composerStatus.textContent = `${availableSkills.length} skills synced`;
  } catch (error) {
    availableSkills = [];
    renderComposerSuggestions();
    if (!quiet) els.composerStatus.textContent = `Skill sync failed: ${error?.message || String(error)}`;
  }
}

function applySkillSuggestion(command = '') {
  const clean = String(command || '').trim();
  if (!clean) return;
  const value = els.prompt.value;
  const next = value.replace(/(^|\s)[/@][a-z0-9_-]*$/i, (_match, prefix) => `${prefix}${clean} `);
  els.prompt.value = next === value ? `${value}${value && !value.endsWith(' ') ? ' ' : ''}${clean} ` : next;
  els.skillMenu.hidden = true;
  els.commandMenuButton.setAttribute('aria-expanded', 'false');
  renderContextWindow();
  updateBusyControls();
  els.prompt.focus();
}

function toggleModelPicker(forceOpen = null) {
  const nextVisible = typeof forceOpen === 'boolean' ? forceOpen : els.modelPicker.hidden;
  els.modelPicker.hidden = !nextVisible;
  els.modelPickerButton.setAttribute('aria-expanded', String(nextVisible));
  if (nextVisible) {
    renderModelPicker(els.modelSearch.value);
    els.modelSearch.focus();
  }
}

async function runWebCommand(name = '') {
  const command = WEB_COMMANDS.find((item) => item.name === name);
  if (!command) return;
  els.skillMenu.hidden = true;
  els.commandMenuButton.setAttribute('aria-expanded', 'false');
  if (command.action === 'new-session') await beginHermesWebDraft();
  else if (command.action === 'model-picker') toggleModelPicker(true);
  else if (command.action === 'context-window' || command.action === 'activity') {
    setInspectorTab(command.action === 'activity' ? 'activity' : 'context');
    els.shell.classList.remove('inspector-closed');
    els.inspectorToggle.setAttribute('aria-expanded', 'true');
    updateScrim();
  } else if (command.action === 'attach-files') {
    els.attachmentInput.click();
  } else if (command.action === 'settings') {
    openSettings();
  }
  els.composerStatus.textContent = `/${command.name} opened`;
}

function renderComposerSuggestions({ force = false } = {}) {
  const value = els.prompt.value || '';
  const mode = webComposerSuggestionMode(value, { force });
  const commandToken = /(?:^|\s)\/([a-z0-9_-]*)$/i.exec(value);
  const skillToken = /(?:^|\s)([/@])([a-z0-9_-]*)$/i.exec(value);
  if (mode === 'none') {
    els.skillMenu.hidden = true;
    els.commandMenuButton.setAttribute('aria-expanded', 'false');
    return;
  }
  const skillPrefix = skillToken?.[1] || '/';
  const skillNeedle = String(skillToken?.[2] || '').toLowerCase();
  const webCommands = mode === 'commands' ? WEB_COMMANDS : commandToken ? webCommandSuggestions(value) : [];
  const skills = mode === 'typed'
    ? skillNeedle ? skillSuggestionsForInput(value, availableSkills, 8) : availableSkills.slice(0, 8)
    : [];
  const visibleWebCommands = webCommands;
  const visibleSkills = skills;
  const seen = new Set();
  const suggestions = [
    ...visibleWebCommands.map((command) => ({ command: `/${command.name}`, name: command.name, description: command.description, type: 'WEB', webCommand: true })),
    ...visibleSkills.map((skill) => ({ command: skill.command.replace(/^[/@]/, skillPrefix), name: skill.name, description: skill.description, type: skill.category || 'SKILL' })),
  ].filter((item) => {
    if (seen.has(item.command)) return false;
    seen.add(item.command);
    return true;
  }).slice(0, 12);
  els.skillMenu.replaceChildren();
  if (!suggestions.length) {
    els.skillMenu.hidden = true;
    return;
  }
  for (const suggestion of suggestions) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'skill-option';
    option.setAttribute('role', 'option');
    const command = document.createElement('strong');
    command.textContent = suggestion.command;
    const copy = document.createElement('span');
    copy.textContent = suggestion.description || suggestion.name;
    const type = document.createElement('small');
    type.textContent = suggestion.type;
    option.append(command, copy, type);
    option.addEventListener('click', () => {
      if (suggestion.webCommand) runWebCommand(suggestion.name).catch((error) => { els.composerStatus.textContent = error?.message || String(error); });
      else applySkillSuggestion(suggestion.command);
    });
    els.skillMenu.append(option);
  }
  els.skillMenu.hidden = false;
  els.commandMenuButton.setAttribute('aria-expanded', 'true');
}


async function selectModel(model) {
  selectedModelProvider = modelProviderName(model);
  const binding = {
    modelId: model.id,
    rawModelId: model.rawModelId,
    provider: model.provider,
    contextTokens: model.contextTokens || 0,
    reasoning: model.reasoning,
    fast: model.fast,
  };
  settings = {
    ...settings,
    model: model.id,
    extensionPreferredModel: binding,
    sessionModelBindings: { ...(settings.sessionModelBindings || {}), ...(activeSessionId ? { [activeSessionId]: binding } : {}) },
  };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  if (activeSessionId) {
    const response = await client.fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/model`, {
      method: 'POST',
      body: JSON.stringify({ provider: model.provider, model: model.rawModelId, model_options: modelOptionsPayload(), require_model_lock: true }),
    });
    if (!response.ok) throw new Error(`Model switch failed (${response.status}).`);
  }
  els.modelLabel.textContent = model.label || model.rawModelId;
  renderModelPicker();
  els.modelPicker.hidden = true;
  els.modelPickerButton.setAttribute('aria-expanded', 'false');
  renderContextWindow();
}

function applyAppearance() {
  const mode = normalizeColorMode(settings.webColorMode || 'light');
  const theme = normalizeAppearanceTheme(settings.webAppearanceTheme || 'nous');
  const textSize = ['default', 'large', 'extra-large'].includes(settings.webTextSize) ? settings.webTextSize : 'default';
  const resolved = resolveColorMode(mode, globalThis.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.hermesMode = resolved;
  document.documentElement.dataset.hermesColorMode = mode;
  document.documentElement.dataset.hermesTheme = theme;
  document.documentElement.dataset.hermesTextSize = textSize;
  document.documentElement.style.colorScheme = resolved;
}

function renderAppearanceSettings() {
  const mode = normalizeColorMode(els.settingsColorMode.value || settings.webColorMode || 'light');
  const theme = normalizeAppearanceTheme(els.settingsTheme.value || settings.webAppearanceTheme || 'nous');
  const textSize = ['default', 'large', 'extra-large'].includes(els.settingsTextSize.value) ? els.settingsTextSize.value : 'default';
  for (const button of els.settingsColorModeButtons) {
    const selected = button.dataset.colorMode === mode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  for (const button of els.settingsTextSizeButtons) {
    const selected = button.dataset.textSize === textSize;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  els.settingsThemeGrid.replaceChildren();
  for (const item of APPEARANCE_THEMES) {
    const selected = item.value === theme;
    const button = document.createElement('button');
    button.className = `theme-card${selected ? ' selected' : ''}`;
    button.type = 'button';
    button.dataset.theme = item.value;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(selected));
    button.setAttribute('aria-label', `${item.name}: ${item.description}`);
    const p = item.preview;
    button.style.cssText = `--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};`;
    const preview = document.createElement('span');
    preview.className = 'theme-preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    const copy = document.createElement('span');
    copy.className = 'theme-card-copy';
    const name = document.createElement('strong');
    name.textContent = item.name;
    copy.append(name);
    const check = document.createElement('span');
    check.className = 'theme-check';
    check.textContent = selected ? '✓' : '';
    button.append(preview, copy, check);
    els.settingsThemeGrid.append(button);
  }
}

function applyAndPersistAppearance() {
  settings = {
    ...settings,
    webColorMode: normalizeColorMode(els.settingsColorMode.value),
    webAppearanceTheme: normalizeAppearanceTheme(els.settingsTheme.value),
    webTextSize: ['default', 'large', 'extra-large'].includes(els.settingsTextSize.value)
      ? els.settingsTextSize.value
      : 'default',
  };
  applyAppearance();
  renderAppearanceSettings();
  chrome.storage.local.set({ hermesBrowserSettings: settings }).catch((error) => {
    els.composerStatus.textContent = `Appearance save failed: ${error?.message || String(error)}`;
  });
}

function openSettings() {
  els.settingsColorMode.value = settings.webColorMode || 'light';
  els.settingsTheme.value = settings.webAppearanceTheme || 'nous';
  els.settingsTextSize.value = settings.webTextSize || 'default';
  els.settingsProfile.value = settings.activeProfile || '';
  els.settingsGatewayUrl.value = settings.gatewayUrl || '';
  els.settingsApiKey.value = '';
  renderAppearanceSettings();
  els.settingsDialog.showModal();
}

async function saveSettings() {
  settings = migrateConnectionSettings({
    ...settings,
    webColorMode: normalizeColorMode(els.settingsColorMode.value),
    webAppearanceTheme: normalizeAppearanceTheme(els.settingsTheme.value),
    webTextSize: els.settingsTextSize.value,
    activeProfile: els.settingsProfile.value.trim() || settings.activeProfile,
    gatewayUrl: els.settingsGatewayUrl.value.trim() || settings.gatewayUrl,
    ...(els.settingsApiKey.value ? { apiKey: els.settingsApiKey.value } : {}),
  });
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  applyAppearance();
  renderConnectionTruth({ status: 'idle' });
  els.settingsDialog.close();
  await loadApp();
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function readFile(file, method) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader[method](file);
  });
}

function renderAttachments() {
  els.attachmentList.replaceChildren();
  els.attachmentList.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = `${attachment.kind === 'image' ? 'IMAGE' : 'FILE'} · ${attachment.name} · ${formatBytes(attachment.size)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => {
      attachments = attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    chip.append(label, remove);
    els.attachmentList.append(chip);
  }
  renderContextWindow();
}

async function attachFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const image = String(file.type || '').startsWith('image/');
    const text = image ? '' : await readFile(file, 'readAsText').catch(() => '');
    const dataUrl = image ? await readFile(file, 'readAsDataURL') : '';
    attachments.push({ id: `${Date.now()}:${Math.random()}`, kind: image ? 'image' : 'file', name: file.name || 'attachment', size: file.size, type: file.type, text: text.slice(0, 120_000), dataUrl });
  }
  renderAttachments();
  els.prompt.focus();
}

function toggleAttachMenu(force) {
  const visible = typeof force === 'boolean' ? force : els.attachMenu.hidden;
  els.attachMenu.hidden = !visible;
  els.attachButton.setAttribute('aria-expanded', String(visible));
}

async function pasteImageAttachment() {
  if (!navigator.clipboard?.read) throw new Error('This browser does not allow image paste from the clipboard.');
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = type.split('/')[1] || 'png';
    await attachFiles([new File([blob], `pasted-image.${extension}`, { type })]);
    return;
  }
  throw new Error('No image was found in the clipboard.');
}

function filesFromPasteEvent(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const files = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) files.push(file);
  }
  for (const file of Array.from(data.files || [])) {
    if (!files.some((candidate) => candidate.name === file.name && candidate.size === file.size && candidate.type === file.type)) files.push(file);
  }
  return files;
}

async function handleComposerPaste(event) {
  const files = filesFromPasteEvent(event);
  if (!files.length) return false;
  event.preventDefault();
  await attachFiles(files);
  els.composerStatus.textContent = `${files.length} pasted attachment${files.length === 1 ? '' : 's'} ready`;
  return true;
}

function dragEventHasFiles(event) {
  return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

function setComposerDropActive(active) {
  els.composer.classList.toggle('drop-active', Boolean(active));
  els.composerDropOverlay.hidden = !active;
}

async function handleComposerDrop(event) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  setComposerDropActive(false);
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  await attachFiles(files);
  els.composerStatus.textContent = `${files.length} dropped attachment${files.length === 1 ? '' : 's'} ready`;
}

function addUrlAttachment() {
  const url = globalThis.prompt('Paste a URL to attach to this prompt:');
  if (!url?.trim()) return;
  attachments.push({ id: `${Date.now()}:${Math.random()}`, kind: 'url', name: 'URL context', size: 0, type: 'text/uri-list', text: url.trim(), dataUrl: '' });
  renderAttachments();
  els.prompt.focus();
}

function insertPromptSnippet() {
  const snippet = 'Summarize the attached context and call out the important takeaways.';
  els.prompt.value = [els.prompt.value.trim(), snippet].filter(Boolean).join(els.prompt.value.trim() ? '\n\n' : '');
  els.prompt.focus();
  updateBusyControls();
}

async function handleAttachAction(action) {
  toggleAttachMenu(false);
  if (action === 'files') els.attachmentInput.click();
  else if (action === 'images') els.imageAttachmentInput.click();
  else if (action === 'paste-image') await pasteImageAttachment();
  else if (action === 'url') addUrlAttachment();
  else if (action === 'snippet') insertPromptSnippet();
}

function attachmentPrompt() {
  if (!attachments.length) return '';
  return `\n\n[ATTACHMENTS]\n${attachments.map((item, index) => item.kind === 'image'
    ? `Image ${index + 1}: ${item.name}\nInline image data: ${item.dataUrl}`
    : `File ${index + 1}: ${item.name}\n${item.text || '[binary file metadata only]'}`).join('\n\n')}\n[/ATTACHMENTS]`;
}

function voicePagePath() {
  return fullTabEntryPathForPage(globalThis.location.href).replace(/app\.html$/, 'voice-dictation.html');
}

async function openVoiceDictation() {
  await chrome.tabs.create({ url: chrome.runtime.getURL(voicePagePath()), active: true });
  els.composerStatus.textContent = 'Voice tab opened';
}

async function consumeVoiceDraft(draft) {
  const transcript = String(draft?.transcript || draft?.text || draft?.payload?.transcript || '').trim();
  if (!transcript) return false;
  els.prompt.value = [els.prompt.value.trim(), transcript].filter(Boolean).join(' ');
  await chrome.storage.local.remove(VOICE_DRAFT_STORAGE_KEY);
  els.composerStatus.textContent = 'Voice transcript ready';
  updateBusyControls();
  els.prompt.focus();
  return true;
}

async function consumePendingVoiceDraft() {
  const stored = await chrome.storage.local.get([VOICE_DRAFT_STORAGE_KEY]);
  return consumeVoiceDraft(stored?.[VOICE_DRAFT_STORAGE_KEY]);
}

function updateBusyControls() {
  const hasDraft = Boolean(els.prompt.value.trim() || attachments.length);
  els.queueDraft.hidden = !(sending && hasDraft);
  els.steerDraft.hidden = !(sending && hasDraft && activeRunId);
}

function queueCurrentDraft() {
  const text = els.prompt.value.trim();
  if (!text && !attachments.length) return;
  queuedTurn = { text, attachments: [...attachments] };
  els.prompt.value = '';
  attachments = [];
  renderAttachments();
  els.composerStatus.textContent = 'Message queued';
  updateBusyControls();
}

async function steerCurrentDraft() {
  const text = els.prompt.value.trim();
  if (!sending || !activeRunId || !text) return;
  const response = await client.fetch(`/v1/runs/${encodeURIComponent(activeRunId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ input: text, message: text, text }),
  });
  if (!response.ok) throw new Error(`Hermes steer failed (${response.status}).`);
  els.prompt.value = '';
  els.composerStatus.textContent = 'Steer sent';
  updateBusyControls();
}

function renderToolEvent(event) {
  const activity = normalizeToolActivity(event);
  if (shouldPreserveImageGenerationRun(liveRun, activity)) return;
  els.toolActivityList.querySelector('.activity-empty')?.remove();
  const row = document.createElement('article');
  row.className = `tool-event ${activity.status || 'progress'}`;
  const type = document.createElement('small');
  const name = document.createElement('strong');
  const detail = document.createElement('p');
  type.textContent = activity.category;
  name.textContent = activity.label;
  detail.textContent = activity.preview || activity.status || 'Running';
  row.append(type, name, detail);
  els.toolActivityList.prepend(row);
  const imageGeneration = Boolean(activity.aspectRatio);
  liveRun = {
    phase: imageGeneration ? 'IMAGE GENERATION' : 'TOOL ACTIVITY',
    title: imageGeneration ? 'Hermes is generating an image' : activity.label,
    detail: activity.preview || activity.rawName,
    image: imageGeneration,
    aspectRatio: activity.aspectRatio,
    seed: activity.activityId || activeRunId || Date.now(),
  };
  renderMessages(activeMessages);
  setInspectorTab('activity');
}

function setSending(value) {
  sending = Boolean(value);
  els.send.disabled = sending;
  els.stopRun.hidden = !sending;
  if (sending) els.composerStatus.textContent = 'Hermes is working…';
  else if (els.composerStatus.textContent === 'Hermes is working…') els.composerStatus.textContent = '';
  updateBusyControls();
}

function toggleSessionActionsMenu(force) {
  if (!activeSessionId) return;
  const visible = typeof force === 'boolean' ? force : els.sessionActionsMenu.hidden;
  els.sessionActionsMenu.hidden = !visible;
  els.copySessionId.setAttribute('aria-expanded', String(visible));
}

async function renameHermesWebSessionTitle(sessionId, title) {
  const cleanSessionId = String(sessionId || '').trim();
  const cleanTitle = String(title || '').trim();
  if (!cleanSessionId || !cleanTitle) return false;
  const response = await client.fetch(`/api/sessions/${encodeURIComponent(cleanSessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: cleanTitle }),
  });
  const payload = await client.readJson(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session rename failed (${response.status}).`);
  const updated = normalizeHermesSessions({ data: [payload.session || payload] })[0]
    || { id: cleanSessionId, title: cleanTitle, source: sessions.find((session) => session.id === cleanSessionId)?.source || 'hermes_web' };
  sessions = normalizeHermesSessions({ data: [updated, ...sessions.filter((session) => session.id !== cleanSessionId)] });
  if (cleanSessionId === activeSessionId) {
    settings = { ...settings, webSessionTitle: updated.title || cleanTitle };
    await chrome.storage.local.set({ hermesBrowserSettings: settings });
    els.sessionTitle.textContent = settings.webSessionTitle;
  }
  renderSessions(els.sessionSearch.value);
  els.composerStatus.textContent = 'Session renamed and synced';
  return true;
}

function promptRenameHermesWebSession(session = {}) {
  const currentTitle = sessionTitle(session);
  const nextTitle = window.prompt('Rename session', currentTitle);
  if (nextTitle == null) return;
  const cleanTitle = String(nextTitle).trim();
  if (!cleanTitle || cleanTitle === currentTitle) return;
  renameHermesWebSessionTitle(session.id, cleanTitle).catch((error) => {
    els.composerStatus.textContent = `Could not rename session: ${error?.message || String(error)}`;
  });
}

async function beginHermesWebDraft({ focus = true } = {}) {
  clearLiveRun();
  activeSessionId = '';
  activeMessages = [];
  attachments = [];
  settings = { ...settings, webSessionId: '', webSessionTitle: 'New Hermes Web chat' };
  const persistDraft = chrome.storage.local.set({ hermesBrowserSettings: settings });
  els.sessionTitle.textContent = settings.webSessionTitle;
  els.composerSessionLabel.textContent = 'Draft · saved when sent';
  els.errorState.hidden = true;
  els.loadingState.hidden = true;
  renderAttachments();
  renderMessages([]);
  renderSessions(els.sessionSearch.value);
  renderConnectionTruth({ status: 'online' });
  if (focus) els.prompt.focus();
  await persistDraft;
}

async function createSession() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `hermes-web-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const model = effectiveModel();
  const title = `Hermes Web · ${new Date().toLocaleString()}`;
  const response = await client.fetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ id, title, source: HERMES_WEB_SESSION_SOURCE, model: model.model, provider: model.provider || undefined, model_options: modelOptionsPayload() }),
  });
  const payload = await client.readJson(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session creation failed (${response.status}).`);
  const session = payload.session || payload;
  activeSessionId = session.id || id;
  settings = { ...settings, webSessionId: activeSessionId, webSessionTitle: session.title || title };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  activeMessages = [];
  renderMessages([]);
  renderSessions();
  els.sessionTitle.textContent = settings.webSessionTitle;
  els.composerSessionLabel.textContent = activeSessionId;
  return activeSessionId;
}

async function sendPrompt(text) {
  if (sending) return;
  if (!activeSessionId) await createSession();
  const turnAttachments = [...attachments];
  const skillSelection = extractSelectedWebSkills(text, availableSkills);
  const requestText = skillSelection.message || (skillSelection.selectedSkills.length ? 'Use the selected Hermes skill guidance for this request.' : text);
  const prompt = `${requestText}${attachmentPrompt()}`;
  attachments = [];
  renderAttachments();
  const user = { role: 'user', content: text, attachments: turnAttachments };
  const assistant = { role: 'assistant', content: '' };
  activeMessages = [...activeMessages, user];
  liveRun = { phase: 'THINKING', title: 'Hermes is thinking', detail: 'Preparing a response', image: false, seed: Date.now() };
  setSending(true);
  renderMessages(activeMessages);
  activeAbortController = new AbortController();
  const model = effectiveModel();
  try {
    const response = await client.fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/chat/stream`, {
      method: 'POST',
      signal: activeAbortController.signal,
      body: JSON.stringify({
        model: model.model,
        provider: model.provider || undefined,
        model_options: modelOptionsPayload(),
        require_model_lock: Boolean(model.provider || model.model),
        message: prompt,
        selected_skills: skillSelection.selectedSkills,
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Hermes stream failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    await readHermesSse(response, {
      signal: activeAbortController.signal,
      onAssistant: (content) => {
        assistant.content = content;
        if (isRenderableAssistantMessage(assistant)) {
          if (!activeMessages.includes(assistant)) activeMessages = [...activeMessages, assistant];
          const imageSources = resolvedGeneratedImageSources(content);
          if (liveRun?.image) {
            if (imageSources.length && !liveRun.revealPromise) {
              liveRun.revealSources = imageSources;
              liveRun.revealPending = true;
              renderMessages(activeMessages);
              beginFinalImageReveal(imageSources);
            }
            return;
          }
          clearLiveRun();
        }
        renderMessages(activeMessages);
      },
      onTool: renderToolEvent,
      onRun: (runId) => {
        activeRunId = String(runId || '');
        if (liveRun) liveRun.seed = activeRunId || liveRun.seed;
        updateBusyControls();
      },
      onRuntime: (runtime) => {
        const actual = runtime?.runtime || runtime;
        latestRuntime = actual || {};
        if (actual?.model) els.modelLabel.textContent = actual.model;
        activeRunId = String(actual?.run_id || actual?.runId || activeRunId || '');
        updateBusyControls();
        renderContextWindow();
      },
    });
    const refreshed = await client.getSessionMessages(activeSessionId).catch(() => null);
    if (refreshed?.length) {
      activeMessages = refreshed;
      if (!liveRun?.revealPending) renderMessages(activeMessages);
    }
    const listedSessions = normalizeHermesSessions(await client.listSessions({ limit: 200, maxPages: 5 }).catch(() => []));
    sessions = visibleHermesWebSessions(await migrateOwnedHermesWebSessionSources(listedSessions));
    renderSessions(els.sessionSearch.value);
  } finally {
    if (liveRun?.revealPromise) await liveRun.revealPromise;
    activeAbortController = null;
    activeRunId = '';
    clearLiveRun();
    setSending(false);
    renderMessages(activeMessages);
    if (queuedTurn) {
      const next = queuedTurn;
      queuedTurn = null;
      attachments = next.attachments || [];
      await sendPrompt(next.text || 'Please review the attached files.');
    }
  }
}

function showError(title, detail) {
  els.loadingState.hidden = true;
  els.errorState.hidden = false;
  els.errorTitle.textContent = title;
  els.errorDetail.textContent = detail;
}

async function openSession(sessionId) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return;
  activeSessionId = cleanSessionId;
  const session = sessions.find((row) => row.id === cleanSessionId) || { id: cleanSessionId, title: settings.webSessionTitle };
  latestRuntime = runtimeTelemetryForSession(session);
  settings = { ...settings, webSessionId: cleanSessionId, webSessionTitle: sessionTitle(session) };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  els.sessionTitle.textContent = sessionTitle(session);
  els.composerSessionLabel.textContent = cleanSessionId;
  els.errorState.hidden = true;
  els.loadingState.hidden = false;
  els.emptyState.hidden = true;
  els.messageList.hidden = true;
  renderSessions(els.sessionSearch.value);
  renderContextWindow();
  renderConnectionTruth({ status: 'online' });
  try {
    const messages = await client.getSessionMessages(cleanSessionId);
    renderMessages(messages);
    els.loadingState.hidden = true;
  } catch (error) {
    showError('Could not load this session', error?.message || String(error));
  }
}

async function loadApp() {
  const stored = await chrome.storage.local.get(['hermesBrowserSettings']);
  settings = migrateConnectionSettings(stored.hermesBrowserSettings || {});
  applyAppearance();
  applySessionVisibility();
  activeSessionId = handoff.newChat ? '' : (activeSessionId || settings.webSessionId || '');
  const mode = normalizeConnectionMode(settings.connectionMode);
  renderConnectionTruth({ status: 'idle' });
  els.handoffDetail.textContent = handoff.sourceSurfaceId
    ? `Opened from ${handoff.sourceSurfaceId}${handoff.sourceTabId ? ` on browser tab ${handoff.sourceTabId}` : ''}.`
    : 'Opened directly in full view.';
  els.returnToPageButton.hidden = !handoff.sourceTabId;

  if (!settings.gatewayUrl) {
    showError('Connection not configured', 'Open the side panel, configure a Hermes connection, then open full view again.');
    return;
  }
  if (mode === 'cloud' || settings.connectionTransport === 'remote-dashboard' || settings.gatewayMode === 'remote-dashboard') {
    sessions = activeSessionId ? normalizeHermesSessions([{ id: activeSessionId, title: settings.webSessionTitle || 'Hermes Cloud session', source: mode }]) : [];
    renderSessions();
    showError('Live dashboard handoff is next', 'This connection uses a signed-in dashboard tab. Full-tab history remains read-only until the shared background WebSocket coordinator owns the ticketed connection.');
    return;
  }
  if (!settings.apiKey) {
    showError('API token required', 'Open side-panel Settings and connect the Local or Remote API before loading canonical session history.');
    return;
  }

  try {
    const health = await client.fetch('/health', { method: 'GET', cache: 'no-store' });
    if (!health.ok) throw new Error(`Gateway health returned ${health.status}.`);
    renderConnectionTruth({ status: 'online' });
    const metadataPromise = Promise.all([
      loadModels().catch((error) => { els.modelLabel.textContent = requestedModelLabel(); console.warn('[Hermes Web] model discovery:', error); }),
      loadSkills({ quiet: true }),
      client.listSessions({ limit: 200, maxPages: 5 }).then(async (rows) => {
        const listedSessions = normalizeHermesSessions(rows);
        sessions = visibleHermesWebSessions(await migrateOwnedHermesWebSessionSources(listedSessions));
        if (activeSessionId && !sessions.some((session) => session.id === activeSessionId) && !handoff.sessionId) activeSessionId = '';
        renderSessions();
      }),
    ]);
    if (handoff.newChat) await beginHermesWebDraft();
    await metadataPromise;
    if (handoff.newChat) return;
    if (activeSessionId) await openSession(activeSessionId);
    else {
      els.loadingState.hidden = true;
      els.emptyState.hidden = false;
    }
  } catch (error) {
    renderConnectionTruth({ status: 'error' });
    showError('Hermes gateway unavailable', error?.message || String(error));
  }
}

function setInspectorTab(name) {
  for (const tab of document.querySelectorAll('[data-inspector-tab]')) {
    const selected = tab.dataset.inspectorTab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  for (const panel of document.querySelectorAll('[data-inspector-panel]')) {
    const selected = panel.dataset.inspectorPanel === name;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  }
}

function initializeResponsiveShell() {
  const inspectorStartsOpen = globalThis.innerWidth >= 1440;
  els.shell.classList.toggle('inspector-closed', !inspectorStartsOpen);
  els.inspectorToggle.setAttribute('aria-expanded', String(inspectorStartsOpen));
  setNavigationOpen(false);
}

function setNavigationOpen(open) {
  const drawerMode = globalThis.innerWidth <= 1023;
  const visible = drawerMode && Boolean(open);
  els.shell.classList.toggle('nav-open', visible);
  els.navToggle.setAttribute('aria-expanded', String(visible));
  els.sessionRail.inert = drawerMode && !visible;
  els.sessionRail.setAttribute('aria-hidden', String(drawerMode && !visible));
}

function updateScrim() {
  const visible = (globalThis.innerWidth <= 1023 && els.shell.classList.contains('nav-open'))
    || (globalThis.innerWidth <= 1439 && !els.shell.classList.contains('inspector-closed'));
  els.drawerScrim.hidden = !visible;
}

els.navToggle.addEventListener('click', () => {
  setNavigationOpen(!els.shell.classList.contains('nav-open'));
  updateScrim();
});
els.inspectorToggle.addEventListener('click', () => {
  const closed = els.shell.classList.toggle('inspector-closed');
  els.inspectorToggle.setAttribute('aria-expanded', String(!closed));
  updateScrim();
});
els.drawerScrim.addEventListener('click', () => {
  setNavigationOpen(false);
  if (globalThis.innerWidth <= 1439) els.shell.classList.add('inspector-closed');
  els.inspectorToggle.setAttribute('aria-expanded', 'false');
  updateScrim();
});
els.sessionSearch.addEventListener('input', () => renderSessions(els.sessionSearch.value));
els.railVisibilityToggle.addEventListener('click', () => persistSessionVisibility({ webSessionsVisible: settings.webSessionsVisible === false }));
els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = els.prompt.value.trim();
  if (!text && !attachments.length) return;
  if (sending) {
    queueCurrentDraft();
    return;
  }
  const webCommand = parseWebCommand(text);
  if (webCommand && !attachments.length) {
    els.prompt.value = '';
    await runWebCommand(webCommand.name);
    renderContextWindow();
    return;
  }
  els.prompt.value = '';
  renderContextWindow();
  try {
    await sendPrompt(text);
  } catch (error) {
    activeMessages = [...activeMessages, { role: 'system', content: `Send failed: ${error?.message || String(error)}` }];
    renderMessages(activeMessages);
  }
});
els.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});
els.prompt.addEventListener('input', () => {
  updateBusyControls();
  renderComposerSuggestions();
  renderContextWindow();
});
els.prompt.addEventListener('paste', (event) => {
  handleComposerPaste(event).catch((error) => { els.composerStatus.textContent = `Paste failed: ${error?.message || String(error)}`; });
});
['dragenter', 'dragover'].forEach((type) => {
  els.composer.addEventListener(type, (event) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    if (type === 'dragenter') dragDepth += 1;
    setComposerDropActive(true);
  });
});
els.composer.addEventListener('dragleave', (event) => {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setComposerDropActive(false);
});
els.composer.addEventListener('drop', (event) => {
  handleComposerDrop(event).catch((error) => { els.composerStatus.textContent = `Drop failed: ${error?.message || String(error)}`; });
});
els.stopRun.addEventListener('click', () => activeAbortController?.abort());
els.attachButton.addEventListener('click', () => toggleAttachMenu());
els.quickAttach.addEventListener('click', () => toggleAttachMenu(true));
els.attachMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-attach]')?.dataset.attach;
  if (action) handleAttachAction(action).catch((error) => { els.composerStatus.textContent = error?.message || String(error); });
});
els.attachmentInput.addEventListener('change', () => attachFiles(els.attachmentInput.files).finally(() => { els.attachmentInput.value = ''; }));
els.imageAttachmentInput.addEventListener('change', () => attachFiles(els.imageAttachmentInput.files).finally(() => { els.imageAttachmentInput.value = ''; }));
els.voiceButton.addEventListener('click', () => openVoiceDictation().catch((error) => { els.composerStatus.textContent = error?.message || String(error); }));
els.quickVoice.addEventListener('click', () => els.voiceButton.click());
els.quickModel.addEventListener('click', () => toggleModelPicker(true));
els.composerModelControl?.addEventListener('click', () => toggleModelPicker());
els.queueDraft.addEventListener('click', queueCurrentDraft);
els.steerDraft.addEventListener('click', () => steerCurrentDraft().catch((error) => { els.composerStatus.textContent = error?.message || String(error); }));
els.commandMenuButton.addEventListener('click', () => renderComposerSuggestions({ force: els.skillMenu.hidden }));
els.settingsButton.addEventListener('click', openSettings);
els.closeSettings.addEventListener('click', () => els.settingsDialog.close());
els.settingsDialog.addEventListener('click', (event) => {
  if (event.target === els.settingsDialog) els.settingsDialog.close();
});
els.closeImageLightbox?.addEventListener('click', () => els.imageLightbox?.close());
els.zoomImageIn?.addEventListener('click', () => updateImageViewer({ type: 'zoom-in' }));
els.zoomImageOut?.addEventListener('click', () => updateImageViewer({ type: 'zoom-out' }));
els.resetImageZoom?.addEventListener('click', resetImageViewer);
els.imageLightbox?.addEventListener('close', resetImageViewer);
els.imageLightbox?.addEventListener('click', (event) => {
  if (event.target === els.imageLightbox) els.imageLightbox.close();
});
els.imageLightboxCanvas?.addEventListener('wheel', (event) => {
  event.preventDefault();
  updateImageViewer({ type: event.deltaY < 0 ? 'zoom-in' : 'zoom-out' });
}, { passive: false });
els.imageLightboxCanvas?.addEventListener('pointerdown', (event) => {
  if (imageViewerState.scale <= 1) return;
  imagePanGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    imageX: imageViewerState.x,
    imageY: imageViewerState.y,
  };
  els.imageLightboxCanvas.setPointerCapture?.(event.pointerId);
  els.imageLightboxCanvas.toggleAttribute('data-dragging', true);
});
els.imageLightboxCanvas?.addEventListener('pointermove', (event) => {
  if (!imagePanGesture || imagePanGesture.pointerId !== event.pointerId) return;
  updateImageViewer({
    type: 'pan',
    x: imagePanGesture.imageX + event.clientX - imagePanGesture.startX,
    y: imagePanGesture.imageY + event.clientY - imagePanGesture.startY,
  });
});
const endImagePan = (event) => {
  if (!imagePanGesture || (event?.pointerId != null && imagePanGesture.pointerId !== event.pointerId)) return;
  imagePanGesture = null;
  els.imageLightboxCanvas?.removeAttribute('data-dragging');
};
els.imageLightboxCanvas?.addEventListener('pointerup', endImagePan);
els.imageLightboxCanvas?.addEventListener('pointercancel', endImagePan);
for (const button of els.settingsColorModeButtons) {
  button.addEventListener('click', () => {
    els.settingsColorMode.value = button.dataset.colorMode;
    applyAndPersistAppearance();
  });
}
for (const button of els.settingsTextSizeButtons) {
  button.addEventListener('click', () => {
    els.settingsTextSize.value = button.dataset.textSize;
    applyAndPersistAppearance();
  });
}
els.settingsThemeGrid.addEventListener('click', (event) => {
  const card = event.target.closest('[data-theme]');
  if (!card) return;
  els.settingsTheme.value = card.dataset.theme;
  applyAndPersistAppearance();
});
els.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveSettings().catch((error) => { els.composerStatus.textContent = `Settings failed: ${error?.message || String(error)}`; });
});
els.newChatButton.addEventListener('click', () => beginHermesWebDraft().catch((error) => showError('Could not start draft', error?.message || String(error))));
els.modelPickerButton.addEventListener('click', () => toggleModelPicker());
els.modelSearch.addEventListener('input', () => renderModelPicker(els.modelSearch.value));
els.modelOptionsList?.addEventListener('click', (event) => {
  const effort = event.target.closest('[data-runtime-effort]')?.dataset.runtimeEffort;
  if (effort) {
    setModelRuntimeOptions({ reasoningEffort: effort }).catch((error) => { els.composerStatus.textContent = `Runtime option save failed: ${error?.message || String(error)}`; });
    return;
  }
  const toggle = event.target.closest('[data-runtime-toggle]')?.dataset.runtimeToggle;
  const options = activeModelRuntimeOptions();
  if (toggle === 'thinking') {
    setModelRuntimeOptions({ thinkingEnabled: !options.thinkingEnabled }).catch((error) => { els.composerStatus.textContent = `Runtime option save failed: ${error?.message || String(error)}`; });
  } else if (toggle === 'fast') {
    setModelRuntimeOptions({ fastMode: !options.fastMode }).catch((error) => { els.composerStatus.textContent = `Runtime option save failed: ${error?.message || String(error)}`; });
  }
});
els.refreshModels.addEventListener('click', () => refreshModelsFromPicker().catch((error) => { els.modelList.textContent = error?.message || String(error); }));
els.copySessionId.addEventListener('click', () => toggleSessionActionsMenu());
els.sessionActionsMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-session-action]')?.dataset.sessionAction;
  if (!action || !activeSessionId) return;
  toggleSessionActionsMenu(false);
  if (action === 'rename') {
    promptRenameHermesWebSession(sessions.find((session) => session.id === activeSessionId) || { id: activeSessionId, title: settings.sessionTitle });
    return;
  }
  navigator.clipboard.writeText(activeSessionId)
    .then(() => { els.composerStatus.textContent = 'Session ID copied'; })
    .catch((error) => { els.composerStatus.textContent = `Copy failed: ${error?.message || String(error)}`; });
});
els.returnToPageButton.addEventListener('click', async () => {
  if (handoff.sourceTabId) await chrome.tabs.update(handoff.sourceTabId, { active: true });
});
els.connectionTruth.addEventListener('click', () => {
  setInspectorTab('diagnostics');
  els.shell.classList.remove('inspector-closed');
  els.inspectorToggle.setAttribute('aria-expanded', 'true');
  updateScrim();
});
els.copyDiagnostics.addEventListener('click', async () => {
  const report = [
    'Hermes Web diagnostics',
    `Surface: fulltab`,
    `Connection: ${els.diagConnection.textContent}`,
    `Gateway origin: ${els.diagGateway.textContent}`,
    `Session: ${activeSessionId || 'none'}`,
    `Model: ${els.diagModel.textContent}`,
    `Profile: ${els.diagProfile.textContent}`,
  ].join('\n');
  await navigator.clipboard.writeText(report);
  els.copyDiagnostics.textContent = 'Diagnostics copied';
  setTimeout(() => { els.copyDiagnostics.textContent = 'Copy redacted diagnostics'; }, 1400);
});
for (const tab of document.querySelectorAll('[data-inspector-tab]')) {
  tab.addEventListener('click', () => setInspectorTab(tab.dataset.inspectorTab));
}
globalThis.addEventListener('resize', () => {
  if (globalThis.innerWidth <= 1439) {
    els.shell.classList.add('inspector-closed');
    els.inspectorToggle.setAttribute('aria-expanded', 'false');
  }
  setNavigationOpen(els.shell.classList.contains('nav-open'));
  updateScrim();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[VOICE_DRAFT_STORAGE_KEY]?.newValue) consumeVoiceDraft(changes[VOICE_DRAFT_STORAGE_KEY].newValue).catch(() => {});
});
document.addEventListener('click', (event) => {
  if (!els.attachMenu.hidden && !els.attachMenu.contains(event.target) && !els.attachButton.contains(event.target)) toggleAttachMenu(false);
  if (!els.skillMenu.hidden && !els.skillMenu.contains(event.target) && event.target !== els.prompt && event.target !== els.commandMenuButton) {
    els.skillMenu.hidden = true;
    els.commandMenuButton.setAttribute('aria-expanded', 'false');
  }
  if (!els.sessionActionsMenu.hidden && !els.sessionActionsMenu.contains(event.target) && event.target !== els.copySessionId) toggleSessionActionsMenu(false);
});
globalThis.addEventListener('focus', () => consumePendingVoiceDraft().catch(() => {}));
globalThis.addEventListener('visibilitychange', () => {
  if (!document.hidden) consumePendingVoiceDraft().catch(() => {});
});

initializeResponsiveShell();
updateScrim();
loadApp()
  .then(() => consumePendingVoiceDraft())
  .catch((error) => showError('Hermes Web could not start', error?.message || String(error)));
