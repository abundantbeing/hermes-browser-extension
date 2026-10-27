// Pure avatar-source selection for Bot Mode rooms. No DOM, no storage.
//
// Every room surface (message identity header, composer member cluster, room
// member popover, presence strip) runs through the same resolver, which starts
// from this decision: what image can be shown RIGHT NOW, and is there still a
// server-side avatar to fetch. Keeping it pure is what makes the "the real
// avatar sticks, the blobatar only shows for a bot with no avatar" contract
// unit-testable without a live gateway.

// Extract the first usable inline data-URL image from a roster row's avatar
// object (ui_meta shape). Returns '' when the object carries no real image.
export function remoteAvatarImageOf(remoteAvatar) {
  if (!remoteAvatar || typeof remoteAvatar !== 'object') return '';
  for (const key of ['data', 'image', 'dataUrl', 'data_url', 'src', 'icon']) {
    const value = remoteAvatar[key];
    if (typeof value === 'string' && value.startsWith('data:image/')) return value;
  }
  return '';
}

export function isInlineImage(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

// Choose the avatar object to render now. Precedence:
//   1. the roster row's own inline image (freshest server copy in ui_meta),
//   2. a previously hydrated server image from the shared per-connection cache,
//   3. whatever the roster row carried (usually null) so the deterministic
//      blobatar fallback renders for a bot that truly has no avatar.
// `source` is non-null when a real image is already available, which tells the
// caller that no async fetch is needed (the real avatar is already sticking).
export function selectRoomAvatarSource({ rosterAvatar = null, cachedImage = '' } = {}) {
  if (remoteAvatarImageOf(rosterAvatar)) {
    return { avatar: rosterAvatar, source: 'roster', hydrated: true };
  }
  if (isInlineImage(cachedImage)) {
    return { avatar: { image: cachedImage }, source: 'cache', hydrated: true };
  }
  return { avatar: rosterAvatar || null, source: null, hydrated: false };
}

// A server fetch is only worth starting for a bot the roster says HAS an avatar
// that is not already present inline. When the roster row is unknown (still
// loading) the caller may pass `hasAvatar: true` to attempt once, matching the
// composer cluster's long-standing behavior.
export function shouldHydrateRemoteAvatar({ hasAvatar = false, rosterHasInline = false } = {}) {
  return hasAvatar === true && rosterHasInline !== true;
}

// A hydrated server avatar is only as good as the moment it was read: the picture on the
// gateway can change afterwards (Desktop Edit Profile, a file replaced on disk), and the
// panel keeps its cache for as long as it stays open. Entries older than this are shown
// while they are refreshed, and refetched instead of trusted. The gateway itself answers
// with `Cache-Control: private, max-age=60`, so a minute is the freshest it can offer.
export const AVATAR_CACHE_TTL_MS = 60_000;

export function isAvatarCacheFresh(fetchedAt, now = Date.now(), ttlMs = AVATAR_CACHE_TTL_MS) {
  const at = Number(fetchedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  const age = now - at;
  return age >= 0 && age < ttlMs;
}
