import { remoteSessionIdentity } from './gateway-ws.mjs';

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
  return {
    role,
    roleLabel: roleLabel.slice(0, 128),
    content,
    ts: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
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
    const isDefaultRoxas = name === 'default' && targets.has('roxas');
    return targets.has(name) || (title && targets.has(title)) || isDefaultRoxas;
  });
  return matched.length ? matched : roster;
}

export function groupProjectionEntryFromDisplayMessage(message = {}) {
  const row = asObject(message);
  const role = clean(row.role).toLowerCase() === 'user' ? 'user' : 'member';
  const content = textFromPayload(row.content).slice(0, GROUP_TEXT_MAX);
  const timestamp = Number(row.ts ?? row.timestamp ?? Date.now());
  const rawLabel = clean(row.roleLabel || (role === 'user' ? 'You' : 'Hermes'));
  // Projection entries are the cross-client record: a "default" label here
  // would sync back into the desktop roster. Normalize to the canonical name.
  const label = /^default$/i.test(rawLabel) ? 'Roxas' : rawLabel;
  return {
    id: clean(row.id).slice(0, 160),
    from: {
      kind: role === 'user' ? 'user' : 'member',
      name: label.slice(0, 128),
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
  const lines = messages.slice(-GROUP_HISTORY_LIMIT).map((message) => `  ${groupLine(message, viewer.name)}`);

  const lastUserMsg = [...messages].reverse().find((m) => clean(m.role).toLowerCase() === 'user');
  const userText = clean(lastUserMsg?.content);
  const isEveryone = /(^|\s)@everyone\b/i.test(userText);
  const viewerAlias = viewer.name === 'default' ? 'roxas' : viewer.name;
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
  if (!createIfMissing) throw new Error(`Existing group session not found for ${profile}.`);

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


function waitForMemberCompletion(client, liveId, { signal, timeoutMs = GROUP_TURN_TIMEOUT_MS, text = '', onActivity } = {}) {
  if (typeof client?.on !== 'function') return Promise.reject(new Error('The Hermes dashboard transport cannot stream group turns.'));
  return new Promise((resolve, reject) => {
    let finalText = '';
    let settled = false;
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
    const onAbort = () => {
      client.request('session.interrupt', { session_id: liveId }).catch(() => {});
      finish(reject, new DOMException('Group turn stopped by user', 'AbortError'));
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
    client.request('prompt.submit', {
      session_id: liveId,
      text,
    }).catch((error) => finish(reject, error));
  });
}

async function submitMemberPrompt(client, session, prompt, { signal, timeoutMs, onActivity } = {}) {
  let current = session;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await waitForMemberCompletion(client, current.liveId, { signal, timeoutMs, text: prompt, onActivity });
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
  now = () => Date.now(),
  timeoutMs = GROUP_TURN_TIMEOUT_MS,
} = {}) {
  if (!client?.request) throw new TypeError('A Hermes dashboard client is required.');

  async function prepare({ roomId = '', members = [] } = {}) {
    const roster = normalizeMembers(members);
    if (roster.length < GROUP_MEMBER_MIN || roster.length > GROUP_MEMBER_MAX) {
      return { ok: false, reason: 'member-count', sessions: [], failures: [] };
    }
    const sessions = [];
    const failures = [];
    for (const member of roster) {
      try {
        sessions.push(await resolveMemberSession(client, roomId, member, { createIfMissing: false }));
      } catch (error) {
        failures.push({ member: member.name, error: safeFailure(error) });
      }
    }
    return { ok: failures.length === 0, sessions, failures };
  }

  async function send({ roomId = '', groupName = '', members = [], messages = [], text = '', signal, thread = '' } = {}) {
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
    await persist(working, { kind: 'user', roomId: clean(roomId) });
    const failures = [];

    // Desktop-parity @mention routing: "@name" directs the turn at one member,
    // "@everyone" or no mention prompts all members.
    const roster = groupMembersForTurn(trimmed, roster0);

    for (const member of roster) {
      if (signal?.aborted) break;
      await onActivity({ kind: 'working', member: member.name, roleLabel: member.title || member.name });
      try {
        const session = await resolveMemberSession(client, roomId, member);
        const prompt = buildGroupMemberPrompt({ roomId, groupName, members: roster, viewer: member, messages: working });
        const reply = await submitMemberPrompt(client, session, prompt, {
          signal,
          timeoutMs,
          onActivity: (act) => onActivity({ ...act, member: member.name, roleLabel: member.title || member.name }),
        });
        if (!isGroupPassText(reply)) {
          const message = {
            role: 'assistant',
            roleLabel: member.title || member.name,
            content: clean(reply).slice(0, GROUP_TEXT_MAX),
            ts: Number(now()) || Date.now(),
            thread: turnThread,
            ...(member.source ? { source: member.source } : {}),
          };
          working.push(message);
          await onMessage(message, { kind: 'reply', member: member.name, roleLabel: member.title || member.name });
          await persist(working, { kind: 'reply', member: member.name, roomId: clean(roomId) });
        } else {
          await onActivity({ kind: 'pass', member: member.name, roleLabel: member.title || member.name });
        }
      } catch (error) {
        const failure = { member: member.name, roleLabel: member.title || member.name, error: safeFailure(error) };
        failures.push(failure);
        await onActivity({ kind: 'failed', ...failure });
      }
    }
    await onActivity({ kind: 'idle' });

    return { ok: true, messages: working, failures };
  }

  return Object.freeze({ prepare, send });
}
