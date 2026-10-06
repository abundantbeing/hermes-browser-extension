import { remoteSessionIdentity, runtimeModelFromSessionStatus, buildSessionModelSwitchRequest } from './gateway-ws.mjs';
import { profileDefaultModelFromOptions } from './model-discovery.mjs';
import { screenshotAttachParams } from './bot-browser-bridge.mjs';
import { formatGroupTurnWithBrowserContext } from './group-turn-context.mjs';

const GROUP_PROJECTION_MAX_CHARS = 48_000;
const GROUP_MEMBER_MIN = 2;
const GROUP_MEMBER_MAX = 6;
const GROUP_HISTORY_LIMIT = 16;
const GROUP_TEXT_MAX = 1_200;
const GROUP_TURN_TIMEOUT_MS = 180_000;

function clean(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Display-only room events (per-room model-change lines, "X passed" lines) live
// on the surface and must never reach a member prompt or the synced projection.
export function isRoomEventRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = clean(value.kind || value.display_kind).toLowerCase();
  if (kind === 'room-event' || kind === 'room_event') return true;
  return clean(value.role).toLowerCase() === 'system';
}

function textFromPayload(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textFromPayload).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  return textFromPayload(value.text ?? value.output_text ?? value.content ?? value.message ?? '');
}

function normalizeMember(value) {
  if (typeof value === 'string') {
    const name = clean(value).slice(0, 128);
    return name ? { name, title: '', source: '', handle: '' } : null;
  }
  const row = asObject(value);
  const name = clean(row.name || row.profile || row.profileName).slice(0, 128);
  if (!name) return null;
  return {
    name,
    title: clean(row.title || row.displayName).slice(0, 128),
    source: clean(row.source || row.connectionLabel || row.connectionId).slice(0, 128),
    handle: clean(row.handle).slice(0, 128),
  };
}

function normalizeMembers(members) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(members) ? members : []) {
    const member = normalizeMember(raw);
    const key = member?.name.toLowerCase();
    if (!member || seen.has(key)) continue;
    seen.add(key);
    result.push(member);
  }
  return result;
}

function normalizeDisplayMessage(message) {
  const row = asObject(message);
  const role = clean(row.role).toLowerCase() === 'user' ? 'user' : 'assistant';
  const content = textFromPayload(row.content).slice(0, GROUP_TEXT_MAX);
  if (!content) return null;
  const timestamp = Number(row.ts ?? row.timestamp ?? Date.now());
  const rawLabel = clean(row.roleLabel || (role === 'user' ? 'You' : 'Hermes'));
  // "default" is never a display identity. Map it to the canonical primary
  // bot name (Roxas) so group sender labels never leak the raw profile name.
  const roleLabel = /^default$/i.test(rawLabel) ? 'Roxas' : rawLabel;
  const roomEvent = isRoomEventRow(row);
  const speaker = clean(row.speaker).slice(0, 128);
  return {
    role,
    roleLabel: roleLabel.slice(0, 128),
    content,
    ts: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    ...(roomEvent ? { kind: 'room-event' } : {}),
    ...(speaker ? { speaker } : {}),
    ...(Array.isArray(row.attachments) && row.attachments.length ? { attachments: row.attachments } : {}),
  };
}

export function groupMemberSessionTitle(roomId) {
  const id = clean(roomId).slice(0, 160);
  return id ? `Group: ${id}` : '';
}

export function isGroupPassText(text) {
  const value = clean(text);
  return !value || /^\(?\s*pass\s*\)?\.?$/i.test(value);
}

// Desktop-parity @mention routing: "@name" directs the turn at one member,
// "@everyone" (or no mention) prompts every member. Returns the filtered
// member list for this turn.
export function groupMembersForTurn(text = '', members = []) {
  const value = clean(text);
  if (!/@/m.test(value)) return Array.isArray(members) ? members : [];
  if (/(^|\s)@everyone\b/i.test(value)) return Array.isArray(members) ? members : [];
  const targets = new Set();
  for (const match of value.matchAll(/@([a-z0-9_-]+)/gi)) {
    const wanted = String(match[1] || '').toLowerCase();
    if (!wanted || wanted === 'everyone') continue;
    targets.add(wanted);
  }
  if (!targets.size) return Array.isArray(members) ? members : [];
  const roster = Array.isArray(members) ? members : [];
  const matched = roster.filter((member) => {
    const name = clean(member?.name).toLowerCase();
    const title = clean(member?.title).toLowerCase();
    const isDefaultRoxas = false;
    return targets.has(name) || (title && targets.has(title)) || isDefaultRoxas;
  });
  return matched.length ? matched : roster;
}

export function groupProjectionEntryFromDisplayMessage(message = {}) {
  const row = asObject(message);
  // Display-only room events (model-change lines, pass/fail lines) are local to
  // the surface and must never be written into the cross-client projection.
  if (isRoomEventRow(row)) return null;
  const role = clean(row.role).toLowerCase() === 'user' ? 'user' : 'member';
  const content = textFromPayload(row.content).slice(0, GROUP_TEXT_MAX);
  const timestamp = Number(row.ts ?? row.timestamp ?? Date.now());
  const rawLabel = clean(row.roleLabel || (role === 'user' ? 'You' : 'Hermes'));
  // Projection entries are the cross-client record: a "default" label here
  // would sync back into the desktop roster. Normalize to the canonical name.
  const label = /^default$/i.test(rawLabel) ? 'Roxas' : rawLabel;
  // Prefer the additive `speaker` (the real profile name) over the display
  // label so the synced projection stores the actual author. `roleLabel` on
  // display records stays untouched (it is model-facing, B0.5).
  const fromName = role === 'user' ? label : (clean(row.speaker) || label);
  return {
    id: clean(row.id).slice(0, 160),
    from: {
      kind: role === 'user' ? 'user' : 'member',
      name: fromName.slice(0, 128),
      source: clean(row.source).slice(0, 128),
    },
    text: content,
    at: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    thread: clean(row.thread).slice(0, 128),
  };
}

export async function persistGroupProjectionAppend(client, {
  roomId = '',
  roomKey = '',
  profile = 'default',
  message = {},
  now = Date.now(),
} = {}) {
  if (!client?.request) throw new TypeError('A Hermes dashboard client is required.');
  const entry = groupProjectionEntryFromDisplayMessage(message);
  // Display-only room events (model-change lines) are skipped, never synced.
  if (!entry) return { ok: true, skipped: true };
  if (!entry.text) throw new Error('A non-empty group message is required.');
  const targetRoomId = clean(roomId);
  const targetRoomKey = clean(roomKey);
  const id = entry.id || `browser-group-${Math.floor(Number(now) || Date.now())}-${Math.floor(Math.random() * 1000000)}`;
  const readProjection = async () => {
    const payload = await client.request('profiles.list', { include_sessions: false });
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const owner = profiles.find((row) => clean(row?.name) === clean(profile));
    const snapshot = asObject(asObject(owner?.ui_meta)['hermes-bots-groups']);
    return {
      snapshot,
      revision: Math.max(0, Number(asObject(owner?.ui_meta_revisions)['hermes-bots-groups']) || 0),
    };
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readProjection();
    if (Number(current.snapshot.version) !== 3) throw new Error('The connected Hermes runtime does not expose a v3 group projection.');
    const rooms = asObject(current.snapshot.rooms);
    const key = targetRoomKey && rooms[targetRoomKey]
      ? targetRoomKey
      : Object.keys(rooms).find((candidate) => clean(rooms[candidate]?.roomId) === targetRoomId);
    if (!key) throw new Error('The synced group room is no longer available.');
    const room = asObject(rooms[key]);
    const log = Array.isArray(room.log) ? room.log : [];
    if (log.some((candidate) => clean(candidate?.id) === id && clean(candidate?.text) === entry.text)) {
      return { ok: true, id, roomKey: key, revision: current.revision };
    }
    const nextEntry = { ...entry, id };
    const nextRoom = {
      ...room,
      log: [...log, nextEntry].slice(-GROUP_HISTORY_LIMIT),
      revision: Math.max(0, Number(room.revision) || 0) + 1,
    };
    const nextSnapshot = {
      ...current.snapshot,
      updatedAt: Math.floor(Number(now) || Date.now()),
      rooms: { ...rooms, [key]: nextRoom },
    };
    let serializedSize = 0;
    try {
      serializedSize = JSON.stringify(nextSnapshot).length;
    } catch {
      serializedSize = GROUP_PROJECTION_MAX_CHARS + 1;
    }
    if (serializedSize > GROUP_PROJECTION_MAX_CHARS) throw new Error('The group projection reached its published size limit.');

    const result = await client.request('profiles.configure', {
      name: profile,
      ui_meta: { 'hermes-bots-groups': nextSnapshot },
      ui_meta_expected_revisions: { 'hermes-bots-groups': current.revision },
    });
    if (result?.applied?.ui_meta !== true) {
      if (result?.applied?.ui_meta_conflicts && attempt === 0) continue;
      throw new Error('Hermes rejected the group projection update.');
    }
    const appliedRevision = Number(result?.applied?.ui_meta_revisions?.['hermes-bots-groups']);
    if (appliedRevision !== current.revision + 1) throw new Error('Hermes did not advance the group projection revision.');

    const confirmed = await readProjection();
    const confirmedRooms = asObject(confirmed.snapshot.rooms);
    const confirmedLog = Array.isArray(confirmedRooms[key]?.log) ? confirmedRooms[key].log : [];
    if (confirmedLog.some((candidate) => clean(candidate?.id) === id && clean(candidate?.text) === entry.text)) {
      return { ok: true, id, roomKey: key, revision: appliedRevision };
    }
    if (attempt === 0) continue;
    throw new Error('Hermes did not confirm the group projection message.');
  }
  throw new Error('Hermes group projection write could not be confirmed.');
}

export async function persistGroupProjectionCreate(client, {
  roomId = '',
  name = '',
  members = [],
  image = null,
  profile = 'default',
  now = Date.now(),
} = {}) {
  if (!client?.request) throw new TypeError('A Hermes dashboard client is required.');
  const targetRoomId = clean(roomId).slice(0, 160);
  if (!targetRoomId) throw new Error('A group room id is required.');
  const roomName = clean(name).slice(0, 64) || targetRoomId;
  const roster = [...new Set((Array.isArray(members) ? members : [])
    .map((member) => clean(typeof member === 'string' ? member : member?.name))
    .filter(Boolean))];
  if (roster.length < GROUP_MEMBER_MIN || roster.length > GROUP_MEMBER_MAX) {
    throw new Error('A group chat needs 2 to 6 bots.');
  }
  const key = `id:${targetRoomId}`;
  const stamp = Math.floor(Number(now) || Date.now());

  const readProjection = async () => {
    const payload = await client.request('profiles.list', { include_sessions: false });
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const owner = profiles.find((row) => Number(asObject(asObject(row?.ui_meta)['hermes-bots-groups']).version) === 3)
      || profiles.find((row) => clean(row?.name) === clean(profile))
      || profiles.find((row) => clean(row?.name) === 'default')
      || profiles[0];
    const snapshot = asObject(asObject(owner?.ui_meta)['hermes-bots-groups']);
    return {
      ownerName: clean(owner?.name) || clean(profile) || 'default',
      profiles,
      snapshot: Number(snapshot.version) === 3 ? snapshot : { version: 3, updatedAt: stamp, rooms: {}, deleted: {} },
      revision: Math.max(0, Number(asObject(owner?.ui_meta_revisions)['hermes-bots-groups']) || 0),
    };
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readProjection();
    const rooms = asObject(current.snapshot.rooms);
    if (rooms[key]) return { ok: true, roomKey: key, revision: current.revision, ownerName: current.ownerName };
    const room = {
      roomId: targetRoomId,
      name: roomName,
      members: roster.map((memberName) => ({ name: memberName, handle: memberName })),
      log: [],
      revision: 1,
      ...(typeof image === 'string' && image ? { image: image.slice(0, 500_000) } : {}),
    };
    const nextDeleted = { ...asObject(current.snapshot.deleted) };
    delete nextDeleted[key];
    const nextSnapshot = {
      ...current.snapshot,
      version: 3,
      updatedAt: stamp,
      rooms: { ...rooms, [key]: room },
      deleted: nextDeleted,
    };
    let serializedSize = 0;
    try {
      serializedSize = JSON.stringify(nextSnapshot).length;
    } catch {
      serializedSize = GROUP_PROJECTION_MAX_CHARS + 1;
    }
    if (serializedSize > GROUP_PROJECTION_MAX_CHARS) throw new Error('The group projection reached its published size limit.');

    const result = await client.request('profiles.configure', {
      name: current.ownerName,
      ui_meta: { 'hermes-bots-groups': nextSnapshot },
      ui_meta_expected_revisions: { 'hermes-bots-groups': current.revision },
    });
    if (result?.applied?.ui_meta !== true) {
      if (result?.applied?.ui_meta_conflicts && attempt === 0) continue;
      throw new Error('Hermes rejected the new group room.');
    }
    const appliedRevision = Number(result?.applied?.ui_meta_revisions?.['hermes-bots-groups']);
    const confirmed = await readProjection();
    if (!asObject(confirmed.snapshot.rooms)[key]) {
      if (attempt === 0) continue;
      throw new Error('Hermes did not confirm the new group room.');
    }
    // Mirror membership onto each member profile, as rename does. Best-effort:
    // the room itself is already durable in the projection.
    for (const memberName of roster) {
      if (memberName === current.ownerName) continue;
      const memberProfile = confirmed.profiles.find((row) => clean(row?.name) === memberName);
      if (!memberProfile) continue;
      const currentGroups = Array.isArray(asObject(memberProfile.ui_meta).groups) ? asObject(memberProfile.ui_meta).groups : [];
      const nextGroups = [...new Set([...currentGroups.map(clean).filter(Boolean), roomName])];
      try {
        await client.request('profiles.configure', { name: memberName, ui_meta: { groups: nextGroups, group: nextGroups[0] || null } });
      } catch {
        /* best-effort member sync */
      }
    }
    return {
      ok: true,
      roomKey: key,
      revision: Number.isFinite(appliedRevision) ? appliedRevision : confirmed.revision,
      ownerName: current.ownerName,
    };
  }
  throw new Error('Hermes group room creation could not be confirmed.');
}

export async function persistGroupProjectionUpdate(client, {
  roomId = '',
  roomKey = '',
  profile = 'default',
  newName = undefined,
  newImage = undefined,
  now = Date.now(),
} = {}) {
  if (!client?.request) throw new TypeError('A Hermes dashboard client is required.');
  const targetRoomId = clean(roomId);
  const targetRoomKey = clean(roomKey);
  const cleanNewName = newName !== undefined ? clean(newName).slice(0, 64) : undefined;
  if (newName !== undefined && !cleanNewName) throw new Error('A valid group chat name is required.');

  const readProjection = async () => {
    const payload = await client.request('profiles.list', { include_sessions: false });
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    // The v3 group projection is hosted on whichever profile holds 'hermes-bots-groups' in ui_meta,
    // which is canonical 'default' (or the profile with version 3 projection).
    const owner = profiles.find((row) => asObject(asObject(row?.ui_meta)['hermes-bots-groups']).version === 3)
      || profiles.find((row) => clean(row?.name) === 'default')
      || profiles.find((row) => clean(row?.name) === clean(profile))
      || profiles[0];
    const snapshot = asObject(asObject(owner?.ui_meta)['hermes-bots-groups']);
    const ownerName = clean(owner?.name) || clean(profile) || 'default';
    return {
      ownerName,
      profiles,
      snapshot: Number(snapshot.version) === 3 ? snapshot : { version: 3, updatedAt: Date.now(), rooms: {}, deleted: {} },
      revision: Math.max(0, Number(asObject(owner?.ui_meta_revisions)['hermes-bots-groups']) || 0),
    };
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readProjection();
    const rooms = asObject(current.snapshot.rooms);
    // Locate the room: by exact roomKey, by roomId, by name:* prefix, or by room name match
    let key = '';
    if (targetRoomKey && rooms[targetRoomKey]) {
      key = targetRoomKey;
    } else if (targetRoomId && rooms[targetRoomId]) {
      key = targetRoomId;
    } else if (targetRoomId && rooms[`id:${targetRoomId}`]) {
      key = `id:${targetRoomId}`;
    } else if (targetRoomId && rooms[`name:${targetRoomId}`]) {
      key = `name:${targetRoomId}`;
    } else {
      key = Object.keys(rooms).find((candidate) => {
        const r = asObject(rooms[candidate]);
        if (targetRoomId && clean(r.roomId) === targetRoomId) return true;
        if (targetRoomId && clean(r.name).toLowerCase() === targetRoomId.toLowerCase()) return true;
        if (targetRoomKey && clean(r.roomKey) === targetRoomKey) return true;
        if (targetRoomId && candidate.toLowerCase() === `name:${targetRoomId.toLowerCase()}`) return true;
        if (targetRoomId && candidate.toLowerCase() === `id:${targetRoomId.toLowerCase()}`) return true;
        return false;
      }) || '';
    }

    const room = key && rooms[key] ? asObject(rooms[key]) : { name: targetRoomId, members: [], log: [] };
    const currentName = clean(room.name) || targetRoomId;
    const targetName = cleanNewName !== undefined ? cleanNewName : currentName;
    const currentImage = typeof room.image === 'string' ? room.image : null;
    const targetImage = newImage !== undefined ? (newImage ? String(newImage).slice(0, 500_000) : null) : currentImage;

    if (key && currentName === targetName && currentImage === targetImage) {
      return { ok: true, roomKey: key, newName: targetName, newImage: targetImage, revision: current.revision };
    }

    // Determine target room key (Desktop re-keys name-based rooms on rename)
    const targetKey = (!key || key.startsWith('name:')) ? `name:${targetName}` : key;

    const nextRoom = {
      ...room,
      name: targetName,
      ...(targetImage ? { image: targetImage } : {}),
      revision: Math.max(0, Number(room.revision) || 0) + 1,
    };
    if (!targetImage) delete nextRoom.image;

    const nextRooms = { ...rooms };
    if (key && targetKey !== key) {
      delete nextRooms[key];
    }
    nextRooms[targetKey] = nextRoom;

    const nextDeleted = { ...asObject(current.snapshot.deleted) };
    if (key && targetKey !== key) {
      nextDeleted[key] = Math.floor(Number(now) || Date.now());
    }

    const nextSnapshot = {
      ...current.snapshot,
      version: 3,
      updatedAt: Math.floor(Number(now) || Date.now()),
      rooms: nextRooms,
      deleted: nextDeleted,
    };
    const result = await client.request('profiles.configure', {
      name: current.ownerName,
      ui_meta: { 'hermes-bots-groups': nextSnapshot },
      ui_meta_expected_revisions: { 'hermes-bots-groups': current.revision },
    });
    if (result?.applied?.ui_meta !== true) {
      if (result?.applied?.ui_meta_conflicts && attempt === 0) continue;
      throw new Error('Hermes rejected the group projection update.');
    }
    const appliedRevision = Number(result?.applied?.ui_meta_revisions?.['hermes-bots-groups']);
    if (currentName && targetName && currentName !== targetName) {
      const members = Array.isArray(room.members) ? room.members : [];
      for (const member of members) {
        const memberName = clean(member?.name || member);
        if (!memberName || memberName === current.ownerName) continue;
        const memberProfile = current.profiles.find((p) => clean(p?.name) === memberName);
        if (!memberProfile) continue;
        const currentGroups = Array.isArray(asObject(memberProfile.ui_meta).groups)
          ? asObject(memberProfile.ui_meta).groups
          : [];
        const nextGroups = [...new Set(currentGroups.map((g) => (clean(g) === currentName ? targetName : clean(g))))];
        try {
          await client.request('profiles.configure', {
            name: memberName,
            ui_meta: { groups: nextGroups, group: nextGroups[0] || null },
          });
        } catch {
          /* best-effort member sync */
        }
      }
    }
    return { ok: true, roomKey: targetKey, newName: targetName, newImage: targetImage, revision: appliedRevision };
  }
  throw new Error('Hermes group projection update could not be confirmed.');
}

export async function persistGroupProjectionRename(client, options = {}) {
  return persistGroupProjectionUpdate(client, options);
}
function groupLine(message, viewerName = '') {
  if (isRoomEventRow(message)) return '';
  const role = clean(message.role).toLowerCase();
  const label = clean(message.roleLabel || (role === 'user' ? 'You' : 'Hermes'));
  const suffix = role === 'assistant' && label === viewerName ? ' (you)' : '';
  return `${label}${suffix}: ${clean(message.content)}`;
}

function buildGroupMemberPrompt({ roomId, groupName, members, viewer, messages }) {
  const peers = members
    .filter((member) => member.name !== viewer.name)
    .map((member) => member.title ? `${member.title} (@${member.name})` : `@${member.name}`)
    .join(', ');
  const lines = messages
    .filter((message) => !isRoomEventRow(message))
    .slice(-GROUP_HISTORY_LIMIT)
    .map((message) => `  ${groupLine(message, viewer.name)}`);

  const lastUserMsg = [...messages].reverse().find((m) => clean(m.role).toLowerCase() === 'user');
  const userText = clean(lastUserMsg?.content);
  const isEveryone = /(^|\s)@everyone\b/i.test(userText);
  const viewerAlias = viewer.name;
  const isDirectlyAddressed = new RegExp(`(^|\\s)@(?:${viewer.name}|${viewerAlias})\\b`, 'i').test(userText);

  const rules = [
    'Rules for this room:',
    '- Reply with ONE conversational message if you have something valuable to contribute, a point to build on, or if you were addressed.',
    (isEveryone || isDirectlyAddressed)
      ? `- IMPORTANT: The user explicitly called ${isEveryone ? '@everyone' : `@${viewerAlias}`} in this turn. You are directly called to reply — share your own perspective, answer, or check-in from your persona (@${viewerAlias}). Do NOT pass.`
      : '- If you have nothing new to add, reply with exactly "(pass)". Passing lets the conversation settle.',
    '- Mention a teammate as @name only when their input is needed. Do not repeat points already made.',
    '- Never reveal content from private one-to-one chats. Your reply is shown to the room as written.',
  ];

  return [
    `[Group chat: "${clean(groupName) || clean(roomId)}"] You are @${viewerAlias}, one participant in a group chat with ${peers || 'no other agents'} and the user.`,
    '',
    'New messages in the room since your last turn (oldest first):',
    ...lines,
    '',
    ...rules,
  ].join('\n');
}

function sessionRows(result) {
  const value = asObject(result);
  if (Array.isArray(result)) return result;
  if (Array.isArray(value.sessions)) return value.sessions;
  if (Array.isArray(value.data)) return value.data;
  return [];
}

function sessionIdentity(result, fallback = '', profile = '') {
  const identity = remoteSessionIdentity(result, fallback);
  if (!identity.liveId) return null;
  if (identity.profile && identity.profile !== profile) {
    throw new Error(`Hermes profile acknowledgement mismatch for ${profile}.`);
  }
  return {
    liveId: identity.liveId,
    storedId: identity.storedId,
    profile,
  };
}

function safeFailure(error) {
  const message = error?.message || error?.data?.reason || error;
  return clean(message).slice(0, 240) || 'Group member turn failed.';
}

function isSessionGoneError(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  return code === 4001 || /session not found|unknown session|session.*reaped/i.test(safeFailure(error));
}

function isSessionCreateConflict(error) {
  const code = Number(error?.rpcCode ?? error?.code ?? error?.httpStatus);
  return [409, 4065, 4091].includes(code) || /already exists|duplicate|unique.*title|title.*exists/i.test(safeFailure(error));
}

async function resumeMemberSession(client, storedId, profile, title) {
  const resumed = await client.request('session.resume', {
    session_id: storedId,
    profile,
    omit_messages: true,
  });
  const identity = sessionIdentity(resumed, storedId, profile);
  if (!identity) throw new Error(`Hermes did not return a live session for ${profile}.`);
  return { ...identity, title };
}

async function findMemberSession(client, title, profile) {
  const listed = await client.request('session.list', {
    title,
    include_hidden: true,
    profile,
  });
  return sessionRows(listed).find((row) => clean(row?.title) === title) || sessionRows(listed)[0] || null;
}

async function resolveMemberSession(client, roomId, member, { createIfMissing = true } = {}) {
  const title = groupMemberSessionTitle(roomId);
  if (!title) throw new Error('A group room id is required.');
  const profile = member.name;
  const candidate = await findMemberSession(client, title, profile);
  if (candidate?.id) return resumeMemberSession(client, clean(candidate.id), profile, title);
  if (!createIfMissing) {
    const error = new Error(`Existing group session not found for ${profile}.`);
    error.code = 'no-session';
    throw error;
  }

  try {
    const created = await client.request('session.create', {
      title,
      hidden: true,
      profile,
      room_plumbing: true,
      follow_profile_config: true,
    });
    const identity = sessionIdentity(created, '', profile);
    if (!identity) throw new Error(`Hermes did not create a live group session for ${profile}.`);
    return { ...identity, title };
  } catch (error) {
    if (!isSessionCreateConflict(error)) throw error;
    const adopted = await findMemberSession(client, title, profile);
    if (!adopted?.id) throw error;
    return resumeMemberSession(client, clean(adopted.id), profile, title);
  }
}


// Stage this turn's explicit tab screenshots on the member session through the
// gateway image RPC. Runs AFTER the model re-apply and BEFORE prompt.submit on
// every attempt. A partial failure rolls back whatever was already staged and
// rethrows, so a member is never prompted with a silently missing screenshot
// (text-only downgrade). Returns the staged gateway paths for later rollback.
async function stageMemberScreenshots(client, sessionId, attachments = []) {
  const staged = [];
  try {
    for (const attachment of attachments) {
      const params = screenshotAttachParams(attachment, sessionId);
      if (!params) throw new Error('A browser tab screenshot attachment was invalid.');
      const result = await client.request('image.attach_bytes', params);
      if (result?.attached !== true) throw new Error('Hermes did not attach the browser tab screenshot.');
      if (result?.path) staged.push(String(result.path));
    }
    return staged;
  } catch (error) {
    for (const path of staged) {
      try {
        await client.request('image.detach', { session_id: sessionId, path });
      } catch {
        /* best-effort rollback */
      }
    }
    throw error;
  }
}

function waitForMemberCompletion(client, liveId, { signal, timeoutMs = GROUP_TURN_TIMEOUT_MS, text = '', onActivity, attachImages } = {}) {
  if (typeof client?.on !== 'function') return Promise.reject(new Error('The Hermes dashboard transport cannot stream group turns.'));
  return new Promise((resolve, reject) => {
    let finalText = '';
    let settled = false;
    let promptSubmitted = false;
    const stagedPaths = [];
    const offs = [];
    const timer = globalThis.setTimeout(() => finish(reject, new Error('Group member response timed out.')), timeoutMs);
    const matches = (event) => clean(event?.sessionId || event?.session_id) === liveId;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      for (const off of offs) off?.();
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    // A staged screenshot that never made it into a submitted turn is removed
    // from the member session so it cannot leak into the NEXT turn.
    const detachStaged = async () => {
      for (const path of stagedPaths.splice(0)) {
        try {
          await client.request('image.detach', { session_id: liveId, path });
        } catch {
          /* best-effort rollback */
        }
      }
    };
    const onAbort = () => {
      client.request('session.interrupt', { session_id: liveId }).catch(() => {});
      detachStaged().finally(() => finish(reject, new DOMException('Group turn stopped by user', 'AbortError')));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    offs.push(client.on('tool.start', (event) => {
      if (matches(event)) {
        const toolName = clean(event.payload?.tool || event.payload?.name);
        onActivity?.({ kind: 'tool_start', tool: toolName });
      }
    }));
    offs.push(client.on('tool.complete', (event) => {
      if (matches(event)) {
        const toolName = clean(event.payload?.tool || event.payload?.name);
        onActivity?.({ kind: 'tool_complete', tool: toolName });
      }
    }));
    offs.push(client.on('message.delta', (event) => {
      if (matches(event)) {
        const delta = textFromPayload(event.payload?.text ?? event.payload?.content);
        finalText += delta;
        const isPass = /^\s*\(?\s*p?a?s?s?\s*\)?\s*$/i.test(finalText);
        if (!isPass && finalText.trim().length > 0) {
          onActivity?.({ kind: 'typing', delta, text: finalText });
        }
      }
    }));
    offs.push(client.on('message.complete', (event) => {
      if (!matches(event)) return;
      const payload = asObject(event.payload);
      if (payload.error || payload.status === 'error' || payload.ok === false) {
        finish(reject, new Error(safeFailure(payload.error || payload.message || 'Group member response failed.')));
        return;
      }
      const text = textFromPayload(payload.text ?? payload.content ?? payload.output_text) || finalText;
      finish(resolve, text);
    }));
    offs.push(client.on('error', (event) => {
      if (matches(event)) finish(reject, new Error(safeFailure(event.payload || event)));
    }));
    const submit = async () => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (typeof attachImages === 'function') {
        const staged = await attachImages();
        if (Array.isArray(staged)) stagedPaths.push(...staged.filter(Boolean));
      }
      if (signal?.aborted) {
        await detachStaged();
        finish(reject, new DOMException('Group turn stopped by user', 'AbortError'));
        return;
      }
      const accepted = await client.request('prompt.submit', {
        session_id: liveId,
        text,
      });
      promptSubmitted = true;
      return accepted;
    };
    submit().catch(async (error) => {
      if (!promptSubmitted) await detachStaged();
      finish(reject, error);
    });
  });
}

async function submitMemberPrompt(client, session, prompt, { signal, timeoutMs, onActivity, onAttempt, screenshotAttachments = [] } = {}) {
  let current = session;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The per-attempt hook runs before EVERY submission attempt — including a
    // rebound after a 4001 — so a member is never prompted on a session the
    // hook did not configure. The caller commits the resolved session to its
    // cache BEFORE the hook runs. A rejected hook aborts this attempt (and the
    // member's turn) without submitting a prompt.
    if (typeof onAttempt === 'function') await onAttempt({ ...current });
    try {
      return await waitForMemberCompletion(client, current.liveId, {
        signal,
        timeoutMs,
        text: prompt,
        onActivity,
        // Screenshots attach AFTER the model re-apply hook above and BEFORE
        // prompt.submit, on every attempt. A failed attach rejects the attempt
        // instead of silently downgrading to a text-only prompt.
        attachImages: screenshotAttachments.length
          ? () => stageMemberScreenshots(client, current.liveId, screenshotAttachments)
          : null,
      });
    } catch (error) {
      if (attempt > 0 || !isSessionGoneError(error) || !current.storedId) throw error;
      current = await resumeMemberSession(client, current.storedId, current.profile, current.title);
    }
  }
  throw new Error('Hermes could not recover the group member session.');
}

export function createBotGroupRuntime({
  client,
  onActivity = () => undefined,
  onMessage = () => undefined,
  persist = async () => undefined,
  beforeMemberTurn = null,
  now = () => Date.now(),
  timeoutMs = GROUP_TURN_TIMEOUT_MS,
} = {}) {
  if (!client?.request) throw new TypeError('A Hermes dashboard client is required.');

  // Per-member resolved session cache. A room turn otherwise re-resolves every
  // member's live session on each send; caching removes those setup round
  // trips after the first resolution. Only positive resolutions are cached (a
  // missing session is never cached as an absent one), and an entry is dropped
  // whenever the live session is gone and cannot be recovered.
  const sessionCache = new Map();
  // Per-room cache of the exact browser context and screenshots captured for the
  // most recent turn. Runtime-only: a retry reuses them verbatim rather than
  // capturing a different page later, and they are never persisted.
  const turnContextByRoom = new Map();
  const turnScreenshotsByRoom = new Map();
  let activeMember = '';
  // A turn (send or retry) is "running" for its whole member loop, not just
  // during one member's submit, so a retry can be refused while ANY turn runs.
  // `retryMemberName` marks the member whose retry is in flight so a second
  // retry (or a re-entrant one) cannot double-fire.
  let turnRunning = false;
  let retryMemberName = '';

  function sessionSnapshot(entry) {
    return entry ? { liveId: entry.liveId, storedId: entry.storedId, profile: entry.profile, title: entry.title } : null;
  }

  function rememberSession(session) {
    if (!session?.liveId) return session;
    sessionCache.set(clean(session.profile), {
      liveId: session.liveId,
      storedId: session.storedId,
      profile: session.profile,
      title: session.title,
    });
    return session;
  }

  async function memberSessionFor(roomId, member, { createIfMissing = true } = {}) {
    const cached = sessionCache.get(member.name);
    if (cached) return sessionSnapshot(cached);
    return rememberSession(await resolveMemberSession(client, roomId, member, { createIfMissing }));
  }

  function assertMemberIdle(name) {
    if (activeMember && activeMember === name) {
      const error = new Error(`${name} is replying right now; wait for its turn to finish.`);
      error.code = 'member-busy';
      throw error;
    }
  }

  async function prepare({ roomId = '', members = [] } = {}) {
    const roster = normalizeMembers(members);
    if (roster.length < GROUP_MEMBER_MIN || roster.length > GROUP_MEMBER_MAX) {
      return { ok: false, reason: 'member-count', sessions: [], failures: [] };
    }
    const sessions = [];
    const failures = [];
    for (const member of roster) {
      try {
        // Commit the resolved session to the positive cache so a later send()
        // (or readMemberModel) reuses it instead of re-resolving. A missing
        // session still throws `no-session` and is never cached as absent.
        sessions.push(rememberSession(await resolveMemberSession(client, roomId, member, { createIfMissing: false })));
      } catch (error) {
        failures.push({ member: member.name, error: safeFailure(error) });
      }
    }
    return { ok: failures.length === 0, sessions, failures };
  }

  async function send({ roomId = '', groupName = '', members = [], messages = [], text = '', signal, thread = '', browserContext = null, screenshotAttachments = [] } = {}) {
    const roster0 = normalizeMembers(members);
    // Thread id for this turn's entries: an explicit thread (reply inside an
    // expanded thread) or a fresh generated id (new thread from the room view).
    const turnThread = clean(thread).slice(0, 128) || `t${Number(now()).toString(36)}-${Math.floor(Math.random() * 1000000).toString(36)}`;
    const baseMessages = (Array.isArray(messages) ? messages : []).map(normalizeDisplayMessage).filter(Boolean).slice(-GROUP_HISTORY_LIMIT);
    const trimmed = clean(text).slice(0, GROUP_TEXT_MAX);
    if (roster0.length < GROUP_MEMBER_MIN || roster0.length > GROUP_MEMBER_MAX) {
      return { ok: false, reason: 'member-count', messages: baseMessages, failures: [] };
    }
    if (!trimmed) return { ok: false, reason: 'empty', messages: baseMessages, failures: [] };
    if (signal?.aborted) return { ok: false, reason: 'aborted', messages: baseMessages, failures: [] };

    const working = [...baseMessages, {
      role: 'user',
      roleLabel: 'You',
      content: trimmed,
      ts: Number(now()) || Date.now(),
      thread: turnThread,
    }];
    await onMessage(working.at(-1), { kind: 'user' });
    const failures = [];
    const syncFailures = [];
    // The synced projection is a mirror of the room, never a gate on it: a
    // failed write must not stop members from replying. Each failure is
    // reported so the surface can show an honest sync state.
    const mirror = async (meta) => {
      try {
        await persist(working, meta);
      } catch (error) {
        const failure = { stage: meta.kind, ...(meta.member ? { member: meta.member } : {}), error: safeFailure(error) };
        syncFailures.push(failure);
        await onActivity({ kind: 'sync_failed', ...failure });
      }
    };
    await mirror({ kind: 'user', roomId: clean(roomId) });

    // Desktop-parity @mention routing: "@name" directs the turn at one member,
    // "@everyone" or no mention prompts all members.
    const roster = groupMembersForTurn(trimmed, roster0);

    // The exact browser context + screenshots for this turn are resolved ONCE
    // and cached per room (runtime-only). A disabled context is normalized to
    // null so the group prompt stays byte-identical to a session with no
    // browser context at all. Never written into `working` or the projection.
    const effectiveContext = browserContext?.enabled === true ? browserContext : null;
    const screenshots = Array.isArray(screenshotAttachments) ? screenshotAttachments : [];
    turnContextByRoom.set(clean(roomId), effectiveContext);
    turnScreenshotsByRoom.set(clean(roomId), screenshots);

    // Announce the full routed roster up front so the presence strip can show
    // who is queued before the first member begins (B2.1).
    await onActivity({
      kind: 'turn_start',
      thread: turnThread,
      members: roster.map((member) => ({ member: member.name, roleLabel: member.title || member.name })),
    });

    // A retry must not start while this turn's member loop is still draining.
    turnRunning = true;
    try {
    for (const member of roster) {
      if (signal?.aborted) break;
      await onActivity({ kind: 'working', member: member.name, roleLabel: member.title || member.name });
      activeMember = member.name;
      try {
        const session = await memberSessionFor(roomId, member);
        const basePrompt = buildGroupMemberPrompt({ roomId, groupName, members: roster, viewer: member, messages: working });
        // Same turn context for EVERY addressed member; a full BCP v2 envelope
        // (byte-identical base prompt when the context is disabled).
        const prompt = formatGroupTurnWithBrowserContext(basePrompt, effectiveContext);
        const reply = await submitMemberPrompt(client, session, prompt, {
          signal,
          timeoutMs,
          screenshotAttachments: screenshots,
          onActivity: (act) => onActivity({ ...act, member: member.name, roleLabel: member.title || member.name }),
          // Outcome R guard: a per-room model pick is dropped on session.resume,
          // so the surface re-applies it before EVERY submission attempt (the
          // first, and any rebound after a 4001). The resolved session is
          // committed to the cache before the hook runs, so the hook reads the
          // exact session it is about to configure. A rejected hook fails the
          // member (with the reason) and skips its turn rather than silently
          // answering on the wrong model.
          onAttempt: async (attemptSession) => {
            rememberSession(attemptSession);
            if (typeof beforeMemberTurn === 'function') {
              await beforeMemberTurn({ ...member }, { ...attemptSession });
            }
          },
        });
        if (!isGroupPassText(reply)) {
          const message = {
            role: 'assistant',
            roleLabel: member.title || member.name,
            speaker: member.name,
            content: clean(reply).slice(0, GROUP_TEXT_MAX),
            ts: Number(now()) || Date.now(),
            thread: turnThread,
            ...(member.source ? { source: member.source } : {}),
          };
          working.push(message);
          await onMessage(message, { kind: 'reply', member: member.name, roleLabel: member.title || member.name });
          await mirror({ kind: 'reply', member: member.name, roomId: clean(roomId) });
        } else {
          await onActivity({ kind: 'pass', member: member.name, roleLabel: member.title || member.name });
        }
      } catch (error) {
        if (isSessionGoneError(error)) sessionCache.delete(member.name);
        const failure = { member: member.name, roleLabel: member.title || member.name, error: safeFailure(error) };
        failures.push(failure);
        await onActivity({ kind: 'failed', ...failure });
      } finally {
        activeMember = '';
      }
    }
    } finally {
      turnRunning = false;
    }
    await onActivity({ kind: 'idle' });

    return { ok: true, messages: working, failures, syncFailures };
  }

  // Re-run ONE member's turn after a failure. Uses the exact same session
  // resolution and beforeMemberTurn (per-room model re-apply) path as a normal
  // turn, so the stored per-room model binding is re-verified before the prompt
  // is submitted, and moves the member through the presence reducer
  // (retry/queued -> working/typing -> reply|pass|failed -> idle). Refused
  // while any turn runs (`turn-busy`) and against a second in-flight retry
  // (`retry-busy`) so it cannot overlap a turn or double-fire.
  async function retryMember({ roomId = '', groupName = '', members = [], messages = [], member, text = '', thread = '', signal, browserContext = null, screenshotAttachments = [] } = {}) {
    const roster = normalizeMembers(members);
    const target = normalizeMember(member);
    const found = target ? roster.find((entry) => entry.name === target.name) : null;
    const baseMessages = (Array.isArray(messages) ? messages : []).map(normalizeDisplayMessage).filter(Boolean).slice(-GROUP_HISTORY_LIMIT);
    if (!found) return { ok: false, reason: 'member', messages: baseMessages, failures: [] };
    if (signal?.aborted) return { ok: false, reason: 'aborted', messages: baseMessages, failures: [] };
    if (turnRunning || retryMemberName) {
      const error = new Error(turnRunning
        ? 'A group turn is already running; wait for it to finish before retrying.'
        : `${retryMemberName || 'A member'} is already being retried.`);
      error.code = turnRunning ? 'turn-busy' : 'retry-busy';
      throw error;
    }

    const name = found.name;
    const label = found.title || found.name;
    const turnThread = clean(thread).slice(0, 128) || 'main';
    // Fold the original user prompt into the context only when it is not
    // already the last user turn, so the member sees the same ask it failed on
    // without the prompt being duplicated in the room history.
    const working = [...baseMessages];
    const promptText = clean(text).slice(0, GROUP_TEXT_MAX);
    const last = working.at(-1);
    const hasPrompt = Boolean(promptText)
      && clean(last?.role).toLowerCase() === 'user'
      && clean(last?.content) === promptText;
    if (promptText && !hasPrompt) {
      working.push({ role: 'user', roleLabel: 'You', content: promptText, ts: Number(now()) || Date.now(), thread: turnThread });
    }

    const failures = [];
    const syncFailures = [];
    // Reuse the runtime-only per-room context from the most recent turn. A
    // retry MUST NOT capture a different page later: an explicitly-supplied
    // enabled context wins, otherwise the cached one is used verbatim.
    const cachedContext = turnContextByRoom.get(clean(roomId)) || null;
    const effectiveContext = browserContext?.enabled === true ? browserContext : cachedContext;
    const requestedShots = Array.isArray(screenshotAttachments) ? screenshotAttachments : [];
    const screenshots = requestedShots.length ? requestedShots : (turnScreenshotsByRoom.get(clean(roomId)) || []);
    turnContextByRoom.set(clean(roomId), effectiveContext);
    if (screenshots.length) turnScreenshotsByRoom.set(clean(roomId), screenshots);
    // Also used as the double-fire guard: set BEFORE the first await so a
    // re-entrant or duplicate retry is rejected synchronously.
    retryMemberName = name;
    const mirror = async (meta) => {
      try {
        await persist(working, meta);
      } catch (error) {
        const failure = { stage: meta.kind, ...(meta.member ? { member: meta.member } : {}), error: safeFailure(error) };
        syncFailures.push(failure);
        await onActivity({ kind: 'sync_failed', ...failure });
      }
    };
    try {
      await onActivity({ kind: 'retry', member: name, roleLabel: label });
      await onActivity({ kind: 'working', member: name, roleLabel: label });
      activeMember = name;
      const session = await memberSessionFor(roomId, found);
      const basePrompt = buildGroupMemberPrompt({ roomId, groupName, members: roster, viewer: found, messages: working });
      // A retry MUST answer on the exact context the failed turn used, so it
      // reuses the runtime-only per-room cache instead of capturing a page
      // later. An explicitly-supplied enabled context still wins.
      const prompt = formatGroupTurnWithBrowserContext(basePrompt, effectiveContext);
      const reply = await submitMemberPrompt(client, session, prompt, {
        signal,
        timeoutMs,
        screenshotAttachments: screenshots,
        onActivity: (act) => onActivity({ ...act, member: name, roleLabel: label }),
        // Same Outcome R guard as a normal turn: the stored room binding is
        // re-applied and verified before EVERY submission attempt, including a
        // rebound after a 4001. A rejected hook fails the retry with the reason.
        onAttempt: async (attemptSession) => {
          rememberSession(attemptSession);
          if (typeof beforeMemberTurn === 'function') {
            await beforeMemberTurn({ ...found }, { ...attemptSession });
          }
        },
      });
      if (!isGroupPassText(reply)) {
        const message = {
          role: 'assistant',
          roleLabel: label,
          speaker: name,
          content: clean(reply).slice(0, GROUP_TEXT_MAX),
          ts: Number(now()) || Date.now(),
          thread: turnThread,
          ...(found.source ? { source: found.source } : {}),
        };
        working.push(message);
        await onMessage(message, { kind: 'reply', member: name, roleLabel: label });
        await mirror({ kind: 'reply', member: name, roomId: clean(roomId) });
      } else {
        await onActivity({ kind: 'pass', member: name, roleLabel: label });
      }
    } catch (error) {
      if (isSessionGoneError(error)) sessionCache.delete(name);
      const failure = { member: name, roleLabel: label, error: safeFailure(error) };
      failures.push(failure);
      await onActivity({ kind: 'failed', ...failure });
    } finally {
      activeMember = '';
      retryMemberName = '';
    }
    await onActivity({ kind: 'idle' });

    return { ok: true, messages: working, failures, syncFailures };
  }

  // Read-only snapshot of a member's resolved room session (B3.2 / B2.2).
  function getMemberSession(name) {
    return sessionSnapshot(sessionCache.get(clean(name)));
  }

  // Truthful per-room model read: never an assumed value. A member with no
  // existing session reports `no-session` and is NOT cached as absent. A live
  // session that has been reaped (4001) is resumed from the cached stored id
  // and the status read is retried exactly once.
  async function readMemberModel(roomId, member) {
    const normalized = normalizeMember(member);
    if (!normalized) throw new Error('A group member is required.');
    let session;
    try {
      session = await memberSessionFor(roomId, normalized, { createIfMissing: false });
    } catch (error) {
      if (error?.code === 'no-session') return { state: 'no-session' };
      return { state: 'unknown', error: safeFailure(error) };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const status = await client.request('session.status', { session_id: session.liveId });
        const parsed = runtimeModelFromSessionStatus(status);
        if (!parsed.model && !parsed.provider) {
          return { state: 'unknown', error: 'The member session did not report a model.' };
        }
        return { state: 'ok', model: parsed.model, provider: parsed.provider };
      } catch (error) {
        if (attempt === 0 && isSessionGoneError(error) && session.storedId) {
          // The live runtime is gone but the stored row survives: drop the dead
          // cache entry, resume from the cached stored id once, and retry.
          sessionCache.delete(normalized.name);
          try {
            session = rememberSession(await resumeMemberSession(client, session.storedId, session.profile, session.title));
          } catch (resumeError) {
            return { state: 'unknown', error: safeFailure(resumeError) };
          }
          continue;
        }
        if (isSessionGoneError(error)) sessionCache.delete(normalized.name);
        return { state: 'unknown', error: safeFailure(error) };
      }
    }
    return { state: 'unknown', error: 'The member session did not report a model.' };
  }

  // A switch is only verified when the session reports the requested model —
  // and provider, when one was requested. A readable status that still shows
  // the OLD model is NOT success (the live recon showed room status lag).
  function memberModelMatches(parsed, targetModel, targetProvider) {
    const observedModel = clean(parsed?.model);
    if (!observedModel || observedModel !== clean(targetModel)) return false;
    const wantedProvider = clean(targetProvider);
    return !wantedProvider || clean(parsed?.provider) === wantedProvider;
  }

  // Verify a session-scoped switch on the TARGET session only. `session.status`
  // is the primary evidence. When it still shows the old model, a SAFE
  // live-reuse `session.resume` (attempted only after a successful status read
  // proved the session is live, and trusted only when it reused the SAME live
  // id — never a destructive rebuild) is additional gateway evidence. Returns
  // `{ verified, evidence, observed, rebuilt?, error? }`; it never claims
  // success without a target match.
  async function verifyMemberModelSwitch(session, targetModel, targetProvider) {
    let observed = null;
    let statusRead = false;
    try {
      const status = await client.request('session.status', { session_id: session.liveId });
      statusRead = true;
      observed = runtimeModelFromSessionStatus(status);
      if (memberModelMatches(observed, targetModel, targetProvider)) {
        return { verified: true, evidence: 'session.status', observed };
      }
    } catch (error) {
      if (isSessionGoneError(error)) sessionCache.delete(clean(session.profile));
      return { verified: false, observed: null, error: safeFailure(error) };
    }
    if (statusRead && session.storedId) {
      try {
        const resumed = await client.request('session.resume', {
          session_id: session.storedId,
          profile: session.profile,
          omit_messages: true,
        });
        const identity = remoteSessionIdentity(resumed, session.storedId);
        if (identity.liveId && identity.liveId !== session.liveId) {
          // The resume rebuilt the runtime from the stored row (a destructive
          // path): never report the requested pick as verified.
          return { verified: false, observed, rebuilt: true, error: 'The member session was rebuilt on resume.' };
        }
        const resumedModel = runtimeModelFromSessionStatus(asObject(resumed?.info));
        if (memberModelMatches(resumedModel, targetModel, targetProvider)) {
          return { verified: true, evidence: 'session.resume', observed: resumedModel };
        }
        return { verified: false, observed: resumedModel.model || resumedModel.provider ? resumedModel : observed };
      } catch (error) {
        return { verified: false, observed, error: safeFailure(error) };
      }
    }
    return { verified: false, observed };
  }

  // Shape a verification into the public result. `ok` carries explicit
  // `verified`/`evidence`/`observed` fields. Otherwise the switch was accepted
  // but could not be confirmed (`unverified`) or its truth could not be read at
  // all (`unknown`) — neither is ever a success.
  function modelSwitchOutcome(verification, { targetModel, targetProvider, scope, extra = {} }) {
    if (verification.verified) {
      return {
        state: 'ok',
        model: targetModel,
        provider: targetProvider || clean(verification.observed?.provider),
        scope,
        verified: true,
        evidence: verification.evidence,
        observed: verification.observed,
        ...extra,
      };
    }
    return {
      state: verification.observed || !verification.error ? 'unverified' : 'unknown',
      accepted: true,
      verified: false,
      requested: { model: targetModel, provider: targetProvider },
      observed: verification.observed || null,
      scope,
      error: verification.error || 'The member session did not confirm the requested model.',
      ...extra,
    };
  }

  // Session-scoped per-room model switch. Never global. Returns a `confirm`
  // state when the gateway asks (expensive model), requiring a second call with
  // `confirm: true`. Success is only reported after the switch is verified on
  // the target session — never from an arbitrary readable status.
  async function setMemberModel(roomId, member, { model = '', provider = '', confirm = false } = {}) {
    const normalized = normalizeMember(member);
    if (!normalized) throw new Error('A group member is required.');
    const targetModel = clean(model);
    const targetProvider = clean(provider);
    if (!targetModel) throw new Error('A Hermes model is required to switch models.');
    assertMemberIdle(normalized.name);
    const session = await memberSessionFor(roomId, normalized, { createIfMissing: true });
    const request = buildSessionModelSwitchRequest({ sessionId: session.liveId, model: targetModel, provider: targetProvider });
    const params = { ...request.params, ...(confirm ? { confirm_expensive_model: true } : {}) };
    const result = await client.request(request.method, params);
    const scope = clean(result?.scope) || 'session';
    // A confirm request is never success — not even on the second, confirmed
    // call (the gateway can still refuse to apply without a fresh confirmation).
    if (result?.confirm_required === true) {
      return {
        state: 'confirm',
        detail: {
          member: normalized.name,
          model: targetModel,
          provider: targetProvider,
          message: clean(result?.confirm_message),
          warning: clean(result?.warning),
          scope,
        },
      };
    }
    if (scope === 'global') {
      return {
        state: 'unverified',
        accepted: false,
        verified: false,
        requested: { model: targetModel, provider: targetProvider },
        observed: null,
        scope,
        error: 'The gateway applied the model switch globally; a per-room switch must stay session-scoped.',
      };
    }
    const verification = await verifyMemberModelSwitch(session, targetModel, targetProvider);
    return modelSwitchOutcome(verification, { targetModel, targetProvider, scope });
  }

  // Restore the member's PROFILE default model (read from model.options for the
  // profile, never from the current picked session) with a session-scoped
  // switch, then verify the truth on the target session.
  async function resetMemberModel(roomId, member, { confirm = false } = {}) {
    const normalized = normalizeMember(member);
    if (!normalized) throw new Error('A group member is required.');
    assertMemberIdle(normalized.name);
    const session = await memberSessionFor(roomId, normalized, { createIfMissing: true });
    const options = await client.request('model.options', { profile: normalized.name, session_id: session.liveId });
    const profileDefault = profileDefaultModelFromOptions(options);
    if (!profileDefault?.model) {
      const error = new Error(`No profile default model is available for ${normalized.name}.`);
      error.code = 'no-profile-default';
      throw error;
    }
    const targetModel = clean(profileDefault.model);
    const targetProvider = clean(profileDefault.provider);
    const request = buildSessionModelSwitchRequest({ sessionId: session.liveId, model: targetModel, provider: targetProvider });
    const params = { ...request.params, ...(confirm ? { confirm_expensive_model: true } : {}) };
    const result = await client.request(request.method, params);
    const scope = clean(result?.scope) || 'session';
    if (result?.confirm_required === true) {
      return {
        state: 'confirm',
        detail: {
          member: normalized.name,
          model: targetModel,
          provider: targetProvider,
          message: clean(result?.confirm_message),
          warning: clean(result?.warning),
          scope,
        },
      };
    }
    if (scope === 'global') {
      return {
        state: 'unverified',
        accepted: false,
        verified: false,
        source: 'profile-default',
        requested: { model: targetModel, provider: targetProvider },
        observed: null,
        scope,
        error: 'The gateway applied the model switch globally; a per-room switch must stay session-scoped.',
      };
    }
    const verification = await verifyMemberModelSwitch(session, targetModel, targetProvider);
    return modelSwitchOutcome(verification, { targetModel, targetProvider, scope, extra: { source: 'profile-default' } });
  }

  return Object.freeze({ prepare, send, retryMember, getMemberSession, readMemberModel, setMemberModel, resetMemberModel });
}
