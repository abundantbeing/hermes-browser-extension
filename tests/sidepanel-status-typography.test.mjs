import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('status card title typography avoids clipped descenders', async () => {
  const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.status-copy strong {'), css.indexOf('.status-copy span { margin-top'));
  assert.match(block, /line-height:\s*1\.3/);
  assert.match(block, /letter-spacing:\s*0\.015em/);
  assert.match(css, /\.status-card:has\(\.status-dot\.warn\) \.status-copy strong[\s\S]*overflow:\s*visible/);
  assert.match(css, /\.status-card:has\(\.status-dot\.warn\) \.status-copy strong[\s\S]*white-space:\s*normal/);
  assert.doesNotMatch(block, /line-height:\s*0\.96/);
});