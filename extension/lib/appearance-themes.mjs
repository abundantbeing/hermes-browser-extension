export const APPEARANCE_THEMES = Object.freeze([
  {
    value: 'nous',
    name: 'Nous',
    description: 'Ink blue with soft-white Desktop accents',
    preview: { bg: '#0505e8', panel: '#0505e8', text: '#f8faff', muted: '#dbe6ff', accent: '#f8faff' },
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
  {
    value: 'senter-space',
    name: 'Senter Space',
    description: 'Deep space, sea glass, and warm starlight',
    preview: { bg: '#091716', panel: '#112722', text: '#e9d1a5', muted: '#87c6b7', accent: '#c79a55' },
  },
  {
    value: 'aurora',
    name: 'Aphrodite',
    description: 'Hot pink, orchid, and rose with a polished dark-plum counterpart.',
    preview: { bg: '#3b0928', panel: '#5f123d', text: '#fff0f7', muted: '#d89ab7', accent: '#ff4fa3' },
  },
  {
    value: 'solstice',
    name: 'Solstice',
    description: 'Quiet graphite with sun-warmed brass',
    preview: { bg: '#181715', panel: '#25211b', text: '#f1dfbc', muted: '#c4a77c', accent: '#e5b96c' },
  },
]);

export const INLINE_ASSIST_THEME_TOKENS = Object.freeze({
  nous: Object.freeze({
    dark: Object.freeze({ surface: '#082f67', panel: '#0a3572', ink: '#edf4ff', fg: '#f4f8ff', accent: '#8bb7ff', primary: '#0505e8' }),
    light: Object.freeze({ surface: '#0505e8', panel: '#ffffff', ink: '#0505e8', fg: '#f8faff', accent: '#dbe6ff', primary: '#0505e8' }),
  }),
  midnight: Object.freeze({
    dark: Object.freeze({ surface: '#07061a', panel: '#121029', ink: '#d9d2ff', fg: '#eeeaff', accent: '#b7a8ff', primary: '#2a1a69' }),
    light: Object.freeze({ surface: '#f0eeff', panel: '#ffffff', ink: '#2a1a69', fg: '#21164f', accent: '#c9c1ff', primary: '#2a1a69' }),
  }),
  ember: Object.freeze({
    dark: Object.freeze({ surface: '#1a0600', panel: '#2a0b02', ink: '#ffd0a4', fg: '#ffe7d0', accent: '#ff9d4d', primary: '#651b00' }),
    light: Object.freeze({ surface: '#fff1e4', panel: '#fffaf6', ink: '#651b00', fg: '#651b00', accent: '#ffb06b', primary: '#651b00' }),
  }),
  mono: Object.freeze({
    dark: Object.freeze({ surface: '#0d0d0d', panel: '#171717', ink: '#e5e5e5', fg: '#f1f1f1', accent: '#c9c9c9', primary: '#202020' }),
    light: Object.freeze({ surface: '#f2f2f2', panel: '#ffffff', ink: '#202020', fg: '#1d1d1d', accent: '#d4d4d4', primary: '#202020' }),
  }),
  cyberpunk: Object.freeze({
    dark: Object.freeze({ surface: '#001004', panel: '#001b08', ink: '#12ff68', fg: '#36ff7a', accent: '#00ff5f', primary: '#005e25' }),
    light: Object.freeze({ surface: '#eaffef', panel: '#fbfffc', ink: '#005e25', fg: '#00451c', accent: '#37f56f', primary: '#005e25' }),
  }),
  slate: Object.freeze({
    dark: Object.freeze({ surface: '#081015', panel: '#0f1a22', ink: '#d0dbe2', fg: '#e6eef3', accent: '#8eb7d4', primary: '#1d3848' }),
    light: Object.freeze({ surface: '#edf4f8', panel: '#ffffff', ink: '#1d3848', fg: '#18303f', accent: '#b8d4e6', primary: '#1d3848' }),
  }),
  'senter-space': Object.freeze({
    dark: Object.freeze({ surface: '#071614', panel: '#10221f', ink: '#e8d3a8', fg: '#d5eee7', accent: '#64b7a5', primary: '#174f48' }),
    light: Object.freeze({ surface: '#174f48', panel: '#fbf8ef', ink: '#174f48', fg: '#174f48', accent: '#b77c38', primary: '#174f48' }),
  }),
  aurora: Object.freeze({
    dark: Object.freeze({ surface: '#3b0928', panel: '#24111d', ink: '#ffe3ef', fg: '#fff0f7', accent: '#ff4fa3', primary: '#b51c67' }),
    light: Object.freeze({ surface: '#b51c67', panel: '#fff7fb', ink: '#42142f', fg: '#42142f', accent: '#e8358b', primary: '#b51c67' }),
  }),
  solstice: Object.freeze({
    dark: Object.freeze({ surface: '#181715', panel: '#28231b', ink: '#f0dfbb', fg: '#f7ebd7', accent: '#e2b366', primary: '#6b4d22' }),
    light: Object.freeze({ surface: '#6b4d22', panel: '#fffbf3', ink: '#58401f', fg: '#58401f', accent: '#bd7d2d', primary: '#6b4d22' }),
  }),
});

export const DEFAULT_APPEARANCE_THEME = 'nous';
export const DEFAULT_COLOR_MODE = 'dark';
export const COLOR_MODES = Object.freeze(['light', 'dark', 'system']);

export function normalizeAppearanceTheme(value = DEFAULT_APPEARANCE_THEME) {
  const raw = String(value || DEFAULT_APPEARANCE_THEME).trim().toLowerCase();
  return APPEARANCE_THEMES.some((theme) => theme.value === raw) ? raw : DEFAULT_APPEARANCE_THEME;
}

export function normalizeColorMode(value = DEFAULT_COLOR_MODE) {
  const raw = String(value || DEFAULT_COLOR_MODE).trim().toLowerCase();
  return COLOR_MODES.includes(raw) ? raw : DEFAULT_COLOR_MODE;
}

export function resolveColorMode(value = DEFAULT_COLOR_MODE, prefersDark = true) {
  const mode = normalizeColorMode(value);
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function resolveInlineAssistTheme(value = DEFAULT_APPEARANCE_THEME, mode = DEFAULT_COLOR_MODE, prefersDark = true) {
  const theme = normalizeAppearanceTheme(value);
  const resolvedMode = resolveColorMode(mode, prefersDark);
  return Object.freeze({
    theme,
    mode: resolvedMode,
    ...INLINE_ASSIST_THEME_TOKENS[theme][resolvedMode],
    logo: theme === 'nous' ? '#0505e8' : '#111111',
    logoBackground: '#ffffff',
  });
}

export const APPEARANCE_RUNTIME_API = Object.freeze({
  themes: APPEARANCE_THEMES,
  defaultTheme: DEFAULT_APPEARANCE_THEME,
  defaultColorMode: DEFAULT_COLOR_MODE,
  normalizeTheme: normalizeAppearanceTheme,
  normalizeColorMode,
  resolveColorMode,
  resolveInlineAssistTheme,
});
