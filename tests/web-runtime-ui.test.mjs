import assert from 'node:assert/strict';
import test from 'node:test';

import { isRenderableAssistantMessage } from '../extension/lib/web-run-state.mjs';

test('assistant transcript entries require real text or a real media reference', () => {
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: '' }), false);
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: '   ' }), false);
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: 'MEDIA:C:\\Users\\Jaybo\\report.pdf' }), true);
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: 'Finished the report.' }), true);
});
