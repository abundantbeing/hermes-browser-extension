// Petdex pet avatars for Bot Mode.
//
// Mirrors the desktop hermes-bots plugin: a petdex spritesheet is an 8×9 grid
// of 192×208 frames; frame 0 extracted via canvas (downscaled) becomes the
// profile picture. The gallery manifest is public (petdex.dev, CORS `*`).
// Selections persist per profile in chrome.storage.local; the petdex manifest
// is cached in storage.session with a TTL to keep re-syncs fast.

export const PETDEX_MANIFEST_URL = 'https://petdex.dev/api/manifest';
export const PET_MANIFEST_CACHE_KEY = 'hermesPetdexManifest';
export const PET_AVATAR_KEY = 'hermesBotPetAvatars';
const PET_MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;

export const PET_FRAME_W = 192;
export const PET_FRAME_H = 208;
const PET_THUMB_EDGE = 96;

// Extract frame 0 of a spritesheet as a square PNG data URL. Same approach as
// the desktop PetTab (crop during decode, never materialize the full sheet).
export async function petFrameIcon(spriteUrl, fetchFn = globalThis.fetch?.bind(globalThis)) {
  if (!spriteUrl) return null;
  try {
    const response = await fetchFn(spriteUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, 0, 0, PET_FRAME_W, PET_FRAME_H);
    const canvas = document.createElement('canvas');
    canvas.width = PET_THUMB_EDGE;
    canvas.height = PET_THUMB_EDGE;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, PET_FRAME_W, PET_FRAME_H, 0, 0, PET_THUMB_EDGE, PET_THUMB_EDGE);
    bitmap.close();
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

// Fetch + cache the petdex gallery manifest. Returns [{slug, displayName,
// spritesheetUrl, curated}] sorted curated-first then alphabetical.
export async function fetchPetGallery({ storageApi = globalThis.chrome?.storage, force = false, fetchFn = globalThis.fetch?.bind(globalThis) } = {}) {
  if (!force && storageApi?.session?.get) {
    try {
      const stored = await storageApi.session.get(PET_MANIFEST_CACHE_KEY);
      const entry = stored?.[PET_MANIFEST_CACHE_KEY];
      if (entry && Array.isArray(entry.pets) && Date.now() - Number(entry.cachedAt || 0) < PET_MANIFEST_TTL_MS) {
        return entry.pets;
      }
    } catch {
      /* session storage unavailable — fetch fresh */
    }
  }
  const response = await fetchFn(PETDEX_MANIFEST_URL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`petdex-manifest-${response.status}`);
  const payload = await response.json();
  const pets = (Array.isArray(payload) ? payload : payload?.pets || [])
    .filter((pet) => pet && pet.slug && pet.spritesheetUrl)
    .map((pet) => ({
      slug: String(pet.slug),
      displayName: String(pet.displayName || pet.slug),
      spritesheetUrl: String(pet.spritesheetUrl),
      curated: typeof pet.spritesheetUrl === 'string' && pet.spritesheetUrl.includes('/curated/'),
    }))
    .sort((left, right) => {
      if (left.curated !== right.curated) return left.curated ? -1 : 1;
      return left.displayName.localeCompare(right.displayName);
    });
  if (storageApi?.session?.set) {
    try {
      await storageApi.session.set({ [PET_MANIFEST_CACHE_KEY]: { pets, cachedAt: Date.now() } });
    } catch {
      /* non-fatal */
    }
  }
  return pets;
}


export async function readPetAvatar(profileName, storageApi = globalThis.chrome?.storage?.local) {
  if (storageApi?.get && profileName) {
    try {
      const stored = await storageApi.get(PET_AVATAR_KEY);
      const map = stored?.[PET_AVATAR_KEY] || {};
      const entry = map[profileName];
      if (entry && typeof entry.icon === 'string') return entry;
    } catch {
      /* fallback */
    }
  }
  return null;
}

export async function writePetAvatar(profileName, entry, storageApi = globalThis.chrome?.storage?.local) {
  if (!storageApi?.get || !storageApi?.set || !profileName) return;
  const stored = await storageApi.get(PET_AVATAR_KEY);
  const map = stored?.[PET_AVATAR_KEY] || {};
  if (entry) {
    map[profileName] = { slug: entry.slug, displayName: entry.displayName || entry.slug, icon: entry.icon, cachedAt: Date.now() };
  } else {
    delete map[profileName];
  }
  await storageApi.set({ [PET_AVATAR_KEY]: map });
}

export async function readAllPetAvatars(storageApi = globalThis.chrome?.storage?.local) {
  if (!storageApi?.get) return {};
  try {
    const stored = await storageApi.get(PET_AVATAR_KEY);
    return { ...(stored?.[PET_AVATAR_KEY] || {}) };
  } catch {
    return {};
  }
}
