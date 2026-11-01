// Signature font availability probe (v0.3.4 rider F2).
//
// The signature profile prefers Rules Variable (UI) and Rules Gothic Compressed
// (display). When either @font-face fails to load, the stack falls back to
// bundled Space Grotesk and HermesDisplay. This module answers, purely and
// without touching the DOM directly, whether the Rules faces actually resolved,
// so the settings surface can show an honest one-line note instead of pretending
// the signature face is live.
// document.fonts.check() is NOT trustworthy for this: it returns true for a
// family that has no registered @font-face at all, because the browser assumes
// a system font would render. So instead of asking "would something render?",
// the probe asks "did the licensed face actually load?". It iterates the
// FontFaceSet, finds the FontFace entries registered for each family, forces a
// load so an 'unloaded' face settles, and reads the real status ('loaded' vs
// 'error'). A family with no registered face, or one whose load failed, is
// missing; an environment without an iterable FontFaceSet reports unknown
// rather than a confident answer.
//
// Callers pass document.fonts in; the module never references a global.

export const SIGNATURE_UI_FACE = 'Rules Variable';
export const SIGNATURE_DISPLAY_FACE = 'Rules Gothic Compressed';

export function normalizeFontFamily(value) {
  return String(value ?? '').replace(/^[\s"']+|[\s"']+$/g, '').trim().toLowerCase();
}

function registeredFaces(fontSet, family) {
  if (!fontSet || typeof fontSet[Symbol.iterator] !== 'function') return null;
  const target = normalizeFontFamily(family);
  const faces = [];
  for (const face of fontSet) {
    if (face && normalizeFontFamily(face.family) === target) faces.push(face);
  }
  return faces;
}

async function probeFace(fontSet, family) {
  if (!fontSet) return 'unknown';
  let faces;
  try {
    faces = registeredFaces(fontSet, family);
  } catch {
    return 'unknown';
  }
  if (!faces) return 'unknown';
  // No registered @font-face for the family: the licensed face cannot resolve.
  if (faces.length === 0) return 'missing';
  if (faces.some((face) => face.status === 'loaded')) return 'available';
  // An unloaded face has not been requested yet, so its status proves nothing.
  // Force the load, then read the status the browser actually settled on.
  const load = typeof fontSet.load === 'function' ? fontSet.load.bind(fontSet) : null;
  if (load) {
    try {
      await load(`16px "${family}"`);
    } catch {
      // A rejected load means the face could not be fetched; read status below.
    }
    if (faces.some((face) => face.status === 'loaded')) return 'available';
  }
  if (faces.some((face) => face.status === 'error')) return 'missing';
  // Registered but still not settled: never claim certainty either way.
  return 'unknown';
}

export async function probeSignatureFonts(fontSet) {
  const ui = await probeFace(fontSet, SIGNATURE_UI_FACE);
  const display = await probeFace(fontSet, SIGNATURE_DISPLAY_FACE);
  const status = (ui === 'unknown' || display === 'unknown')
    ? 'unknown'
    : (ui === 'available' && display === 'available' ? 'licensed' : 'fallback');
  return {
    ui,
    display,
    status,
    usesFallback: status === 'fallback',
  };
}
