// Sidecar art rotation: the LOCAL SIDECAR card on the start screen, and the
// same hero art in settings, show a different illustration each time the
// panel opens. Pure list + picker so the choice is unit-testable and the
// panel only ever does one pick per load.
export const SIDECAR_ART = Object.freeze([
  'assets/img/sidecar-art/automation.webp',
  'assets/img/sidecar-art/connect.webp',
  'assets/img/sidecar-art/delegate.webp',
  'assets/img/sidecar-art/memory.webp',
  'assets/img/sidecar-art/sandbox.webp',
  'assets/img/sidecar-art/footer.webp',
  'assets/img/sidecar-art/slate.webp',
]);

/** Pick the art for this panel load, never repeating the previous choice. */
export function pickSidecarArt(random = Math.random, previous = '') {
  const pool = SIDECAR_ART.length > 1 && previous
    ? SIDECAR_ART.filter((entry) => entry !== previous)
    : SIDECAR_ART;
  const raw = typeof random === 'function' ? random() : random;
  const value = Number(raw);
  const index = Number.isFinite(value)
    ? Math.min(pool.length - 1, Math.max(0, Math.floor(value * pool.length)))
    : 0;
  return pool[index];
}

/** CSS value for the background layer that consumes the art. */
export function sidecarArtCssValue(entry = '') {
  const value = String(entry || '').trim();
  if (!value) return '';
  if (!SIDECAR_ART.includes(value)) return '';
  return `url("${value}")`;
}