// Stream pacing: turn a bursty stream of text chunks into a smooth
// character-by-character reveal.
//
// Fast runtimes (e.g. a local proxy serving 300-450 tokens/sec) deliver whole
// paragraphs in a single frame, so the transcript "spits it out" instead of
// looking streamed. This module buffers pushed text and reveals it at an
// adaptive, monotonic pace:
//
//   - the reveal rate never exceeds `maxCharsPerSecond` (a hard per-frame cap,
//     so a burst can never dump more than the max rate allows);
//   - it accelerates as the backlog grows (at least CATCH_UP_GAIN x
//     backlog/maxLag chars/sec, clamped to the max rate) so a burst drains
//     within roughly `maxLagMs` after the stream finishes and a long reply
//     still completes quickly;
//   - it enforces `minDurationMs` for tiny payloads by spreading the reveal
//     (pacing) rather than holding the text back until the window elapses;
//   - it reveals whole Unicode code points, so surrogate pairs and emoji are
//     never split mid-pair (multi-code-point grapheme clusters are allowed to
//     land mid-cluster, per spec).
//
// The pacer is DOM-free and dependency-free, and its clock and scheduler are
// injectable, so it is deterministic under test. It serves both the live
// token stream and the completion-reveal path:
//
//   const pacer = createStreamPacer({ onFrame: (text) => paint(text) });
//   onDelta: pacer.push(delta);        // newly arrived text
//   turn end: pacer.finish();          // drain smoothly, then done: true
//   next turn: pacer.reset();
//
// `push()` never renders synchronously: the first frame paints on the
// injected scheduler, and `onFrame` always receives the full revealed string
// (never a delta) plus `{ done, backlog }` — the caller can just assign it to
// textContent.
//
// Counts (`pending()`, `revealed()`, `meta.backlog`) are Unicode code points,
// not UTF-16 units, so they match what `Array.from(text).length` reports.

export const STREAM_PACER_DEFAULTS = Object.freeze({
  minCharsPerSecond: 420,
  maxCharsPerSecond: 2600,
  minDurationMs: 600,
  maxLagMs: 900,
});

// Backlog catch-up gain: while a backlog exists, aim to reveal at least
// gain x backlog / maxLag chars per second (clamped to the max rate). The
// desired rate only ever rises as the backlog grows and falls as it drains,
// so the curve is monotonic and cannot oscillate between frames.
const CATCH_UP_GAIN = 2;

function isHighSurrogate(point) {
  const code = point.codePointAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(point) {
  const code = point.codePointAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

export function createStreamPacer({
  onFrame = () => {},
  now = Date.now,
  schedule = (cb) => setTimeout(cb, 16),
  cancel = clearTimeout,
  minCharsPerSecond = STREAM_PACER_DEFAULTS.minCharsPerSecond,
  maxCharsPerSecond = STREAM_PACER_DEFAULTS.maxCharsPerSecond,
  minDurationMs = STREAM_PACER_DEFAULTS.minDurationMs,
  maxLagMs = STREAM_PACER_DEFAULTS.maxLagMs,
} = {}) {
  const lagMs = Number(maxLagMs) > 0 ? Number(maxLagMs) : 1;
  const minRate = Math.max(0, Number(minCharsPerSecond) || 0) / 1000;
  const maxRate = Math.max(0, Number(maxCharsPerSecond) || 0) / 1000;
  const minWindowMs = Math.max(0, Number(minDurationMs) || 0);

  let pendingPoints = [];      // pushed code points not yet revealed
  let revealedCodePoints = 0;  // code points rendered so far (monotonic per run)
  let revealedText = '';       // the full string handed to onFrame
  let timer = null;            // pending scheduled frame handle
  let closed = false;          // stream finished (finish()/flush())
  let startedAt = null;        // first push of the current run (min-duration window)
  let lastFrameAt = null;      // timestamp of the previous frame tick
  let credit = 0;              // fractional char carry: keeps the cadence smooth

  function stopTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function emit() {
    const backlog = pendingPoints.length;
    onFrame(revealedText, { done: closed && backlog === 0, backlog });
  }

  function scheduleFrame() {
    if (timer === null) timer = schedule(frame);
  }

  // Chars allowed this frame, from the real elapsed time. Three clamped terms:
  //   (a) maxRate x dt          — the hard ceiling, never exceeded;
  //       minRate x dt          — a cruise floor so small deltas keep moving;
  //       CATCH_UP_GAIN x backlog / maxLag x dt — accelerate under load;
  //   (c) backlog x dt / windowLeft — stretch tiny payloads to minDurationMs.
  function frameTake(dt, t) {
    const backlog = pendingPoints.length;
    if (backlog === 0) return 0;
    const cap = maxRate * dt;
    let budget = minRate * dt + (CATCH_UP_GAIN * backlog * dt) / lagMs;
    if (startedAt !== null) {
      const windowLeft = minWindowMs - (t - startedAt);
      if (windowLeft > 0) budget = Math.min(budget, (backlog * dt) / windowLeft);
    }
    budget = Math.min(budget, cap);
    credit = Math.min(credit + budget, cap + 1);
    let take = Math.floor(credit);
    // Frame one of a run always paints at least one char when text is
    // waiting: the min-duration window stretches the reveal, it never makes
    // the transcript sit blank.
    if (take <= 0 && revealedCodePoints === 0) take = 1;
    take = Math.min(take, backlog, Math.floor(cap));
    credit = Math.max(0, credit - take);
    return take;
  }

  function frame() {
    timer = null;
    const t = now();
    const dt = lastFrameAt === null ? 0 : Math.max(0, t - lastFrameAt);
    lastFrameAt = t;
    const take = frameTake(dt, t);
    if (take > 0) {
      revealedText += pendingPoints.slice(0, take).join('');
      pendingPoints.splice(0, take);
      revealedCodePoints += take;
      emit();
    }
    if (pendingPoints.length > 0) scheduleFrame();
  }

  // Append newly arrived text (a delta). Never renders synchronously.
  function push(text) {
    const chunk = String(text ?? '');
    if (!chunk) return;
    const wasIdle = timer === null && pendingPoints.length === 0;
    if (closed) {
      closed = false;
      if (wasIdle) startedAt = null;
    }
    if (startedAt === null) startedAt = now();
    const incoming = Array.from(chunk);
    // Heal a surrogate pair split across pushes while both halves are still
    // pending. A pair whose high half already rendered stays split (one frame
    // of a replacement glyph) rather than losing a character.
    if (pendingPoints.length > 0 && incoming.length > 0
      && isHighSurrogate(pendingPoints[pendingPoints.length - 1])
      && isLowSurrogate(incoming[0])) {
      pendingPoints[pendingPoints.length - 1] += incoming.shift();
    }
    for (const point of incoming) pendingPoints.push(point);
    if (wasIdle) {
      // Start the rate clock at the burst, not at the previous idle frame.
      lastFrameAt = now();
      credit = 0;
    }
    scheduleFrame();
  }

  // Render everything remaining immediately and stop. Terminal for the run:
  // the next push() reopens the pacer.
  function flush() {
    stopTimer();
    if (pendingPoints.length > 0) {
      revealedText += pendingPoints.join('');
      revealedCodePoints += pendingPoints.length;
      pendingPoints = [];
    }
    credit = 0;
    closed = true;
    lastFrameAt = null;
    emit();
  }

  // Close the stream without truncating: whatever is still buffered keeps
  // draining smoothly under the same adaptive pace, then `done` flips true.
  function finish() {
    closed = true;
    if (pendingPoints.length === 0) {
      stopTimer();
      emit();
      return;
    }
    scheduleFrame();
  }

  // Drop buffered text and stop. Emits nothing.
  function reset() {
    stopTimer();
    pendingPoints = [];
    revealedCodePoints = 0;
    revealedText = '';
    closed = false;
    startedAt = null;
    lastFrameAt = null;
    credit = 0;
  }

  return {
    push,
    flush,
    finish,
    reset,
    pending: () => pendingPoints.length,
    revealed: () => revealedCodePoints,
  };
}
