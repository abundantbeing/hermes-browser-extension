import {
  DEFAULT_SETTINGS,
  HERMES_BROWSER_SYSTEM_PROMPT,
  MODEL_EFFORTS,
  buildHermesModelOptions,
  buildHermesPrompt,
  clampText,
  encodeSessionId,
  estimateContextWindow,
  estimateTokens,
  extractAssistantText,
  formatContextMeter,
  groupModelsForMenu,
  groupSessionsForMenu,
  isRestrictedUrl,
  normalizeHermesModels,
  normalizeHermesProfiles,
  normalizeHermesSessions,
  normalizeHermesSkills,
  normalizeGatewayUrl,
  normalizeReasoningEffort,
  reasoningEffortShortLabel,
  renderMarkdown,
  safeTab,
  shouldStopSessionPaging,
  shouldSubmitComposerKey,
  skillSuggestionsForInput,
} from './lib/common.mjs';
import { extractYouTubeVideoId } from './lib/transcript.mjs';

const $ = (selector) => document.querySelector(selector);

const els = {
  appScroll: $('#appScroll'),
  connectPanel: $('#connectPanel'),
  connectButton: $('#connectButton'),
  manualSettingsButton: $('#manualSettingsButton'),
  connectStatus: $('#connectStatus'),
  connectionPill: $('#connectionPill'),
  sessionMenuButton: $('#sessionMenuButton'),
  currentSessionName: $('#currentSessionName'),
  newSessionButton: $('#newSessionButton'),
  sessionMenu: $('#sessionMenu'),
  sessionSearchInput: $('#sessionSearchInput'),
  sessionMenuList: $('#sessionMenuList'),
  createSessionButton: $('#createSessionButton'),
  refreshSessionsButton: $('#refreshSessionsButton'),
  messages: $('#messages'),
  composer: $('#composer'),
  input: $('#promptInput'),
  contextChip: $('#contextChip'),
  contextChipLabel: $('#contextChipLabel'),
  contextPreview: $('#contextPreview'),
  composerDropZone: $('#composerDropZone'),
  dropOverlay: $('#dropOverlay'),
  skillMenu: $('#skillMenu'),
  queueNotice: $('#queueNotice'),
  sendButton: $('#sendButton'),
  stopButton: $('#stopButton'),
  refreshButton: $('#refreshButton'),
  settingsButton: $('#settingsButton'),
  closeSettingsButton: $('#closeSettingsButton'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  testConnectionButton: $('#testConnectionButton'),
  activeTitle: $('#activeTitle'),
  activeUrl: $('#activeUrl'),
  statusDot: $('#statusDot'),
  modelMenuButton: $('#modelMenuButton'),
  currentModelName: $('#currentModelName'),
  currentModelEffort: $('#currentModelEffort'),
  modelMenu: $('#modelMenu'),
  modelSearchInput: $('#modelSearchInput'),
  modelProviderList: $('#modelProviderList'),
  modelMenuList: $('#modelMenuList'),
  modelOptionsList: $('#modelOptionsList'),
  refreshModelsButton: $('#refreshModelsButton'),
  editModelsButton: $('#editModelsButton'),
  contextBarButton: $('#contextBarButton'),
  attachMenuButton: $('#attachMenuButton'),
  attachMenu: $('#attachMenu'),
  attachmentList: $('#attachmentList'),
  fileInput: $('#fileInput'),
  imageInput: $('#imageInput'),
  folderInput: $('#folderInput'),
  contextCompactLabel: $('#contextCompactLabel'),
  contextPercentLabel: $('#contextPercentLabel'),
  contextUsageDetail: $('#contextUsageDetail'),
  contextMeterFill: $('#contextMeterFill'),
  contextPopover: $('#contextPopover'),
  contextBreakdown: $('#contextBreakdown'),
  gatewayUrlInput: $('#gatewayUrlInput'),
  apiKeyInput: $('#apiKeyInput'),
  sessionIdInput: $('#sessionIdInput'),
  sessionTitleInput: $('#sessionTitleInput'),
  contextDepthInput: $('#contextDepthInput'),
  includeTabsInput: $('#includeTabsInput'),
  includePageTextInput: $('#includePageTextInput'),
  includeSelectedTextInput: $('#includeSelectedTextInput'),
  transcriptProviderInput: $('#transcriptProviderInput'),
  profileSelect: $('#profileSelect'),
  refreshProfilesButton: $('#refreshProfilesButton'),
  profileStatus: $('#profileStatus'),
  themeGrid: $('#themeGrid'),
  colorModeButtons: Array.from(document.querySelectorAll('[data-color-mode]')),
  template: $('#messageTemplate'),
};

let settings = { ...DEFAULT_SETTINGS };
let currentContext = { activeTab: null, tabs: [], pageContext: null };
let messages = [];
let availableModels = [];
let availableSessions = [];
let availableSkills = [];
let availableProfiles = [];
let attachments = [];
let selectedModelProvider = '';
const openSessionGroups = new Set();
let sending = false;
let queuedTurn = null;
let activeAbortController = null;
let activeRunId = '';
let dragDepth = 0;
let sessionRoutesAvailable = null;

function setStatus(kind, title, detail) {
  els.statusDot.className = `status-dot ${kind || ''}`.trim();
  const safeTitle = title || 'Hermes Browser Extension';
  const safeDetail = detail || '';
  els.activeTitle.textContent = safeTitle;
  els.activeTitle.title = safeTitle;
  els.activeUrl.textContent = safeDetail;
  els.activeUrl.title = safeDetail;
}

function openSettingsDialog() {
  els.settingsDialog.hidden = false;
  els.settingsDialog.setAttribute('aria-hidden', 'false');
  els.apiKeyInput.focus();
}

function closeSettingsDialog() {
  els.settingsDialog.hidden = true;
  els.settingsDialog.setAttribute('aria-hidden', 'true');
  els.settingsButton.focus();
}

function updateConnectionPrompt() {
  const connected = Boolean(settings.apiKey);
  els.connectPanel.hidden = connected;
  els.connectionPill.textContent = connected ? 'CONNECTED' : 'CONNECT';
  els.connectionPill.className = `connection-pill ${connected ? 'ok' : 'warn'}`;
  if (!connected) {
    els.sendButton.textContent = 'Connect first';
    setStatus('warn', 'Connect Hermes Desktop', 'Click Connect to Hermes, approve locally, then start chatting.');
  } else {
    els.sendButton.textContent = sending ? 'Queue message' : 'Ask Hermes';
  }
  updateComposerBusyState();
}

function updateComposerBusyState() {
  if (els.stopButton) {
    els.stopButton.hidden = !sending;
    els.stopButton.disabled = !sending;
  }
  if (els.sendButton) {
    els.sendButton.disabled = !settings.apiKey && !sending;
    if (settings.apiKey) els.sendButton.textContent = sending ? 'Queue message' : 'Ask Hermes';
  }
  renderQueueNotice();
}

function renderQueueNotice() {
  if (!els.queueNotice) return;
  if (!queuedTurn) {
    els.queueNotice.hidden = true;
    els.queueNotice.textContent = '';
    return;
  }
  const count = queuedTurn.attachments?.length || 0;
  els.queueNotice.hidden = false;
  els.queueNotice.textContent = `Queued next message${count ? ` · ${count} attachment${count === 1 ? '' : 's'}` : ''}. It will send after the current turn stops or finishes.`;
}

function queueCurrentDraft() {
  const text = els.input.value.trim();
  if (!text && !attachments.length) return false;
  queuedTurn = { text, attachments: [...attachments] };
  els.input.value = '';
  clearAttachments();
  renderSkillSuggestions();
  renderQueueNotice();
  setStatus('ok', 'Message queued', 'Hermes will send it after the current turn finishes or stops.');
  els.input.focus();
  return true;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
}

async function stopCurrentTurn() {
  if (!sending) return;
  setStatus('warn', 'Stopping Hermes', activeRunId ? `Interrupt requested for ${activeRunId}` : 'Closing the active browser stream');
  if (activeRunId) {
    apiFetch(`/v1/runs/${encodeURIComponent(activeRunId)}/stop`, { method: 'POST' }).catch(() => {});
  }
  activeAbortController?.abort();
}

function formatNumber(value = 0) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatTokens(tokens = 0) {
  if (!tokens) return '0 tokens';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens`;
  return `${formatNumber(tokens)} tokens`;
}

function estimateLocalSessionTokens(userText = '') {
  const messageTokens = messages.reduce((total, message) => total + estimateTokens(message.content || ''), 0);
  return messageTokens + estimateTokens(userText || '') + estimateAttachmentTokens();
}

const TEXT_ATTACHMENT_LIMIT = 12_000;
const IMAGE_ATTACHMENT_TOKEN_ESTIMATE = 1_200;
const BROWSER_IMAGE_UPLOAD_ENDPOINT = '/api/browser-extension/uploads/images';

const COLOR_MODES = new Set(['light', 'dark', 'system']);
const APPEARANCE_THEMES = Object.freeze([
  {
    value: 'nous',
    name: 'Nous',
    description: 'Glass neutrals with Nous blue accents',
    preview: { bg: '#edf3ff', panel: '#ffffff', text: '#202331', muted: '#65677a', accent: '#9dbdff' },
  },
  {
    value: 'midnight',
    name: 'Midnight',
    description: 'Deep blue-violet with cool accents',
    preview: { bg: '#07061a', panel: '#0d0b25', text: '#d9d2ff', muted: '#8e88bd', accent: '#1d1850' },
  },
  {
    value: 'ember',
    name: 'Ember',
    description: 'Warm crimson and bronze forge',
    preview: { bg: '#1a0600', panel: '#250800', text: '#ffd0a4', muted: '#c98f65', accent: '#4b1603' },
  },
  {
    value: 'mono',
    name: 'Mono',
    description: 'Clean grayscale minimal focus',
    preview: { bg: '#0d0d0d', panel: '#111111', text: '#eeeeee', muted: '#9b9b9b', accent: '#1f1f1f' },
  },
  {
    value: 'cyberpunk',
    name: 'Cyberpunk',
    description: 'Neon green terminal',
    preview: { bg: '#001004', panel: '#001b08', text: '#12ff68', muted: '#00a947', accent: '#002d10' },
  },
  {
    value: 'slate',
    name: 'Slate',
    description: 'Cool slate blue developer focus',
    preview: { bg: '#081015', panel: '#0e171e', text: '#d0dbe2', muted: '#94a3ad', accent: '#172c3d' },
  },
]);
const DEFAULT_APPEARANCE_THEME = APPEARANCE_THEMES[0].value;
const systemColorQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function normalizeColorMode(value = DEFAULT_SETTINGS.colorMode) {
  const raw = String(value || DEFAULT_SETTINGS.colorMode || 'dark').trim().toLowerCase();
  return COLOR_MODES.has(raw) ? raw : (DEFAULT_SETTINGS.colorMode || 'dark');
}

function normalizeAppearanceTheme(value = DEFAULT_SETTINGS.appearanceTheme) {
  const raw = String(value || DEFAULT_SETTINGS.appearanceTheme || DEFAULT_APPEARANCE_THEME).trim().toLowerCase();
  return APPEARANCE_THEMES.some((theme) => theme.value === raw) ? raw : DEFAULT_APPEARANCE_THEME;
}

function resolvedColorMode(value = settings.colorMode) {
  const mode = normalizeColorMode(value);
  if (mode === 'system') return systemColorQuery?.matches ? 'dark' : 'light';
  return mode;
}

function applyAppearanceSettings() {
  const theme = normalizeAppearanceTheme(settings.appearanceTheme);
  const colorMode = normalizeColorMode(settings.colorMode);
  const resolvedMode = resolvedColorMode(colorMode);
  const root = document.documentElement;
  root.dataset.hermesTheme = theme;
  root.dataset.hermesColorMode = colorMode;
  root.dataset.hermesMode = resolvedMode;
  root.style.colorScheme = resolvedMode;
}

function renderAppearanceControls() {
  applyAppearanceSettings();
  const colorMode = normalizeColorMode(settings.colorMode);
  const activeTheme = normalizeAppearanceTheme(settings.appearanceTheme);
  for (const button of els.colorModeButtons || []) {
    const selected = button.dataset.colorMode === colorMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  if (!els.themeGrid) return;
  els.themeGrid.innerHTML = APPEARANCE_THEMES.map((theme) => {
    const selected = theme.value === activeTheme;
    const p = theme.preview;
    return `
      <button class="theme-card ${selected ? 'selected' : ''}" type="button" data-theme="${theme.value}" role="radio" aria-checked="${selected}" aria-label="${theme.name}: ${theme.description}" title="${theme.name}: ${theme.description}" style="--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};">
        <span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="theme-card-copy"><strong>${theme.name}</strong></span>
        <span class="theme-check" aria-hidden="true">${selected ? '✓' : ''}</span>
      </button>
    `;
  }).join('');
}

function persistAppearanceSettings() {
  chrome.storage.local.set({ hermesBrowserSettings: settings });
}

function setAppearanceOption(key, value, { persist = true } = {}) {
  if (key === 'colorMode') settings = { ...settings, colorMode: normalizeColorMode(value) };
  if (key === 'appearanceTheme') settings = { ...settings, appearanceTheme: normalizeAppearanceTheme(value) };
  renderAppearanceControls();
  if (persist) persistAppearanceSettings();
}


function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function attachmentIcon(kind = '') {
  return ({ file: '📄', folder: '📁', image: '🖼', url: '🔗' })[kind] || '📎';
}

function attachmentId(kind, label) {
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2)}:${label}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

async function readFileAsText(file) {
  try {
    return await file.text();
  } catch {
    return '';
  }
}

function isLikelyTextFile(file) {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return type.startsWith('text/') || /\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|mjs|css|html|xml|yaml|yml|toml|py|rs|go|java|c|cpp|h|hpp|sql|log)$/i.test(name);
}

function addAttachment(attachment) {
  attachments = [...attachments.filter((item) => item.id !== attachment.id), attachment];
  renderAttachments();
  renderContextWindow();
}

function removeAttachment(id) {
  attachments = attachments.filter((item) => item.id !== id);
  renderAttachments();
  renderContextWindow();
}

function clearAttachments() {
  attachments = [];
  renderAttachments();
  renderContextWindow();
}

function renderAttachments() {
  els.attachmentList.innerHTML = '';
  els.attachmentList.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    const pill = document.createElement('div');
    pill.className = `attachment-pill ${attachment.kind === 'image' ? 'image' : ''}`.trim();
    pill.title = attachment.detail || attachment.label;

    const icon = attachment.kind === 'image' && attachment.dataUrl
      ? document.createElement('img')
      : document.createElement('strong');
    if (icon.tagName === 'IMG') {
      icon.className = 'attachment-thumb';
      icon.src = attachment.dataUrl;
      icon.alt = '';
    } else {
      icon.textContent = attachmentIcon(attachment.kind);
    }

    const label = document.createElement('span');
    label.textContent = attachment.localPath ? `${attachment.label} · saved` : attachment.label;

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', `Remove ${attachment.label}`);
    close.textContent = '×';
    close.addEventListener('click', () => removeAttachment(attachment.id));

    pill.append(icon, label, close);
    els.attachmentList.appendChild(pill);
  }
}

async function uploadImageAttachment(attachment) {
  if (!attachment || attachment.kind !== 'image' || !attachment.dataUrl || attachment.localPath || !settings.apiKey) {
    return attachment;
  }
  const response = await apiFetch(BROWSER_IMAGE_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({
      data_url: attachment.dataUrl,
      filename: attachment.label,
      session_id: settings.sessionId,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || !payload?.path) {
    throw new Error(payload?.error?.message || payload?.error || `Image upload failed (${response.status})`);
  }
  return {
    ...attachment,
    localPath: payload.path,
    savedFilename: payload.filename,
    mimeType: payload.mime_type,
    savedSize: payload.size,
    detail: `${attachment.detail || payload.mime_type || 'image'} · local path ready`,
    uploadError: '',
  };
}

async function ensureImageAttachmentsSaved() {
  if (!attachments.some((attachment) => attachment.kind === 'image' && attachment.dataUrl && !attachment.localPath)) return;
  if (!settings.apiKey) return;
  const next = await saveImageAttachmentsForTurn(attachments);
  attachments = next;
  renderAttachments();
  renderContextWindow();
}

async function saveImageAttachmentsForTurn(items = []) {
  if (!items.some((attachment) => attachment.kind === 'image' && attachment.dataUrl && !attachment.localPath)) return items;
  if (!settings.apiKey) return items;
  let saved = 0;
  let failed = 0;
  const next = [];
  for (const attachment of items) {
    if (attachment.kind !== 'image' || !attachment.dataUrl || attachment.localPath) {
      next.push(attachment);
      continue;
    }
    try {
      const uploaded = await uploadImageAttachment(attachment);
      if (uploaded.localPath) saved += 1;
      next.push(uploaded);
    } catch (error) {
      failed += 1;
      next.push({ ...attachment, uploadError: error?.message || String(error) });
    }
  }
  if (saved) setStatus('ok', 'Image ready for Hermes vision', `${saved} pasted image${saved === 1 ? '' : 's'} saved locally`);
  if (failed) setStatus('warn', 'Image stayed inline only', `${failed} image${failed === 1 ? '' : 's'} could not be saved locally`);
  return next;
}

async function attachFiles(fileList, { imagesOnly = false } = {}) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (!file) continue;
    const isImage = String(file.type || '').startsWith('image/');
    if (imagesOnly && !isImage) continue;
    if (isImage) {
      const dataUrl = await readFileAsDataUrl(file);
      addAttachment({
        id: attachmentId('image', file.name),
        kind: 'image',
        label: file.name || 'image',
        detail: `${file.type || 'image'} · ${formatBytes(file.size)}`,
        dataUrl,
      });
      continue;
    }
    const text = isLikelyTextFile(file) ? clampText(await readFileAsText(file), TEXT_ATTACHMENT_LIMIT) : '';
    addAttachment({
      id: attachmentId('file', file.name),
      kind: 'file',
      label: file.name || 'file',
      detail: `${file.type || 'file'} · ${formatBytes(file.size)}`,
      text: text || `[${file.name || 'file'} attached as metadata only: ${formatBytes(file.size)}. Browser cannot expose a stable local path; use Hermes Desktop for path-backed file refs.]`,
    });
  }
}

async function attachFolder(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const firstPath = files[0].webkitRelativePath || files[0].name || 'folder';
  const folderName = firstPath.split('/')[0] || 'folder';
  const manifest = files
    .slice(0, 300)
    .map((file) => `${file.webkitRelativePath || file.name} (${formatBytes(file.size)})`)
    .join('\n');
  const omitted = files.length > 300 ? `\n... ${files.length - 300} more files omitted` : '';
  addAttachment({
    id: attachmentId('folder', folderName),
    kind: 'folder',
    label: folderName,
    detail: `${files.length} file${files.length === 1 ? '' : 's'}`,
    text: `Folder: ${folderName}\nFiles:\n${manifest}${omitted}`,
  });
}

async function pasteClipboardImage() {
  if (!navigator.clipboard?.read) {
    throw new Error('Use Ctrl+V inside the Ask Hermes box to paste images. Chrome does not expose global clipboard image read here.');
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const file = new File([blob], `clipboard-${Date.now()}.png`, { type });
      await attachFiles([file], { imagesOnly: true });
      setStatus('ok', 'Image attached from clipboard', file.name);
      return;
    }
    throw new Error('Clipboard does not contain an image.');
  } catch (error) {
    throw new Error(`${error?.message || String(error)} Try Ctrl+V in the message box; Hermes Browser Extension handles pasted image data directly from that paste event.`);
  }
}

function imageFilesFromPasteEvent(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const files = [];
  for (const item of Array.from(data.items || [])) {
    if (!String(item.type || '').startsWith('image/')) continue;
    const file = item.getAsFile?.();
    if (file) files.push(new File([file], file.name || `pasted-image-${Date.now()}.png`, { type: file.type || item.type }));
  }
  for (const file of Array.from(data.files || [])) {
    if (String(file.type || '').startsWith('image/') && !files.some((candidate) => candidate.name === file.name && candidate.size === file.size)) {
      files.push(file);
    }
  }
  return files;
}

function imageDataUrlsFromPasteEvent(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const urls = [];
  const html = data.getData?.('text/html') || '';
  const plain = data.getData?.('text/plain') || '';
  const dataUrlPattern = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
  for (const source of [html, plain]) {
    for (const match of source.matchAll(dataUrlPattern)) {
      if (!urls.includes(match[0])) urls.push(match[0]);
    }
  }
  return urls.slice(0, 6);
}

async function handlePasteImages(event) {
  const imageFiles = imageFilesFromPasteEvent(event);
  const dataUrls = imageDataUrlsFromPasteEvent(event);
  if (!imageFiles.length && !dataUrls.length) return false;
  event.preventDefault();
  if (imageFiles.length) await attachFiles(imageFiles, { imagesOnly: true });
  for (const dataUrl of dataUrls) {
    addAttachment({
      id: attachmentId('image', 'pasted-image'),
      kind: 'image',
      label: `pasted-image-${Date.now()}.png`,
      detail: 'image data pasted from clipboard',
      dataUrl,
    });
  }
  const total = imageFiles.length + dataUrls.length;
  setStatus('ok', 'Image pasted into Hermes', `${total} image${total === 1 ? '' : 's'} attached`);
  els.input.focus();
  return true;
}

function dragEventHasFiles(event) {
  return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

function setDropActive(active) {
  els.composerDropZone?.classList.toggle('dragging', Boolean(active));
  if (els.dropOverlay) els.dropOverlay.hidden = !active;
}

async function handleComposerDrop(event) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  setDropActive(false);
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  await attachFiles(files);
  setStatus('ok', 'Files attached', `${files.length} file${files.length === 1 ? '' : 's'} added from drag/drop`);
  els.input.focus();
}

function attachUrl() {
  const value = window.prompt('Attach URL');
  if (!value) return;
  let url = value.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  addAttachment({
    id: attachmentId('url', url),
    kind: 'url',
    label: url,
    detail: url,
    text: `URL attachment: ${url}`,
  });
}

function imageAttachmentPromptLine(image, index) {
  const lines = [`- Image ${index + 1}: ${image.label} (${image.detail || 'image'})`];
  if (image.localPath) {
    lines.push(`  - Local file path: ${image.localPath}`);
    lines.push('  - These are the actual pasted pixels saved by Hermes Browser Extension; use this path with vision tools if inline image input is unavailable.');
  } else {
    lines.push('  - Inline image data is included in the structured message payload.');
    if (image.uploadError) lines.push(`  - Local save warning: ${image.uploadError}`);
  }
  return lines.join('\n');
}

function attachmentContextText(items = attachments) {
  const blocks = items
    .filter((attachment) => attachment.kind !== 'image')
    .map((attachment) => `### ${attachment.kind.toUpperCase()}: ${attachment.label}\n${attachment.text || attachment.detail || ''}`);
  const images = items.filter((attachment) => attachment.kind === 'image');
  if (images.length) blocks.push(`### IMAGES\n${images.map(imageAttachmentPromptLine).join('\n')}`);
  return blocks.length ? `\n\n--- Browser Attachments ---\n${blocks.join('\n\n')}` : '';
}

function estimateAttachmentTokens(items = attachments) {
  return estimateTokens(attachmentContextText(items)) + (items.filter((attachment) => attachment.kind === 'image').length * IMAGE_ATTACHMENT_TOKEN_ESTIMATE);
}

function userTextWithAttachments(userText = '', items = attachments) {
  const text = String(userText || '').trim();
  return `${text || 'Attachment-only turn.'}${attachmentContextText(items)}`;
}

function outboundContent(prompt = '', items = attachments) {
  const images = items.filter((attachment) => attachment.kind === 'image' && attachment.dataUrl);
  if (!images.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.slice(0, 6).map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })),
  ];
}

function modelDisplayName(model = {}) {
  const raw = String(model.label || model.name || model.id || DEFAULT_SETTINGS.model);
  return raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
}

function modelProviderLabel(model = {}) {
  return String(model.providerLabel || model.provider || model.owner || 'Models');
}

function updateModelButtonMeta() {
  const effort = reasoningEffortShortLabel(settings.reasoningEffort);
  const fast = settings.fastMode ? ' Fast' : '';
  els.currentModelEffort.textContent = `${fast}${effort}`.trim();
  els.currentModelEffort.title = `Reasoning effort: ${effort}${settings.fastMode ? ' · Fast' : ''}`;
}

function renderModelOptions(models = availableModels) {
  const normalized = models.length ? models : normalizeHermesModels([], settings.model);
  availableModels = normalized;
  const selectedIsDefaultFallback =
    settings.model === DEFAULT_SETTINGS.model &&
    normalized.length > 1 &&
    normalized[0]?.id !== settings.model;
  if (selectedIsDefaultFallback || !normalized.some((model) => model.id === settings.model)) {
    settings.model = normalized[0]?.id || DEFAULT_SETTINGS.model;
  }
  const selected = normalized.find((model) => model.id === settings.model) || normalized[0];
  if (selected) {
    settings.modelContextTokens = selected.contextTokens || 0;
    const providerLabel = modelProviderLabel(selected);
    if (!selectedModelProvider || !normalized.some((model) => modelProviderLabel(model) === selectedModelProvider)) {
      selectedModelProvider = providerLabel;
    }
    els.currentModelName.textContent = modelDisplayName(selected);
    els.currentModelName.title = `${selected.providerLabel || selected.provider || ''} ${selected.id}`.trim();
    updateModelButtonMeta();
  }
  renderModelMenu();
  renderModelRuntimeOptions();
  renderContextWindow();
}

function renderModelMenu(query = els.modelSearchInput?.value || '') {
  const allGroups = groupModelsForMenu(availableModels, settings.model, '');
  const needle = String(query || '').trim().toLowerCase();
  const matchingGroups = needle ? groupModelsForMenu(availableModels, settings.model, needle) : allGroups;
  els.modelProviderList.innerHTML = '';
  els.modelMenuList.innerHTML = '';

  if (!allGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'model-group-title';
    empty.textContent = 'No providers found';
    els.modelMenuList.appendChild(empty);
    return;
  }

  const selectedModel = availableModels.find((model) => model.id === settings.model);
  const selectedProvider = selectedModel ? modelProviderLabel(selectedModel) : '';
  if (!selectedModelProvider) selectedModelProvider = selectedProvider || allGroups[0].label;
  if (!allGroups.some((group) => group.label === selectedModelProvider)) selectedModelProvider = allGroups[0].label;

  const providerGroups = needle ? matchingGroups : allGroups;
  for (const group of providerGroups) {
    const providerButton = document.createElement('button');
    providerButton.type = 'button';
    providerButton.className = `model-provider-option ${group.label === selectedModelProvider ? 'selected' : ''}`.trim();
    providerButton.dataset.provider = group.label;

    const providerName = document.createElement('span');
    providerName.className = 'model-provider-name';
    providerName.textContent = group.label;

    const providerCount = document.createElement('span');
    providerCount.className = 'model-provider-count';
    providerCount.textContent = String(group.models.length);

    providerButton.append(providerName, providerCount);
    providerButton.addEventListener('click', () => {
      selectedModelProvider = group.label;
      els.modelSearchInput.value = '';
      renderModelMenu('');
      els.modelSearchInput.focus();
    });
    els.modelProviderList.appendChild(providerButton);
  }

  const groupsToRender = needle
    ? matchingGroups
    : [allGroups.find((group) => group.label === selectedModelProvider) || allGroups[0]];

  if (!groupsToRender.length) {
    const empty = document.createElement('div');
    empty.className = 'model-group-title';
    empty.textContent = 'No models match';
    els.modelMenuList.appendChild(empty);
    return;
  }

  for (const group of groupsToRender) {
    const title = document.createElement('div');
    title.className = 'model-group-title';
    title.textContent = needle ? `${group.label} ${group.models.length}` : `${group.label} ${group.models.length}/${group.models.length}`;
    els.modelMenuList.appendChild(title);

    for (const model of group.models) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-option ${model.selected ? 'selected' : ''}`.trim();
      button.dataset.modelId = model.id;

      const name = document.createElement('span');
      name.className = 'model-option-name';
      name.textContent = modelDisplayName(model);

      const meta = document.createElement('span');
      meta.className = 'model-option-meta';
      meta.textContent = model.selected ? '✓' : (model.contextTokens ? formatTokens(model.contextTokens).replace(' tokens', '') : '');

      button.append(name, meta);
      button.addEventListener('click', () => applySelectedModel(model.id, { keepOpen: true }));
      els.modelMenuList.appendChild(button);
    }
  }
}

function renderModelRuntimeOptions() {
  if (!els.modelOptionsList) return;
  const thinkingEnabled = settings.thinkingEnabled !== false;
  const fastMode = Boolean(settings.fastMode);
  const effort = normalizeReasoningEffort(settings.reasoningEffort);
  const effortRows = MODEL_EFFORTS.map((item) => `
    <button class="model-effort-option ${item.value === effort ? 'selected' : ''}" type="button" data-effort="${item.value}">
      <span>${item.label}</span><strong>${item.value === effort ? '✓' : ''}</strong>
    </button>
  `).join('');
  els.modelOptionsList.innerHTML = `
    <div class="model-options-heading">Options</div>
    <button class="model-toggle-option" type="button" data-toggle="thinking" aria-pressed="${String(thinkingEnabled)}">
      <span>Thinking</span><strong class="toggle-switch ${thinkingEnabled ? 'on' : ''}" aria-hidden="true"></strong>
    </button>
    <button class="model-toggle-option" type="button" data-toggle="fast" aria-pressed="${String(fastMode)}">
      <span>Fast</span><strong class="toggle-switch ${fastMode ? 'on' : ''}" aria-hidden="true"></strong>
    </button>
    <div class="model-options-heading effort-heading">Effort</div>
    <div class="model-effort-list">${effortRows}</div>
  `;
}

function persistModelRuntimeOptions() {
  chrome.storage.local.set({ hermesBrowserSettings: settings });
}

function setModelRuntimeOption(key, value) {
  settings = { ...settings, [key]: value };
  renderModelRuntimeOptions();
  updateModelButtonMeta();
  persistModelRuntimeOptions();
}

function renderContextWindow(userText = els.input?.value || '') {
  const stats = estimateContextWindow({
    userText,
    activeTab: currentContext.activeTab,
    tabs: currentContext.tabs,
    pageContext: currentContext.pageContext,
    settings,
  });
  const sessionTokens = estimateLocalSessionTokens(userText);
  const meter = formatContextMeter({ estimatedTokens: sessionTokens, modelContextTokens: stats.modelContextTokens });

  els.contextCompactLabel.textContent = meter.compactLabel;
  els.contextPercentLabel.textContent = meter.percentLabel;
  els.contextBarButton.title = stats.modelContextTokens
    ? `${formatNumber(sessionTokens)} estimated session tokens of ${formatNumber(stats.modelContextTokens)} available. Next prompt payload estimate: ${formatNumber(stats.estimatedTokens)} tokens.`
    : `${formatNumber(sessionTokens)} estimated session tokens. Selected model did not report a max context window.`;
  els.contextUsageDetail.textContent = stats.modelContextTokens
    ? `${formatNumber(sessionTokens)} / ${formatNumber(stats.modelContextTokens)} tokens · ${meter.percentLabel} · next prompt ${formatNumber(stats.estimatedTokens)} tok`
    : `${formatNumber(sessionTokens)} estimated session tokens · unknown max context`;
  els.contextMeterFill.style.width = stats.modelContextTokens ? `${Math.min(100, Math.max(0, meter.percent))}%` : '0%';

  const attachedParts = [stats.parts.selectedText, stats.parts.pageMetadata, stats.parts.youtubeTranscript, stats.parts.pageText]
    .filter((part) => part?.enabled);
  const attachedChars = attachedParts.reduce((total, part) => total + Number(part.chars || 0), 0);
  const attachedTokens = attachedParts.reduce((total, part) => total + Number(part.estimatedTokens || 0), 0);
  const adapter = currentContext.pageContext?.youtubeTranscript?.ok ? 'YouTube + DOM' : (currentContext.pageContext?.restricted ? 'Restricted' : 'DOM');
  els.contextChipLabel.textContent = `📎 ${adapter} · ${formatNumber(attachedChars)} chars · ~${formatNumber(attachedTokens)} tok`;
  els.contextChip.title = currentContext.activeTab?.url || '';
  els.contextPreview.textContent = [
    currentContext.activeTab?.title || '(unknown tab)',
    currentContext.activeTab?.url || '',
    '',
    clampText(currentContext.pageContext?.selectedText || currentContext.pageContext?.text || currentContext.pageContext?.reason || currentContext.pageContext?.error || 'No readable page text captured yet.', 900),
  ].filter(Boolean).join('\n');

  const rows = [
    ['User draft', stats.parts.userRequest],
    ['Active tab', stats.parts.activeTab],
    ['Open tabs', stats.parts.openTabs],
    ['Selection', stats.parts.selectedText],
    ['Metadata', stats.parts.pageMetadata],
    ['YouTube transcript', stats.parts.youtubeTranscript],
    ['Page text', stats.parts.pageText],
  ];
  els.contextBreakdown.innerHTML = rows.map(([label, part]) => `
    <dt>${label}</dt>
    <dd title="${part.enabled ? 'included' : 'disabled'}">${part.enabled ? `${formatNumber(part.estimatedTokens)} tok · ${formatNumber(part.chars)} chars` : 'disabled'}</dd>
  `).join('');
}

function applySelectedModel(selectedId, { persist = true, keepOpen = false } = {}) {
  const nextId = selectedId || DEFAULT_SETTINGS.model;
  const selected = availableModels.find((model) => model.id === nextId);
  if (selected) selectedModelProvider = modelProviderLabel(selected);
  settings = {
    ...settings,
    model: nextId,
    modelContextTokens: selected?.contextTokens || 0,
  };
  sessionRoutesAvailable = null;
  renderModelOptions(availableModels);
  if (keepOpen) {
    els.modelMenu.hidden = false;
    els.modelMenuButton.setAttribute('aria-expanded', 'true');
    els.modelSearchInput.focus();
  } else {
    els.modelMenu.hidden = true;
    els.modelMenuButton.setAttribute('aria-expanded', 'false');
  }
  if (persist) chrome.storage.local.set({ hermesBrowserSettings: settings });
}

async function loadModels({ quiet = false, payload = null } = {}) {
  try {
    let data = payload;
    if (!data) {
      const response = await apiFetch('/v1/models', { method: 'GET' });
      data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data?.error?.message || data?.error || `Model list failed (${response.status})`);
    }
    availableModels = normalizeHermesModels(data, settings.model);
    renderModelOptions(availableModels);
    applySelectedModel(settings.model, { persist: false });
    if (!quiet) setStatus('ok', 'Hermes models synced', `${availableModels.length} model${availableModels.length === 1 ? '' : 's'} available from local Hermes`);
  } catch (error) {
    availableModels = normalizeHermesModels([], settings.model);
    renderModelOptions(availableModels);
    renderContextWindow();
    if (!quiet) setStatus('warn', 'Model sync failed', error?.message || String(error));
  }
}

async function loadSkills({ quiet = false } = {}) {
  if (!settings.apiKey) {
    availableSkills = [];
    renderSkillSuggestions();
    return;
  }
  try {
    const response = await apiFetch('/v1/skills', { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Skills list failed (${response.status})`);
    availableSkills = normalizeHermesSkills(payload);
    renderSkillSuggestions();
    if (!quiet) setStatus('ok', 'Hermes skills synced', `${availableSkills.length} /skill commands available`);
  } catch (error) {
    availableSkills = [];
    renderSkillSuggestions();
    if (!quiet) setStatus('warn', 'Skill sync failed', error?.message || String(error));
  }
}

function replaceActiveSkillToken(command = '') {
  const value = els.input.value;
  const next = value.replace(/(^|\s)([/@][a-z0-9][a-z0-9_-]*)$/i, (_match, prefix) => `${prefix}${command} `);
  els.input.value = next === value ? `${value}${value && !value.endsWith(' ') ? ' ' : ''}${command} ` : next;
  els.skillMenu.hidden = true;
  renderContextWindow();
  els.input.focus();
}

function renderSkillSuggestions() {
  if (!els.skillMenu) return;
  const suggestions = skillSuggestionsForInput(els.input?.value || '', availableSkills);
  els.skillMenu.innerHTML = '';
  if (!suggestions.length) {
    els.skillMenu.hidden = true;
    return;
  }
  for (const skill of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-option';
    button.setAttribute('role', 'option');
    button.dataset.command = skill.command;
    const name = document.createElement('span');
    name.className = 'skill-option-name';
    name.textContent = skill.name;
    const command = document.createElement('span');
    command.className = 'skill-option-command';
    command.textContent = skill.command;
    button.append(name, command);
    button.addEventListener('click', () => replaceActiveSkillToken(skill.command));
    els.skillMenu.appendChild(button);
  }
  els.skillMenu.hidden = false;
}

function renderProfiles() {
  if (!els.profileSelect) return;
  const selected = settings.activeProfile || availableProfiles.find((profile) => profile.active)?.name || '';
  els.profileSelect.innerHTML = '<option value="">Detect from Hermes gateway</option>';
  for (const profile of availableProfiles) {
    const option = document.createElement('option');
    option.value = profile.name;
    option.textContent = `${profile.name}${profile.active ? ' · active' : ''}${profile.model ? ` · ${profile.model}` : ''}`;
    option.selected = profile.name === selected;
    els.profileSelect.appendChild(option);
  }
  els.profileSelect.value = selected;
  if (!settings.activeProfile && selected) settings = { ...settings, activeProfile: selected };
  if (availableProfiles.length) {
    const active = availableProfiles.find((profile) => profile.name === selected) || availableProfiles.find((profile) => profile.active);
    els.profileStatus.textContent = active
      ? `Using ${active.name}${active.model ? ` · ${active.model}` : ''}${active.skillCount ? ` · ${active.skillCount} skills` : ''}`
      : `${availableProfiles.length} profiles available`;
  } else {
    els.profileStatus.textContent = 'Profile API unavailable. Browser will use the currently running Hermes gateway profile.';
  }
}

async function loadProfiles({ quiet = false } = {}) {
  if (!settings.apiKey) {
    availableProfiles = [];
    renderProfiles();
    return;
  }
  try {
    const response = await apiFetch('/v1/profiles', { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Profiles list failed (${response.status})`);
    availableProfiles = normalizeHermesProfiles(payload, settings.activeProfile || payload.active);
    renderProfiles();
    if (!quiet) setStatus('ok', 'Hermes profiles synced', `${availableProfiles.length} profile${availableProfiles.length === 1 ? '' : 's'} available`);
  } catch (error) {
    availableProfiles = [];
    renderProfiles();
    if (!quiet) setStatus('warn', 'Profile sync unavailable', 'This Hermes gateway does not expose /v1/profiles yet. Using the currently running profile.');
  }
}

async function applySelectedProfile(profileName = '') {
  settings = { ...settings, activeProfile: profileName };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  renderProfiles();
  if (!profileName || !settings.apiKey) return;
  try {
    const response = await apiFetch('/v1/profiles/active', {
      method: 'POST',
      body: JSON.stringify({ name: profileName }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Profile switch failed (${response.status})`);
    setStatus('ok', 'Hermes profile switched', payload.restart_required ? `${profileName} selected. Restart Hermes gateway if the running profile does not change immediately.` : profileName);
    await loadProfiles({ quiet: true });
    await loadModels({ quiet: true });
    await loadSkills({ quiet: true });
  } catch (error) {
    setStatus('warn', 'Profile switch unavailable', `${error?.message || String(error)}. Browser will use the currently running Hermes profile.`);
  }
}

function renderEmptyState() {
  if (messages.length) return;
  const setupCopy = settings.apiKey
    ? 'Ask Hermes about what you are viewing. Active tab, selected text, page text, and open tabs are attached as untrusted context.'
    : 'Click Connect to Hermes, approve locally, then start chatting with page context. Manual API key setup is still available in settings.';
  els.messages.innerHTML = `<div class="empty-state"><strong>THE PAGE IS THE PROMPT</strong><span>${setupCopy}</span></div>`;
}

function sessionDisplayName(session = {}) {
  return String(session.title || session.id || settings.sessionTitle || 'Hermes Browser Extension');
}

function updateSessionLabel() {
  const current = availableSessions.find((session) => session.id === settings.sessionId);
  const label = current ? sessionDisplayName(current) : (settings.sessionTitle || settings.sessionId || 'Hermes Browser Extension');
  els.currentSessionName.textContent = label;
  els.currentSessionName.title = `${label} · ${settings.sessionId}`;
}

function renderSessionMenu(query = els.sessionSearchInput?.value || '') {
  const groups = groupSessionsForMenu(availableSessions, settings.sessionId, query);
  const searching = Boolean(String(query || '').trim());
  els.sessionMenuList.innerHTML = '';
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'session-group-title';
    empty.textContent = 'No sessions found';
    els.sessionMenuList.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const containsSelected = group.sessions.some((session) => session.selected);
    if ((containsSelected || groups.length === 1) && !openSessionGroups.has(group.label)) openSessionGroups.add(group.label);
    const isOpen = searching || openSessionGroups.has(group.label);

    const title = document.createElement('button');
    title.type = 'button';
    title.className = `session-group-title session-group-toggle ${isOpen ? 'open' : ''}`.trim();
    title.setAttribute('aria-expanded', String(isOpen));
    title.innerHTML = `<span>${isOpen ? '▾' : '▸'} ${group.label}</span><strong>${group.sessions.length}</strong>`;
    title.addEventListener('click', () => {
      if (openSessionGroups.has(group.label)) openSessionGroups.delete(group.label);
      else openSessionGroups.add(group.label);
      renderSessionMenu(els.sessionSearchInput.value);
    });
    els.sessionMenuList.appendChild(title);

    if (!isOpen) continue;

    for (const session of group.sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-option ${session.selected ? 'selected' : ''}`.trim();
      button.dataset.sessionId = session.id;

      const name = document.createElement('span');
      name.className = 'session-option-name';
      name.textContent = sessionDisplayName(session);

      const meta = document.createElement('span');
      meta.className = 'session-option-meta';
      meta.textContent = session.selected ? '✓' : (session.messageCount ? `${session.messageCount}` : '');

      button.append(name, meta);
      button.addEventListener('click', () => openHermesSession(session));
      els.sessionMenuList.appendChild(button);
    }
  }
}

async function loadAllHermesSessions() {
  const limit = 500;
  let offset = 0;
  const merged = [];
  for (let page = 0; page < 10; page += 1) {
    const response = await apiFetch(`/api/sessions?limit=${limit}&offset=${offset}&include_children=true&order=recent`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session list failed (${response.status})`);
    const rows = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload.results)
          ? payload.results
          : [];
    merged.push(...rows);
    const hasMore = Boolean(payload.has_more ?? payload.hasMore ?? payload.pagination?.hasMore);
    const total = Number(payload.total || payload.pagination?.total || 0);
    offset += rows.length;
    if (shouldStopSessionPaging({ rowCount: rows.length, offset, total, hasMore })) break;
  }
  return { data: merged };
}

async function loadSessions({ quiet = false } = {}) {
  if (!settings.apiKey) {
    availableSessions = [];
    updateSessionLabel();
    renderSessionMenu();
    return;
  }
  try {
    const payload = await loadAllHermesSessions();
    availableSessions = normalizeHermesSessions(payload);
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('ok', 'Hermes sessions synced', `${availableSessions.length} sessions available`);
  } catch (error) {
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('warn', 'Session sync failed', error?.message || String(error));
  }
}

function makeBrowserSessionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `hermes-browser-extension-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeBrowserSessionTitle(date = new Date()) {
  const stamp = date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  return `Hermes Browser Extension · ${stamp}`;
}

async function createHermesBrowserSession({ title = makeBrowserSessionTitle(), focus = true } = {}) {
  const sessionId = makeBrowserSessionId();
  const response = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: sessionId,
      title,
      source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource,
      model: settings.model,
      system_prompt: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Could not create session (${response.status})`);
  const session = normalizeHermesSessions({ data: [payload.session || payload] })[0] || { id: sessionId, title, source: settings.sessionSource };
  availableSessions = normalizeHermesSessions({ data: [session, ...availableSessions.filter((item) => item.id !== session.id)] });
  settings = { ...settings, sessionId: session.id, sessionTitle: session.title || title };
  sessionRoutesAvailable = true;
  messages = [];
  await chrome.storage.local.set({ hermesBrowserSettings: settings, hermesBrowserMessages: [] });
  renderMessagesFromStorage();
  updateSessionLabel();
  renderSessionMenu();
  if (focus) els.input.focus();
  return session;
}

async function openHermesSession(session) {
  settings = { ...settings, sessionId: session.id, sessionTitle: session.title || session.id };
  sessionRoutesAvailable = true;
  els.sessionMenu.hidden = true;
  els.sessionMenuButton.setAttribute('aria-expanded', 'false');
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  updateSessionLabel();
  renderSessionMenu();
  await loadSessionMessages(session.id);
  setStatus('ok', 'Session opened', `${session.sourceLabel || session.source || 'Hermes'} · ${session.id}`);
}

async function loadSessionMessages(sessionId = settings.sessionId) {
  if (!settings.apiKey) return;
  try {
    const response = await apiFetch(`/api/sessions/${encodeSessionId(sessionId)}/messages`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Messages failed (${response.status})`);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    messages = rows
      .filter((message) => ['user', 'assistant', 'system'].includes(message.role) && message.content)
      .map((message) => ({ role: message.role, content: String(message.content), ts: Number(message.timestamp || Date.now()) }))
      .slice(-settings.maxLocalMessages);
    await chrome.storage.local.set({ hermesBrowserMessages: messages });
    renderMessagesFromStorage();
  } catch (error) {
    addMessage('system', `Could not load session messages: ${error?.message || String(error)}`);
  }
}

function isHermesBrowserSession(session = {}) {
  return String(session.source || '').toLowerCase() === DEFAULT_SETTINGS.sessionSource;
}

async function ensureDefaultBrowserSession({ focus = false } = {}) {
  if (!settings.apiKey || settings.sessionId !== DEFAULT_SETTINGS.sessionId) return;
  const current = availableSessions.find((session) => session.id === settings.sessionId);
  if (isHermesBrowserSession(current)) return;
  if (current) {
    try {
      const response = await apiFetch(`/api/sessions/${encodeSessionId(current.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ source: DEFAULT_SETTINGS.sessionSource }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session migration failed (${response.status})`);
      const migrated = normalizeHermesSessions({ data: [payload.session || payload] })[0];
      if (migrated) {
        availableSessions = normalizeHermesSessions({ data: [migrated, ...availableSessions.filter((item) => item.id !== migrated.id)] });
        updateSessionLabel();
        renderSessionMenu();
        return;
      }
    } catch (error) {
      setStatus('warn', 'Could not migrate Browser session', error?.message || String(error));
    }
  }
  const existingBrowserSession = availableSessions.find(isHermesBrowserSession);
  if (existingBrowserSession) {
    await openHermesSession(existingBrowserSession);
    return;
  }
  await createHermesBrowserSession({ title: makeBrowserSessionTitle(), focus });
}

function renderMessageContentElement(element, content = '') {
  element.innerHTML = renderMarkdown(content || '');
}

function addMessage(role, content, { persist = true } = {}) {
  if (!messages.length) els.messages.innerHTML = '';
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.message-role').textContent = role === 'assistant' ? 'Hermes' : role;
  renderMessageContentElement(node.querySelector('.message-content'), content || '');
  els.messages.appendChild(node);
  requestAnimationFrame(() => {
    els.appScroll.scrollTop = els.appScroll.scrollHeight;
  });
  const record = { role, content: content || '', ts: Date.now() };
  if (persist) {
    messages.push(record);
    trimAndSaveMessages();
  }
  return { node, record };
}

function setMessageContent(node, content) {
  renderMessageContentElement(node.querySelector('.message-content'), content || '');
  requestAnimationFrame(() => {
    els.appScroll.scrollTop = els.appScroll.scrollHeight;
  });
}

async function trimAndSaveMessages() {
  const max = Number(settings.maxLocalMessages || DEFAULT_SETTINGS.maxLocalMessages);
  if (messages.length > max) messages = messages.slice(-max);
  await chrome.storage.local.set({ hermesBrowserMessages: messages });
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['hermesBrowserSettings', 'hermesBrowserMessages']);
  settings = { ...DEFAULT_SETTINGS, ...(stored.hermesBrowserSettings || {}) };
  settings = {
    ...settings,
    thinkingEnabled: settings.thinkingEnabled !== false,
    fastMode: Boolean(settings.fastMode),
    reasoningEffort: normalizeReasoningEffort(settings.reasoningEffort),
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizeAppearanceTheme(settings.appearanceTheme),
  };
  applyAppearanceSettings();
  messages = Array.isArray(stored.hermesBrowserMessages) ? stored.hermesBrowserMessages : [];
  syncSettingsForm();
  renderMessagesFromStorage();
}

function renderMessagesFromStorage() {
  els.messages.innerHTML = '';
  const old = messages;
  messages = [];
  for (const message of old) addMessage(message.role, message.content, { persist: false });
  messages = old;
  renderEmptyState();
}

function syncSettingsForm() {
  renderAppearanceControls();
  renderProfiles();
  renderModelOptions(availableModels);
  els.gatewayUrlInput.value = settings.gatewayUrl;
  els.apiKeyInput.value = settings.apiKey || '';
  els.sessionIdInput.value = settings.sessionId;
  els.sessionTitleInput.value = settings.sessionTitle;
  els.contextDepthInput.value = settings.contextDepth;
  els.includeTabsInput.checked = Boolean(settings.includeTabs);
  els.includePageTextInput.checked = Boolean(settings.includePageText);
  els.includeSelectedTextInput.checked = Boolean(settings.includeSelectedText);
  els.transcriptProviderInput.value = settings.transcriptProvider || DEFAULT_SETTINGS.transcriptProvider;
}

async function saveSettingsFromForm() {
  const selected = availableModels.find((model) => model.id === settings.model);
  settings = {
    ...settings,
    gatewayUrl: normalizeGatewayUrl(els.gatewayUrlInput.value),
    apiKey: els.apiKeyInput.value.trim(),
    model: settings.model || DEFAULT_SETTINGS.model,
    modelContextTokens: selected?.contextTokens || settings.modelContextTokens || 0,
    sessionId: els.sessionIdInput.value.trim() || DEFAULT_SETTINGS.sessionId,
    sessionTitle: els.sessionTitleInput.value.trim() || DEFAULT_SETTINGS.sessionTitle,
    activeProfile: els.profileSelect?.value || settings.activeProfile || DEFAULT_SETTINGS.activeProfile,
    contextDepth: els.contextDepthInput.value,
    includeTabs: els.includeTabsInput.checked,
    includePageText: els.includePageTextInput.checked,
    includeSelectedText: els.includeSelectedTextInput.checked,
    transcriptProvider: els.transcriptProviderInput.value.trim() || DEFAULT_SETTINGS.transcriptProvider,
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizeAppearanceTheme(settings.appearanceTheme),
  };
  applyAppearanceSettings();
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  syncSettingsForm();
  updateConnectionPrompt();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? safeTab(tab) : null;
}

async function currentWindowTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(safeTab);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_error) {
    // Static content scripts or restricted pages may make this unnecessary/impossible.
  }
}

function collectPageContextFallback(options = {}) {
  const TEXT_LIMITS = { minimal: 4_000, normal: 12_000, full: 30_000 };
  function normalizeReadableWhitespace(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function textOf(node) {
    return normalizeReadableWhitespace(node?.innerText || node?.textContent || '');
  }
  function textContentWithoutJunk(root) {
    if (!root) return '';
    const clone = root.cloneNode?.(true);
    if (!clone) return normalizeReadableWhitespace(root.textContent || '');
    clone.querySelectorAll?.('script, style, noscript, svg, canvas, template, iframe').forEach((node) => node.remove());
    return normalizeReadableWhitespace(clone.textContent || '');
  }
  function uniqueReadableLines(values = []) {
    const seen = new Set();
    const lines = [];
    for (const value of values) {
      for (const rawLine of normalizeReadableWhitespace(value).split('\n')) {
        const line = rawLine.trim();
        if (line.length < 2) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(line);
      }
    }
    return lines.join('\n');
  }
  function collectReadablePageText(doc = document, { minSemanticChars = 80 } = {}) {
    const root = doc?.body || doc?.documentElement;
    if (!root) return '';
    const innerText = normalizeReadableWhitespace(root.innerText || doc?.documentElement?.innerText || '');
    const semanticText = uniqueReadableLines(Array.from(doc.querySelectorAll?.('main, article, [role="main"], h1, h2, h3, h4, p, li, blockquote, figcaption, td, th, a[href], button, summary, [aria-label]') || []).map(textOf));
    const fallbackText = textContentWithoutJunk(root);
    if (semanticText.length >= Math.max(minSemanticChars, innerText.length * 1.2)) return semanticText;
    if (innerText) return innerText;
    if (semanticText) return semanticText;
    return fallbackText;
  }
  function clamp(value, limit) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
  }
  function redact(value) {
    return String(value || '')
      .replace(/\bBearer\s+[^\s'"`;&]+/gi, 'Bearer [REDACTED_BEARER]')
      .replace(new RegExp('\\bsk-[A-Za-z0-9_\\-]{12,}\\b', 'g'), '[REDACTED_SECRET]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
      .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*([^\s'"`;&]+)/gi, (_match, key) => `${key}=[REDACTED_SECRET]`);
  }
  function pageMeta() {
    const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '';
    const language = document.documentElement?.lang || document.querySelector('meta[http-equiv="content-language"]')?.content || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 25)
      .map((node) => ({ level: node.tagName.toLowerCase(), text: textOf(node).slice(0, 240) }))
      .filter((item) => item.text);
    const interactive = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]')).slice(0, 80)
      .map((node) => {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        const kind = role || tag;
        const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('name') || node.getAttribute('placeholder') || '';
        const href = tag === 'a' ? node.href : '';
        const text = textOf(node) || label || href;
        return { kind, text: text.slice(0, 220), href };
      })
      .filter((item) => item.text || item.href)
      .slice(0, 40);
    return { description, language, canonical, headings, interactive, forms: [] };
  }
  const depth = options.depth || 'normal';
  const limit = TEXT_LIMITS[depth] || TEXT_LIMITS.normal;
  const selection = globalThis.getSelection?.().toString() || '';
  const text = collectReadablePageText(document);
  return {
    ok: true,
    source: 'scripting-fallback',
    title: document.title || '',
    url: location.href,
    selectedText: clamp(redact(selection), Math.min(limit, 8_000)),
    text: clamp(redact(text), limit),
    meta: pageMeta(),
    capturedAt: new Date().toISOString(),
  };
}

async function getPageContextViaScripting(tabId, options, originalError) {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectPageContextFallback,
      args: [options],
    });
    if (injected?.result) {
      return {
        ...injected.result,
        warning: originalError?.message || String(originalError || ''),
      };
    }
  } catch (fallbackError) {
    return {
      ok: false,
      error: originalError?.message || String(originalError || fallbackError),
      reason: fallbackError?.message || String(fallbackError),
      text: '',
      selectedText: '',
      meta: {},
    };
  }
  return {
    ok: false,
    error: originalError?.message || String(originalError || 'No context result returned'),
    text: '',
    selectedText: '',
    meta: {},
  };
}

async function getPageContext(tab) {
  if (!tab?.id || isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      restricted: true,
      reason: 'Hermes Browser Extension does not read browser internals, extension pages, or sensitive account/payment/password pages in v0.1.',
      text: '',
      selectedText: '',
      meta: {},
    };
  }

  const options = { depth: settings.contextDepth };
  try {
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'HERMES_GET_PAGE_CONTEXT', options });
    // A response that claims ok but carries no actual page text is the signature
    // of a stale/orphaned content script that returned a bare ack. Run the
    // scripting fallback so the user still gets real page text instead of 0.
    if (response?.ok && (response.text || response.selectedText || response.meta?.headings?.length)) return response;
    if (response?.ok) {
      const fallback = await getPageContextViaScripting(tab.id, options, new Error('Stale content script: empty page context'));
      if (fallback?.ok) return fallback;
    }
    return response || { ok: false, error: 'No page context response', text: '', selectedText: '', meta: {} };
  } catch (error) {
    const fallback = await getPageContextViaScripting(tab.id, options, error);
    if (fallback?.ok) return fallback;
    return {
      ok: false,
      error: fallback?.error || error?.message || String(error),
      reason: fallback?.reason || error?.message || String(error),
      text: '',
      selectedText: '',
      meta: {},
    };
  }
}

async function getYoutubeTranscriptForTab(tab) {
  const videoId = extractYouTubeVideoId(tab?.url || '');
  const provider = settings.transcriptProvider || DEFAULT_SETTINGS.transcriptProvider;
  if (!videoId || String(provider).trim().toLowerCase() === 'off') return null;
  try {
    await ensureContentScript(tab.id);
    return await chrome.runtime.sendMessage({
      type: 'HERMES_GET_YOUTUBE_TRANSCRIPT',
      videoId,
      tabId: tab.id,
      provider,
    });
  } catch (error) {
    return { ok: false, videoId, reason: error?.message || String(error), source: 'sidepanel' };
  }
}

async function refreshContext() {
  const [tab, tabs] = await Promise.all([activeTab(), currentWindowTabs()]);
  const pageContext = tab ? await getPageContext(tab) : null;
  const youtubeTranscript = tab ? await getYoutubeTranscriptForTab(tab) : null;
  if (pageContext && youtubeTranscript) pageContext.youtubeTranscript = youtubeTranscript;
  currentContext = { activeTab: tab, tabs, pageContext };

  if (!tab) {
    setStatus('warn', 'No active tab detected', 'Open a normal browser tab and try again.');
  } else if (pageContext?.restricted) {
    setStatus('warn', tab.title || 'Restricted page', `${tab.url} - context restricted`);
  } else if (pageContext?.ok) {
    setStatus('ok', tab.title || 'Active tab ready', tab.url || '');
  } else {
    setStatus('warn', tab.title || 'Page context partial', pageContext?.error || tab.url || '');
  }
  renderContextWindow();
  return currentContext;
}

function authHeaders({ json = false } = {}) {
  const headers = json ? { 'Content-Type': 'application/json' } : {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (settings.activeProfile) headers['X-Hermes-Profile'] = settings.activeProfile;
  return headers;
}

async function apiFetch(path, options = {}) {
  const base = normalizeGatewayUrl(settings.gatewayUrl);
  const hasBody = typeof options.body !== 'undefined';
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...authHeaders({ json: hasBody }),
      ...(options.headers || {}),
    },
  });
}

async function ensureHermesSession() {
  if (sessionRoutesAvailable === false) return false;
  const sessionPath = `/api/sessions/${encodeSessionId(settings.sessionId)}`;
  const getResponse = await apiFetch(sessionPath, { method: 'GET' });
  if (getResponse.ok) {
    sessionRoutesAvailable = true;
    return true;
  }
  if (getResponse.status !== 404) {
    const text = await getResponse.text();
    throw new Error(`Could not inspect Hermes session (${getResponse.status}): ${text.slice(0, 500)}`);
  }

  const createResponse = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: settings.sessionId,
      title: settings.sessionTitle,
      source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource,
      model: settings.model,
      system_prompt: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });
  if (createResponse.status === 404 || createResponse.status === 405) {
    sessionRoutesAvailable = false;
    return false;
  }
  if (!createResponse.ok && createResponse.status !== 409) {
    const text = await createResponse.text();
    throw new Error(`Could not create Hermes Browser Extension session (${createResponse.status}): ${text.slice(0, 500)}`);
  }
  sessionRoutesAvailable = true;
  return true;
}

function parseSseBlock(block) {
  const event = { type: 'message', data: '' };
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.type = line.slice(6).trim();
    if (line.startsWith('data:')) event.data += `${line.slice(5).trim()}\n`;
  }
  event.data = event.data.trim();
  if (!event.data) return event;
  try {
    event.json = JSON.parse(event.data);
  } catch {
    event.json = null;
  }
  return event;
}

function sseBlocksFromBuffer(buffer, { flush = false } = {}) {
  const blocks = [];
  let match;
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  while ((match = boundary.exec(buffer)) !== null) {
    blocks.push(buffer.slice(start, match.index));
    start = boundary.lastIndex;
  }
  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    blocks.push(rest);
    return { blocks, rest: '' };
  }
  return { blocks, rest };
}

function textFromRunCompleted(data = {}) {
  const messagesList = Array.isArray(data.messages) ? data.messages : [];
  for (let index = messagesList.length - 1; index >= 0; index -= 1) {
    const message = messagesList[index];
    if (message?.role === 'assistant' && message.content) return String(message.content);
  }
  return data.content ? String(data.content) : '';
}

function appendOpenAiChunkText(event, finalText) {
  if (event.data === '[DONE]') return finalText;
  const data = event.json || {};
  const delta = data.choices?.[0]?.delta?.content || data.choices?.[0]?.message?.content || '';
  return delta ? `${finalText}${delta}` : finalText;
}

async function readSseResponse(response, onDelta, onTool, { signal, onRun } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';

  async function processBlock(block) {
    const event = parseSseBlock(block);
    const data = event.json || {};
    if (event.type === 'run.started' && data.run_id) {
      onRun?.(data.run_id);
    } else if (event.type === 'assistant.delta' && data.delta) {
      finalText += data.delta;
      onDelta(finalText);
    } else if (event.type === 'assistant.completed' && data.content) {
      finalText = finalText || data.content;
      onDelta(finalText);
    } else if (event.type === 'run.completed') {
      const completedText = textFromRunCompleted(data);
      if (completedText) {
        finalText = completedText;
        onDelta(finalText);
      }
    } else if (event.type === 'chat.completion.chunk' || event.type === 'message') {
      const nextText = appendOpenAiChunkText(event, finalText);
      if (nextText !== finalText) {
        finalText = nextText;
        onDelta(finalText);
      }
    } else if (event.type?.startsWith('tool.') && onTool) {
      onTool(data);
    } else if (event.type === 'hermes.tool.progress' && onTool) {
      onTool(data);
    } else if (event.type === 'error') {
      throw new Error(data.message || event.data || 'Hermes stream error');
    }
  }

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException('Hermes turn stopped by user', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = sseBlocksFromBuffer(buffer);
    buffer = parsed.rest;
    for (const block of parsed.blocks) await processBlock(block);
  }

  buffer += decoder.decode();
  const parsed = sseBlocksFromBuffer(buffer, { flush: true });
  for (const block of parsed.blocks) await processBlock(block);
  return finalText;
}

function currentModelOptionsPayload() {
  return buildHermesModelOptions(settings);
}

async function streamSessionChat(prompt, onDelta, onTool, { signal, attachments: turnAttachments = attachments, onRun } = {}) {
  const hasSessionRoutes = await ensureHermesSession();
  if (!hasSessionRoutes) return streamChatCompletions(prompt, onDelta, onTool, { signal, attachments: turnAttachments, onRun });

  const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/chat/stream`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: settings.model,
      model_options: currentModelOptionsPayload(),
      message: outboundContent(prompt, turnAttachments),
      system_message: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Hermes stream failed (${response.status}): ${text.slice(0, 900)}`);
  }
  return readSseResponse(response, onDelta, onTool, { signal, onRun });
}

async function streamChatCompletions(prompt, onDelta, onTool, { signal, attachments: turnAttachments = attachments, onRun } = {}) {
  const response = await apiFetch('/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'X-Hermes-Session-Id': settings.sessionId,
      'X-Hermes-Session-Key': settings.sessionId,
    },
    body: JSON.stringify({
      model: settings.model,
      model_options: currentModelOptionsPayload(),
      stream: true,
      messages: [
        { role: 'system', content: HERMES_BROWSER_SYSTEM_PROMPT },
        { role: 'user', content: outboundContent(prompt, turnAttachments) },
      ],
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Hermes chat-completions stream failed (${response.status}): ${text.slice(0, 900)}`);
  }
  return readSseResponse(response, onDelta, onTool, { signal, onRun });
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function publicApiFetch(path, options = {}) {
  const base = normalizeGatewayUrl(settings.gatewayUrl);
  const hasBody = typeof options.body !== 'undefined';
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openApprovalUrl(url) {
  if (!url) return;
  try {
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function pollPairing(pairingId, { attempts = 90, delay = 1500 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const response = await publicApiFetch(`/api/browser-extension/pair/status/${encodeURIComponent(pairingId)}`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (payload.status === 'approved' && payload.token) return payload.token;
    if (payload.status === 'expired' || response.status === 410) throw new Error('Pairing expired. Click Connect again.');
    if (response.status === 404) throw new Error('Pairing request was not found. Click Connect again.');
    els.connectStatus.textContent = 'Waiting for Hermes Desktop approval...';
    await sleep(delay);
  }
  throw new Error('Timed out waiting for Hermes Desktop approval.');
}

async function connectToHermes() {
  settings.gatewayUrl = normalizeGatewayUrl(settings.gatewayUrl || els.gatewayUrlInput.value || DEFAULT_SETTINGS.gatewayUrl);
  els.connectButton.disabled = true;
  els.connectButton.textContent = 'Connecting...';
  els.connectStatus.textContent = 'Looking for Hermes Desktop on localhost...';
  try {
    const health = await publicApiFetch('/health', { method: 'GET' });
    if (!health.ok) throw new Error(`Hermes Desktop API is not reachable (${health.status}).`);

    const start = await publicApiFetch('/api/browser-extension/pair/start', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Hermes Browser Extension',
        extensionId: chrome.runtime?.id || '',
      }),
    });
    const payload = await readJsonResponse(start);
    if (!start.ok) throw new Error(payload?.error?.message || payload?.error || `Pairing failed (${start.status})`);

    if (payload.token) {
      settings.apiKey = payload.token;
    } else {
      els.connectStatus.textContent = 'Approval opened. Approve Hermes Browser Extension, then return here.';
      await openApprovalUrl(payload.approval_url);
      settings.apiKey = await pollPairing(payload.pairing_id);
    }

    await chrome.storage.local.set({ hermesBrowserSettings: settings });
    syncSettingsForm();
    updateConnectionPrompt();
    await loadModels({ quiet: true });
    await loadSkills({ quiet: true });
    await loadProfiles({ quiet: true });
    await loadSessions({ quiet: true });
    await ensureDefaultBrowserSession({ focus: false });
    els.connectStatus.textContent = 'Connected to Hermes. You can start chatting with page context.';
    setStatus('ok', 'Hermes Browser Extension connected', normalizeGatewayUrl(settings.gatewayUrl));
  } catch (error) {
    els.connectStatus.textContent = `${error?.message || String(error)} Manual setup is still available in settings.`;
    openSettingsDialog();
  } finally {
    els.connectButton.disabled = false;
    els.connectButton.textContent = 'Connect to Hermes';
  }
}

async function fallbackSessionChat(prompt, turnAttachments = attachments) {
  const hasSessionRoutes = await ensureHermesSession();
  if (!hasSessionRoutes) return fallbackChatCompletions(prompt, turnAttachments);

  const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: settings.model,
      model_options: currentModelOptionsPayload(),
      message: outboundContent(prompt, turnAttachments),
      system_message: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Hermes request failed (${response.status})`);
  return extractAssistantText(payload);
}

async function fallbackChatCompletions(prompt, turnAttachments = attachments) {
  const response = await apiFetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'X-Hermes-Session-Id': settings.sessionId,
      'X-Hermes-Session-Key': settings.sessionId,
    },
    body: JSON.stringify({
      model: settings.model,
      model_options: currentModelOptionsPayload(),
      stream: false,
      messages: [
        { role: 'system', content: HERMES_BROWSER_SYSTEM_PROMPT },
        { role: 'user', content: outboundContent(prompt, turnAttachments) },
      ],
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Hermes request failed (${response.status})`);
  return extractAssistantText(payload);
}

async function askHermes(userText, turnAttachments = [...attachments]) {
  if (!settings.apiKey) {
    updateConnectionPrompt();
    addMessage('system', 'Connection setup needed: click Connect to Hermes, approve in the local Hermes approval page, then send again. Your draft is still in the composer.');
    els.connectButton.focus();
    return false;
  }

  sending = true;
  activeAbortController = new AbortController();
  activeRunId = '';
  updateComposerBusyState();
  els.input.value = '';
  attachments = [];
  renderAttachments();
  renderSkillSuggestions();
  renderContextWindow('');

  let didSend = false;
  let shouldFlushQueue = false;
  try {
    const preparedAttachments = await saveImageAttachmentsForTurn(turnAttachments);
    const context = await refreshContext();
    const promptUserText = userTextWithAttachments(userText, preparedAttachments);
    const displayUserText = preparedAttachments.length
      ? `${userText || 'Attachment-only turn.'}\n${preparedAttachments.map((attachment) => `${attachmentIcon(attachment.kind)} ${attachment.label}`).join('\n')}`
      : userText;
    const prompt = buildHermesPrompt({
      userText: promptUserText,
      activeTab: context.activeTab,
      tabs: context.tabs,
      pageContext: context.pageContext,
      settings,
    });

    addMessage('user', displayUserText);
    const { node } = addMessage('assistant', 'Thinking...', { persist: false });
    let answer = '';
    let liveText = '';
    try {
      answer = await streamSessionChat(
        prompt,
        (partial) => {
          liveText = partial || '';
          setMessageContent(node, liveText || 'Thinking...');
        },
        (tool) => setMessageContent(node, `${liveText || 'Working...'}\n\n[tool] ${tool.tool_name || tool.tool || 'Hermes tool'} ${tool.preview || ''}`.trim()),
        {
          signal: activeAbortController.signal,
          attachments: preparedAttachments,
          onRun: (runId) => {
            activeRunId = runId;
          },
        },
      );
    } catch (streamError) {
      if (isAbortError(streamError)) {
        answer = liveText ? `${liveText}\n\n[stopped by user]` : '[stopped by user]';
      } else {
        setMessageContent(node, `Streaming failed, retrying non-streaming...\n${streamError.message}`);
        answer = await fallbackSessionChat(prompt, preparedAttachments);
      }
    }
    const finalAnswer = answer || liveText || '(empty response)';
    setMessageContent(node, finalAnswer);
    messages.push({ role: 'assistant', content: finalAnswer, ts: Date.now() });
    await trimAndSaveMessages();
    await loadSessions({ quiet: true });
    didSend = true;
  } catch (error) {
    addMessage('system', `Hermes Browser Extension error: ${error?.message || String(error)}`);
  } finally {
    activeAbortController = null;
    activeRunId = '';
    sending = false;
    updateComposerBusyState();
    renderContextWindow();
    els.input.focus();
    shouldFlushQueue = Boolean(queuedTurn);
  }
  if (shouldFlushQueue) {
    const next = queuedTurn;
    queuedTurn = null;
    renderQueueNotice();
    await askHermes(next.text, next.attachments || []);
  }
  return didSend;
}

async function testConnection() {
  await saveSettingsFromForm();
  els.testConnectionButton.disabled = true;
  els.testConnectionButton.textContent = 'Testing...';
  try {
    const response = await apiFetch('/health', { method: 'GET' });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text}`);

    const modelsResponse = await apiFetch('/v1/models', { method: 'GET' });
    const modelsPayload = await readJsonResponse(modelsResponse);
    if (!modelsResponse.ok) throw new Error(`Health OK, auth/model probe failed (${modelsResponse.status}): ${JSON.stringify(modelsPayload).slice(0, 500)}`);
    await loadModels({ quiet: true, payload: modelsPayload });
    await loadSkills({ quiet: true });
    await loadProfiles({ quiet: true });

    const hasSessionRoutes = await ensureHermesSession();
    setStatus(
      'ok',
      hasSessionRoutes ? 'Hermes gateway + session API connected' : 'Hermes gateway connected',
      hasSessionRoutes ? normalizeGatewayUrl(settings.gatewayUrl) : `${normalizeGatewayUrl(settings.gatewayUrl)} - OpenAI-compatible fallback mode`,
    );
  } catch (error) {
    setStatus('error', 'Hermes gateway test failed', error?.message || String(error));
  } finally {
    els.testConnectionButton.disabled = false;
    els.testConnectionButton.textContent = 'Test connection';
  }
}

function closeFloatingPanels() {
  els.modelMenu.hidden = true;
  els.modelMenuButton.setAttribute('aria-expanded', 'false');
  els.sessionMenu.hidden = true;
  els.sessionMenuButton.setAttribute('aria-expanded', 'false');
  els.attachMenu.hidden = true;
  els.attachMenuButton.setAttribute('aria-expanded', 'false');
  if (els.skillMenu) els.skillMenu.hidden = true;
  els.contextPopover.hidden = true;
  els.contextBarButton.setAttribute('aria-expanded', 'false');
}

function eventPathContains(event, node) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path.includes(node) || node.contains(event.target);
}

function bindEvents() {
  els.settingsButton.addEventListener('click', openSettingsDialog);
  els.manualSettingsButton.addEventListener('click', openSettingsDialog);
  [els.modelMenu, els.sessionMenu, els.contextPopover, els.attachMenu, els.skillMenu].filter(Boolean).forEach((panel) => {
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
  });
  els.connectButton.addEventListener('click', connectToHermes);
  els.sessionMenuButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    const nextHidden = !els.sessionMenu.hidden;
    closeFloatingPanels();
    els.sessionMenu.hidden = nextHidden;
    els.sessionMenuButton.setAttribute('aria-expanded', String(!nextHidden));
    if (!nextHidden) {
      await loadSessions({ quiet: true });
      els.sessionSearchInput.focus();
      els.sessionSearchInput.select();
    }
  });
  els.newSessionButton.addEventListener('click', async () => {
    if (!settings.apiKey) {
      updateConnectionPrompt();
      els.connectButton.focus();
      return;
    }
    try {
      await createHermesBrowserSession();
      await loadSessions({ quiet: true });
      setStatus('ok', 'New Hermes Browser Extension session', settings.sessionId);
    } catch (error) {
      setStatus('error', 'Could not create session', error?.message || String(error));
    }
  });
  els.createSessionButton.addEventListener('click', async () => {
    try {
      await createHermesBrowserSession();
      els.sessionMenu.hidden = true;
      els.sessionMenuButton.setAttribute('aria-expanded', 'false');
      await loadSessions({ quiet: true });
    } catch (error) {
      setStatus('error', 'Could not create session', error?.message || String(error));
    }
  });
  els.refreshSessionsButton.addEventListener('click', () => loadSessions());
  els.sessionSearchInput.addEventListener('input', () => renderSessionMenu(els.sessionSearchInput.value));
  els.closeSettingsButton.addEventListener('click', closeSettingsDialog);
  els.settingsDialog.addEventListener('click', (event) => {
    if (event.target === els.settingsDialog) closeSettingsDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.settingsDialog.hidden) closeSettingsDialog();
      closeFloatingPanels();
    }
  });
  document.addEventListener('click', (event) => {
    if (!els.modelMenu.hidden && !eventPathContains(event, els.modelMenu) && !eventPathContains(event, els.modelMenuButton)) {
      els.modelMenu.hidden = true;
      els.modelMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (!els.sessionMenu.hidden && !eventPathContains(event, els.sessionMenu) && !eventPathContains(event, els.sessionMenuButton)) {
      els.sessionMenu.hidden = true;
      els.sessionMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (!els.attachMenu.hidden && !eventPathContains(event, els.attachMenu) && !eventPathContains(event, els.attachMenuButton)) {
      els.attachMenu.hidden = true;
      els.attachMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (els.skillMenu && !els.skillMenu.hidden && !eventPathContains(event, els.skillMenu) && event.target !== els.input) {
      els.skillMenu.hidden = true;
    }
    if (!els.contextPopover.hidden && !eventPathContains(event, els.contextPopover) && !eventPathContains(event, els.contextBarButton)) {
      els.contextPopover.hidden = true;
      els.contextBarButton.setAttribute('aria-expanded', 'false');
    }
  });
  els.refreshButton.addEventListener('click', refreshContext);
  els.stopButton?.addEventListener('click', stopCurrentTurn);
  els.refreshModelsButton.addEventListener('click', () => loadModels());
  els.refreshProfilesButton?.addEventListener('click', () => loadProfiles());
  els.profileSelect?.addEventListener('change', () => applySelectedProfile(els.profileSelect.value));
  els.editModelsButton.addEventListener('click', () => {
    closeFloatingPanels();
    openSettingsDialog();
    setStatus('warn', 'Edit models in Hermes Desktop', 'Use Hermes Desktop model settings or the Hermes model command, then Refresh Models here.');
  });
  els.modelMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.modelMenu.hidden;
    closeFloatingPanels();
    els.modelMenu.hidden = nextHidden;
    els.modelMenuButton.setAttribute('aria-expanded', String(!nextHidden));
    if (!nextHidden) {
      els.modelSearchInput.focus();
      els.modelSearchInput.select();
    }
  });
  els.modelOptionsList.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (key === 'thinking') setModelRuntimeOption('thinkingEnabled', settings.thinkingEnabled === false);
      if (key === 'fast') setModelRuntimeOption('fastMode', !settings.fastMode);
      return;
    }
    const effort = event.target.closest('[data-effort]');
    if (effort) {
      setModelRuntimeOption('reasoningEffort', normalizeReasoningEffort(effort.dataset.effort));
    }
  });
  els.modelSearchInput.addEventListener('input', () => renderModelMenu(els.modelSearchInput.value));
  els.attachMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.attachMenu.hidden;
    closeFloatingPanels();
    els.attachMenu.hidden = nextHidden;
    els.attachMenuButton.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.attachMenu.addEventListener('click', async (event) => {
    const attachButton = event.target.closest('[data-attach]');
    const snippetButton = event.target.closest('[data-snippet]');
    if (snippetButton) {
      const text = snippetButton.dataset.snippet || '';
      els.input.value = els.input.value ? `${els.input.value}\n${text}` : text;
      renderContextWindow();
      els.input.focus();
      return;
    }
    if (!attachButton) return;
    const kind = attachButton.dataset.attach;
    try {
      if (kind === 'files') els.fileInput.click();
      if (kind === 'folder') els.folderInput.click();
      if (kind === 'images') els.imageInput.click();
      if (kind === 'paste-image') await pasteClipboardImage();
      if (kind === 'url') attachUrl();
    } catch (error) {
      addMessage('system', `Attach failed: ${error?.message || String(error)}`);
    }
  });
  els.fileInput.addEventListener('change', async () => {
    await attachFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  els.imageInput.addEventListener('change', async () => {
    await attachFiles(els.imageInput.files, { imagesOnly: true });
    els.imageInput.value = '';
  });
  els.folderInput.addEventListener('change', async () => {
    await attachFolder(els.folderInput.files);
    els.folderInput.value = '';
  });
  els.contextChip.addEventListener('click', () => {
    const nextHidden = !els.contextPreview.hidden;
    els.contextPreview.hidden = nextHidden;
    els.contextChip.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.contextBarButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.contextPopover.hidden;
    closeFloatingPanels();
    els.contextPopover.hidden = nextHidden;
    els.contextBarButton.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.testConnectionButton.addEventListener('click', testConnection);
  for (const button of els.colorModeButtons || []) {
    button.addEventListener('click', () => setAppearanceOption('colorMode', button.dataset.colorMode));
  }
  els.themeGrid?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-theme]');
    if (!card) return;
    setAppearanceOption('appearanceTheme', card.dataset.theme);
  });
  systemColorQuery?.addEventListener?.('change', () => {
    if (normalizeColorMode(settings.colorMode) === 'system') renderAppearanceControls();
  });
  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveSettingsFromForm();
    if (settings.apiKey) {
      await loadModels({ quiet: true });
      await loadSkills({ quiet: true });
      await loadProfiles({ quiet: true });
      await loadSessions({ quiet: true });
      await ensureDefaultBrowserSession({ focus: false });
    }
    closeSettingsDialog();
    await refreshContext();
  });
  els.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) {
      queueCurrentDraft();
      return;
    }
    const userText = els.input.value.trim();
    if (!userText && !attachments.length) return;
    await askHermes(userText, [...attachments]);
  });
  els.input.addEventListener('keydown', (event) => {
    if (!els.skillMenu.hidden && (event.key === 'Tab' || event.key === 'ArrowRight')) {
      const first = els.skillMenu.querySelector('[data-command]');
      if (first?.dataset.command) {
        event.preventDefault();
        replaceActiveSkillToken(first.dataset.command);
        return;
      }
    }
    if (shouldSubmitComposerKey(event)) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.input.addEventListener('paste', (event) => {
    handlePasteImages(event).catch((error) => addMessage('system', `Paste failed: ${error?.message || String(error)}`));
  });
  document.addEventListener('paste', (event) => {
    const tag = String(event.target?.tagName || '').toUpperCase();
    const editable = event.target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    if (event.target === els.input || editable) return;
    handlePasteImages(event).catch((error) => addMessage('system', `Paste failed: ${error?.message || String(error)}`));
  });
  ['dragenter', 'dragover'].forEach((type) => {
    els.composerDropZone?.addEventListener(type, (event) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      if (type === 'dragenter') dragDepth += 1;
      setDropActive(true);
    });
  });
  els.composerDropZone?.addEventListener('dragleave', (event) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDropActive(false);
  });
  els.composerDropZone?.addEventListener('drop', (event) => {
    handleComposerDrop(event).catch((error) => addMessage('system', `Drop attach failed: ${error?.message || String(error)}`));
  });
  els.input.addEventListener('input', () => {
    renderContextWindow();
    renderSkillSuggestions();
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', async () => {
      els.input.value = button.dataset.prompt || '';
      els.composer.requestSubmit();
    });
  });
  chrome.tabs?.onActivated?.addListener?.(() => refreshContext());
  chrome.tabs?.onUpdated?.addListener?.((_tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) refreshContext();
  });
}

bindEvents();
try {
  await loadSettings();
  if (settings.apiKey) {
    await loadModels({ quiet: true });
    await loadSkills({ quiet: true });
    await loadProfiles({ quiet: true });
    await loadSessions({ quiet: true });
    await ensureDefaultBrowserSession({ focus: false });
  } else {
    renderModelOptions();
    renderSessionMenu();
    renderProfiles();
    renderSkillSuggestions();
    updateSessionLabel();
  }
} catch (error) {
  setStatus('error', 'Settings failed to load', error?.message || String(error));
  renderEmptyState();
}
try {
  await refreshContext();
} catch (error) {
  setStatus('warn', 'Context refresh unavailable', error?.message || String(error));
}
updateConnectionPrompt();
renderEmptyState();
