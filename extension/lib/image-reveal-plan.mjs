// Pairs the pictures a turn names with the image generations still waiting for them.
//
// Generations are paired with pictures in the order they started, so the first
// picture reveals in the first card, the next in the next card, and so on. The turn's
// own order comes from the recovered pictures when there are any, then the reply's.
// A picture already shown in a card is not revealed again. A picture the reply shows
// inline is `replaced`: once it has revealed, its card gives way to the reply. Any other
// picture beyond the waiting generations becomes its own card and stays. A generation
// with no picture is reported in `idle` so the caller can drop it. Pure: no DOM, no network.

import { shouldReuseImageGenerationActivity } from './common.mjs';

function uniqueSources(values) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const source = String(value || '').trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    unique.push(source);
  }
  return unique;
}

export function planImageReveals({ pendingCount = 0, inline = [], recovered = [], shown = [] } = {}) {
  const count = Math.max(0, Math.floor(Number(pendingCount) || 0));
  const replaced = uniqueSources(inline);
  const inReply = new Set(replaced);
  const already = new Set(uniqueSources(shown));
  const ordered = uniqueSources([...uniqueSources(recovered), ...replaced]).filter((source) => !already.has(source));
  const reveals = ordered.slice(0, count).map((source, placeholderIndex) => ({ placeholderIndex, source }));
  const cards = ordered.slice(count).filter((source) => !inReply.has(source));
  const idle = [];
  for (let index = reveals.length; index < count; index += 1) idle.push(index);
  return { reveals, cards, idle, replaced };
}

const FINISHED = /^(completed|finished|done|success|error|failed)$/i;

// Which generation card an image_generate event updates, or -1 for a new card. `cards` are
// in the order they started: { key, status, claimed }. An event with a call id updates the
// card with that id. One without an id updates the newest card that has no picture yet,
// as the old single-card rule did for the same sequence, unless that card had finished and
// the event starts a new call.
export function pickImageGenerationCard(cards = [], activity = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const key = String(activity?.activityId || '').trim();
  if (key) return list.findIndex((card) => card?.key === key);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const card = list[index];
    if (card?.claimed) continue;
    const previous = { rawName: 'image_generate', activityId: card?.key || '', status: card?.status || '' };
    const next = { rawName: 'image_generate', activityId: '', status: activity?.status || '' };
    return shouldReuseImageGenerationActivity(previous, next) ? index : -1;
  }
  return -1;
}

export function isFinishedImageStatus(status = '') {
  return FINISHED.test(String(status || ''));
}
