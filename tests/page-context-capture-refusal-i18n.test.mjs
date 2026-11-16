import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PAGE_CONTEXT_CAPTURE_REFUSAL_BLOCKED_KEY,
  PAGE_CONTEXT_CAPTURE_REFUSAL_OFF_KEY,
} from '../extension/lib/page-script-host-policy.mjs';

test('page context capture refusals return locale keys for the side panel', async () => {
  const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(content, new RegExp(`reasonKey = '${PAGE_CONTEXT_CAPTURE_REFUSAL_OFF_KEY}'|pageContextCaptureRefusedResponse\\(reasonKey`));
  assert.doesNotMatch(content, /Page context is off for this site\./);
  assert.doesNotMatch(content, /This page cannot be captured\./);
  assert.match(content, new RegExp(`'${PAGE_CONTEXT_CAPTURE_REFUSAL_BLOCKED_KEY}'`));
});

test('side panel translates capture refusal reasonKey from content replies', async () => {
  const sidepanel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = sidepanel.slice(
    sidepanel.indexOf('async function getPageContext(tab, options = {})'),
    sidepanel.indexOf('async function getYoutubeTranscriptForTab'),
  );
  assert.match(block, /response\?\.reasonKey/);
  assert.match(block, /reason: t\(response\.reasonKey/);
});