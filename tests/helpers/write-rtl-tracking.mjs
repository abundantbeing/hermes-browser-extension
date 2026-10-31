// Regenerates the right-to-left typography block at the end of extension/sidepanel.css.
// Run after adding CSS that uses letter-spacing or text-transform: uppercase:
//   node tests/helpers/write-rtl-tracking.mjs
import fs from 'node:fs';
import path from 'node:path';

import { RTL_BLOCK_END, RTL_BLOCK_START, buildRtlBlock, trackedSelectors } from './rtl-tracking.mjs';

const root = process.env.RTL_ROOT || path.resolve(import.meta.dirname, '..', '..');
export const PANEL_STYLESHEETS = [
  'extension/lib/fonts.css',
  'extension/lib/branded-select.css',
  'extension/sidepanel.css',
  'extension/sidepanel-themes.css',
  'extension/context-menu-editor.css',
  'extension/lib/user-file-attachments.css',
  'extension/lib/agent-prompt-card.css',
  'extension/lib/effort-control.css',
  'extension/lib/voice-wingbeat.css',
  'extension/lib/pixel-icons.css',
  'extension/lib/adaptive-ui.css',
];

export function withoutRtlBlock(css) {
  const start = css.indexOf(RTL_BLOCK_START);
  if (start < 0) return css;
  const end = css.indexOf(RTL_BLOCK_END, start);
  return css.slice(0, start) + css.slice(end + RTL_BLOCK_END.length).replace(/^\n/, '');
}

export function expectedBlock() {
  const texts = PANEL_STYLESHEETS.map((file) => withoutRtlBlock(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')));
  const intro = '/* Right-to-left (and so Arabic): letters are never spaced apart (it breaks the joining) and nothing is forced to capitals (they mean nothing in the script). Every rule above that tracks or capitalises text has its right-to-left twin here. */';
  return `${RTL_BLOCK_START}\n${intro}\n${buildRtlBlock(trackedSelectors(texts))}\n${RTL_BLOCK_END}\n`;
}

if (process.argv[1]?.endsWith('write-rtl-tracking.mjs')) {
  const file = path.join(root, 'extension/sidepanel.css');
  const css = withoutRtlBlock(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${css.replace(/\n*$/, '\n')}\n${expectedBlock()}`);
  console.log('wrote the RTL typography block');
}
