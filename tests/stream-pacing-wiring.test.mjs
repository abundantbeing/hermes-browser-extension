import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

test('the live turn stream is paced instead of painted in bursts', () => {
  assert.match(sidepanelSource, /import \{ createStreamPacer \} from '\.\/lib\/stream-pacing\.mjs';/);
  assert.match(sidepanelSource, /streamPacer = createStreamPacer\(\{/);
  // Driven by animation frames, not a timer, so it matches the paint cadence.
  assert.match(sidepanelSource, /schedule: \(cb\) => requestAnimationFrame\(cb\),\s*\n\s*cancel: \(id\) => cancelAnimationFrame\(id\),/);
  // Deltas are sliced off the cumulative stream and handed to the pacer.
  assert.match(sidepanelSource, /streamPacer\.push\(liveText\.slice\(pushedLive\)\);/);
  assert.match(sidepanelSource, /pushedLive = liveText\.length;/);
  // A rewritten cumulative stream restarts the reveal rather than duplicating.
  assert.match(sidepanelSource, /if \(liveText\.length < pushedLive\) \{/);
  assert.match(sidepanelSource, /streamPacer\.reset\(\);/);
  assert.doesNotMatch(sidepanelSource, /streamView\.updateText\(liveText \|\| THINKING_PLACEHOLDER\);/, 'the raw burst paint must be gone');
});

test('the paced reveal finishes before the terminal paint so the bubble cannot jump', () => {
  assert.match(
    sidepanelSource,
    /if \(streamPacer\.pending\(\) > 0\) \{\s*\n\s*streamPacer\.finish\(\);\s*\n\s*await Promise\.race\(\[pacerDrained, new Promise\(\(resolve\) => setTimeout\(resolve, 3_500\)\)\]\);\s*\n\s*\}\s*\n\s*await streamView\.flush\(finalAnswer, \{ imageSources: recoveredImageSources \}\);/,
    'the drain wait must sit directly before the terminal flush',
  );
  assert.match(sidepanelSource, /if \(meta\.done\) resolvePacerDrain\?\.\(\);/);
});

test('terminal error paths paint whatever the pacer still holds', () => {
  assert.match(sidepanelSource, /let streamPacer = null;/);
  assert.equal((sidepanelSource.match(/streamPacer\?\.flush\?\.\(\);/g) || []).length, 2);
});
