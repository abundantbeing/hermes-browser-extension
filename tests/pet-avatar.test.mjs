import test from 'node:test';
import assert from 'node:assert/strict';

import { PET_AVATAR_KEY, readAllPetAvatars } from '../extension/lib/pet-avatar.mjs';

test('readAllPetAvatars returns only persisted profile selections', async () => {
  const selected = {
    alice: {
      slug: 'mew',
      displayName: 'Mew',
      icon: 'data:image/png;base64,selected',
      cachedAt: 42,
    },
  };
  const storageApi = {
    async get(key) {
      assert.equal(key, PET_AVATAR_KEY);
      return { [PET_AVATAR_KEY]: selected };
    },
  };

  assert.deepEqual(await readAllPetAvatars(storageApi), selected);
});

test('readAllPetAvatars has no hardcoded identity fallback', async () => {
  assert.deepEqual(await readAllPetAvatars(undefined), {});
  assert.deepEqual(await readAllPetAvatars({ get: async () => { throw new Error('unavailable'); } }), {});
});
