import test from 'node:test';
import assert from 'node:assert/strict';

import {
  remoteAvatarImageOf,
  isInlineImage,
  selectRoomAvatarSource,
  shouldHydrateRemoteAvatar,
  isAvatarCacheFresh,
  AVATAR_CACHE_TTL_MS,
} from '../extension/lib/room-avatar.mjs';

const PNG = 'data:image/png;base64,AAAA';

test('remoteAvatarImageOf reads the first usable data-url image and ignores the rest', () => {
  assert.equal(remoteAvatarImageOf({ data: 'data:image/png;base64,AAAA' }), 'data:image/png;base64,AAAA');
  assert.equal(remoteAvatarImageOf({ dataUrl: PNG }), PNG);
  assert.equal(remoteAvatarImageOf({ icon: PNG }), PNG);
  assert.equal(remoteAvatarImageOf({ src: 'https://example.test/a.png' }), '');
  assert.equal(remoteAvatarImageOf(null), '');
  assert.equal(remoteAvatarImageOf('data:image/png;base64,AAAA'), '');
});

test('isInlineImage only accepts inline data-url images', () => {
  assert.equal(isInlineImage(PNG), true);
  assert.equal(isInlineImage(''), false);
  assert.equal(isInlineImage('https://example.test/a.png'), false);
  assert.equal(isInlineImage(undefined), false);
});

test('selectRoomAvatarSource prefers the roster inline image over the cache', () => {
  const rosterAvatar = { data: PNG };
  const selection = selectRoomAvatarSource({ rosterAvatar, cachedImage: 'data:image/png;base64,BBBB' });
  assert.equal(selection.source, 'roster');
  assert.equal(selection.hydrated, true);
  assert.equal(selection.avatar, rosterAvatar);
});

test('selectRoomAvatarSource reuses a cached server image so the real avatar sticks', () => {
  const selection = selectRoomAvatarSource({ rosterAvatar: null, cachedImage: PNG });
  assert.equal(selection.source, 'cache');
  assert.equal(selection.hydrated, true);
  assert.equal(remoteAvatarImageOf(selection.avatar), PNG);
});

test('selectRoomAvatarSource leaves the fallback only when there is truly no avatar', () => {
  const selection = selectRoomAvatarSource({ rosterAvatar: null, cachedImage: '' });
  assert.equal(selection.source, null);
  assert.equal(selection.hydrated, false);
  assert.equal(selection.avatar, null);
});

test('shouldHydrateRemoteAvatar fetches only for a bot whose avatar is server-side only', () => {
  assert.equal(shouldHydrateRemoteAvatar({ hasAvatar: true, rosterHasInline: false }), true);
  assert.equal(shouldHydrateRemoteAvatar({ hasAvatar: true, rosterHasInline: true }), false);
  assert.equal(shouldHydrateRemoteAvatar({ hasAvatar: false, rosterHasInline: false }), false);
  assert.equal(shouldHydrateRemoteAvatar({}), false);
});

test('a server-side-only avatar hydrates once then renders from cache (the old room bug)', () => {
  // Roster row: has a real avatar, but the inline row carries no image. The old
  // room header / popover / presence surfaces stopped here and kept the blobatar.
  const rosterRow = { profileName: 'roxas', hasAvatar: true, avatar: null };
  const first = selectRoomAvatarSource({ rosterAvatar: rosterRow.avatar, cachedImage: '' });
  assert.equal(first.source, null);
  assert.equal(shouldHydrateRemoteAvatar({ hasAvatar: rosterRow.hasAvatar, rosterHasInline: booleanInline(first) }), true);
  // After hydration the shared cache answers synchronously on every re-render.
  const second = selectRoomAvatarSource({ rosterAvatar: rosterRow.avatar, cachedImage: PNG });
  assert.equal(second.source, 'cache');
  assert.equal(second.avatar.image, PNG);

  function booleanInline(selection) {
    return Boolean(remoteAvatarImageOf(selection.avatar));
  }
});

test('isAvatarCacheFresh trusts a cached avatar only for the gateway cache window', () => {
  const now = 1_000_000;
  assert.equal(isAvatarCacheFresh(now - 1_000, now), true);
  assert.equal(isAvatarCacheFresh(now - AVATAR_CACHE_TTL_MS + 1, now), true);
  assert.equal(isAvatarCacheFresh(now - AVATAR_CACHE_TTL_MS, now), false);
  assert.equal(isAvatarCacheFresh(undefined, now), false);
  assert.equal(isAvatarCacheFresh(0, now), false);
  assert.equal(isAvatarCacheFresh(now + 5_000, now), false);
});
