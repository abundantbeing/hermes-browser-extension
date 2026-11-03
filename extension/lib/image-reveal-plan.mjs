// Pairs the pictures a turn names with the image generations still waiting for them.
//
// Generations are paired with pictures in the order they started, so the first
// picture reveals in the first card, the next in the next card, and so on. When
// the reply names its pictures itself (`handoff`), the reply shows them inline once
// they have revealed, so nothing is added as an extra card. Otherwise a picture
// beyond the waiting generations becomes its own card. A generation with no picture
// is reported in `idle` so the caller can drop it. Pure: no DOM, no network.

export function planImageReveals({ pendingCount = 0, sources = [], handoff = false } = {}) {
  const count = Math.max(0, Math.floor(Number(pendingCount) || 0));
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(sources) ? sources : []) {
    const source = String(value || '').trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    unique.push(source);
  }
  const reveals = unique.slice(0, count).map((source, placeholderIndex) => ({ placeholderIndex, source }));
  const cards = handoff ? [] : unique.slice(count);
  const idle = [];
  for (let index = reveals.length; index < count; index += 1) idle.push(index);
  return { reveals, cards, idle, handoff: Boolean(handoff) };
}
