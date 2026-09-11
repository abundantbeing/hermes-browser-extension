import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('bottom-anchored popovers reserve the live composer dock height (#101)', () => {
  const floating = css.match(/\.model-menu,\s*\n\.context-popover\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(floating, /bottom:\s*calc\(var\(--hermes-bottom-dock-height, 0px\) \+ 6px\)/);
  assert.match(floating, /max-height:\s*calc\(100vh - var\(--hermes-bottom-dock-height, 0px\) - 18px\)/);
  assert.match(floating, /overflow-y:\s*auto/);

  const modelMenu = css.match(/^\.model-menu\s*\{[\s\S]*?\}/m)?.[0] || '';
  assert.match(modelMenu, /max-height:\s*min\(480px, calc\(100vh - var\(--hermes-bottom-dock-height, 0px\) - 18px\)\)/);
  assert.match(modelMenu, /grid-template-rows:\s*auto minmax\(58px, auto\) minmax\(0, 1fr\) minmax\(0, auto\) auto/);
  assert.doesNotMatch(css, /calc\(100vh - 176px\)/, 'the fixed 176px guess must be gone');

  const optionsList = css.match(/\.model-options-list\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(optionsList, /min-height:\s*0/);
  assert.match(optionsList, /overflow-y:\s*auto/);

  const assist = css.match(/\.model-menu\[data-selection-target="assist"\]\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(assist, /grid-template-rows:\s*auto auto minmax\(58px, auto\) minmax\(0, 1fr\) minmax\(0, auto\) auto/);
});
