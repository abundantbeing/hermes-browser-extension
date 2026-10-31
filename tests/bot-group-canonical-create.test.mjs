import test from 'node:test';
import assert from 'node:assert/strict';

import { groupMemberCreateParams, groupMemberSessionTitle } from '../extension/lib/bot-group-runtime.mjs';

const READY = { session_authority: true };

test('group member sessions are created with canonical params on a session authority', () => {
  const title = groupMemberSessionTitle('room-9');
  assert.equal(title, 'Group: room-9');
  const authority = groupMemberCreateParams({ readyPayload: READY }, { title, profile: 'work' });
  assert.deepEqual(Object.keys(authority).sort(), ['follow_profile_config', 'hidden', 'profile', 'request_id', 'source', 'title']);
  assert.equal(authority.hidden, true);
  assert.equal(authority.follow_profile_config, true);
  assert.equal(authority.title, 'Group: room-9');
  assert.equal(authority.profile, 'work');
  assert.equal(authority.source, 'gui');
  assert.ok(!('room_plumbing' in authority));
  // On a gateway that agent_factory reads the title from, hidden plus "Group:" is room plumbing.
  assert.ok(authority.hidden && authority.title.startsWith('Group:'));

  // A legacy dashboard socket keeps the marker.
  for (const client of [{ readyPayload: { session_authority: false } }, { readyPayload: null }, {}]) {
    assert.deepEqual(groupMemberCreateParams(client, { title, profile: 'work' }), {
      title, hidden: true, profile: 'work', room_plumbing: true, follow_profile_config: true,
    });
  }
});
