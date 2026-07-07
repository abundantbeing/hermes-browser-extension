const NOT_AVAILABLE = 'unknown';

export function browserFamilyFromUserAgent(userAgent = '') {
  const ua = String(userAgent || '');
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua) || /Opera/i.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox (unsupported preview)';
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua)) return 'Safari (unsupported preview)';
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return 'Chrome';
  return NOT_AVAILABLE;
}

export function redactDiagnosticUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '(not configured)';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return '(invalid URL)';
  }
}

export function redactExtensionOrigin(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '(not available)';
  try {
    const url = new URL(raw);
    if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:' || url.protocol === 'safari-web-extension:') {
      return `${url.protocol}//${url.host}`;
    }
    return url.origin;
  } catch {
    return '(invalid extension origin)';
  }
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function availability(value, { missing = 'missing', available = 'available' } = {}) {
  return value ? available : missing;
}

function safeLine(value = '') {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_BEARER]')
    .replace(/(api[_-]?key|token|password|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/(Authorization|Cookie):\s*[^\n]+/gi, '$1: [REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function bullet(label, value) {
  return `- ${label}: ${safeLine(value) || NOT_AVAILABLE}`;
}

export function buildSupportDiagnostics({
  extensionVersion = '',
  extensionOrigin = '',
  buildInfo = {},
  userAgent = '',
  platform = '',
  settings = {},
  connection = {},
  health = {},
  capabilities = {},
  selectedModel = {},
  contextScope = {},
  lastError = null,
  extractorMode = '',
} = {}) {
  const browserFamily = browserFamilyFromUserAgent(userAgent);
  const contextScopeMode = contextScope?.mode || 'follow-active-tab';
  const gatewayMode = settings.gatewayMode || 'local-api';
  const gatewayOrigin = redactDiagnosticUrl(settings.gatewayUrl || '');
  const warnings = Array.isArray(capabilities.warnings) ? capabilities.warnings : [];
  const lines = [
    '# Hermes Browser Diagnostics',
    '',
    '## Extension',
    bullet('Extension version', extensionVersion || buildInfo.version || NOT_AVAILABLE),
    bullet('Extension origin', redactExtensionOrigin(extensionOrigin)),
    bullet('Build commit', buildInfo.shortCommit || (buildInfo.commit ? String(buildInfo.commit).slice(0, 7) : NOT_AVAILABLE)),
    bullet('Build dirty', yesNo(buildInfo.dirty)),
    bullet('Built at', buildInfo.builtAt || NOT_AVAILABLE),
    '',
    '## Browser / OS',
    bullet('Browser family', browserFamily),
    bullet('Platform', platform || NOT_AVAILABLE),
    '',
    '## Gateway',
    bullet('Gateway mode', gatewayMode),
    bullet('Gateway URL origin', gatewayOrigin),
    bullet('Connection state', connection.state || NOT_AVAILABLE),
    bullet('Connection detail', connection.detail || NOT_AVAILABLE),
    bullet('Health ok', yesNo(health.ok)),
    bullet('Hermes version', health.version || health.hermes_version || NOT_AVAILABLE),
    bullet('Hermes build', health.build || health.commit || NOT_AVAILABLE),
    '',
    '## Runtime capabilities',
    bullet('Models', availability(capabilities.models)),
    bullet('Sessions', availability(capabilities.sessions)),
    bullet('Skills', availability(capabilities.skills)),
    bullet('Profiles', availability(capabilities.profiles)),
    bullet('Run events', availability(capabilities.runEvents || capabilities.browserEvents)),
    bullet('Browser Context Protocol', availability(capabilities.browserContextProvider, { missing: 'missing', available: 'available' })),
    bullet('Browser context upload', availability(capabilities.browserContextUpload)),
    bullet('Companion plugin', availability(capabilities.browserCompanionPlugin)),
    bullet('Plugin actions', availability(capabilities.pluginActions)),
    bullet('Browser control', capabilities.browserControl ? 'blocked by read-only policy' : 'disabled'),
    '',
    '## Request context',
    bullet('Selected model', selectedModel.label || selectedModel.id || settings.model || NOT_AVAILABLE),
    bullet('Selected provider', selectedModel.provider || settings.provider || NOT_AVAILABLE),
    bullet('Active profile', settings.activeProfile || NOT_AVAILABLE),
    bullet('Context source mode', contextScopeMode),
    bullet('Extractor mode', extractorMode || 'extension-dom'),
    bullet('Open tabs included', yesNo(settings.includeTabs)),
    bullet('Page text included', yesNo(settings.includePageText)),
    bullet('Selection included', yesNo(settings.includeSelectedText)),
    bullet('Context depth', settings.contextDepth || NOT_AVAILABLE),
  ];

  if (warnings.length) {
    lines.push('', '## Capability warnings');
    for (const warning of warnings.slice(0, 8)) lines.push(`- ${safeLine(warning)}`);
  }

  if (lastError) {
    lines.push('', '## Last visible error');
    lines.push(bullet('Kind', lastError.kind || NOT_AVAILABLE));
    lines.push(bullet('Title', lastError.title || NOT_AVAILABLE));
    lines.push(bullet('Detail', lastError.detail || lastError.message || NOT_AVAILABLE));
  }

  lines.push(
    '',
    '## Privacy note',
    'This diagnostic block intentionally excludes API keys, bearer tokens, cookies, page text, selected text, tab titles, full tab URLs, and webpage content.',
  );

  return {
    markdown: `${lines.join('\n')}\n`,
    browserFamily,
    gatewayOrigin,
    redacted: true,
  };
}
