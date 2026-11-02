(async () => {
  const generation = Math.max(0, Number(globalThis.__HERMES_INLINE_HELPER_GENERATION__) || 0) + 1;
  globalThis.__HERMES_INLINE_HELPER_GENERATION__ = generation;
  const previousCleanup = globalThis.__HERMES_INLINE_HELPER_CLEANUP__;
  if (typeof previousCleanup === 'function') previousCleanup();

  const browserApi = globalThis.hermesBrowserApi;
  const policy = globalThis.HermesInlineDraft;
  const appearance = globalThis.HermesAppearance;
  const extractor = globalThis.HermesContentExtractor;
  const adapters = globalThis.HermesSiteAdapters;
  const i18n = globalThis.HermesI18nContent;
  const look = globalThis.HermesInlineAssistLook;
  const appearancePreferences = globalThis.HermesAppearancePreferences;
  if (!policy?.classifyEditable || !policy?.buildInlineDraftRequest || !policy?.applyResult || !appearance?.resolveInlineAssistTheme || !i18n?.ready) return;
  await i18n.ready;
  if (globalThis.__HERMES_INLINE_HELPER_GENERATION__ !== generation) return;
  const translateUiText = (value) => i18n.translateText(value);

  const REQUEST = 'HERMES_INLINE_DRAFT_REQUEST';
  const RESULT = 'HERMES_INLINE_DRAFT_RESULT';
  const SESSION_STATUS = 'HERMES_INLINE_SESSION_STATUS';
  const OPEN_SESSION = 'HERMES_INLINE_OPEN_SESSION';
  const CONTEXT_ACTION = 'HERMES_INLINE_CONTEXT_ACTION';
  const FONT_REQUEST = 'HERMES_INLINE_FONT_REQUEST';
  const extensionRoot = String(browserApi.runtime.getManifest()?.side_panel?.default_path || '').startsWith('extension/') ? 'extension/' : '';
  const logoUrl = browserApi.runtime.getURL(`${extensionRoot}assets/img/hermes-browser-extension-icon-ink.png`);
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
    if (text) element.textContent = translateUiText(text);
    return element;
  }

  function makeRaw(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function button(className, text, label = text) {
    const element = make('button', className, text);
    element.type = 'button';
    element.setAttribute('aria-label', translateUiText(label));
    return element;
  }

  function logo(className) {
    const mark = make('span', className);
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', translateUiText('Hermes Browser Extension'));
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

  // Page scripts can dispatch synthetic events at any node they can reach, so
  // every Assist control only reacts to events the browser itself produced
  // (a real click, key press, or toggle by the user).
  function trustedOnly(handler) {
    return function trustedHandler(event, ...rest) {
      if (!event || event.isTrusted !== true) return undefined;
      return handler.call(this, event, ...rest);
    };
  }

  const host = make('div');
  host.id = 'hermes-inline-draft-host';
  host.setAttribute('data-hermes-owned', 'true');
  // Closed root: page scripts must not be able to reach Assist's controls or read
// results (reply text, chat title) back out of its DOM.
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = make('style');
  style.textContent = `
    :host { all:initial; position:fixed; z-index:2147483646; inset:0; pointer-events:none; --hb-surface:#0d0d0d; --hb-paper:#171717; --hb-blue:#e5e5e5; --hb-fg:#f1f1f1; --hb-accent:#c9c9c9; --hb-logo:#0d0d0d; --hb-logo-bg:#f5f5f5; --hb-line:color-mix(in srgb,var(--hb-blue) 24%,transparent); --hb-muted:color-mix(in srgb,var(--hb-blue) 68%,transparent); --hb-soft:color-mix(in srgb,var(--hb-accent) 12%,var(--hb-paper)); --hermes-fg-rgb:241,241,241; --hermes-line-strong:rgba(229,229,229,0.78); --hermes-text-zoom:1; --hb-font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; --hb-font-display:var(--hb-font-ui); --hermes-font-mono:ui-monospace,SFMono-Regular,Consolas,monospace; --hb-display-scale:1; font-family:var(--hb-font-ui); color-scheme:dark; }
    *, *::before, *::after { box-sizing:border-box; }
    button, textarea { font:inherit; }
    .launcher { position:fixed; z-index:2; display:grid; place-items:center; width:24px; height:24px; padding:0; border:0; border-radius:50%; background:var(--hx-fill,#141414); cursor:pointer; pointer-events:auto; opacity:.85; box-shadow:0 0 0 1px var(--hx-hair,rgba(0,0,0,.08)); transition:opacity 120ms ease,box-shadow 120ms ease; }
    .launcher[data-tone="light"] { --hx-fill:#f4f4f1; --hx-glyph:#111111; --hx-hair:rgba(255,255,255,.14); }
    .launcher[data-tone="dark"] { --hx-fill:#141414; --hx-glyph:#f4f4f1; --hx-hair:rgba(0,0,0,.08); }
    .launcher:hover, .launcher:focus-visible { opacity:1; outline:none; box-shadow:0 0 0 2px var(--hb-accent); }
    .launcher.busy::before { content:""; position:absolute; inset:-4px; border-radius:50%; pointer-events:none; border:2px solid transparent; border-top-color:var(--hb-accent); border-right-color:var(--hb-accent); animation:spin .9s linear infinite; }
    .launcher-label { position:absolute; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); white-space:nowrap; padding:3px 6px; border:1px solid var(--hb-line); background:var(--hb-paper); color:var(--hb-blue); font:600 calc(10.5px * var(--hermes-text-zoom, 1))/1.2 var(--hb-font-ui); opacity:0; pointer-events:none; transition:opacity 120ms ease; }
    .launcher:hover .launcher-label, .launcher:focus-visible .launcher-label { opacity:1; }
    .launcher-logo, .brand-logo { display:block; mask-position:center; mask-size:contain; mask-repeat:no-repeat; -webkit-mask-position:center; -webkit-mask-size:contain; -webkit-mask-repeat:no-repeat; }
    .launcher-logo { width:18px; height:18px; background:var(--hx-glyph,#f4f4f1); }
    .launcher[data-icon="girl"] .launcher-logo, .brand-mark[data-icon="girl"] .brand-logo { border-radius:50%; mask-size:cover; -webkit-mask-size:cover; }
    .launcher[data-icon="girl"] .launcher-logo { width:22px; height:22px; }
    .launcher[hidden], .panel[hidden] { display:none; }
    .panel { position:fixed; z-index:1; width:min(380px,calc(100vw - 20px)); max-height:min(680px,calc(100vh - 20px)); overflow:auto; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); pointer-events:auto; box-shadow:0 18px 50px rgba(0,0,0,.32), 0 0 0 1px color-mix(in srgb,var(--hb-blue) 14%,transparent); }
    .panel, .preview, .custom { scrollbar-gutter:stable; }
    .panel::-webkit-scrollbar, .preview::-webkit-scrollbar, .custom::-webkit-scrollbar { width:8px; }
    .panel::-webkit-scrollbar-thumb, .preview::-webkit-scrollbar-thumb, .custom::-webkit-scrollbar-thumb { background:rgba(var(--hermes-fg-rgb),0.45); border:1px solid var(--hermes-line-strong); }
    .head { display:grid; grid-template-columns:30px 1fr 44px; gap:12px; align-items:center; padding:14px; border-bottom:1px solid var(--hb-line); }
    .brand-mark { display:grid; place-items:center; width:30px; height:30px; padding:0; border-radius:50%; background:var(--hb-blue); }
    .brand-logo { width:22px; height:22px; background:var(--hb-paper); }
    .brand-mark[data-icon="girl"] .brand-logo { width:28px; height:28px; }
    .kicker, .section-label { display:block; color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); letter-spacing:.16em; text-transform:uppercase; }
    .title { display:block; margin-top:4px; font-family:var(--hb-font-display); font-size:calc(22px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); line-height:1; color:var(--hb-blue); }
    .close { width:44px; height:44px; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font-size:calc(28px * var(--hermes-text-zoom, 1)); line-height:1; display:grid; place-items:center; transition:background 120ms ease,border-color 120ms ease,color 120ms ease; }
    .close:hover, .close:focus-visible { background:var(--hb-blue); color:var(--hb-paper); border-color:var(--hb-blue); outline:2px solid var(--hb-blue); outline-offset:2px; }
    .context { display:grid; grid-template-columns:1fr auto; gap:10px; padding:9px 12px; border-bottom:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .secure { color:var(--hb-blue); font-weight:800; }
    .body { display:flex; flex-direction:column; gap:11px; padding:12px; }
    .note, .status, .privacy, .run-copy { margin:0; color:var(--hb-muted); font-size:calc(11px * var(--hermes-text-zoom, 1)); line-height:1.45; }
    .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-top:1px solid var(--hb-line); border-left:1px solid var(--hb-line); }
    .action { min-height:58px; padding:9px; border:0; border-right:1px solid var(--hb-line); border-bottom:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; text-align:left; font-family:var(--hb-font-display); font-size:calc(13px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); font-weight:700; }
    .action.primary { background:var(--hb-blue); color:var(--hb-paper); }
    .action small { display:block; margin-top:3px; color:var(--hb-muted); font-family:var(--hb-font-ui); font-size:calc(9px * var(--hermes-text-zoom, 1)); font-weight:400; line-height:1.3; }
    .action.primary small { color:color-mix(in srgb,var(--hb-paper) 74%,transparent); }
    .action:hover, .action:focus-visible, .route:hover, .route:focus-visible, .result-actions button:hover, .result-actions button:focus-visible { outline:2px solid var(--hb-blue); outline-offset:-2px; }
    .local-actions { display:flex; flex-wrap:wrap; gap:7px; }
    .local-actions .action { min-height:0; padding:5px 11px; border:1px solid var(--hb-line); background:var(--hb-soft); font-family:var(--hb-font-ui); font-size:calc(11.5px * var(--hermes-text-zoom, 1)); font-weight:600; text-transform:none; letter-spacing:normal; }
    .local-actions .action small { display:none; }
    .more-actions { justify-self:start; padding:4px 0; border:0; background:transparent; color:var(--hb-muted); cursor:pointer; font-size:calc(10.5px * var(--hermes-text-zoom, 1)); text-decoration:underline; }
    .action[hidden] { display:none; }
    .custom { width:100%; min-height:40px; resize:vertical; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); padding:9px; font:calc(11px * var(--hermes-text-zoom, 1))/1.4 var(--hb-font-ui); }
    .custom-row { display:grid; grid-template-columns:1fr auto; gap:7px; align-items:stretch; }
    .custom-go { min-width:76px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-blue); color:var(--hb-paper); cursor:pointer; font-size:calc(11px * var(--hermes-text-zoom, 1)); font-weight:700; }
    .route-title { margin:0; color:var(--hb-blue); font-family:var(--hb-font-display); font-size:calc(20px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); line-height:1.05; }
    .route { display:grid; grid-template-columns:42px 1fr 18px; gap:9px; align-items:center; width:100%; padding:11px; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; text-align:left; }
    .route.recommended { border:2px solid var(--hb-blue); background:var(--hb-soft); }
    .route:disabled { cursor:not-allowed; opacity:.45; }
    .route-num { font-family:var(--hb-font-display); font-size:calc(20px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); font-weight:700; }
    .route strong { font-family:var(--hb-font-display); font-size:calc(13px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); }
    .route small { display:block; margin-top:3px; color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); line-height:1.35; }
    .route .tag { display:block; margin-top:4px; color:var(--hb-blue); font-size:calc(8px * var(--hermes-text-zoom, 1)); letter-spacing:.11em; text-transform:uppercase; }
    .arrow { font-size:calc(18px * var(--hermes-text-zoom, 1)); }
    .privacy { margin-top:2px; border:1px solid var(--hb-line); padding:9px; }
    .working { display:grid; place-items:center; min-height:170px; text-align:center; }
    .working-mark { width:34px; height:34px; border:3px solid var(--hb-line); border-top-color:var(--hb-blue); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .success { display:flex; align-items:center; gap:8px; color:var(--hb-blue); font-size:calc(11px * var(--hermes-text-zoom, 1)); font-weight:800; }
    .success i { width:9px; height:9px; background:var(--hb-blue); }
    .run-card, .preview { border:1px solid var(--hb-line); background:var(--hb-paper); padding:11px; }
    .run-row { display:flex; justify-content:space-between; gap:10px; color:var(--hb-muted); font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .run-title { margin:8px 0 3px; color:var(--hb-blue); font-family:var(--hb-font-display); font-size:calc(17px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); font-weight:700; }
    .preview { max-height:170px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--hb-blue); font:calc(11px * var(--hermes-text-zoom, 1))/1.5 var(--hermes-font-mono); user-select:text; }
    .result-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
    .result-actions button { min-height:39px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; font-family:var(--hb-font-display); font-size:calc(12px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); font-weight:700; }
    .result-actions .main { background:var(--hb-blue); color:var(--hb-paper); }
    .result-actions[data-action-count="3"] button:last-child { grid-column:1 / -1; }
    .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid var(--hb-line); padding:9px; color:var(--hb-blue); font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .setting small { color:var(--hb-muted); }
    .toggle { appearance:none; width:34px; height:18px; margin:0; border:1px solid var(--hb-blue); background:var(--hb-paper); position:relative; cursor:pointer; }
    .toggle:checked { background:var(--hb-blue); }
    .toggle::after { content:""; position:absolute; width:12px; height:12px; left:2px; top:2px; background:var(--hb-blue); transition:left 120ms ease,background 120ms ease; }
    .toggle:checked::after { left:18px; background:var(--hb-paper); }
    .foot { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px 12px; border-top:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); }
    .foot-control { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid var(--hb-line); color:var(--hb-blue); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); white-space:nowrap; }
    .foot-control em { font-style:normal; color:var(--hb-muted); }
    .route-select { border:0; background:transparent; color:var(--hb-blue); font:inherit; cursor:pointer; }
    .route-select option { color:#111; }
    .foot-safety { width:100%; font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .panel[data-font-profile="signature"] .title, .panel[data-font-profile="signature"] .route-title, .panel[data-font-profile="signature"] .run-title, .panel[data-font-profile="signature"] .action, .panel[data-font-profile="signature"] .route strong, .panel[data-font-profile="signature"] .result-actions button { text-transform:uppercase; font-weight:500; letter-spacing:.02em; }
    .panel[data-font-profile="signature"] .action small, .panel[data-font-profile="signature"] .route small { text-transform:none; letter-spacing:normal; }
    .panel[data-mode="quick"] { width:min(290px,calc(100vw - 20px)); }
    .panel[data-mode="quick"] .head, .panel[data-mode="quick"] .context, .panel[data-mode="quick"] .foot, .panel[data-mode="bar"] .head, .panel[data-mode="bar"] .context, .panel[data-mode="bar"] .foot { display:none; }
    .panel[data-mode="quick"] .body, .panel[data-mode="bar"] .body { padding:0; gap:0; }
    .panel[data-mode="bar"] { max-height:none; overflow:visible; }
    .quick-ask { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--hb-line); }
    .quick-input { flex:1; min-width:0; border:0; background:transparent; color:var(--hb-blue); font:calc(12.5px * var(--hermes-text-zoom, 1))/1.3 var(--hb-font-ui); outline:none; }
    .quick-input::placeholder { color:var(--hb-muted); }
    .quick-label { padding:9px 12px 4px; }
    .quick-list { display:grid; }
    .quick-item { display:grid; grid-template-columns:20px 1fr; gap:10px; align-items:center; padding:8px 12px; border:0; background:transparent; color:var(--hb-blue); text-align:left; cursor:pointer; font-family:var(--hb-font-ui); }
    .quick-item:hover, .quick-item:focus-visible { background:var(--hb-soft); outline:none; }
    .quick-num { width:18px; height:18px; display:grid; place-items:center; border:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .quick-item strong { display:block; font-size:calc(13px * var(--hermes-text-zoom, 1)); font-weight:600; }
    .quick-item small { display:block; color:var(--hb-muted); font-size:calc(11px * var(--hermes-text-zoom, 1)); }
    .quick-tools { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 12px; border-top:1px solid var(--hb-line); }
    .quick-chip { padding:3px 9px; border:1px solid var(--hb-line); border-radius:999px; background:transparent; color:var(--hb-blue); cursor:pointer; font:600 calc(10.5px * var(--hermes-text-zoom, 1))/1.3 var(--hb-font-ui); }
    .quick-options { margin-left:auto; width:26px; height:26px; border:1px solid var(--hb-line); border-radius:50%; background:transparent; color:var(--hb-blue); cursor:pointer; }
    .quick-foot { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:7px 12px; border-top:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .quick-full { border:0; padding:0; background:transparent; color:var(--hb-blue); cursor:pointer; font:inherit; white-space:nowrap; }
    .quick-back { display:flex; align-items:center; gap:8px; width:100%; padding:9px 12px; border:0; border-bottom:1px solid var(--hb-line); background:transparent; color:var(--hb-blue); cursor:pointer; text-align:left; font-family:var(--hb-font-display); font-size:calc(17px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); }
    .quick-opt { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--hb-line); color:var(--hb-blue); font-size:calc(12px * var(--hermes-text-zoom, 1)); }
    .quick-opt small { display:block; color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .bar { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; padding:8px 10px; color:var(--hb-blue); font-size:calc(12px * var(--hermes-text-zoom, 1)); }
    .bar-title { font-weight:700; }
    .bar-preview { width:100%; max-height:4.6em; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; color:var(--hb-blue); }
    .bar-actions { display:flex; flex-wrap:wrap; gap:6px; margin-left:auto; }
    .bar-actions button { padding:4px 9px; border:1px solid var(--hb-line); background:transparent; color:var(--hb-blue); cursor:pointer; font:600 calc(11px * var(--hermes-text-zoom, 1))/1.3 var(--hb-font-ui); }
    .bar-actions button.main { border-color:var(--hb-blue); background:var(--hb-blue); color:var(--hb-paper); }
    .bar-actions button:disabled { opacity:.45; cursor:not-allowed; }
    @media (max-width:520px) { .panel { width:calc(100vw - 16px); } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { transition:none!important; animation:none!important; } }
  `;

  const launcher = button('launcher', '', 'Open Hermes Assist');
  const launcherLabel = make('span', 'launcher-label', 'Hermes Assist');
  launcherLabel.setAttribute('aria-hidden', 'true');
  launcher.append(logo('launcher-logo'), launcherLabel);
  launcher.dataset.icon = 'wing';
  launcher.dataset.tone = 'dark';
  // The label above the circle is its only tooltip: a title would add the browser's own under the cursor.
  launcher.setAttribute('aria-label', translateUiText('Open Hermes Assist'));
  launcher.hidden = true;

  const panel = make('section', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', translateUiText('Hermes Assist'));
  panel.hidden = true;

  const head = make('header', 'head');
  const brandMark = make('div', 'brand-mark');
  brandMark.appendChild(logo('brand-logo'));
  head.appendChild(brandMark);
  const brandCopy = make('div');
  const brandKicker = make('span', 'kicker', 'Hermes Browser');
  const brandTitle = make('strong', 'title', 'Hermes Assist');
  brandCopy.append(brandKicker, brandTitle);
  const close = button('close', '×', 'Close Hermes Assist');
  head.append(brandCopy, close);
  const context = make('div', 'context');
  const contextDetail = make('span', '', 'Focused draft');
  const contextState = make('span', 'secure', 'PRIVATE');
  context.append(contextDetail, contextState);
  const body = make('div', 'body');
  const foot = make('footer', 'foot');
  const footSafety = make('span', 'foot-safety', 'Never posts or sends. Only this field changes.');
  foot.append(footSafety);
  panel.append(head, context, body, foot);
  // The font stacks live in a stylesheet inside the closed root, set on the circle and the panel, so the
  // page can not read the user's font choice off the host element.
  const fontStyle = make('style', 'assist-fonts');
  // Per-page family names: a page can not guess or pre-declare them, and since it can list what
  // document.fonts holds, each family gets its own random name that does not say which font it is.
  const randomHex = (bytes) => Array.from(globalThis.crypto?.getRandomValues?.(new Uint8Array(bytes)) || Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  // One CSS identifier per name (FontFace parses the family as CSS): HermesAssist-<page token>-<family token>.
  const fontPrefix = `HermesAssist-${randomHex(4)}-`;
  const fontNames = new Map();
  const fontName = (family) => {
    if (!fontNames.has(family)) {
      const taken = new Set(fontNames.values());
      let name = `${fontPrefix}${randomHex(3)}`;
      while (taken.has(name)) name = `${fontPrefix}${randomHex(3)}`;
      fontNames.set(family, name);
    }
    return fontNames.get(family);
  };
  shadow.append(style, fontStyle, launcher, panel);
  (document.documentElement || document.body).appendChild(host);
  browserApi.storage?.local?.get?.('hermesBrowserSettings').then((stored) => {
    const percent = Number(stored?.hermesBrowserSettings?.textZoomPercent);
    if (!Number.isFinite(percent)) return;
    const bounded = Math.min(200, Math.max(75, Math.round(percent)));
    host.style.setProperty('--hermes-text-zoom', String(bounded / 100));
  }).catch(() => {});

  let target = null;
  let siteProfile = null;
  let siteContextPreferences = {};
  let pendingAction = null;
  let lastRunAction = null;
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
  let activeView = { name: 'assist', args: [] };
  let panelScrollSuspended = false;
  let targetResizeObserver = null;
  let targetMutationObserver = null;
  let positionFrame = 0;
  let stabilizationFrame = 0;
  let stabilizationDeadline = 0;
  const SITE_CONTEXT_STORAGE_KEY = 'hermesInlineSiteContextPreferences';
  // "Replace text automatically" has its own key, shared with Settings → Hermes Assist, so Assist never
  // rewrites the settings record Settings and Hermes Control also save. Unset, the record's copy decides.
  const AUTO_REPLACE_STORAGE_KEY = 'hermesInlineAssistAutoReplace';
  let savedAutoReplace = null;
  const HIDDEN_SITES_STORAGE_KEY = 'hermesInlineAssistHiddenSites';
  let hiddenSites = [];
  const visualViewport = globalThis.visualViewport || null;
  let assistSettings = {
    inlineAssistEnabled: true,
    inlineAssistDefaultRoute: policy.routePreferences?.ASK || 'ask',
    appearanceTheme: appearance.defaultTheme || 'nous',
    colorMode: appearance.defaultColorMode || 'dark',
    inlineAssistIcon: 'wing',
    fontProfile: 'signature',
    customFontFamily: '',
  };
  let requestedFontFamilies = '';
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
    applyAssistFontStacks();
    applyLauncherIcon();
  }

  function assetUrl(path) {
    return browserApi.runtime.getURL(`${extensionRoot}${path}`);
  }

  function maskWith(element, path) {
    if (!element) return;
    const url = `url("${assetUrl(path)}")`;
    element.style.maskImage = url;
    element.style.webkitMaskImage = url;
  }

  // The circle takes the tone that stands out against the page under it: the backgrounds from that element
  // up to the first opaque one, see-through ones blended over what is under them.
  function pageToneBehind(element) {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const color = look?.parseCssColor?.(globalThis.getComputedStyle?.(node)?.backgroundColor);
      if (!color || !(color.a > 0)) continue;
      layers.push(color);
      if (color.a >= 1) break;
    }
    const colorScheme = globalThis.getComputedStyle?.(document.documentElement)?.getPropertyValue?.('color-scheme') || '';
    return look?.circleToneForBackground?.(look.blendSurface?.(layers, { colorScheme }) || null, { colorScheme }) || 'dark';
  }

  function applyLauncherIcon() {
    const icon = look?.normalizeInlineAssistIcon?.(assistSettings.inlineAssistIcon) || 'wing';
    const tone = target ? pageToneBehind(siteProfile?.placement?.anchorElement || target) : launcher.dataset.tone;
    launcher.dataset.icon = icon;
    launcher.dataset.tone = tone || 'dark';
    maskWith(launcher.querySelector('.launcher-logo'), look?.inlineAssistIconAsset?.(icon, launcher.dataset.tone) || 'assets/img/assist-wing.png');
    // The panel's own mark is a circle in the theme's ink: light on dark themes, dark on light ones.
    brandMark.dataset.icon = icon;
    maskWith(brandMark.querySelector('.brand-logo'), look?.inlineAssistIconAsset?.(icon, host.dataset.mode === 'light' ? 'dark' : 'light') || 'assets/img/assist-wing.png');
  }

  // The tone comes from what is under the circle once placed, since it usually sits beside the field: the
  // page under that point, not counting Assist itself. Without elementsFromPoint, the field's own surface.
  function surfaceToneAt(x, y, fallback) {
    const under = typeof document.elementsFromPoint === 'function'
      ? Array.from(document.elementsFromPoint(x, y) || []).find((element) => element !== host && !host.contains(element))
      : null;
    return pageToneBehind(under || fallback);
  }

  function setLauncherTone(tone) {
    const next = tone || 'dark';
    if (launcher.dataset.tone === next) return;
    launcher.dataset.tone = next;
    maskWith(launcher.querySelector('.launcher-logo'), look?.inlineAssistIconAsset?.(launcher.dataset.icon, next) || 'assets/img/assist-wing.png');
  }

  function applyAssistFontStacks() {
    const profile = appearancePreferences?.normalizeFontProfile?.(assistSettings.fontProfile, assistSettings.customFontFamily) || 'signature';
    const profileStack = appearancePreferences?.fontFamilyPreview?.(profile, assistSettings.customFontFamily) || '';
    const localFamily = profile === 'custom-local' ? appearancePreferences?.sanitizeLocalFontFamily?.(assistSettings.customFontFamily) || '' : '';
    const stacks = look?.inlineAssistFontStacks?.(profile, profileStack, fontName, { localFamily });
    if (!stacks) return null;
    panel.dataset.fontProfile = profile;
    fontStyle.textContent = `.launcher, .panel { --hb-font-ui: ${stacks.ui}; --hb-font-display: ${stacks.display}; --hermes-font-mono: ${stacks.mono}; --hb-display-scale: ${profile === 'signature' ? '1.3' : '1'}; font-family: var(--hb-font-ui); }`;
    return stacks;
  }

  // The faces arrive as bytes from the background (font files are never web-accessible) when the panel
  // first opens, and are registered under namespaced family names. If they never arrive, the stacks fall
  // through to the system fonts at their end.
  function requestAssistFonts() {
    const stacks = applyAssistFontStacks();
    registerLocalAssistFonts(stacks?.localFamilies);
    const key = stacks?.families?.join('|') || '';
    if (!key || key === requestedFontFamilies) return;
    requestedFontFamilies = key;
    Promise.resolve()
      .then(() => browserApi.runtime.sendMessage({ type: FONT_REQUEST, families: stacks.families }))
      .then((reply) => registerAssistFonts(reply?.fonts))
      .catch(() => {});
  }

  // A custom local font is read from the computer with local() under its random name, so a page that declares
  // @font-face with the same family name can neither replace it nor see which name Assist asks for.
  const registeredLocalFonts = new Set();
  function registerLocalAssistFonts(families) {
    if (!Array.isArray(families) || typeof globalThis.FontFace !== 'function' || !document.fonts?.add) return;
    for (const family of families) {
      if (registeredLocalFonts.has(family)) continue;
      registeredLocalFonts.add(family);
      try {
        const face = new globalThis.FontFace(fontName(`local:${family}`), `local(${JSON.stringify(family)})`);
        face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
      } catch {
        // Not installed or not readable: the stack falls through to the system fonts after it.
      }
    }
  }

  function registerAssistFonts(fonts) {
    if (!Array.isArray(fonts) || typeof globalThis.FontFace !== 'function' || !document.fonts?.add) return;
    for (const font of fonts) {
      try {
        const binary = atob(String(font.data || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const face = new globalThis.FontFace(fontName(String(font.family || '')), bytes.buffer, { weight: font.weight, style: font.style });
        face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
      } catch {
        // A face that will not load leaves the stack to fall through to the next family.
      }
    }
  }

  function setLauncherBusy(busy) {
    launcher.classList.toggle('busy', Boolean(busy));
  }

  // The user hid the circle on this site (by its adapter, or this hostname and its subdomains).
  function circleHiddenHere() {
    return Boolean(look?.isInlineAssistHiddenSite?.(location.hostname, siteProfile?.adapterId, hiddenSites));
  }

  function applyAssistSettings() {
    autoReplace = savedAutoReplace ?? (assistSettings.inlineAssistAutoReplace !== false);
    // An open panel shows the saved choice; the switch stays off where the editor cannot be written to.
    for (const toggle of panel.querySelectorAll('input.toggle[data-setting="auto-replace"]')) {
      if (!toggle.disabled) toggle.checked = autoReplace;
    }
    applyAssistAppearance();
    host.dataset.inlineAssistDefaultRoute = policy.normalizeRoutePreference?.(assistSettings.inlineAssistDefaultRoute) || 'ask';
    host.dataset.inlineAssistSessionRetention = String(assistSettings.inlineAssistSessionRetention || 'retain');
    if (assistSettings.inlineAssistEnabled === false || circleHiddenHere()) {
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
    const stored = await browserApi.storage.local.get(['hermesBrowserSettings', SITE_CONTEXT_STORAGE_KEY, AUTO_REPLACE_STORAGE_KEY, HIDDEN_SITES_STORAGE_KEY]).catch(() => ({}));
    assistSettings = { ...assistSettings, ...(stored?.hermesBrowserSettings || {}) };
    savedAutoReplace = typeof stored?.[AUTO_REPLACE_STORAGE_KEY] === 'boolean' ? stored[AUTO_REPLACE_STORAGE_KEY] : null;
    hiddenSites = look?.normalizeInlineAssistHiddenSites?.(stored?.[HIDDEN_SITES_STORAGE_KEY]) || [];
    siteContextPreferences = adapters?.normalizeInlineSiteContextPreferences?.(stored?.[SITE_CONTEXT_STORAGE_KEY]) || {};
    assistSettings.inlineAssistDefaultRoute = policy.normalizeRoutePreference?.(assistSettings.inlineAssistDefaultRoute) || 'ask';
    refreshSiteProfile();
    applyAssistSettings();
  }

  async function persistAutoReplace(enabled) {
    autoReplace = Boolean(enabled);
    savedAutoReplace = autoReplace;
    await browserApi.storage.local.set({ [AUTO_REPLACE_STORAGE_KEY]: autoReplace });
  }

  async function persistAssistSettings(patch) {
    const stored = await browserApi.storage.local.get('hermesBrowserSettings').catch(() => ({}));
    const next = { ...(stored?.hermesBrowserSettings || {}), ...patch };
    assistSettings = { ...assistSettings, ...next };
    await browserApi.storage.local.set({ hermesBrowserSettings: next });
  }

  async function persistDefaultRoute(route) {
    const stored = await browserApi.storage.local.get('hermesBrowserSettings').catch(() => ({}));
    const next = {
      ...(stored?.hermesBrowserSettings || {}),
      inlineAssistEnabled: assistSettings.inlineAssistEnabled !== false,
      inlineAssistDefaultRoute: policy.normalizeRoutePreference?.(route) || 'ask',
    };
    assistSettings = { ...assistSettings, ...next };
    await browserApi.storage.local.set({ hermesBrowserSettings: next });
  }

  async function persistSiteContextMode(adapterId, mode) {
    if (!adapterId || adapterId === 'generic' || !['draft', 'visible'].includes(mode)) return;
    siteContextPreferences = adapters?.normalizeInlineSiteContextPreferences?.({
      ...siteContextPreferences,
      [adapterId]: mode,
    }) || { ...siteContextPreferences, [adapterId]: mode };
    await browserApi.storage.local.set({ [SITE_CONTEXT_STORAGE_KEY]: siteContextPreferences });
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
    if (changes?.[AUTO_REPLACE_STORAGE_KEY]) {
      const value = changes[AUTO_REPLACE_STORAGE_KEY].newValue;
      savedAutoReplace = typeof value === 'boolean' ? value : null;
    }
    if (changes?.[HIDDEN_SITES_STORAGE_KEY]) hiddenSites = look?.normalizeInlineAssistHiddenSites?.(changes[HIDDEN_SITES_STORAGE_KEY].newValue) || [];
    if (changes?.[SITE_CONTEXT_STORAGE_KEY]) {
      siteContextPreferences = adapters?.normalizeInlineSiteContextPreferences?.(changes[SITE_CONTEXT_STORAGE_KEY].newValue) || {};
      refreshSiteProfile();
      if (!panel.hidden) renderAssist();
    }
    applyAssistSettings();
  }

  function onSystemThemeChanged() {
    if (assistSettings.colorMode === 'system') applyAssistAppearance();
    // A page that follows the system theme repaints behind the circle.
    position();
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
    include(profile?.placement?.slot?.element);
    include(profile?.placement?.slot?.rowElement);
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
    // Watch the whole composer when the circle sits beside one of its controls, so a re-rendered control
    // moves the circle with it.
    let composerRoot = profile?.placement?.slot?.element || null;
    while (composerRoot && !composerRoot.contains?.(target)) composerRoot = composerRoot.parentElement;
    const layoutRoot = composerRoot && composerRoot !== document.body && composerRoot !== document.documentElement
      ? composerRoot
      : (anchor || observed[observed.length - 1]);
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

  // The site's own control the circle sits beside (see site-adapters inlineSlot). A slot whose control
  // is gone, hidden or would put the circle on the text or a send button gives no placement, and the
  // caller falls back to the generic corner rule.
  function slotPlacement(slot, viewport, targetRect, obstacleRects) {
    if (!slot?.element?.isConnected || typeof policy.inlineSlotPlacement !== 'function') return null;
    const visibleRect = (element) => {
      const box = element?.isConnected ? element.getBoundingClientRect() : null;
      return box && box.width > 0 && box.height > 0 ? box : null;
    };
    const slotObstacles = Array.from(slot.obstacles || []).map(visibleRect).filter(Boolean);
    return policy.inlineSlotPlacement({
      strategy: slot.strategy,
      rect: visibleRect(slot.element),
      rowRect: visibleRect(slot.rowElement),
      gap: slot.gap,
      minGapBelow: slot.minGapBelow,
    }, viewport, { size: 24, targetRect, obstacleRects: [...obstacleRects, ...slotObstacles] });
  }

  function position() {
    // No field is targeted and nothing is showing: this runs for every scroll
    // event of every scroller on the page, so do not touch the DOM for it.
    if (!target && launcher.hidden && panel.hidden) return;
    if (!target || assistSettings.inlineAssistEnabled === false || circleHiddenHere()) {
      suspendPanelForScroll();
      return;
    }
    if (!isTargetVisible(target)) {
      suspendPanelForScroll();
      return;
    }
    let profile = siteProfile || refreshSiteProfile();
    // Sites re-render their composers (X swaps the avatar and toolbar nodes): a slot whose control left
    // the page is looked up again rather than dropped.
    if (profile?.placement?.slot?.element && !profile.placement.slot.element.isConnected) profile = refreshSiteProfile();
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
    const launcherPosition = slotPlacement(profile?.placement?.slot, viewport, targetRect, obstacleRects)
      || (typeof policy.inlineLauncherPlacement === 'function'
        ? policy.inlineLauncherPlacement(rect, viewport, {
          targetRect,
          obstacleRects,
          preferred: profile?.placement?.preferred || ['inside-end'],
          size: 24,
        })
        : policy.inlineLauncherPosition(rect, viewport, { launcherSize: 24 }));
    if (!launcherPosition) {
      suspendPanelForScroll();
      return;
    }
    resumePanelAfterScroll();
    launcher.hidden = false;
    launcher.dataset.placement = launcherPosition.strategy || 'inside-end';
    launcher.style.left = `${launcherPosition.left}px`;
    launcher.style.top = `${launcherPosition.top}px`;
    setLauncherTone(surfaceToneAt(launcherPosition.left + 12, launcherPosition.top + 12, anchor));
    if (!panel.hidden && panel.dataset.mode === 'bar') {
      // The quick menu's result bar sits just under the field (or just above it near the bottom).
      const safe = 8;
      const width = Math.min(Math.max(targetRect.width, 260), 560, viewportWidth - safe * 2);
      const barHeight = panel.getBoundingClientRect().height || 60;
      panel.style.width = `${width}px`;
      panel.style.maxHeight = '';
      panel.style.left = `${Math.max(safe, Math.min(viewportWidth - width - safe, targetRect.left))}px`;
      panel.style.top = `${targetRect.bottom + 8 + barHeight <= viewportHeight - safe ? targetRect.bottom + 8 : Math.max(safe, targetRect.top - 8 - barHeight)}px`;
    } else if (!panel.hidden) {
      // The panel opens right at the circle: just below it, lined up with its left edge, or just above it
      // when there is clearly more room there. It never jumps to a detached corner of the page.
      const safe = 8;
      const panelWidth = Math.min(panel.dataset.mode === 'quick' ? 290 : 380, viewportWidth - 20);
      panel.style.width = '';
      const panelHeight = Math.max(260, panel.getBoundingClientRect().height || 0);
      const circleTop = launcherPosition.top;
      const circleBottom = launcherPosition.top + 24;
      const roomBelow = viewportHeight - circleBottom - 8 - safe;
      const roomAbove = circleTop - 8 - safe;
      const below = roomBelow >= Math.min(panelHeight, 300) || roomBelow >= roomAbove;
      const room = below ? roomBelow : roomAbove;
      panel.style.maxHeight = `${Math.max(200, Math.min(680, room))}px`;
      panel.style.left = `${Math.max(safe, Math.min(viewportWidth - panelWidth - safe, launcherPosition.left))}px`;
      panel.style.top = `${below ? circleBottom + 8 : Math.max(safe, circleTop - 8 - Math.min(panelHeight, room))}px`;
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
    applyLauncherIcon();
    if (targetChanged) observeTargetLayout();
    else stabilizePosition(420);
    launcher.hidden = assistSettings.inlineAssistEnabled === false || circleHiddenHere() || !isTargetVisible(target);
    if (!launcher.hidden) position();
  }

  function setBody(...nodes) {
    body.replaceChildren(...nodes);
    renderFooter();
    position();
  }

  // The footer: where Assist runs, automatic replacement, the Assist model, and what Assist never does.
  // The route and auto-replace are the same saved settings as Settings → Hermes Assist; the model is
  // changed there.
  const ROUTE_LABELS = Object.freeze({ ask: 'Ask every time', current: 'Continue current chat', new: 'Start new Assist session', background: 'Run in background' });

  function currentRoutePreference() {
    return policy.normalizeRoutePreference?.(assistSettings.inlineAssistDefaultRoute) || 'ask';
  }

  function makeRouteSelect() {
    const routeSelect = make('select', 'route-select');
    routeSelect.setAttribute('aria-label', translateUiText('Where it runs'));
    for (const [value, label] of Object.entries(ROUTE_LABELS)) {
      const option = make('option', '', label);
      option.value = value;
      routeSelect.appendChild(option);
    }
    routeSelect.value = currentRoutePreference();
    routeSelect.addEventListener('change', trustedOnly(() => { persistDefaultRoute(routeSelect.value).catch(() => {}); }));
    return routeSelect;
  }

  function makeAutoReplaceToggle() {
    const supportsSafeApply = (siteProfile?.applyMode || 'safe-apply') !== 'copy-only';
    const toggle = make('input', 'toggle');
    toggle.type = 'checkbox';
    toggle.checked = supportsSafeApply && autoReplace;
    toggle.disabled = !supportsSafeApply;
    toggle.dataset.setting = 'auto-replace';
    toggle.addEventListener('change', trustedOnly(() => { persistAutoReplace(toggle.checked).catch(() => {}); }));
    return toggle;
  }

  function assistModelName() {
    return assistSettings.inlineAssistModel ? makeRaw('span', '', assistSettings.inlineAssistModel) : make('span', '', 'Same as chat');
  }

  function renderFooter() {
    const routeControl = make('label', 'foot-control');
    routeControl.append(make('em', '', 'Runs'), makeRouteSelect());
    const replaceControl = make('label', 'foot-control');
    replaceControl.append(make('em', '', 'Auto-replace'), makeAutoReplaceToggle());
    const modelControl = make('span', 'foot-control');
    modelControl.title = translateUiText('Change it in Settings → Hermes Assist');
    modelControl.append(make('em', '', 'Model'), assistModelName());
    footSafety.className = 'foot-safety';
    footSafety.textContent = translateUiText('Never posts or sends. Only this field changes.');
    foot.replaceChildren(routeControl, replaceControl, modelControl, footSafety);
  }

  // The quick menu: a small menu at the circle. One line to ask, the site's first four actions (1–4 run
  // them while the menu has focus), the instant tools, options, and a way to the full panel.
  function renderQuickMenu() {
    activeView = { name: 'quick', args: [] };
    panel.dataset.mode = 'quick';
    const profile = siteProfile || refreshSiteProfile();
    const askRow = make('div', 'quick-ask');
    const input = make('input', 'quick-input');
    input.type = 'text';
    input.placeholder = translateUiText('Ask Hermes…');
    input.setAttribute('aria-label', translateUiText('Ask Hermes'));
    input.addEventListener('keydown', trustedOnly((event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      const text = input.value.trim();
      if (text) beginAction({ id: 'custom', label: text.slice(0, 1000), detail: 'Custom instruction', mode: 'draft-copy-only' });
    }));
    askRow.append(input);
    const label = makeRaw('span', 'section-label quick-label', profile?.label || location.hostname.replace(/^www\./, ''));
    const list = make('div', 'quick-list');
    pageActions().slice(0, 4).forEach((action, index) => {
      const item = button('quick-item', '', action.label);
      item.dataset.actionId = action.id;
      const copy = make('span');
      copy.append(make('strong', '', action.label), make('small', '', action.detail || action.instruction || 'Use this field only'));
      item.append(makeRaw('span', 'quick-num', String(index + 1)), copy);
      item.addEventListener('click', trustedOnly(() => beginAction(action)));
      list.appendChild(item);
    });
    const tools = make('div', 'quick-tools');
    localActions.forEach((action) => {
      const chip = button('quick-chip', action.label);
      chip.addEventListener('click', trustedOnly(() => runLocalAction(action)));
      tools.appendChild(chip);
    });
    const gear = button('quick-options', '⚙', 'Assist options');
    gear.addEventListener('click', trustedOnly(renderQuickOptions));
    tools.appendChild(gear);
    const quickFoot = make('div', 'quick-foot');
    const summary = makeRaw('span', 'quick-summary', [
      translateUiText(profile?.contextMode === 'visible' ? 'Reads thread' : 'This field only'),
      translateUiText(ROUTE_LABELS[currentRoutePreference()]),
      assistSettings.inlineAssistModel || translateUiText('Same as chat'),
    ].join(' · '));
    const full = button('quick-full', 'Full panel →');
    full.addEventListener('click', trustedOnly(() => {
      panel.dataset.mode = 'full';
      renderAssist();
    }));
    quickFoot.append(summary, full);
    setBody(askRow, label, list, tools, quickFoot);
  }

  // Assist's options, reached from the quick menu's gear: the same saved settings as Settings → Hermes Assist.
  function renderQuickOptions() {
    activeView = { name: 'quick-options', args: [] };
    const profile = siteProfile || refreshSiteProfile();
    const back = button('quick-back', '', 'Back to the quick menu');
    back.append(makeRaw('span', '', '←'), make('span', '', 'Assist options'));
    back.addEventListener('click', trustedOnly(renderQuickMenu));
    const row = (title, detail, control) => {
      const node = make('label', 'quick-opt');
      const copy = make('span');
      copy.append(make('strong', '', title));
      if (detail) copy.append(detail instanceof globalThis.Node ? detail : make('small', '', detail));
      node.append(copy, control);
      return node;
    };
    const rows = [];
    if (profile?.contextPolicy?.userConfigurable) {
      const contextToggle = make('input', 'toggle');
      contextToggle.type = 'checkbox';
      contextToggle.checked = profile.contextMode === 'visible';
      contextToggle.addEventListener('change', trustedOnly(() => {
        void persistSiteContextMode(profile.adapterId, contextToggle.checked ? 'visible' : 'draft');
      }));
      rows.push(row('Read the visible thread', 'Off: this field only', contextToggle));
    }
    rows.push(row('Where it runs', '', makeRouteSelect()));
    const model = make('span', 'foot-control');
    model.append(assistModelName());
    rows.push(row('Model', 'Change it in Settings → Hermes Assist', model));
    rows.push(row('Replace text automatically', 'Undo is always one click away', makeAutoReplaceToggle()));
    const keepChats = make('input', 'toggle');
    keepChats.type = 'checkbox';
    keepChats.checked = assistSettings.inlineAssistSessionRetention !== 'delete';
    keepChats.addEventListener('change', trustedOnly(() => {
      persistAssistSettings({ inlineAssistSessionRetention: keepChats.checked ? 'keep' : 'delete' }).catch(() => {});
    }));
    rows.push(row('Keep Assist chats', 'Kept under Inline assist in your history', keepChats));
    // Hides the circle on this site: by the adapter when the site has one (every hostname of it), else by
    // this hostname and its subdomains. Settings → Hermes Assist → Sites turns it back on.
    const hideSite = make('input', 'toggle');
    hideSite.type = 'checkbox';
    hideSite.dataset.setting = 'hide-site';
    hideSite.addEventListener('change', trustedOnly(() => {
      if (!hideSite.checked) return;
      const site = profile?.adapterId && profile.adapterId !== 'generic' ? profile.adapterId : location.hostname.replace(/^www\./, '');
      hiddenSites = look?.normalizeInlineAssistHiddenSites?.([...hiddenSites, site]) || [site];
      browserApi.storage.local.set({ [HIDDEN_SITES_STORAGE_KEY]: hiddenSites }).catch(() => {});
      launcher.hidden = true;
      hidePanel();
    }));
    rows.push(row('Hide the circle on this site', 'Turn it back on in Settings → Hermes Assist', hideSite));
    setBody(back, ...rows);
  }

  // The quick menu's result: a slim bar under the field. When the draft was written into the field it
  // offers Keep and Undo; when it could not be (or auto-replace is off) it previews the draft with Copy first.
  function renderResultBar({ fieldChanged = false } = {}) {
    activeView = { name: 'bar', args: [{ fieldChanged }] };
    panel.dataset.mode = 'bar';
    panel.hidden = false;
    const bar = make('div', 'bar');
    bar.append(make('strong', 'bar-title', appliedAutomatically ? 'Draft in place' : (fieldChanged ? 'Field changed · review required' : 'Draft ready')));
    if (!appliedAutomatically) bar.append(makeRaw('div', 'bar-preview', resultText || translateUiText('(empty draft)')));
    const actions = make('div', 'bar-actions');
    const add = (label, handler, { main = false, disabled = false } = {}) => {
      const item = button(main ? 'main' : '', label);
      item.disabled = disabled;
      item.addEventListener('click', trustedOnly(handler));
      actions.appendChild(item);
    };
    if (appliedAutomatically) {
      add('Keep', () => {
        hidePanel();
        pending = null;
        resetResult();
      }, { main: true });
      add('Undo', undoResult, { disabled: !applyReceipt });
    } else {
      add('Copy', copyResult, { main: true });
    }
    add('Again', tryAgain, { disabled: !lastRunAction });
    if (applyReceipt) add('Shorter', makeShorter);
    if (appliedAutomatically) add('Copy', copyResult);
    if (!appliedAutomatically) {
      add('Full panel', () => {
        panel.dataset.mode = 'full';
        renderResult({ fieldChanged });
      });
    }
    if (resultSessionId) {
      add('Open session', () => {
        panel.dataset.mode = 'full';
        renderOpenSessionChoices();
      });
    }
    bar.append(actions);
    setBody(bar);
  }

  function renderAssist() {
    activeView = { name: 'assist', args: [] };
    const profile = siteProfile || refreshSiteProfile();
    const contextText = boundedContextForTarget();
    const usesVisibleContext = profile?.contextMode === 'visible';
    contextDetail.textContent = translateUiText(currentContextLabel());
    contextState.textContent = translateUiText(usesVisibleContext ? 'BOUNDED' : 'DRAFT ONLY');
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
      contextToggle.setAttribute('aria-label', translateUiText(`Use visible ${profile.label} context`));
      contextToggle.addEventListener('change', trustedOnly(() => {
        void persistSiteContextMode(profile.adapterId, contextToggle.checked ? 'visible' : 'draft');
      }));
      contextSetting.append(contextCopy, contextToggle);
      nodes.push(contextSetting);
      if (usesVisibleContext && profile.contextPolicy.warning) nodes.push(make('p', 'privacy', profile.contextPolicy.warning));
    }

    const label = make('span', 'section-label', `What should Hermes do on ${profile?.label || 'this site'}?`);
    const actionsNode = make('div', 'actions');
    // Up to four actions in the grid; the rest wait behind More actions.
    const actionButtons = pageActions().map((action, index) => {
      const actionButton = button(`action${index === 0 ? ' primary' : ''}`, action.label);
      actionButton.dataset.actionId = action.id;
      actionButton.appendChild(make('small', '', action.detail || action.instruction || 'Use this field only'));
      actionButton.addEventListener('click', trustedOnly(() => beginAction(action)));
      actionButton.hidden = index >= 4;
      actionsNode.appendChild(actionButton);
      return actionButton;
    });
    const moreActions = actionButtons.length > 4 ? button('more-actions', 'More actions') : null;
    moreActions?.addEventListener('click', trustedOnly(() => {
      const showing = moreActions.dataset.expanded === 'true';
      actionButtons.forEach((item, index) => { item.hidden = showing && index >= 4; });
      moreActions.dataset.expanded = String(!showing);
      moreActions.textContent = translateUiText(showing ? 'More actions' : 'Fewer actions');
    }));
    const localLabel = make('span', 'section-label', 'Instant tools · no model call');
    const localNode = make('div', 'local-actions');
    localActions.forEach((action) => {
      const actionButton = button('action', action.label);
      actionButton.dataset.actionId = action.id;
      actionButton.appendChild(make('small', '', action.detail));
      actionButton.addEventListener('click', trustedOnly(() => runLocalAction(action)));
      localNode.appendChild(actionButton);
    });
    const customLabel = make('span', 'section-label', 'Or tell Hermes exactly what you need');
    const customRow = make('div', 'custom-row');
    const custom = make('textarea', 'custom');
    custom.placeholder = translateUiText('Make this more confident without sounding aggressive…');
    custom.setAttribute('aria-label', translateUiText('Custom Hermes Assist instruction'));
    const customGo = button('custom-go', 'Ask Hermes');
    const submitCustom = () => {
      const text = custom.value.trim();
      if (!text) return custom.focus();
      beginAction({ id: 'custom', label: text.slice(0, 1000), detail: 'Custom instruction', mode: 'draft-copy-only' });
    };
    custom.addEventListener('keydown', trustedOnly((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        submitCustom();
      }
    }));
    customGo.addEventListener('click', trustedOnly(submitCustom));
    customRow.append(custom, customGo);
    nodes.push(label, actionsNode);
    if (moreActions) nodes.push(moreActions);
    nodes.push(localLabel, localNode, customLabel, customRow);
    setBody(...nodes);
  }

  async function beginAction(action) {
    if (!target) return;
    pendingAction = action;
    const status = await browserApi.runtime.sendMessage({ type: SESSION_STATUS }).catch(() => null);
    const decision = policy.routeDecision?.({
      preference: assistSettings.inlineAssistDefaultRoute,
      hasActiveSession: Boolean(status?.hasActiveSession),
    }) || 'ask';
    if (decision === 'ask') renderRouting(status || {});
    else requestDraft(action, decision);
  }

  function renderRouting(session = {}) {
    activeView = { name: 'routing', args: [session] };
    contextDetail.textContent = translateUiText(session.hasActiveSession
      ? `Active chat · ${Number(session.messageCount || 0) || 'existing'} messages`
      : 'No active chat');
    contextState.textContent = translateUiText('CHOOSE');
    contextState.className = '';
    const title = make('h2', 'route-title', 'Where should Hermes work?');
    const note = make('p', 'note', 'Hermes will never replace or switch an existing conversation without this choice.');
    const routes = [
      { num: '01', route: policy.routes.CURRENT, title: 'Continue current chat', detail: session.hasActiveSession ? `Add this request to “${session.title || 'current chat'}”.` : 'No active chat is available.', disabled: !session.hasActiveSession },
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
      routeButton.addEventListener('click', trustedOnly(async () => {
        if (rememberRoute) await persistDefaultRoute(route.route);
        await requestDraft(pendingAction, route.route);
      }));
      return routeButton;
    });
    const rememberSetting = make('label', 'setting');
    const rememberCopy = make('span');
    rememberCopy.append(make('strong', '', 'Use this choice next time'), make('br'), make('small', '', 'You can change it anytime in Settings → Hermes Assist.'));
    const rememberToggle = make('input', 'toggle');
    rememberToggle.type = 'checkbox';
    rememberToggle.checked = rememberRoute;
    rememberToggle.addEventListener('change', trustedOnly(() => { rememberRoute = rememberToggle.checked; }));
    rememberSetting.append(rememberCopy, rememberToggle);
    const privacy = make('p', 'privacy');
    privacy.append('Background runs stay in session history under ', make('strong', '', 'Inline assist'), '. They receive this bounded field snapshot—not other form values.');
    setBody(title, note, ...routeNodes, rememberSetting, privacy);
  }

  async function requestDraft(action, route) {
    if (!target || !action) return;
    lastRunAction = action;
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
      if (built.reason === 'sensitive-content') return renderFailure('Hermes blocked this field because it appears to contain sensitive content.');
      // Improve, Shorten, Fix grammar and Change tone rewrite the field's text; only the Draft actions start from nothing.
      if (built.reason === 'empty-draft') return renderFailure(`${translateUiText(action.label)} works on what is already in the field. Type something first, or pick a Draft action to start from nothing.`);
      return renderFailure('This field is not eligible for inline drafting.');
    }
    pending = { ...built.request, applyMode: supportsSafeApply ? 'safe-apply' : 'copy-only' };
    resetResult();
    setLauncherBusy(true);
    renderWorking();
    const response = await browserApi.runtime.sendMessage({ type: REQUEST, request: pending }).catch((error) => ({ ok: false, reason: error?.message }));
    if (!response?.ok) renderFailure(response?.reason || 'Hermes could not queue this draft.');
  }

  function renderWorking() {
    // From the quick menu the draft is written into the field when it is ready: the menu steps aside and
    // the circle's ring shows the run.
    if (panel.dataset.mode === 'quick') {
      hidePanel();
      return;
    }
    activeView = { name: 'working', args: [] };
    contextState.textContent = translateUiText('WORKING');
    const wrap = make('div', 'working');
    const mark = make('i', 'working-mark');
    const title = make('h2', 'route-title', 'Hermes is drafting');
    const copy = make('p', 'status', pending?.route === policy.routes.BACKGROUND ? 'Your current conversation stays visible.' : 'This request is bound to the selected session.');
    wrap.append(mark, title, copy);
    setBody(wrap);
  }

  function renderFailure(reason) {
    setLauncherBusy(false);
    // A run from the quick menu hid the menu while it ran: its failure shows in the bar under the field.
    if (panel.hidden && panel.dataset.mode === 'quick') return renderFailureBar(reason);
    activeView = { name: 'failure', args: [reason] };
    contextState.textContent = translateUiText('BLOCKED');
    const title = make('h2', 'route-title', 'Assist could not run');
    const detail = make('p', 'status', reason || 'Hermes could not create this draft.');
    const back = button('action', 'Back to actions');
    back.addEventListener('click', trustedOnly(renderAssist));
    setBody(title, detail, back);
  }

  function renderFailureBar(reason) {
    activeView = { name: 'failure-bar', args: [reason] };
    panel.dataset.mode = 'bar';
    panel.hidden = false;
    const bar = make('div', 'bar');
    bar.append(make('strong', 'bar-title', 'Assist could not run'), make('div', 'bar-preview', reason || 'Hermes could not create this draft.'));
    const actions = make('div', 'bar-actions');
    const again = button('main', 'Try again');
    again.addEventListener('click', trustedOnly(() => {
      panel.dataset.mode = 'quick';
      hidePanel();
      tryAgain();
    }));
    const dismiss = button('', 'Close');
    dismiss.addEventListener('click', trustedOnly(hidePanel));
    actions.append(again, dismiss);
    bar.append(actions);
    setBody(bar);
    position();
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
    setLauncherBusy(false);
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
    if (panel.dataset.mode === 'quick' || panel.dataset.mode === 'bar') return renderResultBar({ fieldChanged });
    activeView = { name: 'result', args: [{ fieldChanged, noModel }] };
    const actionLabel = pending?.actionId === 'custom'
      ? pending.actionLabel
      : translateUiText(pending?.actionLabel || 'Result');
    contextDetail.textContent = `${translateUiText(noModel ? 'Local utility' : 'Inline assist')} · ${actionLabel}`;
    contextState.textContent = translateUiText('COMPLETE');
    contextState.className = 'secure';
    const copyOnly = pending?.applyMode === 'copy-only';
    const success = make('div', 'success');
    success.append(make('i'), make('span', '', copyOnly
      ? 'Draft ready · this managed editor stays untouched'
      : (appliedAutomatically ? 'Replaced the original field safely' : (fieldChanged ? 'Field changed · review required' : 'Draft ready for review'))));
    const card = make('div', 'run-card');
    const row = make('div', 'run-row');
    row.append(make('span', '', 'Session'), makeRaw('strong', '', resultSessionTitle || translateUiText('Inline assist')));
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
    const preview = makeRaw('div', 'preview', resultText || translateUiText('(empty draft)'));
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
    keep.addEventListener('click', trustedOnly(applyResult));
    undo.addEventListener('click', trustedOnly(undoResult));
    copyButton.addEventListener('click', trustedOnly(copyResult));
    open.addEventListener('click', trustedOnly(renderOpenSessionChoices));
    actions.append(keep, undo, copyButton);
    if (resultSessionId) actions.append(open);
    // Try again always; Shorter once the draft is in the field, since it shortens what the field holds.
    const followUps = make('div', 'result-actions follow-ups');
    const again = button('', 'Try again');
    again.disabled = !lastRunAction;
    again.addEventListener('click', trustedOnly(tryAgain));
    followUps.append(again);
    if (applyReceipt) {
      const shorter = button('', 'Shorter');
      shorter.addEventListener('click', trustedOnly(makeShorter));
      followUps.append(shorter);
    }
    setBody(success, card, label, preview, actions, followUps);
  }

  // Run the same action again from the text the user had: an applied draft is undone first.
  function tryAgain() {
    const action = lastRunAction;
    if (!action) return undefined;
    if (applyReceipt) {
      const undone = policy.undoResult(target, applyReceipt);
      if (!undone.ok) return renderFailure('Undo was blocked because the field changed after the replacement.');
      applyReceipt = null;
      appliedAutomatically = false;
    }
    return action.local ? runLocalAction(action) : beginAction(action);
  }

  // Shorten the draft that is now in the field (offered only once it was applied there).
  function makeShorter() {
    const shorten = genericActions.find((item) => item.id === 'shorten');
    applyReceipt = null;
    appliedAutomatically = false;
    if (shorten) beginAction(shorten);
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
      contextDetail.textContent = translateUiText('Copied result to clipboard');
    } catch {
      contextDetail.textContent = translateUiText('Copy blocked · select preview manually');
    }
  }

  function renderOpenSessionChoices() {
    if (!resultSessionId) return;
    activeView = { name: 'open-session', args: [] };
    contextState.textContent = translateUiText('CHOOSE');
    contextState.className = '';
    const title = make('h2', 'route-title', 'Where should this session open?');
    const note = make('p', 'note', 'Open the retained Assist session in the extension side panel or in Hermes Web.');
    const options = [
      { num: '01', surface: 'sidepanel', title: 'Browser Extension', detail: 'Open the exact session in the Hermes Browser Extension side panel.', recommended: true },
      { num: '02', surface: 'web', title: 'Hermes Web', detail: 'Open the Hermes Web app in a new browser tab.' },
    ].map((option) => {
      const routeButton = button(`route${option.recommended ? ' recommended' : ''}`, '');
      routeButton.dataset.sessionSurface = option.surface;
      const copy = make('span');
      copy.append(make('strong', '', option.title), make('small', '', option.detail));
      routeButton.append(make('span', 'route-num', option.num), copy, make('span', 'arrow', '→'));
      routeButton.addEventListener('click', trustedOnly(() => {
        openResultSession(option.surface);
      }));
      return routeButton;
    });
    const back = button('action', 'Back to result');
    back.addEventListener('click', trustedOnly(() => renderResult()));
    setBody(title, note, ...options, back);
  }

  async function openResultSession(surface = 'sidepanel') {
    if (!resultSessionId) return;
    const response = await browserApi.runtime.sendMessage({
      type: OPEN_SESSION,
      sessionId: resultSessionId,
      surface: surface === 'web' ? 'web' : 'sidepanel',
    }).catch((error) => ({ ok: false, reason: error?.message || String(error) }));
    if (!response?.ok) {
      if (response?.webapp) renderWebappUnavailable(response);
      else renderFailure(response?.reason || 'Hermes could not open that retained session.');
      return;
    }
    if (surface === 'web' && response.hint) {
      renderWebappOpened(response.hint);
      return;
    }
    hidePanel();
    pending = null;
    resetResult();
  }

  // Hermes Web is the Webapp the user's own gateway serves. When it cannot be opened the
  // background says why; the commands are the same three the side panel's dialog offers.
  function renderWebappUnavailable(response) {
    activeView = { name: 'webapp-unavailable', args: [response] };
    contextState.textContent = translateUiText('BLOCKED');
    const reasons = {
      'needs-address': 'This connection is remote, so there is no address to try. Enter the Hermes Web address in Settings.',
      'invalid-address': 'The Hermes Web address in Settings is not a valid http or https address.',
      'permission-denied': 'The browser did not allow the Hermes Browser Extension to reach this address:',
      unreachable: 'Nothing answered at this address:',
    };
    const nodes = [
      make('h2', 'route-title', 'Hermes Web is not available'),
      make('p', 'note', 'Your gateway serves Hermes Web once it is turned on. On the computer that runs Hermes, run these commands.'),
      make('p', 'note', reasons[response?.webapp] || reasons.unreachable),
    ];
    if (response?.address && ['unreachable', 'permission-denied'].includes(response.webapp)) {
      nodes.push(makeRaw('div', 'preview', String(response.address)));
    }
    nodes.push(makeRaw('div', 'preview', ['hermes config set webapp.enabled true', 'hermes gateway restart', 'hermes webapp'].join('\n')));
    const back = button('action', 'Back to result');
    back.addEventListener('click', trustedOnly(() => renderResult()));
    setBody(...nodes, back);
  }

  function renderWebappOpened(hint) {
    activeView = { name: 'webapp-opened', args: [hint] };
    contextState.textContent = translateUiText('COMPLETE');
    const done = button('action', 'Close');
    done.addEventListener('click', trustedOnly(() => {
      hidePanel();
      pending = null;
      resetResult();
    }));
    setBody(
      make('h2', 'route-title', 'Hermes Web opened'),
      make('p', 'note', hint === 'signed-in'
        ? 'Hermes Web opened, already signed in.'
        : hint === 'local-kept'
          ? 'Hermes Web opened. On this computer, run hermes webapp once to sign in. After that, the Hermes Browser Extension keeps this browser signed in until you close it.'
          : hint === 'local'
            ? 'Hermes Web opened. On this computer, run hermes webapp once to sign in. The tab stays signed in.'
            : 'Hermes Web opened. Sign in on that page with your dashboard account.'),
      done,
    );
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
    if (event.isTrusted !== true) return;
    if (event.key === 'Escape') hidePanel();
  }

  function containAssistInteraction(event) {
    event.stopPropagation();
  }

  function onLauncherPointerDown(event) {
    if (event.isTrusted !== true) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      target?.focus?.({ preventScroll: true });
    } catch {
      target?.focus?.();
    }
  }

  function togglePanel(event) {
    if (event.isTrusted !== true) return;
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
    // A run still out is dropped here (its result is ignored), so its ring stops with it.
    pending = null;
    setLauncherBusy(false);
    panel.hidden = false;
    requestAssistFonts();
    if ((look?.normalizeInlineAssistOpenMode?.(assistSettings.inlineAssistOpenMode) || 'panel') === 'quick') {
      renderQuickMenu();
    } else {
      panel.dataset.mode = 'full';
      renderAssist();
    }
    position();
  }

  function applyLocalizedFrame() {
    launcher.setAttribute('aria-label', translateUiText('Open Hermes Assist'));
    panel.setAttribute('aria-label', translateUiText('Hermes Assist'));
    for (const mark of [launcher.querySelector('.launcher-logo'), brandMark.querySelector('.brand-logo')]) {
      mark?.setAttribute('aria-label', translateUiText('Hermes Browser Extension'));
    }
    brandKicker.textContent = translateUiText('Hermes Browser');
    brandTitle.textContent = translateUiText('Hermes Assist');
    close.setAttribute('aria-label', translateUiText('Close Hermes Assist'));
    footSafety.textContent = translateUiText('Never posts or sends. Only this field changes.');
  }

  function rerenderLocalizedView() {
    applyLocalizedFrame();
    if (panel.hidden) return;
    if (activeView.name === 'routing') renderRouting(...activeView.args);
    else if (activeView.name === 'working') renderWorking();
    else if (activeView.name === 'failure') renderFailure(...activeView.args);
    else if (activeView.name === 'result') renderResult(...activeView.args);
    else if (activeView.name === 'open-session') renderOpenSessionChoices();
    else if (activeView.name === 'webapp-unavailable') renderWebappUnavailable(...activeView.args);
    else if (activeView.name === 'webapp-opened') renderWebappOpened(...activeView.args);
    else renderAssist();
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
  // 1–4 run the quick menu's actions, only while the menu itself has focus (never inside the ask line,
  // and never as page-level shortcuts).
  panel.addEventListener('keydown', trustedOnly((event) => {
    if (panel.dataset.mode !== 'quick' || activeView.name !== 'quick') return;
    if (event.target?.matches?.('input, textarea, select') || !/^[1-4]$/.test(event.key)) return;
    const item = body.querySelectorAll('.quick-item')[Number(event.key) - 1];
    const action = item && pageActions().find((candidate) => candidate.id === item.dataset.actionId);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    beginAction(action);
  }));
  close.addEventListener('click', trustedOnly(hidePanel));
  browserApi.runtime.onMessage.addListener(onResult);
  browserApi.storage.onChanged.addListener(onStorageChanged);
  const unsubscribeI18n = i18n.subscribe(rerenderLocalizedView);
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
    browserApi.runtime.onMessage.removeListener(onResult);
    browserApi.storage.onChanged.removeListener(onStorageChanged);
    unsubscribeI18n();
    systemThemeQuery?.removeEventListener?.('change', onSystemThemeChanged);
    host.remove();
  };
})();
