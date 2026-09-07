import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_AVATAR_KEY, readAllPetAvatars } from '../extension/lib/pet-avatar.mjs';

test('avatar roster has no synthetic default when storage is unavailable', async () => {
  assert.deepEqual(await readAllPetAvatars(null), {});
});

test('avatar roster returns only the user-saved profile avatars', async () => {
  const avatars = { custom: { slug: 'test-pet', displayName: 'Test pet', icon: 'test-icon' } };
  const storage = { get: async (key) => {
    assert.equal(key, PET_AVATAR_KEY);
    return { [PET_AVATAR_KEY]: avatars };
  } };
  assert.deepEqual(await readAllPetAvatars(storage), avatars);
});

test('avatar roster tolerates a storage failure without inventing profiles', async () => {
  assert.deepEqual(await readAllPetAvatars({ get: async () => { throw new Error('unavailable'); } }), {});
});
