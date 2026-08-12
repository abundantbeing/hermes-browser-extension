// Tool categorization and labeling extracted from common.mjs — 2026-08-12 module split

import { redactSensitiveText } from './redaction.mjs';
import { normalizeReadableWhitespace } from './text-utils.mjs';

const TOOL_CATEGORY_PATTERNS = Object.freeze([
  ['edit', /^(patch|write_file|skill_manage)$|write|patch|edit|update|rename/i],
  ['terminal', /^(terminal|process|execute_code)$|shell|command|exec|code/i],
  ['browser', /^browser_|playwright|chrome_devtools|computer_use|snapshot|screenshot|click|type|scroll|navigate|page/i],
  ['web', /^(web_search|web_extract|x_search)$|web|twitter|\bx\b|research/i],
  ['media', /vision|image|video|audio|speech|voice|tts|transcrib/i],
  ['meta', /todo|memory|session|delegate|cron|plan|profile|context/i],
  ['file', /^(read_file|search_files)$|file|search|extract|document|content/i],
]);

const TOOL_LABELS = Object.freeze({
  read_file: 'Reading file',
  search_files: 'Searching project',
  web_extract: 'Reading source',
  patch: 'Patching file',
  write_file: 'Writing file',
  skill_manage: 'Updating skill',
  terminal: 'Running command',
  process: 'Checking process',
  execute_code: 'Executing code',
  web_search: 'Searching web',
  x_search: 'Checking X',
  vision_analyze: 'Reading image',
  image_generate: 'Generating image',
  text_to_speech: 'Rendering voice',
  todo: 'Updating plan',
  memory: 'Saving memory',
  session_search: 'Searching sessions',
  delegate_task: 'Delegating task',
  cronjob: 'Scheduling job',
});

const TOOL_CATEGORY_LABELS = Object.freeze({
  file: 'Reading file',
  edit: 'Updating file',
  terminal: 'Running command',
  browser: 'Inspecting page',
  web: 'Searching web',
  media: 'Processing media',
  meta: 'Updating plan',
});

export function toolCategoryForName(name = '') {
  const rawName = String(name || '').trim();
  if (!rawName) return 'meta';
  const match = TOOL_CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(rawName));
  return match?.[0] || 'meta';
}

export function toolLabelForName(name = '', category = toolCategoryForName(name)) {
  const rawName = String(name || '').trim();
  if (TOOL_LABELS[rawName]) return TOOL_LABELS[rawName];
  if (/click/i.test(rawName)) return 'Clicking browser';
  if (/type|fill/i.test(rawName)) return 'Typing in browser';
  if (/scroll/i.test(rawName)) return 'Scrolling page';
  if (/navigate|back/i.test(rawName)) return 'Navigating browser';
  if (/console/i.test(rawName)) return 'Reading console';
  if (/image_generate/i.test(rawName)) return 'Generating image';
  if (/vision|image/i.test(rawName)) return 'Reading image';
  if (/write/i.test(rawName)) return 'Writing file';
  if (/patch|edit/i.test(rawName)) return 'Patching file';
  if (/search/i.test(rawName) && category === 'file') return 'Searching project';
  if (/search/i.test(rawName) && category === 'web') return 'Searching web';
  return TOOL_CATEGORY_LABELS[category] || 'Using tool';
}

export function sanitizeToolPreview(value = '', maxChars = 110) {
  const max = Math.max(0, Number(maxChars || 0));
  if (!max) return '';
  const text = normalizeReadableWhitespace(redactSensitiveText(String(value || ''))).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  if (max === 1) return '…';
  return `${text.slice(0, max - 1).trimEnd()}…`;
}