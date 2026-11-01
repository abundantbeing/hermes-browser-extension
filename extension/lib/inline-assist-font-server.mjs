// The background half of Hermes Assist's fonts: the panel lives in a web page, which may not load the
// extension's font files (they are not web-accessible, and the Rules faces are licensed), so the
// background reads the files and hands this extension's own content scripts the bytes.
import { INLINE_ASSIST_FONT_FILES } from './inline-assist-look.mjs';

export const INLINE_ASSIST_FONT_REQUEST = 'HERMES_INLINE_FONT_REQUEST';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function createInlineAssistFontServer({ runtime, fetch: fetchImpl = globalThis.fetch } = {}) {
  return async function handleInlineAssistFontRequest(message, sender) {
    if (!sender || sender.id !== runtime?.id || !sender.tab) return { ok: false, reason: 'forbidden', fonts: [] };
    const families = Array.isArray(message?.families) ? message.families : [];
    const wanted = families.filter((family, index) => Object.hasOwn(INLINE_ASSIST_FONT_FILES, family) && families.indexOf(family) === index);
    const fonts = [];
    for (const family of wanted) {
      for (const { file, weight, style } of INLINE_ASSIST_FONT_FILES[family]) {
        try {
          const response = await fetchImpl(runtime.getURL(file));
          if (!response?.ok) continue;
          fonts.push({ family, weight, style, data: toBase64(await response.arrayBuffer()) });
        } catch {
          // A face that is absent (the licensed Rules files in a clean checkout) is skipped; the stack falls
          // back to the next family.
        }
      }
    }
    return { ok: fonts.length > 0, fonts };
  };
}
