// Stage a pasted image through the session-authority socket for a chat that runs over REST.
//
// A REST chat has no live dashboard session, but its session is a stored session on the gateway and the
// authority socket addresses it by that stored id. `image.attach_bytes` there is staging only
// (gateway/session_images.py): it decodes the pixels, writes them to the profile's cache/images and answers
// the file's path, which the REST turn then names like a dashboard upload's path. It refuses unless this
// socket is subscribed to the session (`permission_denied` otherwise), so the viewer attaches read-only with
// session.resume (no history, no runtime started) just for the call and leaves again with session.detach.
//
// Pure: the socket is injected. Never throws.

import { WS_METHODS, isUnknownMethodError } from './gateway-ws.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function reasonOf(error) {
  return text(error?.data?.reason || error?.message).toLowerCase();
}

/**
 * @returns {Promise<{ok: true, path: string, name: string, mime: string, bytes: number}
 *   | {ok: false, reason: 'no-authority-socket'|'no-session'|'not-an-image'|'session-not-held'|'method-not-found'|'refused'|'error', detail?: string}>}
 */
export async function stageImageViaSessionSocket({ client = null, sessionId = '', dataUrl = '', filename = '' } = {}) {
  if (!client?.request || client.readyState !== 1 || client.readyPayload?.session_authority !== true) return { ok: false, reason: 'no-authority-socket' };
  const stored = text(sessionId);
  if (!stored) return { ok: false, reason: 'no-session' };
  if (!text(dataUrl).startsWith('data:image/')) return { ok: false, reason: 'not-an-image' };
  let live = stored;
  let subscriptionId = '';
  try {
    const snapshot = await client.request(WS_METHODS.sessionResume, { session_id: stored, omit_messages: true });
    live = text(snapshot?.session_id) || stored;
    subscriptionId = text(snapshot?.subscription_id);
    const result = await client.request(WS_METHODS.imageAttachBytes, {
      session_id: live,
      content_base64: dataUrl,
      filename: text(filename).slice(0, 200) || 'image.png',
    });
    if (result?.attached !== true || !text(result.path)) return { ok: false, reason: 'refused', detail: text(result?.message) };
    return { ok: true, path: text(result.path), name: text(result.name), mime: text(result.mime), bytes: Number(result.bytes) || 0 };
  } catch (error) {
    if (isUnknownMethodError(error)) return { ok: false, reason: 'method-not-found', detail: reasonOf(error) };
    if (reasonOf(error) === 'not_found') return { ok: false, reason: 'session-not-held' };
    return { ok: false, reason: 'error', detail: reasonOf(error).slice(0, 120) };
  } finally {
    if (subscriptionId) {
      try { await client.request(WS_METHODS.sessionDetach, { session_id: live, subscription_id: subscriptionId }); } catch { /* the viewer leaves with the socket anyway */ }
    }
  }
}
