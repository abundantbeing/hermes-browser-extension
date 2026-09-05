import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSseReviewEvents } from '../scripts/hermes-review-github-event.mjs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

test('parseSseReviewEvents joins streaming deltas into one review', () => {
  const lines = [
    ': keep-alive comment',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
    '',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: ', world' } }] }),
    '',
    'data: [DONE]',
    '',
  ];
  const result = parseSseReviewEvents(lines);
  assert.equal(result.chunks.join(''), 'Hello, world');
  assert.equal(result.streamError, null);
  assert.equal(result.sawDone, true);
});

test('parseSseReviewEvents strips trailing carriage returns', () => {
  const frame = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'A' } }] });
  const lines = [frame + CR, '', 'data: [DONE]' + CR, ''];
  const result = parseSseReviewEvents(lines);
  assert.equal(result.chunks.join(''), 'A');
  assert.equal(result.sawDone, true);
});

test('parseSseReviewEvents rejoins multi-line data frames before parsing', () => {
  const obj = JSON.stringify({ choices: [{ delta: { content: 'M' } }] });
  const cut = obj.indexOf(':[') + 1; // split between JSON tokens so the SSE newline keeps validity
  const lines = ['data: ' + obj.slice(0, cut), 'data: ' + obj.slice(cut), ''];
  const result = parseSseReviewEvents(lines);
  assert.equal(result.chunks.join(''), 'M');
});

test('parseSseReviewEvents surfaces error frames without throwing', () => {
  const result = parseSseReviewEvents(['data: {"error":"boom"}', '']);
  assert.match(String(result.streamError), /boom/);
  assert.equal(result.chunks.length, 0);
});

test('parseSseReviewEvents ignores non-JSON payloads like ping events', () => {
  const result = parseSseReviewEvents(['data: ping', '', 'data: not json', '']);
  assert.deepEqual(result.chunks, []);
  assert.equal(result.streamError, null);
});

test('parseSseReviewEvents captures message.content when no deltas stream', () => {
  const lines = ['data: ' + JSON.stringify({ choices: [{ message: { content: 'full message' } }] }), ''];
  const result = parseSseReviewEvents(lines);
  assert.equal(result.chunks.join(''), 'full message');
});
