(() => {
  const previousCleanup = globalThis.__HERMES_INLINE_HELPER_CLEANUP__;
  if (typeof previousCleanup === 'function') previousCleanup();

  const policy = globalThis.HermesInlineDraft;
  const appearance = globalThis.HermesAppearance;
  const extractor = globalThis.HermesContentExtractor;
  const adapters = globalThis.HermesSiteAdapters;
  if (!policy?.classifyEditable || !policy?.buildInlineDraftRequest || !policy?.applyResult || !appearance?.resolveInlineAssistTheme) return;

  const REQUEST = 'HERMES_INLINE_DRAFT_REQUEST';
  const RESULT = 'HERMES_INLINE_DRAFT_RESULT';
  const SESSION_STATUS = 'HERMES_INLINE_SESSION_STATUS';
  const OPEN_SESSION = 'HERMES_INLINE_OPEN_SESSION';
  const CONTEXT_ACTION = 'HERMES_INLINE_CONTEXT_ACTION';
  const extensionRoot = String(chrome.runtime.getManifest()?.side_panel?.default_path || '').startsWith('extension/') ? 'extension/' : '';
  const logoUrl = chrome.runtime.getURL(`${extensionRoot}assets/img/hermes-browser-extension-icon-ink.png`);
  const documentId = `doc-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const genericActions = [
    { id: 'draft-for-context', label: 'Draft for this field', detail: 'Use page + field context', mode: 'draft-copy-only' },
    { id: 'improve', label: 'Improve writing', detail: 'Clarity, tone, and flow', mode: 'draft-copy-only' },
    { id: 'shorten', label: 'Shorten', detail: 'Keep the meaning', mode: 'draft-copy-only' },
    { id: 'fix-grammar', label: 'Fix grammar', detail: 'Minimal edits only', mode: 'draft-copy-only' },
    { id: 'draft-reply', label: 'Draft reply', detail: 'Use approved thread context', mode: 'draft-copy-only' },
    { id: 'change-tone', label: 'Change tone', detail: 'Direct, warm, or formal', mode: 'draft-copy-only' },
  ];
  const localActions = [
    { id: 'clean-formatting', label: 'Clean formatting', detail: 'Whitespace cleanup · no model', local: true },
    { id: 'bullet-list', label: 'Make bullets', detail: 'Deterministic list · no model', local: true },
  ];

  function make(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function button(className, text, label = text) {
    const element = make('button', className, text);
    element.type = 'button';
    element.setAttribute('aria-label', label);
    return element;
  }

  function logo(className) {
    const mark = make('span', className);
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'Hermes Browser Extension');
    mark.style.maskImage = `url("${logoUrl}")`;
    mark.style.webkitMaskImage = `url("${logoUrl}")`;
    return mark;
  }

  function colorChannels(value, fallback = '241,241,241') {
    const hex = String(value || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
    if (!hex) return fallback;
    const expanded = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join('') : hex;
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)).join(',');
  }

  const host = make('div');
  host.id = 'hermes-inline-draft-host';
  host.setAttribute('data-hermes-owned', 'true');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = make('style');
  style.textContent = `
    :host { all:initial; position:fixed; z-index:2147483646; inset:0; pointer-events:none; --hb-surface:#0d0d0d; --hb-paper:#171717; --hb-blue:#e5e5e5; --hb-fg:#f1f1f1; --hb-accent:#c9c9c9; --hb-logo:#0d0d0d; --hb-logo-bg:#f5f5f5; --hb-line:color-mix(in srgb,var(--hb-blue) 24%,transparent); --hb-muted:color-mix(in srgb,var(--hb-blue) 68%,transparent); --hb-soft:color-mix(in srgb,var(--hb-accent) 12%,var(--hb-paper)); --hermes-fg-rgb:241,241,241; --hermes-line-strong:rgba(229,229,229,0.78); font-family:"Segoe UI",Arial,sans-serif; color-scheme:dark; }
    *, *::before, *::after { box-sizing:border-box; }
    button, textarea { font:inherit; }
    .launcher { position:fixed; z-index:2; display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-logo-bg); color:var(--hb-logo); cursor:pointer; pointer-events:auto; overflow:hidden; transition:background 120ms ease,border-color 120ms ease; }
    .launcher:hover, .launcher:focus-visible { background:var(--hb-soft); border-color:var(--hb-blue); outline:2px solid var(--hb-blue); outline-offset:2px; }
    .launcher-logo, .brand-logo { display:block; background:var(--hb-logo); mask-position:center; mask-size:contain; mask-repeat:no-repeat; -webkit-mask-position:center; -webkit-mask-size:contain; -webkit-mask-repeat:no-repeat; }
    .launcher-logo { width:30px; height:30px; }
    .launcher[hidden], .panel[hidden] { display:none; }
    .panel { position:fixed; z-index:1; width:min(370px,calc(100vw - 20px)); max-height:min(650px,calc(100vh - 20px)); overflow:auto; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); pointer-events:auto; }
    .panel, .preview, .custom { scrollbar-gutter:stable; }
    .panel::-webkit-scrollbar, .preview::-webkit-scrollbar, .custom::-webkit-scrollbar { width:8px; }
    .panel::-webkit-scrollbar-thumb, .preview::-webkit-scrollbar-thumb, .custom::-webkit-scrollbar-thumb { background:rgba(var(--hermes-fg-rgb),0.45); border:1px solid var(--hermes-line-strong); }
    .head { display:grid; grid-template-columns:44px 1fr 34px; gap:11px; align-items:center; padding:12px; border-bottom:1px solid var(--hb-line); }
    .brand-mark { display:grid; place-items:center; width:44px; height:44px; padding:0; border:1px solid var(--hb-line); background:var(--hb-logo-bg); }
    .brand-logo { width:42px; height:42px; }
    .kicker, .section-label { display:block; color:var(--hb-muted); font-size:9px; letter-spacing:.14em; text-transform:uppercase; }
    .title { display:block; margin-top:3px; font-family:Georgia,"Times New Roman",serif; font-size:20px; line-height:1; color:var(--hb-blue); }
    .close { width:32px; height:32px; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font-size:20px; }
    .context { display:grid; grid-template-columns:1fr auto; gap:10px; padding:9px 12px; border-bottom:1px solid var(--hb-line); color:var(--hb-muted); font-size:10px; }
    .secure { color:var(--hb-blue); font-weight:800; }
    .body { display:flex; flex-direction:column; gap:11px; padding:12px; }
    .note, .status, .privacy, .run-copy { margin:0; color:var(--hb-muted); font-size:11px; line-height:1.45; }
    .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-top:1px solid var(--hb-line); border-left:1px solid var(--hb-line); }
    .action { min-height:58px; padding:9px; border:0; border-right:1px solid var(--hb-line); border-bottom:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; text-align:left; font-family:Georgia,"Times New Roman",serif; font-size:13px; font-weight:700; }
    .action.primary { background:var(--hb-blue); color:var(--hb-paper); }
    .action small { display:block; margin-top:3px; color:var(--hb-muted); font-family:"Segoe UI",Arial,sans-serif; font-size:9px; font-weight:400; line-height:1.3; }
    .action.primary small { color:color-mix(in srgb,var(--hb-paper) 74%,transparent); }
    .action:hover, .action:focus-visible, .route:hover, .route:focus-visible, .result-actions button:hover, .result-actions button:focus-visible { outline:2px solid var(--hb-blue); outline-offset:-2px; }
    .local-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
    .local-actions .action { border:1px solid var(--hb-line); min-height:50px; background:var(--hb-soft); }
    .custom { width:100%; min-height:62px; resize:vertical; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); padding:9px; font:11px/1.4 "Segoe UI",Arial,sans-serif; }
    .custom-row { display:grid; grid-template-columns:1fr auto; gap:7px; align-items:stretch; }
    .custom-go { min-width:76px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-blue); color:var(--hb-paper); cursor:pointer; font-size:11px; font-weight:700; }
    .route-title { margin:0; color:var(--hb-blue); font-family:Georgia,"Times New Roman",serif; font-size:20px; line-height:1.05; }
    .route { display:grid; grid-template-columns:42px 1fr 18px; gap:9px; align-items:center; width:100%; padding:11px; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; text-align:left; }
    .route.recommended { border:2px solid var(--hb-blue); background:var(--hb-soft); }
    .route:disabled { cursor:not-allowed; opacity:.45; }
    .route-num { font-family:Georgia,"Times New Roman",serif; font-size:20px; font-weight:700; }
    .route strong { font-family:Georgia,"Times New Roman",serif; font-size:13px; }
    .route small { display:block; margin-top:3px; color:var(--hb-muted); font-size:9px; line-height:1.35; }
    .route .tag { display:block; margin-top:4px; color:var(--hb-blue); font-size:8px; letter-spacing:.11em; text-transform:uppercase; }
    .arrow { font-size:18px; }
    .privacy { margin-top:2px; border:1px solid var(--hb-line); padding:9px; }
    .working { display:grid; place-items:center; min-height:170px; text-align:center; }
    .working-mark { width:34px; height:34px; border:3px solid var(--hb-line); border-top-color:var(--hb-blue); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .success { display:flex; align-items:center; gap:8px; color:var(--hb-blue); font-size:11px; font-weight:800; }
    .success i { width:9px; height:9px; background:var(--hb-blue); }
    .run-card, .preview { border:1px solid var(--hb-line); background:var(--hb-paper); padding:11px; }
    .run-row { display:flex; justify-content:space-between; gap:10px; color:var(--hb-muted); font-size:10px; }
    .run-title { margin:8px 0 3px; color:var(--hb-blue); font-family:Georgia,"Times New Roman",serif; font-size:17px; font-weight:700; }
    .preview { max-height:170px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--hb-blue); font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; user-select:text; }
    .result-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
    .result-actions button { min-height:39px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; font-family:Georgia,"Times New Roman",serif; font-size:12px; font-weight:700; }
    .result-actions .main { background:var(--hb-blue); color:var(--hb-paper); }
    .result-actions[data-action-count="3"] button:last-child { grid-column:1 / -1; }
    .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid var(--hb-line); padding:9px; color:var(--hb-blue); font-size:10px; }
    .setting small { color:var(--hb-muted); }
    .toggle { appearance:none; width:34px; height:18px; margin:0; border:1px solid var(--hb-blue); background:var(--hb-paper); position:relative; cursor:pointer; }
    .toggle:checked { background:var(--hb-blue); }
    .toggle::after { content:""; position:absolute; width:12px; height:12px; left:2px; top:2px; background:var(--hb-blue); transition:left 120ms ease,background 120ms ease; }
    .toggle:checked::after { left:18px; background:var(--hb-paper); }
    .foot { display:flex; justify-content:space-between; gap:10px; padding:10px 12px; border-top:1px solid var(--hb-line); color:var(--hb-muted); font-size:9px; }
    @media (max-width:420px) { .panel { width:calc(100vw - 16px); } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { transition:none!important; animation:none!important; } }
  `;

  const launcher = button('launcher', '', 'Open Hermes Assist');
  launcher.appendChild(logo('launcher-logo'));
  launcher.title = 'Open Hermes Assist';
  launcher.hidden = true;

  const panel = make('section', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Hermes Assist');
  panel.hidden = true;

  const head = make('header', 'head');
  const brandMark = make('div', 'brand-mark');
  brandMark.appendChild(logo('brand-logo'));
  head.appendChild(brandMark);
  const brandCopy = make('div');
  brandCopy.append(make('span', 'kicker', 'Hermes Browser'), make('strong', 'title', 'Hermes Assist'));
  const close = button('close', '×', 'Close Hermes Assist');
  head.append(brandCopy, close);
  const context = make('div', 'context');
  const contextDetail = make('span', '', 'Focused draft');
  const contextState = make('span', 'secure', 'PRIVATE');
  context.append(contextDetail, contextState);
  const body = make('div', 'body');
  const foot = make('footer', 'foot');
  foot.append(make('span', '', 'No submit · no send · no other fields touched'), make('strong', '', 'SAFE APPLY'));
  panel.append(head, context, body, foot);
  shadow.append(style, launcher, panel);
  (document.documentElement || document.body).appendChild(host);

  let target = null;
  let siteProfile = null;
  let siteContextPreferences = {};
  let pendingAction = null;
  let pending = null;
  let handledResultRequestId = '';
  let resultText = '';
  let resultSessionId = '';
  let resultSessionTitle = '';
  let resultModelNotice = '';
  let applyReceipt = null;
  let autoReplace = true;
  let appliedAutomatically = false;
  let rememberRoute = false;
  let panelScrollSuspended = false;
  let targetResizeObserver = null;
  let targetMutationObserver = null;
  let positionFrame = 0;
  let stabilizationFrame = 0;
  let stabilizationDeadline = 0;
  const SITE_CONTEXT_STORAGE_KEY = 'hermesInlineSiteContextPreferences';
  const visualViewport = globalThis.visualViewport || null;
  let assistSettings = {
    inlineAssistEnabled: true,
    inlineAssistDefaultRoute: policy.routePreferences?.ASK || 'ask',
    appearanceTheme: appearance.defaultTheme || 'nous',
    colorMode: appearance.defaultColorMode || 'dark',
  };
  const systemThemeQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)') || null;

  function applyAssistAppearance() {
    const tokens = appearance.resolveInlineAssistTheme(
      assistSettings.appearanceTheme,
      assistSettings.colorMode,
      systemThemeQuery?.matches !== false,
    );
    host.dataset.theme = tokens.theme;
    host.dataset.mode = tokens.mode;
    host.style.setProperty('--hb-surface', tokens.surface);
    host.style.setProperty('--hb-paper', tokens.panel);
    host.style.setProperty('--hb-blue', tokens.ink);
    host.style.setProperty('--hb-fg', tokens.fg);
    host.style.setProperty('--hb-accent', tokens.accent);
    host.style.setProperty('--hb-logo', tokens.logo);
    host.style.setProperty('--hb-logo-bg', tokens.logoBackground);
    host.style.setProperty('--hermes-fg-rgb', colorChannels(tokens.fg));
    host.style.setProperty('--hermes-line-strong', `rgba(${colorChannels(tokens.ink)},0.78)`);
    host.style.colorScheme = tokens.mode;
  }

  function applyAssistSettings() {
    applyAssistAppearance();
    if (assistSettings.inlineAssistEnabled === false) {
      disconnectTargetObservers();
      launcher.hidden = true;
      hidePanel();
    } else if (target && isTargetVisible(target)) {
      if (!targetResizeObserver && !targetMutationObserver) observeTargetLayout();
      launcher.hidden = false;
      position();
    }
  }

  async function loadAssistSettings() {
    const stored = await chrome.storage.local.get(['hermesBrowserSettings', SITE_CONTEXT_STORAGE_KEY]).catch(() => ({}));
    assistSettings = { ...assistSettings, ...(stored?.hermesBrowserSettings || {}) };
    siteContextPreferences = adapters?.normalizeInlineSiteContextPreferences?.(stored?.[SITE_CONTEXT_STORAGE_KEY]) || {};
    assistSettings.inlineAssistDefaultRoute = policy.normalizeRoutePreference?.(assistSettings.inlineAssistDefaultRoute) || 'ask';
    refreshSiteProfile();
    applyAssistSettings();
  }

  async function persistDefaultRoute(route) {
    const stored = await chrome.storage.local.get('hermesBrowserSettings').catch(() => ({}));
    const next = {
      ...(stored?.hermesBrowserSettings || {}),
      inlineAssistEnabled: assistSettings.inlineAssistEnabled !== false,
      inlineAssistDefaultRoute: policy.normalizeRoutePreference?.(route) || 'ask',
    };
    assistSettings = { ...assistSettings, ...next };
    await chrome.storage.local.set({ hermesBrowserSettings: next });
  }

  async function persistSiteContextMode(adapterId, mode) {
    if (!adapterId || adapterId === 'generic' || !['draft', 'visible'].includes(mode)) return;
    siteContextPreferences = adapters?.normalizeInlineSiteContextPreferences?.({
      ...siteContextPreferences,
      [adapterId]: mode,
    }) || { ...siteContextPreferences, [adapterId]: mode };
    await chrome.storage.local.set({ [SITE_CONTEXT_STORAGE_KEY]: siteContextPreferences });
    refreshSiteProfile();
    if (!panel.hidden) renderAssist();
    else position();
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes?.hermesBrowserSettings) {
      assistSettings = { ...assistSettings, ...(changes.hermesBrowserSettings.newValue || {}) };
      assistSettings.inlineAssistDefaultRoute = policy.normalizeRoutePreference?.(assistSettings.inlineAssistDefaultRoute) || 'ask';
    }
    if (changes?.[SITE_CONTEXT_STORAGE_KEY]) {
      siteContextPreferences = adapters?.normalizeInlineSiteContextPreferences?.(changes[SITE_CONTEXT_STORAGE_KEY].newValue) || {};
      refreshSiteProfile();
      if (!panel.hidden) renderAssist();
    }
    applyAssistSettings();
  }

  function onSystemThemeChanged() {
    if (assistSettings.colorMode === 'system') applyAssistAppearance();
  }

  function refreshSiteProfile(candidate = target) {
    if (!candidate) {
      siteProfile = null;
      return null;
    }
    const resolved = adapters?.inspectInlineSite?.(document, candidate, {
      url: location.href,
      contextPreferences: siteContextPreferences,
    });
    if (resolved) {
      siteProfile = resolved;
      return siteProfile;
    }
    const legacy = adapters?.inspectSite?.(document, { url: location.href }) || {};
    siteProfile = {
      adapterId: legacy.adapterId || 'generic',
      label: legacy.label || location.hostname.replace(/^www\./, '') || 'this site',
      surface: 'focused-draft',
      confidence: legacy.matched ? 0.7 : 0.5,
      actions: legacy.actions || [],
      contextMode: 'draft',
      contextPolicy: { defaultMode: 'draft', private: true, userConfigurable: false, warning: '' },
      contextElement: null,
      placement: { anchorElement: candidate, obstacleElements: [], preferred: ['inside-end'] },
      applyMode: 'safe-apply',
    };
    return siteProfile;
  }

  function pageActions() {
    const profile = siteProfile || refreshSiteProfile();
    const siteActions = Array.isArray(profile?.actions) ? profile.actions : [];
    const available = profile?.adapterId !== 'generic' && siteActions.length
      ? siteActions
      : genericActions;
    const seen = new Set();
    return available.filter((item) => {
      if (item?.mode !== 'draft-copy-only' || !item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, 6);
  }

  function currentContextLabel() {
    const current = policy.classifyEditable(target);
    const profile = siteProfile || refreshSiteProfile();
    const adapter = profile?.label || location.hostname.replace(/^www\./, '') || 'page';
    const surface = String(profile?.surface || 'focused draft').replace(/-/g, ' ');
    return `${adapter} · ${surface} · ${current.eligible ? current.text.length : 0} characters`;
  }

  function boundedContextForTarget({ explicitGenericCapture = false } = {}) {
    if (!target) return '';
    const profile = siteProfile || refreshSiteProfile();
    const captureProfile = explicitGenericCapture && profile?.adapterId === 'generic'
      ? { ...profile, contextMode: 'visible' }
      : profile;
    return String(adapters?.captureInlineSiteContext?.(document, target, captureProfile) || '').slice(0, 6_000);
  }

  function isTargetVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const viewportWidth = globalThis.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight;
    return rect.width > 0
      && rect.height > 0
      && rect.right > 8
      && rect.left < viewportWidth - 8
      && rect.bottom >= 40
      && rect.top < viewportHeight - 8;
  }

  function hasUnresolvedInteraction() {
    return !panel.hidden || panelScrollSuspended;
  }

  function stopPositionStabilization() {
    if (positionFrame) cancelAnimationFrame(positionFrame);
    if (stabilizationFrame) cancelAnimationFrame(stabilizationFrame);
    positionFrame = 0;
    stabilizationFrame = 0;
    stabilizationDeadline = 0;
  }

  function disconnectTargetObservers() {
    targetResizeObserver?.disconnect();
    targetMutationObserver?.disconnect();
    targetResizeObserver = null;
    targetMutationObserver = null;
    stopPositionStabilization();
  }

  function schedulePosition() {
    if (positionFrame || !target) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      position();
    });
  }

  function stabilizePosition(duration = 900) {
    if (!target) return;
    const now = globalThis.performance?.now?.() || Date.now();
    stabilizationDeadline = Math.max(stabilizationDeadline, now + duration);
    if (stabilizationFrame) return;
    const tick = () => {
      stabilizationFrame = 0;
      position();
      const current = globalThis.performance?.now?.() || Date.now();
      if (target && current < stabilizationDeadline) stabilizationFrame = requestAnimationFrame(tick);
    };
    stabilizationFrame = requestAnimationFrame(tick);
  }

  function observeTargetLayout() {
    disconnectTargetObservers();
    if (!target) return;
    const profile = siteProfile || refreshSiteProfile();
    const anchor = profile?.placement?.anchorElement || target;
    const obstacles = Array.from(profile?.placement?.obstacleElements || []);
    const observed = [];
    const seen = new Set();
    const include = (element) => {
      if (!element || seen.has(element) || element === document.body || element === document.documentElement || element === host) return;
      seen.add(element);
      observed.push(element);
    };
    include(target);
    include(anchor);
    obstacles.forEach(include);
    let ancestor = anchor?.parentElement || target.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1) {
      include(ancestor);
      ancestor = ancestor.parentElement;
    }
    if (typeof globalThis.ResizeObserver === 'function') {
      targetResizeObserver = new globalThis.ResizeObserver(() => {
        schedulePosition();
        stabilizePosition(240);
      });
      observed.forEach((element) => targetResizeObserver.observe(element));
    }
    const layoutRoot = anchor || observed[observed.length - 1];
    if (layoutRoot && typeof MutationObserver === 'function') {
      targetMutationObserver = new MutationObserver(() => {
        refreshSiteProfile();
        schedulePosition();
        stabilizePosition(240);
      });
      targetMutationObserver.observe(layoutRoot, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'aria-label'],
      });
    }
    stabilizePosition(1_200);
  }

  function suspendPanelForScroll() {
    launcher.hidden = true;
    if (panel.hidden) return;
    panelScrollSuspended = true;
    panel.style.visibility = 'hidden';
    panel.style.pointerEvents = 'none';
  }

  function resumePanelAfterScroll() {
    if (!panelScrollSuspended) return;
    panelScrollSuspended = false;
    panel.style.visibility = '';
    panel.style.pointerEvents = '';
  }

  function position() {
    if (!target || assistSettings.inlineAssistEnabled === false) {
      suspendPanelForScroll();
      return;
    }
    if (!isTargetVisible(target)) {
      suspendPanelForScroll();
      return;
    }
    const profile = siteProfile || refreshSiteProfile();
    const anchor = profile?.placement?.anchorElement?.isConnected
      ? profile.placement.anchorElement
      : target;
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      suspendPanelForScroll();
      return;
    }
    const targetRect = target.getBoundingClientRect();
    const obstacleRects = Array.from(profile?.placement?.obstacleElements || [])
      .filter((element) => element?.isConnected && element !== target)
      .map((element) => element.getBoundingClientRect())
      .filter((obstacle) => obstacle.width > 0 && obstacle.height > 0);
    const viewportWidth = globalThis.innerWidth;
    const viewportHeight = globalThis.innerHeight;
    const viewport = {
      width: visualViewport?.width || viewportWidth,
      height: visualViewport?.height || viewportHeight,
      offsetLeft: visualViewport?.offsetLeft || 0,
      offsetTop: visualViewport?.offsetTop || 0,
    };
    const launcherPosition = typeof policy.inlineLauncherPlacement === 'function'
      ? policy.inlineLauncherPlacement(rect, viewport, {
        targetRect,
        obstacleRects,
        preferred: profile?.placement?.preferred || ['inside-end'],
      })
      : policy.inlineLauncherPosition(rect, viewport);
    if (!launcherPosition) {
      suspendPanelForScroll();
      return;
    }
    resumePanelAfterScroll();
    launcher.hidden = false;
    launcher.dataset.placement = launcherPosition.strategy || 'inside-end';
    launcher.style.left = `${launcherPosition.left}px`;
    launcher.style.top = `${launcherPosition.top}px`;
    if (!panel.hidden) {
      const safe = 8;
      const panelWidth = Math.min(370, viewportWidth - 20);
      const detachedPlacement = launcherPosition.strategy && launcherPosition.strategy !== 'inside-end';
      const belowTop = rect.bottom + 8;
      const availableBelow = viewportHeight - belowTop - safe;
      const availableAbove = rect.top - 8 - safe;
      if (detachedPlacement && (availableBelow >= 300 || availableAbove >= 300)) {
        const useBelow = availableBelow >= 300 || availableBelow >= availableAbove;
        const availableHeight = useBelow ? availableBelow : availableAbove;
        panel.style.maxHeight = `${Math.min(650, Math.max(300, availableHeight))}px`;
        panel.style.left = `${Math.max(safe, Math.min(viewportWidth - panelWidth - safe, rect.right - panelWidth))}px`;
        panel.style.top = `${useBelow ? belowTop : safe}px`;
        return;
      }
      panel.style.maxHeight = '';
      const panelHeight = Math.max(260, panel.getBoundingClientRect().height || 0);
      const outsideRight = rect.right + panelWidth + 12 <= viewportWidth - safe;
      const leftOfLauncher = launcherPosition.left - panelWidth - 8;
      const panelLeft = outsideRight
        ? rect.right + 8
        : (leftOfLauncher >= safe
          ? leftOfLauncher
          : Math.max(safe, Math.min(viewportWidth - panelWidth - safe, rect.right - panelWidth)));
      const aboveTop = rect.top - panelHeight - 8;
      const panelTop = belowTop + panelHeight <= viewportHeight - safe
        ? belowTop
        : (aboveTop >= safe ? aboveTop : Math.max(safe, Math.min(viewportHeight - panelHeight - safe, rect.top)));
      panel.style.left = `${panelLeft}px`;
      panel.style.top = `${panelTop}px`;
    }
  }

  function resetResult() {
    resultText = '';
    resultSessionId = '';
    resultSessionTitle = '';
    resultModelNotice = '';
    applyReceipt = null;
    appliedAutomatically = false;
  }

  function hidePanel() {
    panel.hidden = true;
    panelScrollSuspended = false;
    panel.style.visibility = '';
    panel.style.pointerEvents = '';
    pendingAction = null;
  }

  function setTarget(candidate) {
    if (hasUnresolvedInteraction() && target?.isConnected && candidate !== target) return;
    const classification = policy.classifyEditable(candidate);
    if (!classification.eligible) {
      if (hasUnresolvedInteraction()) return;
      target = null;
      siteProfile = null;
      disconnectTargetObservers();
      launcher.hidden = true;
      hidePanel();
      return;
    }
    const targetChanged = target !== candidate;
    target = candidate;
    refreshSiteProfile(candidate);
    if (targetChanged) observeTargetLayout();
    else stabilizePosition(420);
    launcher.hidden = assistSettings.inlineAssistEnabled === false || !isTargetVisible(target);
    if (!launcher.hidden) position();
  }

  function setBody(...nodes) {
    body.replaceChildren(...nodes);
    position();
  }

  function renderAssist() {
    const profile = siteProfile || refreshSiteProfile();
    const contextText = boundedContextForTarget();
    const usesVisibleContext = profile?.contextMode === 'visible';
    contextDetail.textContent = currentContextLabel();
    contextState.textContent = usesVisibleContext ? 'BOUNDED' : 'DRAFT ONLY';
    contextState.className = 'secure';

    const nodes = [];
    if (profile?.contextPolicy?.userConfigurable) {
      const contextSetting = make('label', 'setting');
      const contextCopy = make('span');
      const contextTitle = usesVisibleContext
        ? `Use visible ${String(profile.surface || 'page').replace(/-/g, ' ')} context`
        : 'Use focused draft only';
      const contextDescription = usesVisibleContext
        ? `${contextText.length} bounded context characters · saved for ${profile.label}`
        : `Strict default · no visible ${profile.label} conversation context`;
      contextCopy.append(make('strong', '', contextTitle), make('br'), make('small', '', contextDescription));
      const contextToggle = make('input', 'toggle');
      contextToggle.type = 'checkbox';
      contextToggle.checked = usesVisibleContext;
      contextToggle.setAttribute('aria-label', `Use visible ${profile.label} context`);
      contextToggle.addEventListener('change', () => {
        void persistSiteContextMode(profile.adapterId, contextToggle.checked ? 'visible' : 'draft');
      });
      contextSetting.append(contextCopy, contextToggle);
      nodes.push(contextSetting);
      if (usesVisibleContext && profile.contextPolicy.warning) nodes.push(make('p', 'privacy', profile.contextPolicy.warning));
    }

    const label = make('span', 'section-label', `What should Hermes do on ${profile?.label || 'this site'}?`);
    const actionsNode = make('div', 'actions');
    pageActions().forEach((action, index) => {
      const actionButton = button(`action${index === 0 ? ' primary' : ''}`, action.label);
      actionButton.dataset.actionId = action.id;
      actionButton.appendChild(make('small', '', action.detail || action.instruction || 'Use this field only'));
      actionButton.addEventListener('click', () => beginAction(action));
      actionsNode.appendChild(actionButton);
    });
    const localLabel = make('span', 'section-label', 'Instant tools · no model call');
    const localNode = make('div', 'local-actions');
    localActions.forEach((action) => {
      const actionButton = button('action', action.label);
      actionButton.dataset.actionId = action.id;
      actionButton.appendChild(make('small', '', action.detail));
      actionButton.addEventListener('click', () => runLocalAction(action));
      localNode.appendChild(actionButton);
    });
    const customLabel = make('span', 'section-label', 'Or tell Hermes exactly what you need');
    const customRow = make('div', 'custom-row');
    const custom = make('textarea', 'custom');
    custom.placeholder = 'Make this more confident without sounding aggressive…';
    custom.setAttribute('aria-label', 'Custom Hermes Assist instruction');
    const customGo = button('custom-go', 'Ask Hermes');
    customGo.addEventListener('click', () => {
      const text = custom.value.trim();
      if (!text) return custom.focus();
      beginAction({ id: 'custom', label: text.slice(0, 120), detail: 'Custom instruction', mode: 'draft-copy-only' });
    });
    customRow.append(custom, customGo);
    const setting = make('label', 'setting');
    const settingCopy = make('span');
    const supportsSafeApply = profile?.applyMode !== 'copy-only';
    settingCopy.append(
      make('strong', '', supportsSafeApply ? 'Automatic replacement' : 'Preview + copy only'),
      make('br'),
      make('small', '', supportsSafeApply
        ? 'Falls back to review if the field changed'
        : 'This managed editor is not mutated until insertion is verified'),
    );
    const toggle = make('input', 'toggle');
    toggle.type = 'checkbox';
    toggle.checked = supportsSafeApply && autoReplace;
    toggle.disabled = !supportsSafeApply;
    toggle.addEventListener('change', () => { autoReplace = toggle.checked; });
    setting.append(settingCopy, toggle);
    nodes.push(label, actionsNode, localLabel, localNode, customLabel, customRow, setting);
    setBody(...nodes);
  }

  async function beginAction(action) {
    if (!target) return;
    pendingAction = action;
    const status = await chrome.runtime.sendMessage({ type: SESSION_STATUS }).catch(() => null);
    const decision = policy.routeDecision?.({
      preference: assistSettings.inlineAssistDefaultRoute,
      hasActiveSession: Boolean(status?.hasActiveSession),
    }) || 'ask';
    if (decision === 'ask') renderRouting(status || {});
    else requestDraft(action, decision);
  }

  function renderRouting(session = {}) {
    contextDetail.textContent = session.hasActiveSession
      ? `Active chat · ${Number(session.messageCount || 0) || 'existing'} messages`
      : 'No active Browser chat';
    contextState.textContent = 'CHOOSE';
    contextState.className = '';
    const title = make('h2', 'route-title', 'Where should Hermes work?');
    const note = make('p', 'note', 'Hermes will never replace or switch an existing conversation without this choice.');
    const routes = [
      { num: '01', route: policy.routes.CURRENT, title: 'Continue current chat', detail: session.hasActiveSession ? `Add this request to “${session.title || 'current Browser chat'}”.` : 'No active Browser chat is available.', disabled: !session.hasActiveSession },
      { num: '02', route: policy.routes.NEW, title: 'Start new Assist session', detail: 'Create and open a new Hermes Assist session.' },
      { num: '03', route: policy.routes.BACKGROUND, title: 'Run in background', detail: 'Keep the current chat visible. Return the result to this field.', tag: 'New session · Inline assist', recommended: true },
    ];
    const routeNodes = routes.map((route) => {
      const routeButton = button(`route${route.recommended ? ' recommended' : ''}`, '');
      routeButton.dataset.route = route.route;
      routeButton.disabled = Boolean(route.disabled);
      const copy = make('span');
      copy.append(make('strong', '', route.title), make('small', '', route.detail));
      if (route.tag) copy.appendChild(make('span', 'tag', route.tag));
      routeButton.append(make('span', 'route-num', route.num), copy, make('span', 'arrow', '→'));
      routeButton.addEventListener('click', async () => {
        if (rememberRoute) await persistDefaultRoute(route.route);
        await requestDraft(pendingAction, route.route);
      });
      return routeButton;
    });
    const rememberSetting = make('label', 'setting');
    const rememberCopy = make('span');
    rememberCopy.append(make('strong', '', 'Use this choice next time'), make('br'), make('small', '', 'You can change it anytime in Settings → Hermes Assist.'));
    const rememberToggle = make('input', 'toggle');
    rememberToggle.type = 'checkbox';
    rememberToggle.checked = rememberRoute;
    rememberToggle.addEventListener('change', () => { rememberRoute = rememberToggle.checked; });
    rememberSetting.append(rememberCopy, rememberToggle);
    const privacy = make('p', 'privacy');
    privacy.append('Background runs stay in session history under ', make('strong', '', 'Inline assist'), '. They receive this bounded field snapshot—not other form values.');
    setBody(title, note, ...routeNodes, rememberSetting, privacy);
  }

  async function requestDraft(action, route) {
    if (!target || !action) return;
    const requestId = `req-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const profile = siteProfile || refreshSiteProfile();
    const pageContext = boundedContextForTarget({ explicitGenericCapture: action.id === 'draft-for-context' });
    const supportsSafeApply = profile?.applyMode !== 'copy-only';
    const built = policy.buildInlineDraftRequest(target, {
      action,
      route,
      autoReplace: autoReplace && supportsSafeApply,
      requestId,
      documentId,
      pageUrl: location.href,
      adapterId: profile?.adapterId || 'generic',
      pageContext,
      redact: (text) => extractor?.redactSensitiveTextWithCount?.(text) || { text, count: 0 },
    });
    if (!built.ok) {
      return renderFailure(built.reason === 'sensitive-content'
        ? 'Hermes blocked this field because it appears to contain sensitive content.'
        : 'This field is not eligible for inline drafting.');
    }
    pending = { ...built.request, applyMode: supportsSafeApply ? 'safe-apply' : 'copy-only' };
    resetResult();
    renderWorking();
    const response = await chrome.runtime.sendMessage({ type: REQUEST, request: pending }).catch((error) => ({ ok: false, reason: error?.message }));
    if (!response?.ok) renderFailure(response?.reason || 'Hermes could not queue this draft.');
  }

  function renderWorking() {
    contextState.textContent = 'WORKING';
    const wrap = make('div', 'working');
    const mark = make('i', 'working-mark');
    const title = make('h2', 'route-title', 'Hermes is drafting');
    const copy = make('p', 'status', pending?.route === policy.routes.BACKGROUND ? 'Your current conversation stays visible.' : 'This request is bound to the selected Browser session.');
    wrap.append(mark, title, copy);
    setBody(wrap);
  }

  function renderFailure(reason) {
    contextState.textContent = 'BLOCKED';
    const title = make('h2', 'route-title', 'Assist could not run');
    const detail = make('p', 'status', reason || 'Hermes could not create this draft.');
    const back = button('action', 'Back to actions');
    back.addEventListener('click', renderAssist);
    setBody(title, detail, back);
  }

  function runLocalAction(action) {
    const current = policy.classifyEditable(target);
    if (!current.eligible) return renderFailure('The original field is no longer available.');
    pending = {
      requestId: `local-${Date.now()}`,
      documentId,
      draftText: current.text,
      actionId: action.id,
      actionLabel: action.label,
      route: 'local',
      autoReplace: autoReplace && siteProfile?.applyMode !== 'copy-only',
      adapterId: 'local',
      applyMode: siteProfile?.applyMode || 'safe-apply',
    };
    const transformed = policy.runLocalTransform(current.text, action.id);
    if (!transformed.ok) return renderFailure('This deterministic transform could not process the field.');
    receiveResult({ ok: true, text: transformed.text, sessionTitle: 'Local utility · no model', sessionId: '', noModel: true });
  }

  function receiveResult(message) {
    resultText = policy.sanitizeInlineDraftResult(message.text || message.result || '');
    resultSessionId = String(message.sessionId || '');
    resultSessionTitle = String(message.sessionTitle || (message.noModel ? 'Local utility · no model' : 'Inline assist'));
    resultModelNotice = String(message.modelNotice || '');
    const current = policy.classifyEditable(target);
    const fieldChanged = !current.eligible || current.text !== pending.draftText;
    if (resultText && pending.autoReplace && !fieldChanged) {
      const applied = policy.applyResult(target, { draftText: pending.draftText, resultText, adapterId: pending.adapterId });
      if (applied.ok) {
        applyReceipt = applied.receipt;
        appliedAutomatically = true;
      }
    }
    renderResult({ fieldChanged, noModel: Boolean(message.noModel) });
  }

  function onResult(message) {
    if (message?.type === CONTEXT_ACTION) {
      const current = policy.classifyEditable(document.activeElement);
      if (current.eligible) {
        setTarget(document.activeElement);
        openPanel();
        const action = [...pageActions(), ...localActions].find((item) => item.id === message.actionId);
        if (action?.local) runLocalAction(action);
        else if (action) beginAction(action);
      }
      return false;
    }
    if (message?.type !== RESULT || !pending) return false;
    if (message.requestId !== pending.requestId || message.documentId !== documentId) return false;
    if (message.requestId === handledResultRequestId) return false;
    handledResultRequestId = message.requestId;
    if (message.ok === false) {
      renderFailure(message.reason || 'Hermes could not create this draft.');
      return false;
    }
    receiveResult(message);
    return false;
  }

  function renderResult({ fieldChanged = false, noModel = false } = {}) {
    contextDetail.textContent = `${noModel ? 'Local utility' : 'Inline assist'} · ${pending?.actionLabel || 'Result'}`;
    contextState.textContent = 'COMPLETE';
    contextState.className = 'secure';
    const copyOnly = pending?.applyMode === 'copy-only';
    const success = make('div', 'success');
    success.append(make('i'), make('span', '', copyOnly
      ? 'Draft ready · this managed editor stays untouched'
      : (appliedAutomatically ? 'Replaced the original field safely' : (fieldChanged ? 'Field changed · review required' : 'Draft ready for review'))));
    const card = make('div', 'run-card');
    const row = make('div', 'run-row');
    row.append(make('span', '', 'Session'), make('strong', '', resultSessionTitle || 'Inline assist'));
    const title = make('div', 'run-title', noModel ? 'Finished without a model call.' : 'Draft ready. Still your decision.');
    const copy = make('p', 'run-copy', appliedAutomatically
      ? 'The original field was unchanged while Hermes worked, so automatic replacement was allowed.'
      : (fieldChanged ? 'The field changed while Hermes worked, so automatic replacement was blocked.' : 'Review the result before applying it.'));
    card.append(row, title, copy);
    if (resultModelNotice) {
      const routingNotice = make('p', 'privacy', `Model routing · ${resultModelNotice}`);
      routingNotice.setAttribute('role', 'status');
      card.append(routingNotice);
    }
    const label = make('span', 'section-label', 'Result preview');
    const preview = make('div', 'preview', resultText || '(empty draft)');
    const actions = make('div', 'result-actions');
    actions.dataset.actionCount = resultSessionId ? '4' : '3';
    const keep = button('main', copyOnly ? 'Copy to use' : (policy.inlineDraftPrimaryActionLabel?.({
      originalText: pending?.draftText || '',
      appliedAutomatically,
    }) || (appliedAutomatically ? 'Keep replacement' : 'Apply to field')));
    keep.disabled = copyOnly;
    const undo = button('', 'Undo');
    undo.disabled = !applyReceipt;
    const copyButton = button('', 'Copy');
    const open = button('', 'Open session');
    open.disabled = !resultSessionId;
    keep.addEventListener('click', applyResult);
    undo.addEventListener('click', undoResult);
    copyButton.addEventListener('click', copyResult);
    open.addEventListener('click', renderOpenSessionChoices);
    actions.append(keep, undo, copyButton);
    if (resultSessionId) actions.append(open);
    const setting = make('label', 'setting');
    const settingCopy = make('span');
    settingCopy.append(
      make('strong', '', copyOnly ? 'Preview + copy only' : 'Automatic replacement'),
      make('br'),
      make('small', '', copyOnly ? 'Direct mutation is disabled for this editor' : 'Falls back to review if the field changed'),
    );
    const toggle = make('input', 'toggle');
    toggle.type = 'checkbox';
    toggle.checked = !copyOnly && autoReplace;
    toggle.disabled = copyOnly;
    toggle.addEventListener('change', () => { autoReplace = toggle.checked; });
    setting.append(settingCopy, toggle);
    setBody(success, card, label, preview, actions, setting);
  }

  function applyResult() {
    if (pending?.applyMode === 'copy-only') return renderFailure('Direct apply is disabled for this managed editor. Use Copy, then paste the reviewed draft yourself.');
    if (!appliedAutomatically) {
      const applied = policy.applyResult(target, { draftText: pending.draftText, resultText, adapterId: pending.adapterId });
      if (!applied.ok) return renderFailure('The field changed, so Hermes did not overwrite it. Copy the result or start a new assist.');
      applyReceipt = applied.receipt;
      appliedAutomatically = true;
    }
    hidePanel();
    pending = null;
    resetResult();
  }

  function undoResult() {
    if (!applyReceipt) return;
    const undone = policy.undoResult(target, applyReceipt);
    if (!undone.ok) return renderFailure('Undo was blocked because the field changed after the replacement.');
    applyReceipt = null;
    appliedAutomatically = false;
    renderResult();
  }

  async function copyResult() {
    if (!resultText) return;
    try {
      await navigator.clipboard.writeText(resultText);
      contextDetail.textContent = 'Copied result to clipboard';
    } catch {
      contextDetail.textContent = 'Copy blocked · select preview manually';
    }
  }

  function renderOpenSessionChoices() {
    if (!resultSessionId) return;
    contextState.textContent = 'CHOOSE';
    contextState.className = '';
    const title = make('h2', 'route-title', 'Where should this session open?');
    const note = make('p', 'note', 'Open the retained Assist session in the Browser side panel or in Hermes Web.');
    const options = [
      { num: '01', surface: 'sidepanel', title: 'Browser Extension', detail: 'Open the exact session in the Hermes Browser side panel.', recommended: true },
      { num: '02', surface: 'web', title: 'Hermes Web', detail: 'Open the exact session in the full Hermes Web workspace.' },
    ].map((option) => {
      const routeButton = button(`route${option.recommended ? ' recommended' : ''}`, '');
      routeButton.dataset.sessionSurface = option.surface;
      const copy = make('span');
      copy.append(make('strong', '', option.title), make('small', '', option.detail));
      routeButton.append(make('span', 'route-num', option.num), copy, make('span', 'arrow', '→'));
      routeButton.addEventListener('click', () => openResultSession(option.surface));
      return routeButton;
    });
    const back = button('action', 'Back to result');
    back.addEventListener('click', () => renderResult());
    setBody(title, note, ...options, back);
  }

  async function openResultSession(surface = 'sidepanel') {
    if (!resultSessionId) return;
    const response = await chrome.runtime.sendMessage({
      type: OPEN_SESSION,
      sessionId: resultSessionId,
      surface: surface === 'web' ? 'web' : 'sidepanel',
    }).catch((error) => ({ ok: false, reason: error?.message || String(error) }));
    if (!response?.ok) {
      renderFailure(response?.reason || 'Hermes could not open that retained session.');
      return;
    }
    hidePanel();
    pending = null;
    resetResult();
  }

  function onFocus(event) {
    if (event.composedPath?.().includes(host)) return;
    setTarget(event.target);
  }

  function onEditableInput(event) {
    if (!target || event.composedPath?.().includes(host)) return;
    if (event.target === target || target.contains?.(event.target)) stabilizePosition(420);
  }

  function onKey(event) {
    if (event.key === 'Escape') hidePanel();
  }

  function containAssistInteraction(event) {
    event.stopPropagation();
  }

  function onLauncherPointerDown(event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      target?.focus?.({ preventScroll: true });
    } catch {
      target?.focus?.();
    }
  }

  function togglePanel(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!panel.hidden) {
      hidePanel();
      position();
      return;
    }
    openPanel();
  }

  function openPanel() {
    if (!target || assistSettings.inlineAssistEnabled === false || !isTargetVisible(target)) return;
    resetResult();
    pending = null;
    panel.hidden = false;
    renderAssist();
    position();
  }

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('input', onEditableInput, true);
  document.addEventListener('keydown', onKey, true);
  globalThis.addEventListener('resize', position);
  globalThis.addEventListener('scroll', position, true);
  visualViewport?.addEventListener?.('resize', position);
  visualViewport?.addEventListener?.('scroll', position);
  shadow.addEventListener('pointerdown', containAssistInteraction);
  shadow.addEventListener('mousedown', containAssistInteraction);
  shadow.addEventListener('click', containAssistInteraction);
  shadow.addEventListener('keydown', containAssistInteraction);
  shadow.addEventListener('keypress', containAssistInteraction);
  shadow.addEventListener('keyup', containAssistInteraction);
  launcher.addEventListener('pointerdown', onLauncherPointerDown);
  launcher.addEventListener('mousedown', onLauncherPointerDown);
  launcher.addEventListener('click', togglePanel);
  close.addEventListener('click', hidePanel);
  chrome.runtime.onMessage.addListener(onResult);
  chrome.storage.onChanged.addListener(onStorageChanged);
  systemThemeQuery?.addEventListener?.('change', onSystemThemeChanged);
  void loadAssistSettings();

  globalThis.__HERMES_INLINE_HELPER_CLEANUP__ = () => {
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('input', onEditableInput, true);
    document.removeEventListener('keydown', onKey, true);
    globalThis.removeEventListener('resize', position);
    globalThis.removeEventListener('scroll', position, true);
    visualViewport?.removeEventListener?.('resize', position);
    visualViewport?.removeEventListener?.('scroll', position);
    disconnectTargetObservers();
    chrome.runtime.onMessage.removeListener(onResult);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    systemThemeQuery?.removeEventListener?.('change', onSystemThemeChanged);
    host.remove();
  };
})();
