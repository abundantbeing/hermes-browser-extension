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
  const overlayScrollbar = globalThis.HermesOverlayScrollbar;
  if (!policy?.classifyEditable || !policy?.buildInlineDraftRequest || !policy?.applyResult || !appearance?.resolveInlineAssistTheme || !i18n?.ready) return;
  await i18n.ready;
  if (globalThis.__HERMES_INLINE_HELPER_GENERATION__ !== generation) return;
  const translateUiText = (value) => i18n.translateText(value);

  const PAGE_CONTEXT_CHARS = 12_000;
  const REQUEST = 'HERMES_INLINE_DRAFT_REQUEST';
  const RESULT = 'HERMES_INLINE_DRAFT_RESULT';
  const SESSION_STATUS = 'HERMES_INLINE_SESSION_STATUS';
  const OPEN_SESSION = 'HERMES_INLINE_OPEN_SESSION';
  const CONTEXT_ACTION = 'HERMES_INLINE_CONTEXT_ACTION';
  const FONT_REQUEST = 'HERMES_INLINE_FONT_REQUEST';
  const MODELS_REQUEST = 'HERMES_INLINE_ASSIST_MODELS';
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
  // Longer, the pair of Shorter after a draft: Hermes expands the draft in the field.
  const expandAction = { id: 'expand', label: 'Expand', mode: 'draft-copy-only' };

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

  // pixelarticons settings-cog, as the side panel's Settings button draws it.
  function settingsCog() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.icon = 'settings-cog';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 20h3v-2h4v4h2v-4h4v2h-2v4H9v-4H7v2H2v-5h2v3Zm18 2h-5v-2h3v-3h2v5ZM6 11H2v2h4v4H4v-2H0V9h4V7h2v4Zm14-2h4v6h-4v2h-2v-4h4v-2h-4V7h2v2Zm-6 7h-4v-2h4v2Zm-4-2H8v-4h2v4Zm6 0h-2v-4h2v4Zm-2-4h-4V8h4v2ZM7 4H4v3H2V2h5v2Zm8 0h2V2h5v5h-2V4h-3v2h-4V2h-2v4H7V4h2V0h6v4Z');
    svg.append(path);
    return svg;
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
    .launcher-logo { display:block; mask-position:center; mask-size:contain; mask-repeat:no-repeat; -webkit-mask-position:center; -webkit-mask-size:contain; -webkit-mask-repeat:no-repeat; }
    .launcher-logo { width:18px; height:18px; background:var(--hx-glyph,#f4f4f1); }
    .launcher[data-icon="girl"] .launcher-logo { border-radius:50%; mask-size:cover; -webkit-mask-size:cover; }
    .launcher[data-icon="girl"] .launcher-logo { width:22px; height:22px; }
    /* A size smaller where a site's row is tight (LinkedIn's comment pill). */
    .launcher[data-size="small"] { width:20px; height:20px; }
    .launcher[data-size="small"] .launcher-logo { width:15px; height:15px; }
    .launcher[data-size="small"][data-icon="girl"] .launcher-logo { width:18px; height:18px; }
    .launcher[hidden], .panel[hidden] { display:none; }
    .panel { position:fixed; z-index:1; width:min(380px,calc(100vw - 20px)); max-height:min(680px,calc(100vh - 20px)); overflow:auto; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); pointer-events:auto; box-shadow:0 18px 50px rgba(0,0,0,.32), 0 0 0 1px color-mix(in srgb,var(--hb-blue) 14%,transparent); }
    /* The panel, the result preview and the dropdown lists float the branded thumb over their content
       (lib/overlay-scrollbar.mjs): no strip is kept beside a search box or a row. The instruction box is a
       textarea, which cannot hold the thumb, so it keeps the canonical sharp bar, with no strip reserved. */
    .custom::-webkit-scrollbar { width:8px; }
    .custom::-webkit-scrollbar-thumb { background:rgba(var(--hermes-fg-rgb),0.45); border:1px solid var(--hermes-line-strong); }
    .head { display:grid; grid-template-columns:46px minmax(0,1fr) auto 32px; gap:11px; align-items:center; padding:11px 12px 11px 14px; border-bottom:1px solid var(--hb-line); }
    .brand-wing { display:block; width:46px; height:20px; background:var(--hb-blue); mask-position:left center; mask-size:contain; mask-repeat:no-repeat; -webkit-mask-position:left center; -webkit-mask-size:contain; -webkit-mask-repeat:no-repeat; }
    .head-copy { min-width:0; }
    .head-detail { display:block; margin-top:4px; overflow:hidden; color:var(--hb-muted); font-size:calc(10px * var(--hermes-text-zoom, 1)); white-space:nowrap; text-overflow:ellipsis; }
    .head-state { color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); font-weight:700; letter-spacing:.12em; text-transform:uppercase; white-space:nowrap; }
    .section-label { display:block; color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); letter-spacing:.16em; text-transform:uppercase; }
    .title { display:block; font-family:var(--hb-font-display); font-size:calc(20px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); line-height:1; color:var(--hb-blue); }
    .close { width:32px; height:32px; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font-size:calc(20px * var(--hermes-text-zoom, 1)); line-height:1; display:grid; place-items:center; transition:background 120ms ease,border-color 120ms ease,color 120ms ease; }
    .close:hover, .close:focus-visible { background:var(--hb-blue); color:var(--hb-paper); border-color:var(--hb-blue); outline:2px solid var(--hb-blue); outline-offset:2px; }
    .secure { color:var(--hb-blue); font-weight:800; }
    .body { display:flex; flex-direction:column; gap:11px; padding:12px; }
    .note, .status, .privacy, .run-copy { margin:0; color:var(--hb-muted); font-size:calc(11px * var(--hermes-text-zoom, 1)); line-height:1.45; }
    .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-top:1px solid var(--hb-line); border-left:1px solid var(--hb-line); }
    .action { min-height:58px; padding:9px; border:0; border-right:1px solid var(--hb-line); border-bottom:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; text-align:left; font-family:var(--hb-font-display); font-size:calc(13px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); font-weight:700; }
    .action.primary { background:var(--hb-blue); color:var(--hb-paper); }
    .action small { display:block; margin-top:3px; color:var(--hb-muted); font-family:var(--hb-font-ui); font-size:calc(9px * var(--hermes-text-zoom, 1)); font-weight:400; line-height:1.3; }
    .action.primary small { color:color-mix(in srgb,var(--hb-paper) 74%,transparent); }
    .action:hover, .action:focus-visible, .route:hover, .route:focus-visible, .result-actions button:hover, .result-actions button:focus-visible { outline:2px solid var(--hb-blue); outline-offset:-2px; }
    .local-actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(0,1fr)); gap:7px; }
    .local-actions .action { min-height:0; padding:5px 11px; border:1px solid var(--hb-line); background:var(--hb-soft); text-align:center; font-family:var(--hb-font-ui); font-size:calc(11.5px * var(--hermes-text-zoom, 1)); font-weight:600; text-transform:none; letter-spacing:normal; }
    .local-actions .action small { display:none; }
    .more-actions { justify-self:start; padding:4px 0; border:0; background:transparent; color:var(--hb-muted); cursor:pointer; font-size:calc(10.5px * var(--hermes-text-zoom, 1)); text-decoration:underline; }
    .action[hidden] { display:none; }
    .custom { display:block; width:100%; height:34px; min-height:34px; max-height:96px; resize:none; overflow-y:auto; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); padding:8px 9px; font:calc(11px * var(--hermes-text-zoom, 1))/1.4 var(--hb-font-ui); }
    .custom:focus-visible { outline:2px solid var(--hb-blue); outline-offset:-2px; }
    .custom-row { display:grid; grid-template-columns:1fr auto; gap:7px; align-items:start; }
    .custom-go { min-width:76px; min-height:34px; height:34px; padding:0 12px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-blue); color:var(--hb-paper); cursor:pointer; font-size:calc(11px * var(--hermes-text-zoom, 1)); font-weight:700; }
    .sheet-nav { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .sheet-back { display:inline-flex; align-items:center; gap:6px; min-height:28px; padding:4px 10px 4px 8px; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font:600 calc(11px * var(--hermes-text-zoom, 1))/1.2 var(--hb-font-ui); }
    .sheet-close { display:grid; place-items:center; width:28px; height:28px; padding:0; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font-size:calc(18px * var(--hermes-text-zoom, 1)); line-height:1; }
    .sheet-back:hover, .sheet-back:focus-visible, .sheet-close:hover, .sheet-close:focus-visible { outline:none; border-color:var(--hb-accent); background:var(--hb-soft); }
    .route-title { margin:0; color:var(--hb-blue); font-family:var(--hb-font-display); font-size:calc(20px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); line-height:1.05; }
    .route { display:grid; grid-template-columns:42px 1fr 18px; gap:9px; align-items:center; width:100%; padding:11px; border:1px solid var(--hb-line); border-radius:0; background:var(--hb-paper); color:var(--hb-blue); cursor:pointer; text-align:left; }
    .route.recommended { border:2px solid var(--hb-blue); background:var(--hb-soft); }
    .route:disabled { cursor:not-allowed; opacity:.45; }
    .route-num { font-family:var(--hb-font-display); font-size:calc(20px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); font-weight:700; }
    .route strong { font-family:var(--hb-font-display); font-size:calc(13px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); }
    .route small { display:block; margin-top:3px; color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); line-height:1.35; }
    .route .tag { display:block; margin-top:4px; color:var(--hb-blue); font-size:calc(8px * var(--hermes-text-zoom, 1)); letter-spacing:.11em; text-transform:uppercase; }
    .arrow { font-size:calc(18px * var(--hermes-text-zoom, 1)); }
    .context-peek-wrap { display:flex; flex-direction:column; gap:6px; margin-top:-4px; }
    .context-peek { align-self:flex-start; padding:2px 0; border:0; background:transparent; color:var(--hb-muted); cursor:pointer; font-size:calc(10.5px * var(--hermes-text-zoom, 1)); text-decoration:underline; }
    .context-peek:hover, .context-peek:focus-visible { color:var(--hb-blue); outline:none; }
    .context-preview { border:1px solid var(--hb-line); padding:8px 9px; font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
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
    /* Two columns of buttons never leave a hole: an odd last one takes the whole row. */
    .result-actions > button:last-child:nth-child(odd) { grid-column:1 / -1; }
    .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid var(--hb-line); padding:9px; color:var(--hb-blue); font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .setting small { color:var(--hb-muted); }
    .toggle { appearance:none; width:34px; height:18px; margin:0; border:1px solid var(--hb-blue); background:var(--hb-paper); position:relative; cursor:pointer; }
    .toggle:checked { background:var(--hb-blue); }
    .toggle::after { content:""; position:absolute; width:12px; height:12px; left:2px; top:2px; background:var(--hb-blue); transition:left 120ms ease,background 120ms ease; }
    .toggle:checked::after { left:18px; background:var(--hb-paper); }
    .foot { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; padding:10px 12px; border-top:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); }
    .foot-control { display:grid; gap:4px; align-content:start; min-width:0; padding:6px 8px; border:1px solid var(--hb-line); color:var(--hb-blue); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); white-space:nowrap; }
    .foot-control em { font-style:normal; color:var(--hb-muted); font-size:calc(9px * var(--hermes-text-zoom, 1)); letter-spacing:.12em; text-transform:uppercase; }
    .dd { position:relative; display:inline-block; min-width:0; }
    .dd-button { display:inline-flex; align-items:center; gap:6px; max-width:100%; min-height:0; padding:2px 4px; border:0; background:transparent; color:var(--hb-blue); font:inherit; text-align:left; cursor:pointer; }
    .dd-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .dd-chevron { flex:none; width:6px; height:6px; margin-top:-3px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(45deg); }
    .dd-button[aria-expanded="true"] .dd-chevron { margin-top:3px; transform:rotate(225deg); }
    .dd-button:focus-visible { outline:2px solid var(--hb-accent); outline-offset:1px; }
    .dd-list { position:absolute; z-index:6; right:0; bottom:calc(100% + 6px); display:flex; flex-direction:column; min-width:max(100%, 190px); max-width:280px; max-height:240px; overflow:auto; border:1px solid var(--hb-line); background:var(--hb-paper); box-shadow:0 8px 24px rgba(0,0,0,.35); }
    .dd-list[hidden] { display:none; }
    .quick-opt .dd-list { top:calc(100% + 6px); bottom:auto; }
    .foot .dd-list { left:0; right:auto; }
    .dd-option { flex:none; display:grid; gap:2px; min-height:0; padding:7px 10px; border:0; border-top:1px solid var(--hb-line); background:transparent; color:var(--hb-blue); font:inherit; text-align:left; white-space:normal; cursor:pointer; }
    .dd-option:first-of-type, .dd-note + .dd-option { border-top:0; }
    .dd-option strong { font-weight:600; }
    .dd-option small { color:var(--hb-muted); font-size:calc(9.5px * var(--hermes-text-zoom, 1)); }
    .dd-option:hover, .dd-option:focus-visible { outline:none; background:var(--hb-soft); }
    .dd-option[aria-selected="true"] { box-shadow:inset 3px 0 0 var(--hb-accent); background:var(--hb-soft); }
    .failure-detail { margin:0; overflow-wrap:anywhere; line-height:1.45; }
    .failure-back { align-self:flex-start; min-height:0; padding:7px 12px; border:1px solid var(--hb-line); background:transparent; color:var(--hb-blue); font:600 calc(11px * var(--hermes-text-zoom, 1))/1.2 var(--hb-font-ui); cursor:pointer; }
    .failure-back:hover, .failure-back:focus-visible { outline:none; border-color:var(--hb-accent); background:var(--hb-soft); }
    .dd-search { flex:none; position:sticky; top:0; z-index:1; width:100%; box-sizing:border-box; margin:0; padding:7px 10px; border:0; border-bottom:1px solid var(--hb-line); background:var(--hb-paper); color:var(--hb-blue); font:inherit; outline:none; }
    .dd-search:focus-visible { box-shadow:inset 0 0 0 2px var(--hb-accent); }
    .dd-option[hidden] { display:none; }
    .dd-note { flex:none; margin:0; padding:8px 10px; color:var(--hb-muted); font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .foot-safety { grid-column:1 / -1; font-size:calc(10px * var(--hermes-text-zoom, 1)); }
    .foot-control .dd { display:block; width:100%; }
    .foot-control .dd-button { width:100%; justify-content:space-between; padding:2px 0; }
    .foot-replace { cursor:pointer; }
    .foot-value { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
    .foot-value .toggle { order:2; flex:none; }
    .foot-state { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .foot-value .toggle:checked ~ .foot-state-off, .foot-value .toggle:not(:checked) ~ .foot-state-on { display:none; }
    .foot-value .toggle:disabled ~ .foot-state { color:var(--hb-muted); }
    .foot-control .effort { width:100%; }
    .effort { --effort-progress:0; display:inline-flex; align-items:center; gap:8px; min-width:0; }
    .effort-opt .effort { flex:1; max-width:200px; }
    .effort-track { position:relative; flex:1; min-width:96px; height:22px; }
    .effort.compact .effort-track { flex:1; min-width:0; }
    .effort-lane { position:absolute; top:8px; bottom:8px; left:5px; right:5px; border:1px solid var(--hb-line); background:color-mix(in srgb,var(--hb-blue) 7%,transparent); pointer-events:none; }
    .effort-fill { position:absolute; inset:0; background:color-mix(in srgb,var(--hb-blue) 22%,transparent); transform:scaleX(var(--effort-progress)); transform-origin:left center; transition:transform 160ms cubic-bezier(.2,.8,.2,1); }
    .effort-stop { position:absolute; top:50%; left:clamp(1px,var(--effort-stop),calc(100% - 1px)); width:3px; height:3px; background:color-mix(in srgb,var(--hb-blue) 55%,transparent); transform:translate(-50%,-50%); }
    .effort-stop[data-reached="true"] { background:var(--hb-blue); }
    .effort-range { position:relative; display:block; width:100%; height:22px; margin:0; padding:0; border:0; border-radius:0; background:transparent; appearance:none; -webkit-appearance:none; cursor:ew-resize; touch-action:pan-y; }
    .effort-range:focus-visible { outline:2px solid var(--hb-accent); outline-offset:1px; }
    .effort-range::-webkit-slider-runnable-track { height:22px; border:0; background:transparent; }
    .effort-range::-webkit-slider-thumb { -webkit-appearance:none; width:10px; height:18px; margin-top:2px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-blue); box-shadow:0 0 0 2px var(--hb-paper); }
    .effort-range::-moz-range-track { height:22px; border:0; background:transparent; }
    .effort-range::-moz-range-progress { background:transparent; }
    .effort-range::-moz-range-thumb { width:8px; height:16px; border:1px solid var(--hb-blue); border-radius:0; background:var(--hb-blue); box-shadow:0 0 0 2px var(--hb-paper); }
    .effort-value { min-width:58px; color:var(--hb-blue); font-weight:600; white-space:nowrap; }
    .panel[data-font-profile="signature"] .title, .panel[data-font-profile="signature"] .route-title, .panel[data-font-profile="signature"] .run-title, .panel[data-font-profile="signature"] .action, .panel[data-font-profile="signature"] .route strong, .panel[data-font-profile="signature"] .result-actions button { text-transform:uppercase; font-weight:500; letter-spacing:.02em; }
    .panel[data-font-profile="signature"] .action small, .panel[data-font-profile="signature"] .route small { text-transform:none; letter-spacing:normal; }
    .panel[data-mode="quick"] { width:min(290px,calc(100vw - 20px)); }
    .panel[data-mode="quick"] .head, .panel[data-mode="quick"] .foot, .panel[data-mode="bar"] .head, .panel[data-mode="bar"] .foot { display:none; }
    .panel[data-mode="quick"] .body, .panel[data-mode="bar"] .body { padding:0; gap:0; }
    .panel[data-mode="quick"]:not([data-view="quick"]):not([data-view="quick-options"]) .body { padding:12px; gap:11px; }
    .panel[data-mode="bar"] { max-height:none; overflow:visible; }
    .quick-ask { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--hb-line); }
    .quick-input { flex:1; min-width:0; border:0; background:transparent; color:var(--hb-blue); font:calc(12.5px * var(--hermes-text-zoom, 1))/1.3 var(--hb-font-ui); outline:none; }
    .quick-input::placeholder { color:var(--hb-muted); }
    .quick-close { display:grid; place-items:center; flex:none; width:22px; height:22px; padding:0; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-muted); cursor:pointer; font-size:calc(15px * var(--hermes-text-zoom, 1)); line-height:1; }
    .quick-close:hover, .quick-close:focus-visible { color:var(--hb-blue); border-color:var(--hb-accent); outline:none; }
    .pop-ghost { position:fixed; z-index:1; box-sizing:border-box; pointer-events:none; border:1px solid var(--hb-blue); background:var(--hb-paper); box-shadow:0 18px 50px rgba(0,0,0,.32); }
    .quick-label { padding:9px 12px 4px; }
    .quick-list { display:grid; }
    .quick-item { display:grid; grid-template-columns:20px 1fr; gap:10px; align-items:center; padding:8px 12px; border:0; background:transparent; color:var(--hb-blue); text-align:left; cursor:pointer; font-family:var(--hb-font-ui); }
    .quick-item:hover, .quick-item:focus-visible { background:var(--hb-soft); outline:none; }
    .quick-num { width:18px; height:18px; display:grid; place-items:center; border:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .quick-item strong { display:block; font-size:calc(13px * var(--hermes-text-zoom, 1)); font-weight:600; }
    .quick-item small { display:block; color:var(--hb-muted); font-size:calc(11px * var(--hermes-text-zoom, 1)); }
    .quick-tools { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 12px; border-top:1px solid var(--hb-line); }
    .quick-chip { padding:3px 9px; border:1px solid var(--hb-line); border-radius:999px; background:transparent; color:var(--hb-blue); cursor:pointer; font:600 calc(10.5px * var(--hermes-text-zoom, 1))/1.3 var(--hb-font-ui); }
    .quick-options { display:grid; place-items:center; padding:0; margin-left:auto; width:26px; height:26px; border:1px solid var(--hb-line); border-radius:50%; background:transparent; color:var(--hb-blue); cursor:pointer; }
    .quick-foot { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:7px 12px; border-top:1px solid var(--hb-line); color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .quick-full { border:0; padding:0; background:transparent; color:var(--hb-blue); cursor:pointer; font:inherit; white-space:nowrap; }
    .quick-back { display:flex; align-items:center; gap:8px; width:100%; padding:9px 12px; border:0; border-bottom:1px solid var(--hb-line); background:transparent; color:var(--hb-blue); cursor:pointer; text-align:left; font-family:var(--hb-font-display); font-size:calc(17px * var(--hermes-text-zoom, 1) * var(--hb-display-scale, 1)); }
    .quick-opt { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--hb-line); color:var(--hb-blue); font-size:calc(12px * var(--hermes-text-zoom, 1)); }
    .quick-opt small { display:block; color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .bar { display:grid; color:var(--hb-blue); font-size:calc(12px * var(--hermes-text-zoom, 1)); }
    .bar-head { display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--hb-line); }
    .bar-name { display:flex; align-items:center; gap:8px; min-width:0; }
    .bar-mark { flex:none; width:16px; height:16px; background:var(--hb-blue); mask-position:center; mask-size:contain; mask-repeat:no-repeat; -webkit-mask-position:center; -webkit-mask-size:contain; -webkit-mask-repeat:no-repeat; }
    .bar-mark[data-icon="girl"] { width:18px; height:18px; border-radius:50%; mask-size:cover; -webkit-mask-size:cover; }
    .bar-title { font-weight:700; font-size:calc(13px * var(--hermes-text-zoom, 1)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .bar-return { display:inline-flex; align-items:center; gap:5px; margin-left:auto; padding:2px 0; border:0; background:transparent; color:var(--hb-muted); cursor:pointer; font:600 calc(11px * var(--hermes-text-zoom, 1))/1.3 var(--hb-font-ui); white-space:nowrap; }
    .bar-return:hover, .bar-return:focus-visible { color:var(--hb-blue); outline:none; text-decoration:underline; }
    .bar-note { margin:0; padding:8px 12px 0; color:var(--hb-muted); font-size:calc(10.5px * var(--hermes-text-zoom, 1)); }
    .bar-preview { margin:0; padding:9px 12px 0; max-height:calc(4.6em + 9px); overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; color:var(--hb-blue); }
    .bar-actions { display:grid; gap:8px; padding:10px 12px 12px; }
    .bar-main { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .bar-main button { height:32px; padding:0 10px; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font:700 calc(12px * var(--hermes-text-zoom, 1))/1 var(--hb-font-ui); }
    .bar-main button.main { border-color:var(--hb-blue); background:var(--hb-blue); color:var(--hb-paper); }
    .bar-tools { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
    .bar-tools button { min-height:28px; min-width:0; padding:5px 6px; border:1px solid var(--hb-line); border-radius:0; background:transparent; color:var(--hb-blue); cursor:pointer; font:600 calc(11px * var(--hermes-text-zoom, 1))/1.25 var(--hb-font-ui); overflow-wrap:anywhere; }
    .bar-tools > button:last-child:nth-child(odd) { grid-column:1 / -1; }
    .bar-main button:hover, .bar-main button:focus-visible, .bar-tools button:hover, .bar-tools button:focus-visible { outline:none; background:var(--hb-soft); }
    .bar-main button.main:hover, .bar-main button.main:focus-visible { background:var(--hb-blue); box-shadow:inset 0 0 0 2px var(--hb-paper); }
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
  const brandWing = logo('brand-wing');
  const brandCopy = make('div', 'head-copy');
  const brandTitle = make('strong', 'title', 'Hermes Assist');
  const contextDetail = make('span', 'head-detail', 'Focused draft');
  brandCopy.append(brandTitle, contextDetail);
  const contextState = make('span', 'head-state secure', 'PRIVATE');
  const close = button('close', '×', 'Close Hermes Assist');
  head.append(brandWing, brandCopy, contextState, close);
  const body = make('div', 'body');
  const foot = make('footer', 'foot');
  const footSafety = make('span', 'foot-safety', 'Never posts or sends. Only this field changes.');
  foot.append(footSafety);
  panel.append(head, body, foot);
  overlayScrollbar?.attachOverlayScrollbar(panel);
  // Above the circle the panel is placed by its height, which settles after it opens (fonts, late rows).
  const panelResizeObserver = typeof globalThis.ResizeObserver === 'function'
    ? new globalThis.ResizeObserver(() => { if (!panel.hidden) schedulePosition(); })
    : null;
  panelResizeObserver?.observe(panel);
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
  const overlayStyle = make('style', 'overlay-scrollbar');
  overlayStyle.textContent = overlayScrollbar?.css || '';
  shadow.append(style, overlayStyle, fontStyle, launcher, panel);
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
  let pendingField = null;
  let handledResultRequestId = '';
  let resultText = '';
  let resultSessionId = '';
  let resultSessionTitle = '';
  let resultModelNotice = '';
  let resultContextWithheld = false;
  let applyReceipt = null;
  let autoReplace = true;
  let appliedAutomatically = false;
  let rememberRoute = false;
  let activeView = { name: 'assist', args: [] };
  // Where the chooser's Back goes (the screen and mode it was opened from), and what runs once a place is
  // picked (Again undoes the draft in the field only then).
  let routingBack = null;
  let pendingPrepare = null;
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
    maskWith(brandWing, 'assets/img/hermes-wing-mark.svg');
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
    for (const slider of panel.querySelectorAll('.effort[data-setting="effort"]')) slider.refreshEffort?.();
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

  // What Hermes gets from the page, as the panel shows it: the thread, with any secret the page quotes taken out.
  function boundedContext({ explicitGenericCapture = false } = {}) {
    if (!target) return { text: '', messages: 0 };
    const profile = siteProfile || refreshSiteProfile();
    const captureProfile = explicitGenericCapture && profile?.adapterId === 'generic'
      ? { ...profile, contextMode: 'visible' }
      : profile;
    const captured = adapters?.inlineSiteContext?.(document, target, captureProfile)
      || { text: String(adapters?.captureInlineSiteContext?.(document, target, captureProfile) || ''), messages: 0 };
    const redacted = extractor?.redactSensitiveTextWithCount?.(captured.text)?.text ?? captured.text;
    return { text: String(policy.withoutSecretText?.(redacted) ?? redacted).slice(0, PAGE_CONTEXT_CHARS), messages: captured.messages || 0 };
  }

  function contextSummary({ text, messages }, site) {
    const template = messages > 1
      ? 'Reads {count} messages · {chars} characters · saved for {site}'
      : messages === 1
        ? 'Reads 1 message · {chars} characters · saved for {site}'
        : 'Reads {chars} characters around the field · saved for {site}';
    return translateUiText(template).replace('{count}', String(messages)).replace('{chars}', String(text.length)).replace('{site}', site);
  }

  function contextPeek(text) {
    const wrap = make('div', 'context-peek-wrap');
    const toggle = button('context-peek', 'See what Hermes reads');
    toggle.setAttribute('aria-expanded', 'false');
    let shown = null;
    toggle.addEventListener('click', trustedOnly(() => {
      if (shown) {
        shown.remove();
        shown = null;
      } else {
        shown = makeRaw('div', 'preview context-preview', text);
        wrap.append(shown);
        overlayScrollbar?.attachOverlayScrollbar(shown, { watchResize: false });
      }
      toggle.textContent = translateUiText(shown ? 'Hide what Hermes reads' : 'See what Hermes reads');
      toggle.setAttribute('aria-expanded', String(Boolean(shown)));
    }));
    wrap.append(toggle);
    return wrap;
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

  function slotSearchRoot(field) {
    const boundary = field.closest?.('[role="dialog"], [data-testid="cellInnerDiv"], article, form');
    if (boundary) return boundary;
    let node = field;
    for (let depth = 0; depth < 12 && node.parentElement && node.parentElement !== document.body; depth += 1) node = node.parentElement;
    return node;
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
    for (const slot of placementSlots(profile)) {
      include(slot?.element);
      include(slot?.rowElement);
    }
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
    let composerRoot = placementSlots(profile)[0]?.element || null;
    while (composerRoot && !composerRoot.contains?.(target)) composerRoot = composerRoot.parentElement;
    const usable = (element) => element && element !== document.body && element !== document.documentElement;
    // A site that draws its composer's buttons a moment after focus (X, or any other site) has no slot yet:
    // the area around the field is watched until it has one, so the circle moves there before any typing.
    const awaitingSlot = !usable(composerRoot);
    const layoutRoot = usable(composerRoot)
      ? composerRoot
      : (awaitingSlot ? slotSearchRoot(target) : (anchor || observed[observed.length - 1]));
    if (layoutRoot && typeof MutationObserver === 'function') {
      // On any other site the watched area can be most of the page: a late toolbar arrives as added
      // or unhidden nodes, so only those are watched there, and the site is read again once per frame.
      const genericWait = awaitingSlot && (!profile?.adapterId || profile.adapterId === 'generic');
      let queued = 0;
      const observer = new MutationObserver(() => {
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          if (targetMutationObserver !== observer) return;
          refreshSiteProfile();
          if (awaitingSlot && placementSlots(siteProfile).length) {
            observeTargetLayout();
            return;
          }
          schedulePosition();
          stabilizePosition(240);
        });
      });
      targetMutationObserver = observer;
      observer.observe(layoutRoot, genericWait
        ? { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] }
        : { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'aria-label'] });
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
  // The site's slots, tried in order: the first that fits takes the circle, at its size (smaller where the
  // site's row is tight). A slot among buttons that sit inside the field's own box may overlap the field.
  function slotPlacement(slots, viewport, targetRect, obstacleRects) {
    if (typeof policy.inlineSlotPlacement !== 'function') return null;
    const visibleRect = (element) => {
      const box = element?.isConnected ? element.getBoundingClientRect() : null;
      return box && box.width > 0 && box.height > 0 ? box : null;
    };
    const iconRect = (element) => {
      for (const icon of element?.querySelectorAll?.('svg, img') || []) {
        const box = visibleRect(icon);
        if (box) return box;
      }
      return null;
    };
    for (const slot of slots || []) {
      if (!slot?.element?.isConnected) continue;
      const size = Number(slot.size) || 24;
      const slotObstacles = Array.from(slot.obstacles || []).map(visibleRect).filter(Boolean);
      const placed = policy.inlineSlotPlacement({
        strategy: slot.strategy,
        rect: visibleRect(slot.element),
        rowRect: visibleRect(slot.rowElement),
        levelRect: iconRect(slot.element),
        gap: slot.gap,
        minGapBelow: slot.minGapBelow,
      }, viewport, { size, targetRect: slot.overField ? null : targetRect, obstacleRects: [...obstacleRects, ...slotObstacles] });
      if (placed) return { ...placed, size };
    }
    return null;
  }

  function placementSlots(profile) {
    const placement = profile?.placement;
    return placement?.slots || (placement?.slot ? [placement.slot] : []);
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
    if (placementSlots(profile).some((slot) => slot?.element && !slot.element.isConnected)) profile = refreshSiteProfile();
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
    const launcherPosition = slotPlacement(placementSlots(profile), viewport, targetRect, obstacleRects)
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
    const circle = Number(launcherPosition.size) || 24;
    launcher.hidden = false;
    launcher.dataset.placement = launcherPosition.strategy || 'inside-end';
    if (circle < 24) launcher.dataset.size = 'small';
    else delete launcher.dataset.size;
    launcher.style.left = `${launcherPosition.left}px`;
    launcher.style.top = `${launcherPosition.top}px`;
    setLauncherTone(surfaceToneAt(launcherPosition.left + circle / 2, launcherPosition.top + circle / 2, anchor));
    if (!panel.hidden && panel.dataset.mode === 'bar') {
      // The quick menu's result bar: under the field, clear of the circle and of the site's own controls.
      // The bar is placed by its full content height at its final width, never by a height an earlier
      // placement capped it to, or it would grow back and be capped again on every resize.
      const circleRect = { top: launcherPosition.top, left: launcherPosition.left, width: circle, height: circle };
      const windowSize = { width: viewportWidth, height: viewportHeight };
      const scrolled = panel.scrollTop;
      panel.style.width = `${policy.inlineResultBarPlacement(targetRect, circleRect, windowSize, { obstacles: obstacleRects }).width}px`;
      panel.style.maxHeight = '';
      panel.style.overflowY = '';
      const bar = policy.inlineResultBarPlacement(targetRect, circleRect, windowSize, { barHeight: panel.getBoundingClientRect().height || 60, obstacles: obstacleRects });
      panel.style.width = `${bar.width}px`;
      panel.style.maxHeight = bar.maxHeight ? `${bar.maxHeight}px` : '';
      panel.style.overflowY = bar.maxHeight ? 'auto' : '';
      panel.scrollTop = scrolled;
      panel.style.left = `${bar.left}px`;
      panel.style.top = `${bar.top}px`;
    } else if (!panel.hidden) {
      // The panel opens right at the circle: just below it, lined up with its left edge, or just above it
      // when there is clearly more room there. It never jumps to a detached corner of the page.
      const safe = 8;
      const panelWidth = Math.min(panel.dataset.mode === 'quick' ? 290 : 380, viewportWidth - 20);
      panel.style.width = '';
      const panelHeight = Math.max(260, panel.getBoundingClientRect().height || 0);
      const circleTop = launcherPosition.top;
      const circleBottom = launcherPosition.top + circle;
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
    resultContextWithheld = false;
    applyReceipt = null;
    appliedAutomatically = false;
  }

  // Opening and closing pop like a bubble from the circle: a widening or shrinking circle, in pixel dither
  // steps between sparse dots and solid. Closing leaves a shell that vanishes while the panel itself closes
  // at once, so nothing waits on it. None of it runs when reduced motion is asked for.
  const POP_OPEN_MS = 200;
  const POP_CLOSE_MS = 160;
  const DITHER_SPARSE = 'conic-gradient(#000 0 25%, transparent 0 100%)';
  const DITHER_HALF = 'repeating-conic-gradient(#000 0 25%, transparent 0 50%)';
  const DITHER_DENSE = 'conic-gradient(transparent 0 25%, #000 0 100%)';

  function popAllowed() {
    return typeof panel.animate === 'function' && globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches !== true;
  }

  function popFrames(box, steps) {
    const circle = launcher.hidden ? null : launcher.getBoundingClientRect();
    const x = Math.round(circle ? circle.left + circle.width / 2 - box.left : 0);
    const y = Math.round(circle ? circle.top + circle.height / 2 - box.top : 0);
    const reach = Math.ceil(Math.max(...[[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([cx, cy]) => Math.hypot(cx - x, cy - y))));
    const at = (radius) => `circle(${radius}px at ${x}px ${y}px)`;
    const dither = (image) => ({ maskImage: image, webkitMaskImage: image, maskSize: '4px 4px', webkitMaskSize: '4px 4px' });
    return steps.map(([offset, radius, image]) => ({ offset, ...(radius === null ? {} : { clipPath: at(radius === 'reach' ? reach : radius) }), ...dither(image) }));
  }

  function popOpen() {
    if (!popAllowed() || panel.hidden) return;
    const box = panel.getBoundingClientRect();
    if (!box.width || !box.height) return;
    panel.animate(popFrames(box, [[0, 12, DITHER_SPARSE], [0.35, null, DITHER_HALF], [0.65, null, DITHER_DENSE], [1, 'reach', 'none']]), { duration: POP_OPEN_MS, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function popClose() {
    if (!popAllowed() || panel.hidden) return;
    const box = panel.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const shell = make('div', 'pop-ghost');
    Object.assign(shell.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    shadow.append(shell);
    const done = () => shell.remove();
    const animation = shell.animate(popFrames(box, [[0, 'reach', DITHER_DENSE], [0.4, null, DITHER_HALF], [1, 12, DITHER_SPARSE]]), { duration: POP_CLOSE_MS, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' });
    animation.onfinish = done;
    animation.oncancel = done;
    setTimeout(done, POP_CLOSE_MS + 200);
  }

  function hidePanel() {
    popClose();
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
    // Which screen shows: the quick menu and its options lay themselves out, every other screen keeps the
    // panel's padding even when it opened from the quick menu.
    panel.dataset.view = activeView?.name || '';
    body.replaceChildren(...nodes);
    renderFooter();
    position();
  }

  // The footer: where Assist runs, automatic replacement, the Assist model, and what Assist never does.
  // The route, auto-replace and model are the same saved settings as Settings → Hermes Assist.
  const ROUTE_LABELS = Object.freeze({ ask: 'Ask every time', current: 'Continue current chat', new: 'Start new Assist session', background: 'Run in background' });

  function currentRoutePreference() {
    return policy.normalizeRoutePreference?.(assistSettings.inlineAssistDefaultRoute) || 'ask';
  }

  // The one Assist dropdown that is open, so Escape can close it before closing Assist.
  let closeOpenDropdown = null;

  // Assist's own dropdown, in the panel's look instead of the browser's select list. `loadOptions` (async)
  // fills it each time it opens; `onPick` saves a choice and returns false when it did not take.
  function makeDropdown({ setting, label, value, valueLabel, options = [], loadOptions = null, onPick }) {
    const box = make('span', 'dd');
    box.dataset.setting = setting;
    const trigger = button('dd-button', '', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const shown = makeRaw('span', 'dd-value', valueLabel || value || '');
    trigger.append(shown, make('i', 'dd-chevron'));
    const list = make('div', 'dd-list');
    const listScroll = overlayScrollbar?.attachOverlayScrollbar(list, { watchResize: false });
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', translateUiText(label));
    list.hidden = true;
    let current = value;
    let choices = options;
    const close = ({ focus = false } = {}) => {
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (closeOpenDropdown === close) closeOpenDropdown = null;
      if (focus) trigger.focus();
    };
    const fill = (items, note = '') => {
      list.replaceChildren();
      if (note) list.append(make('p', 'dd-note', note));
      // A long list (the models) gets a search box that narrows it as you type.
      if (items.length > 8) {
        const search = make('input', 'dd-search');
        search.type = 'search';
        search.placeholder = translateUiText('Search');
        search.setAttribute('aria-label', translateUiText('Search'));
        search.addEventListener('input', trustedOnly(() => {
          const query = search.value.trim().toLowerCase();
          for (const option of list.querySelectorAll('[role="option"]')) option.hidden = Boolean(query) && !option.textContent.toLowerCase().includes(query);
        }));
        list.append(search);
      }
      for (const item of items) {
        const option = button('dd-option', '', item.label);
        option.setAttribute('role', 'option');
        option.dataset.value = item.value;
        option.setAttribute('aria-selected', String(item.value === current));
        option.append(makeRaw('strong', '', translateUiText(item.label)));
        if (item.detail) option.append(makeRaw('small', '', item.detail));
        option.addEventListener('click', trustedOnly(async () => {
          const taken = await onPick(item);
          if (taken === false) return;
          current = item.value;
          shown.textContent = translateUiText(item.label);
          close({ focus: true });
        }));
        list.append(option);
      }
      listScroll?.refresh();
    };
    const open = async () => {
      closeOpenDropdown?.();
      fill(choices, loadOptions ? translateUiText('Loading…') : '');
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      closeOpenDropdown = close;
      if (loadOptions) {
        const loaded = await loadOptions().catch(() => null);
        if (list.hidden) return;
        if (loaded?.items?.length) {
          choices = loaded.items;
          if (loaded.current) current = loaded.current;
          fill(choices);
        } else fill([], loaded?.note || translateUiText('No models yet. Open the side panel once so Hermes can list them.'));
      }
      (list.querySelector('input.dd-search') || list.querySelector('[aria-selected="true"]') || list.querySelector('[role="option"]'))?.focus();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    };
    trigger.addEventListener('click', trustedOnly(() => (list.hidden ? open() : close())));
    box.addEventListener('keydown', trustedOnly((event) => {
      const items = [...list.querySelectorAll('[role="option"]')];
      const at = items.indexOf(shadow.activeElement ?? event.target);
      if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close({ focus: true });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (list.hidden) return void open();
        const shownItems = items.filter((item) => !item.hidden);
        const from = shownItems.indexOf(items[at]);
        const next = from < 0
          ? shownItems[event.key === 'ArrowDown' ? 0 : shownItems.length - 1]
          : shownItems[(from + (event.key === 'ArrowDown' ? 1 : shownItems.length - 1)) % Math.max(shownItems.length, 1)];
        next?.focus();
      } else if (event.key === 'Tab' && !list.hidden) close();
    }));
    box.addEventListener('focusout', (event) => {
      if (!list.hidden && !box.contains(event.relatedTarget)) close();
    });
    box.append(trigger, list);
    return box;
  }

  function makeRouteSelect() {
    const value = currentRoutePreference();
    return makeDropdown({
      setting: 'route',
      label: 'Where it runs',
      value,
      valueLabel: translateUiText(ROUTE_LABELS[value]),
      options: Object.entries(ROUTE_LABELS).map(([key, text]) => ({ value: key, label: text })),
      onPick: (item) => persistDefaultRoute(item.value).catch(() => false),
    });
  }

  // The model Assist runs on: the models the side panel verified for this connection, changed right here.
  function makeModelSelect() {
    const value = String(assistSettings.inlineAssistModel || '');
    let listed = [];
    const toItem = (model) => ({ value: model.id, label: model.label || model.rawModelId || model.id, detail: model.providerLabel || model.provider || '' });
    return makeDropdown({
      setting: 'model',
      label: 'Model',
      value,
      valueLabel: value ? String(assistSettings.inlineAssistRawModel || value) : translateUiText('Same as chat'),
      loadOptions: async () => {
        const reply = await browserApi.runtime.sendMessage({ type: MODELS_REQUEST });
        if (!reply?.ok) return { items: [], note: reply?.reason || '' };
        listed = reply.models || [];
        return { items: listed.map(toItem), current: reply.selectedId || value };
      },
      onPick: async (item) => {
        const model = listed.find((entry) => entry.id === item.value);
        if (!model) return false;
        await persistAssistSettings({ inlineAssistModel: model.id, inlineAssistRawModel: model.rawModelId || model.id, inlineAssistProvider: model.provider || '' });
        return true;
      },
    });
  }

  // The reasoning effort Assist runs with, on the side panel's slider: one step per level, the level shown
  // while it moves, saved when it is let go. It is Assist's own setting, like the model above it.
  function makeEffortSlider({ compact = false } = {}) {
    const efforts = look?.efforts || [];
    const last = Math.max(efforts.length - 1, 1);
    const wrap = make('span', `effort${compact ? ' compact' : ''}`);
    wrap.dataset.setting = 'effort';
    const track = make('span', 'effort-track');
    const lane = make('span', 'effort-lane');
    lane.setAttribute('aria-hidden', 'true');
    lane.append(make('span', 'effort-fill'));
    const stops = efforts.map((_, index) => {
      const stop = make('i', 'effort-stop');
      stop.style.setProperty('--effort-stop', `${index / last * 100}%`);
      lane.append(stop);
      return stop;
    });
    const range = make('input', 'effort-range');
    range.type = 'range';
    range.min = '0';
    range.max = String(efforts.length - 1);
    range.step = '1';
    range.setAttribute('aria-label', translateUiText('Reasoning effort'));
    range.title = translateUiText('Higher effort can take more time and tokens.');
    track.append(lane, range);
    const shown = make('strong', 'effort-value');
    let committed = look?.inlineAssistEffortIndex?.(assistSettings.inlineAssistReasoningEffort) ?? 1;
    const show = (index) => {
      const step = Math.max(0, Math.min(efforts.length - 1, Math.round(Number(index) || 0)));
      const label = translateUiText(efforts[step]?.label || '');
      range.value = String(step);
      range.setAttribute('aria-valuetext', label);
      shown.textContent = label;
      wrap.style.setProperty('--effort-progress', String(step / last));
      wrap.dataset.effortValue = efforts[step]?.value || '';
      stops.forEach((stop, position) => { stop.dataset.reached = String(position <= step); });
    };
    range.addEventListener('input', trustedOnly(() => show(range.value)));
    range.addEventListener('change', trustedOnly(() => {
      const step = Number(range.value);
      if (step === committed || !efforts[step]) return;
      committed = step;
      show(step);
      persistAssistSettings({ inlineAssistReasoningEffort: efforts[step].value, inlineAssistThinkingEnabled: true }).catch(() => {});
    }));
    // A change saved elsewhere (Settings, another tab) moves the slider, unless it is being dragged.
    wrap.refreshEffort = () => {
      if (shadow.activeElement === range) return;
      committed = look?.inlineAssistEffortIndex?.(assistSettings.inlineAssistReasoningEffort) ?? 1;
      show(committed);
    };
    show(committed);
    wrap.append(track, shown);
    return wrap;
  }

  // The model and effort Assist runs with, as one line: the model's own name, not its provider key.
  function assistModelSummary() {
    const model = String(assistSettings.inlineAssistRawModel || assistSettings.inlineAssistModel || '') || translateUiText('Same as chat');
    const effort = look?.efforts?.[look?.inlineAssistEffortIndex?.(assistSettings.inlineAssistReasoningEffort) ?? 1];
    return effort ? `${model} · ${translateUiText(effort.label)}` : model;
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

  function renderFooter() {
    const routeControl = make('span', 'foot-control');
    routeControl.append(make('em', '', 'Runs'), makeRouteSelect());
    const replaceValue = make('span', 'foot-value');
    replaceValue.append(makeAutoReplaceToggle(), make('span', 'foot-state foot-state-on', 'Replaces the text'), make('span', 'foot-state foot-state-off', 'Shows a preview'));
    const replaceControl = make('label', 'foot-control foot-replace');
    replaceControl.append(make('em', '', 'Auto-replace'), replaceValue);
    const modelControl = make('span', 'foot-control');
    modelControl.append(make('em', '', 'Model'), makeModelSelect());
    const effortControl = make('label', 'foot-control');
    effortControl.append(make('em', '', 'Effort'), makeEffortSlider({ compact: true }));
    footSafety.className = 'foot-safety';
    footSafety.textContent = translateUiText('Never posts or sends. Only this field changes.');
    foot.replaceChildren(routeControl, replaceControl, modelControl, effortControl, footSafety);
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
    const closeMenu = button('quick-close', '×', 'Close Hermes Assist');
    closeMenu.addEventListener('click', trustedOnly(hidePanel));
    askRow.append(input, closeMenu);
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
    const gear = button('quick-options', '', 'Assist options');
    gear.append(settingsCog());
    gear.addEventListener('click', trustedOnly(renderQuickOptions));
    tools.appendChild(gear);
    const quickFoot = make('div', 'quick-foot');
    const summary = makeRaw('span', 'quick-summary', [
      translateUiText(profile?.contextMode === 'visible' ? 'Reads thread' : 'This field only'),
      translateUiText(ROUTE_LABELS[currentRoutePreference()]),
      assistModelSummary(),
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
    rows.push(row('Model', 'Used only by Assist', makeModelSelect()));
    const effortRow = row('Effort', '', makeEffortSlider());
    effortRow.classList.add('effort-opt');
    rows.push(effortRow);
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
    const head = make('div', 'bar-head');
    const toFull = button('bar-return', '', 'Return to full panel');
    toFull.append(makeRaw('span', '', '←'), make('span', '', 'Return to full panel'));
    toFull.addEventListener('click', trustedOnly(() => {
      panel.dataset.mode = 'full';
      renderResult({ fieldChanged });
    }));
    head.append(barTitle(appliedAutomatically ? 'Draft in place' : (fieldChanged ? 'Field changed · review required' : 'Draft ready')), toFull);
    bar.append(head);
    if (resultModelNotice) bar.append(makeRaw('p', 'bar-note', `${translateUiText('Model routing')} · ${resultModelNotice}`));
    if (resultContextWithheld) bar.append(make('p', 'bar-note', 'Written without the page: page context is off for this connection.'));
    if (!appliedAutomatically) bar.append(makeRaw('div', 'bar-preview', resultText || translateUiText('(empty draft)')));
    // The decision first, as one pair (Undo, then Keep filled); the ways to change the draft after it, as one
    // joined strip of equal cells, so neither row ever leaves a hole.
    const actions = make('div', 'bar-actions');
    const decide = make('div', 'bar-main');
    const tools = make('div', 'bar-tools');
    const add = (row, label, handler, { main = false, disabled = false } = {}) => {
      const item = button(main ? 'main' : '', label);
      item.disabled = disabled;
      item.addEventListener('click', trustedOnly(handler));
      row.appendChild(item);
    };
    // Again, Shorter and Longer run as from the quick menu: the bar steps aside while Hermes works, and the
    // chooser's Back comes back to this bar.
    const rerun = (run) => () => {
      const back = { view: activeView, mode: 'bar' };
      panel.dataset.mode = 'quick';
      run({ back });
    };
    if (appliedAutomatically) {
      add(decide, 'Undo', undoResult, { disabled: !applyReceipt });
      add(decide, 'Keep', () => {
        hidePanel();
        pending = null;
        resetResult();
      }, { main: true });
      add(tools, 'Again', rerun(tryAgain), { disabled: !lastRunAction });
    } else {
      add(decide, 'Again', rerun(tryAgain), { disabled: !lastRunAction });
      add(decide, 'Copy', copyResult, { main: true });
    }
    if (applyReceipt) {
      add(tools, 'Shorter', rerun(makeShorter));
      add(tools, 'Longer', rerun(makeLonger));
    }
    if (appliedAutomatically) add(tools, 'Copy', copyResult);
    if (resultSessionId) {
      add(tools, 'Open session', () => {
        panel.dataset.mode = 'full';
        renderOpenSessionChoices();
      });
    }
    actions.append(decide);
    if (tools.childElementCount) actions.append(tools);
    bar.append(actions);
    setBody(bar);
  }

  // The bar's title line: the circle's own icon (Settings → Hermes Assist → Button icon) beside what
  // happened, drawn in the panel's ink, so its light or dark version follows the panel, not the page.
  function barTitle(text) {
    const title = make('span', 'bar-name');
    const mark = make('span', 'bar-mark');
    mark.setAttribute('aria-hidden', 'true');
    const icon = look?.normalizeInlineAssistIcon?.(assistSettings.inlineAssistIcon) || 'wing';
    mark.dataset.icon = icon;
    maskWith(mark, look?.inlineAssistIconAsset?.(icon, host.dataset.mode === 'dark' ? 'dark' : 'light') || 'assets/img/assist-wing.png');
    title.append(mark, make('strong', 'bar-title', text));
    return title;
  }

  function renderAssist() {
    activeView = { name: 'assist', args: [] };
    const profile = siteProfile || refreshSiteProfile();
    const context = boundedContext();
    const usesVisibleContext = profile?.contextMode === 'visible';
    contextDetail.textContent = translateUiText(currentContextLabel());
    contextState.textContent = translateUiText(usesVisibleContext ? 'BOUNDED' : 'DRAFT ONLY');
    contextState.classList.add('secure');

    const nodes = [];
    if (profile?.contextPolicy?.userConfigurable) {
      const contextSetting = make('label', 'setting');
      const contextCopy = make('span');
      const contextTitle = usesVisibleContext
        ? translateUiText('Use visible {site} context').replace('{site}', String(profile.surface || 'page').replace(/-/g, ' '))
        : 'Use focused draft only';
      const contextDescription = usesVisibleContext
        ? contextSummary(context, profile.label)
        : translateUiText('Strict default · no visible {site} conversation context').replace('{site}', profile.label);
      contextCopy.append(make('strong', '', contextTitle), make('br'), make('small', '', contextDescription));
      const contextToggle = make('input', 'toggle');
      contextToggle.type = 'checkbox';
      contextToggle.checked = usesVisibleContext;
      contextToggle.setAttribute('aria-label', translateUiText('Use visible {site} context').replace('{site}', profile.label));
      contextToggle.addEventListener('change', trustedOnly(() => {
        void persistSiteContextMode(profile.adapterId, contextToggle.checked ? 'visible' : 'draft');
      }));
      contextSetting.append(contextCopy, contextToggle);
      nodes.push(contextSetting);
      if (usesVisibleContext && context.text) nodes.push(contextPeek(context.text));
      if (usesVisibleContext && profile.contextPolicy.warning) nodes.push(make('p', 'privacy', profile.contextPolicy.warning));
    }

    const label = make('span', 'section-label', profile?.label ? translateUiText('What should Hermes do on {site}?').replace('{site}', profile.label) : 'What should Hermes do on this site?');
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
    custom.rows = 1;
    custom.placeholder = translateUiText('Say what to change…');
    custom.addEventListener('input', trustedOnly(() => {
      custom.style.height = 'auto';
      const borders = custom.offsetHeight - custom.clientHeight;
      custom.style.height = `${Math.min(96, custom.scrollHeight + borders)}px`;
    }));
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

  // `prepare` runs once Hermes is about to run (false stops it); `back` is where the chooser's Back returns.
  async function beginAction(action, { prepare = null, back = null } = {}) {
    if (!target) return;
    pendingAction = action;
    pendingPrepare = typeof prepare === 'function' ? prepare : null;
    routingBack = back || { view: activeView, mode: panel.dataset.mode };
    const status = await browserApi.runtime.sendMessage({ type: SESSION_STATUS }).catch(() => null);
    const decision = policy.routeDecision?.({
      preference: assistSettings.inlineAssistDefaultRoute,
      hasActiveSession: Boolean(status?.hasActiveSession),
    }) || 'ask';
    if (decision === 'ask') renderRouting(status || {});
    else runPrepared(action, decision);
  }

  function runPrepared(action, route) {
    const prepare = pendingPrepare;
    pendingPrepare = null;
    routingBack = null;
    if (prepare && prepare() === false) return undefined;
    return requestDraft(action, route);
  }

  // Back on the chooser: the screen it was opened from, as it was (nothing was undone yet).
  function leaveRouting() {
    const back = routingBack;
    routingBack = null;
    pendingPrepare = null;
    pendingAction = null;
    showView(back?.view, back?.mode);
  }

  // A screen shown again as it was: the bar, the quick menu or its options, a result, or the actions.
  function showView(view = null, mode = '') {
    panel.dataset.mode = mode || 'full';
    const args = view?.args || [];
    if (view?.name === 'bar') return renderResultBar(...args);
    if (view?.name === 'failure-bar') return renderFailureBar(...args);
    if (view?.name === 'quick') return renderQuickMenu();
    if (view?.name === 'quick-options') return renderQuickOptions();
    if (view?.name === 'result') return renderResult(...args);
    if (view?.name === 'failure') return renderFailure(...args);
    return renderAssist();
  }

  function renderRouting(session = {}) {
    // Never in the bar's tight layout: from the bar the chooser takes the quick menu's.
    if (panel.dataset.mode === 'bar') panel.dataset.mode = 'quick';
    activeView = { name: 'routing', args: [session] };
    contextDetail.textContent = translateUiText(session.hasActiveSession
      ? `Active chat · ${Number(session.messageCount || 0) || 'existing'} messages`
      : 'No active chat');
    contextState.textContent = translateUiText('CHOOSE');
    contextState.classList.remove('secure');
    // Back to where it was opened from; Close where the panel's own header (with its ×) is hidden.
    const nav = make('div', 'sheet-nav');
    const back = button('sheet-back', '', 'Back');
    back.append(makeRaw('span', '', '←'), make('span', '', 'Back'));
    back.addEventListener('click', trustedOnly(leaveRouting));
    nav.append(back);
    if (panel.dataset.mode !== 'full') {
      const closeSheet = button('sheet-close', '×', 'Close Hermes Assist');
      closeSheet.addEventListener('click', trustedOnly(hidePanel));
      nav.append(closeSheet);
    }
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
        await runPrepared(pendingAction, route.route);
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
    setBody(nav, title, note, ...routeNodes, rememberSetting, privacy);
  }

  async function requestDraft(action, route) {
    if (!target || !action) return;
    lastRunAction = action;
    const requestId = `req-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const profile = siteProfile || refreshSiteProfile();
    const pageContext = boundedContext({ explicitGenericCapture: action.id === 'draft-for-context' }).text;
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
      if (built.reason === 'empty-draft') return renderFailure(translateUiText('{action} works on what is already in the field. Type something first, or pick a Draft action to start from nothing.').replace('{action}', translateUiText(action.label)));
      return renderFailure('This field is not eligible for inline drafting.');
    }
    pending = { ...built.request, applyMode: supportsSafeApply ? 'safe-apply' : 'copy-only' };
    pendingField = target;
    resetResult();
    setLauncherBusy(true);
    renderWorking();
    const response = await browserApi.runtime.sendMessage({ type: REQUEST, request: pending }).catch((error) => ({ ok: false, reason: error?.message }));
    if (!response?.ok) renderFailure(response?.reason || 'Hermes could not queue this draft.');
  }

  function renderWorking() {
    // From the quick menu the draft is written into the field when it is ready: the menu steps aside and
    // the circle's ring shows the run.
    if (panel.dataset.mode === 'quick' || panel.dataset.mode === 'bar') {
      panel.dataset.mode = 'quick';
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
    // A run from the quick menu (which hid the menu while it ran) or from the bar under the field shows its
    // failure in that bar.
    if ((panel.hidden && panel.dataset.mode === 'quick') || (!panel.hidden && panel.dataset.mode === 'bar')) return renderFailureBar(reason);
    activeView = { name: 'failure', args: [reason] };
    contextState.textContent = translateUiText('BLOCKED');
    const title = make('h2', 'route-title', 'Assist could not run');
    const detail = make('p', 'status failure-detail', reason || 'Hermes could not create this draft.');
    const back = button('failure-back', 'Back to actions');
    back.addEventListener('click', trustedOnly(renderAssist));
    setBody(title, detail, back);
  }

  function renderFailureBar(reason) {
    activeView = { name: 'failure-bar', args: [reason] };
    panel.dataset.mode = 'bar';
    panel.hidden = false;
    const bar = make('div', 'bar');
    const head = make('div', 'bar-head');
    head.append(barTitle('Assist could not run'));
    bar.append(head, make('div', 'bar-preview', reason || 'Hermes could not create this draft.'));
    const actions = make('div', 'bar-actions');
    const decide = make('div', 'bar-main');
    const dismiss = button('', 'Close');
    dismiss.addEventListener('click', trustedOnly(hidePanel));
    const again = button('main', 'Try again');
    again.addEventListener('click', trustedOnly(() => {
      panel.dataset.mode = 'quick';
      tryAgain();
    }));
    decide.append(dismiss, again);
    actions.append(decide);
    bar.append(actions);
    setBody(bar);
    position();
  }

  function runLocalAction(action) {
    const current = policy.classifyEditable(target);
    if (!current.eligible) return renderFailure('The original field is no longer available.');
    lastRunAction = action;
    pendingField = target;
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
    resultContextWithheld = message.contextWithheld === true;
    // The draft belongs to the field the run came from, even if another one took focus while Hermes worked.
    if (pendingField?.isConnected && pendingField !== target) setTarget(pendingField);
    const current = policy.classifyEditable(pendingField?.isConnected ? pendingField : target);
    const fieldChanged = !current.eligible || current.text !== pending.draftText;
    if (resultText && pending.autoReplace && !fieldChanged && (!pendingField || pendingField === target)) {
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
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
      const current = policy.classifyEditable(focused);
      if (current.eligible) {
        setTarget(focused);
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
    contextState.classList.add('secure');
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
      const routingNotice = makeRaw('p', 'privacy', `${translateUiText('Model routing')} · ${resultModelNotice}`);
      routingNotice.setAttribute('role', 'status');
      card.append(routingNotice);
    }
    if (resultContextWithheld) {
      const withheldNotice = make('p', 'privacy', 'Hermes wrote this without the page: page context is off for this connection. Turn it on in the side panel to include the thread.');
      withheldNotice.setAttribute('role', 'status');
      card.append(withheldNotice);
    }
    const label = make('span', 'section-label', 'Result preview');
    const preview = makeRaw('div', 'preview', resultText || translateUiText('(empty draft)'));
    overlayScrollbar?.attachOverlayScrollbar(preview, { watchResize: false });
    const actions = make('div', 'result-actions');
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
    // Try again and Quick menu always (back to the bar, the draft still up); Shorter and Longer once the draft
    // is in the field, since they rework what the field holds. The buttons come in pairs.
    const followUps = make('div', 'result-actions follow-ups');
    const again = button('', 'Try again');
    again.disabled = !lastRunAction;
    again.addEventListener('click', trustedOnly(tryAgain));
    const quick = button('', 'Quick menu');
    quick.addEventListener('click', trustedOnly(() => renderResultBar({ fieldChanged })));
    followUps.append(again, quick);
    if (applyReceipt) {
      const shorter = button('', 'Shorter');
      shorter.addEventListener('click', trustedOnly(makeShorter));
      const longer = button('', 'Longer');
      longer.addEventListener('click', trustedOnly(makeLonger));
      followUps.append(shorter, longer);
    }
    setBody(success, card, label, preview, actions, followUps);
  }

  // Run the same action again from the text the user had. An applied draft is undone only once Hermes is
  // about to run, so backing out of the chooser leaves it in the field.
  function tryAgain({ back = null } = {}) {
    const action = lastRunAction;
    if (!action) return undefined;
    const undoApplied = () => {
      if (!applyReceipt) return true;
      const undone = policy.undoResult(target, applyReceipt);
      if (!undone.ok) {
        renderFailure('Undo was blocked because the field changed after the replacement.');
        return false;
      }
      applyReceipt = null;
      appliedAutomatically = false;
      return true;
    };
    if (action.local) return undoApplied() ? runLocalAction(action) : undefined;
    return beginAction(action, { prepare: undoApplied, back });
  }

  // Shorter and Longer rework the draft that is now in the field (offered only once it was applied there).
  function reworkDraft(action, back) {
    if (!action) return undefined;
    return beginAction(action, {
      back,
      prepare: () => {
        applyReceipt = null;
        appliedAutomatically = false;
        return true;
      },
    });
  }

  function makeShorter({ back = null } = {}) {
    return reworkDraft(genericActions.find((item) => item.id === 'shorten'), back);
  }

  function makeLonger({ back = null } = {}) {
    return reworkDraft(expandAction, back);
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
    contextState.classList.remove('secure');
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

  // The element the event really came from: inside an open shadow root (LinkedIn's Start a post editor)
  // the event's target is only the shadow root's host.
  function eventOrigin(event) {
    const first = event.composedPath?.()[0];
    return first?.nodeType === 1 ? first : event.target;
  }

  function onFocus(event) {
    if (event.composedPath?.().includes(host)) return;
    setTarget(eventOrigin(event));
  }

  function onEditableInput(event) {
    if (!target || event.composedPath?.().includes(host)) return;
    const origin = eventOrigin(event);
    if (origin === target || target.contains?.(origin)) stabilizePosition(420);
  }

  // A press outside the quick menu closes it, as a menu does; the full panel and the bar stay open.
  function onPagePointerDown(event) {
    if (event.isTrusted !== true || panel.hidden || panel.dataset.mode !== 'quick') return;
    if (event.composedPath?.().includes(host)) return;
    hidePanel();
  }

  function onKey(event) {
    if (event.isTrusted !== true) return;
    if (event.key !== 'Escape') return;
    // The first Escape closes an open Assist dropdown, the next one closes Assist.
    if (closeOpenDropdown) {
      closeOpenDropdown({ focus: true });
      return;
    }
    hidePanel();
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
    popOpen();
  }

  function applyLocalizedFrame() {
    launcher.setAttribute('aria-label', translateUiText('Open Hermes Assist'));
    panel.setAttribute('aria-label', translateUiText('Hermes Assist'));
    for (const mark of [launcher.querySelector('.launcher-logo'), brandWing]) {
      mark?.setAttribute('aria-label', translateUiText('Hermes Browser Extension'));
    }
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
    else showView(activeView, panel.dataset.mode);
  }

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('input', onEditableInput, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPagePointerDown, true);
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
    document.removeEventListener('pointerdown', onPagePointerDown, true);
    globalThis.removeEventListener('resize', position);
    globalThis.removeEventListener('scroll', position, true);
    visualViewport?.removeEventListener?.('resize', position);
    visualViewport?.removeEventListener?.('scroll', position);
    disconnectTargetObservers();
    panelResizeObserver?.disconnect();
    browserApi.runtime.onMessage.removeListener(onResult);
    browserApi.storage.onChanged.removeListener(onStorageChanged);
    unsubscribeI18n();
    systemThemeQuery?.removeEventListener?.('change', onSystemThemeChanged);
    host.remove();
  };
})();
