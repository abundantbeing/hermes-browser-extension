import { validateThemeDocument } from './custom-themes.mjs';

export const AGENT_THEME_START = 'HERMES_THEME_V1_START';
export const AGENT_THEME_END = 'HERMES_THEME_V1_END';

const DESCRIPTION_MAX = 300;
const SEMANTIC_KEYS = Object.freeze([
  'canvas', 'paper', 'ink', 'muted', 'primary', 'primaryDeep', 'onPrimary',
  'accent', 'onAccent', 'line', 'input', 'danger', 'onDanger', 'shellForeground',
]);

function authoredThemeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function buildAgentThemePrompt(description) {
  const request = String(description || '').trim();
  if (!request || request.length > DESCRIPTION_MAX) {
    throw authoredThemeError('agent-theme-description', `Theme description must be between 1 and ${DESCRIPTION_MAX} characters`);
  }
  const paletteShape = SEMANTIC_KEYS.map((key) => `    "${key}": "#000000"`).join(',\n');
  return [
    'Create one Hermes Browser semantic color theme for this visual direction:',
    request,
    '',
    'Return exactly one JSON document between the markers below.',
    'Use schemaVersion 1, a concise name and description, and complete colors plus darkColors palettes.',
    'Every palette value must be an opaque six-digit hexadecimal color.',
    'Keep text/background pairs readable. Use semantic colors only: no CSS, no URLs, no scripts, no fonts, no images, and no extra keys.',
    AGENT_THEME_START,
    '{',
    '  "schemaVersion": 1,',
    '  "name": "Theme name",',
    '  "description": "Theme description",',
    '  "colors": {',
    paletteShape,
    '  },',
    '  "darkColors": {',
    paletteShape,
    '  }',
    '}',
    AGENT_THEME_END,
    'Do not add prose or Markdown inside the markers.',
  ].join('\n');
}

export function extractAgentThemeDocument(responseText) {
  const response = String(responseText || '');
  const starts = response.split(AGENT_THEME_START).length - 1;
  const ends = response.split(AGENT_THEME_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    const message = starts === 0 || ends === 0
      ? 'Agent theme response is missing the required markers'
      : 'Agent theme response must contain exactly one marked document';
    throw authoredThemeError('agent-theme-markers', message);
  }
  const start = response.indexOf(AGENT_THEME_START) + AGENT_THEME_START.length;
  const end = response.indexOf(AGENT_THEME_END, start);
  if (end < start) throw authoredThemeError('agent-theme-markers', 'Agent theme response markers are out of order');
  let parsed;
  try {
    parsed = JSON.parse(response.slice(start, end).trim());
  } catch (cause) {
    throw authoredThemeError('agent-theme-json', 'Agent theme response contains invalid JSON', { cause });
  }
  const validation = validateThemeDocument(parsed);
  if (!validation.valid) {
    throw authoredThemeError('agent-theme-validation', 'Agent theme response failed theme validation', {
      validationErrors: validation.errors,
    });
  }
  return validation.document;
}
