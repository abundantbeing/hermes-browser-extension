import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldPreserveImageGenerationRun } from '../extension/lib/web-run-state.mjs';

test('an active image-generation run survives later unrelated tool events until final media settles', () => {
  assert.equal(
    shouldPreserveImageGenerationRun(
      { image: true, revealPending: false },
      { rawName: 'vision_analyze', aspectRatio: '' },
    ),
    true,
  );
  assert.equal(
    shouldPreserveImageGenerationRun(
      { image: true, revealPending: false },
      { rawName: 'image_generate', aspectRatio: 'square' },
    ),
    false,
  );
  assert.equal(
    shouldPreserveImageGenerationRun(
      { image: false },
      { rawName: 'vision_analyze', aspectRatio: '' },
    ),
    false,
  );
});
