// Group rooms a current Hermes gateway runs itself ("hosted rooms"). On a session authority the
// gateway refuses a client that drives each member's hidden session (bot-group-runtime.mjs), so a
// room there is created with groups.create, a message is a groups.send event, and the members'
// replies, passes and failures are read back from groups.log while groups.state says who is
// working. There are no pushed room events: the room is polled while a turn runs. Hermes Desktop
// speaks the same methods (apps/desktop/src/plugins/hermes-bots/canonical-group-*.ts).
//
// Rules this module follows (gateway/session_group_controls.py, hosted_room_discussion.py):
// - Every method's params are a closed set; anything extra is refused as invalid_params.
// - A room belongs to the signed-in subject and the profile that hosts it, so each panel room
//   keeps the hosted room id and hosting profile it was created with and sends that profile on
//   every call.
// - Hosted room ids are fresh: a member's hidden session is titled "Group: <room_id>", and the
//   panel's old rooms already hold that title for their own ids.
// - The roster is frozen at creation; a panel room whose members changed gets a new hosted room.
// - groups.send takes exactly {text, thread_id} (attachments aside). Everything in text is shown in
//   the room log and given to every member, so no page context rides along.
// - A message's discussion is over at its room.activity marker, a later room.stop_requested, or a
//   newer user message in the same thread; an idle driver alone races between two members.

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ID_MAX = 128;
const MEMBER_MIN = 2;
const MEMBER_MAX = 6;
const NAME_MAX = 200;
const TEXT_MAX_BYTES = 65_536;
const LOG_PAGE = 100;
export const HOSTED_ROOM_POLL_MS = 1_000;
// A member turn may run for the gateway's own agent timeout; the room is followed this long.
export const HOSTED_TURN_TIMEOUT_MS = 30 * 60_000;
export const HOSTED_ROOMS_STORAGE_KEY = 'hermesBrowserHostedGroupRooms';
export const HOSTED_MEMBER_SETTINGS_NOTE = 'Hermes runs this room\'s bots on their own profile settings. Change a bot\'s model in its own chat.';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function validIdentifier(value) {
  const text = clean(value);
  return Boolean(text) && text.length <= ID_MAX && IDENTIFIER_RE.test(text);
}

function defaultRandomId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function rpcReason(error) {
  return clean(error?.data?.reason) || clean(error?.rpcMessage) || clean(error?.message);
}

function failureText(error) {
  const data = asObject(error?.data);
  const detail = clean(data.detail);
  const reason = rpcReason(error);
  return (detail ? `${reason}: ${detail}` : reason) || 'Hermes refused the group room request.';
}

// 'hosted' when the gateway drives rooms itself, 'legacy' when it says it does not and owns none
// (the client-driven runtime applies), 'unavailable' otherwise. Mirrors Desktop's groupExecutionMode.
export function hostedGroupMode(capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return 'unavailable';
  const { driver, persistent_process: persistent, features, methods } = capabilities;
  if (features !== undefined && (!Array.isArray(features) || features.some((entry) => typeof entry !== 'string'))) return 'unavailable';
  if (methods !== undefined && (!Array.isArray(methods) || methods.some((entry) => typeof entry !== 'string'))) return 'unavailable';
  if (driver === true) return 'hosted';
  const ownsRooms = Object.hasOwn(capabilities, 'protocol_version') || Object.hasOwn(capabilities, 'authority_gateway_id')
    || methods?.includes('groups.create') || features?.includes('canonical_session_owner');
  if (driver === false && persistent === false && !ownsRooms) return 'legacy';
  return 'unavailable';
}

// How this socket runs group rooms: { mode: 'hosted' | 'legacy' | 'unavailable', profile }.
// `profile` is the hosting profile to name on every room call ('' = the socket's own). A gateway
// with no group verbs (-32601) predates hosted rooms, so the client-driven runtime applies.
export async function probeHostedGroups(client, profile = '') {
  const ask = (name) => client.request('groups.capabilities', name ? { profile: name } : {});
  let name = clean(profile);
  try {
    let capabilities;
    try {
      capabilities = await ask(name);
    } catch (error) {
      if (!name || rpcReason(error) !== 'profile_mismatch') throw error;
      name = '';
      capabilities = await ask(name);
    }
    return { mode: hostedGroupMode(capabilities), profile: name, capabilities };
  } catch (error) {
    if (Number(error?.rpcCode ?? error?.code) === -32601) return { mode: 'legacy', profile: name, capabilities: null };
    return { mode: 'unavailable', profile: name, capabilities: null, error };
  }
}

function foldAscii(value) {
  return clean(value).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeRoster(members = []) {
  const roster = [];
  const seen = new Set();
  for (const raw of asList(members)) {
    const row = typeof raw === 'string' ? { name: raw } : asObject(raw);
    const name = clean(row.name || row.profile || row.profileName);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    roster.push({ name, title: clean(row.title || row.displayName) });
  }
  return roster;
}

// The handle a member answers to: its title folded to plain letters when that is a valid, unused
// handle ("Naminé" -> "Namine"), else its profile name. @all and @everyone are reserved.
function memberHandles(roster) {
  const taken = new Set(['all', 'everyone']);
  return roster.map((member) => {
    const folded = foldAscii(member.title).replace(/\s+/g, '');
    const candidate = validIdentifier(folded) && !/[._:-]$/.test(folded) && !taken.has(folded.toLowerCase())
      ? folded
      : member.name;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

// The roster groups.create seats: one entry per profile, the profile as its id. `seatedHandles`
// ({profile: handle}) are the handles a room was created with: they win, so a title that changed
// (or loaded) since then never respells a mention the room cannot resolve.
export function hostedRoomMembers(members = [], seatedHandles = null) {
  const roster = normalizeRoster(members);
  const seated = asObject(seatedHandles);
  const handles = memberHandles(roster).map((handle, index) => {
    const kept = clean(seated[roster[index].name]);
    return validIdentifier(kept) ? kept : handle;
  });
  return roster.map((member, index) => {
    const displayName = member.title.slice(0, NAME_MAX);
    return {
      member_id: member.name,
      profile: member.name,
      handle: handles[index],
      target: { kind: 'local', profile: member.name },
      ...(displayName && displayName !== member.name ? { display_name: displayName } : {}),
    };
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The user's text with every @title / @profile mention spelled as that member's room handle, so
// the gateway routes "@Naminé" to Naminé. Other text is left exactly as typed.
export function hostedMentionText(text = '', members = [], seatedHandles = null) {
  let value = String(text ?? '');
  if (!value.includes('@')) return value;
  const seated = hostedRoomMembers(members, seatedHandles);
  const spellings = [];
  for (const member of seated) {
    for (const spelling of [member.display_name, member.profile]) {
      const word = clean(spelling);
      if (word && word.toLowerCase() !== member.handle.toLowerCase()) spellings.push({ word, handle: member.handle });
    }
  }
  spellings.sort((a, b) => b.word.length - a.word.length);
  for (const { word, handle } of spellings) {
    value = value.replace(new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, 'giu'), `$1@${handle}`);
  }
  return value;
}

// The members a message addresses, as the gateway routes it: mentioned handles (in roster order),
// or every member when none resolves or @all / @everyone is used.
export function hostedRespondents(text = '', members = [], seatedHandles = null) {
  const roster = normalizeRoster(members);
  const seated = hostedRoomMembers(members, seatedHandles);
  const routed = hostedMentionText(text, members, seatedHandles);
  const mentioned = new Set();
  for (const match of routed.matchAll(/@([A-Za-z0-9][A-Za-z0-9._:-]*)/g)) mentioned.add(match[1].toLowerCase());
  if (mentioned.has('all') || mentioned.has('everyone')) return roster;
  const picked = roster.filter((member, index) => mentioned.has(seated[index].handle.toLowerCase()));
  return picked.length ? picked : roster;
}

const MESSAGE_KINDS = new Set(['message.user', 'message.member', 'message']);

export function isHostedRoomMessage(event) {
  return MESSAGE_KINDS.has(clean(event?.kind));
}

function eventText(event) {
  const payload = asObject(event?.payload);
  return typeof payload.text === 'string' ? payload.text : (typeof payload.content === 'string' ? payload.content : '');
}

function eventMs(event) {
  const seconds = Number(event?.created_at);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function memberLabel(memberId, roster, event) {
  const actor = asObject(event?.actor);
  const row = roster.find((member) => member.name === memberId);
  return clean(actor.display_name) || row?.title || memberId;
}

// The panel's display rows for a hosted room log: the user's messages and the members' replies.
export function displayMessagesFromHostedLog(events = [], members = []) {
  const roster = normalizeRoster(members);
  const rows = [];
  for (const event of asList(events)) {
    const kind = clean(event?.kind);
    const payload = asObject(event?.payload);
    const thread = clean(payload.thread_id) || 'main';
    const ts = eventMs(event);
    if (kind === 'message.user') {
      rows.push({ role: 'user', roleLabel: 'You', content: eventText(event), ts, thread });
    } else if (kind === 'message.member' || (kind === 'message' && clean(asObject(event?.actor).kind) === 'member')) {
      const memberId = clean(asObject(event?.actor).id) || clean(payload.member_id);
      rows.push({
        role: 'assistant',
        roleLabel: memberLabel(memberId, roster, event),
        speaker: memberId,
        content: eventText(event),
        ts,
        thread,
      });
    }
  }
  return rows;
}

// Per-gateway store of which hosted room backs which panel room, in browser storage.
export function createHostedRoomBindings({ storage, gatewayKey = '' } = {}) {
  const key = clean(gatewayKey) || 'default';
  async function readAll() {
    try {
      const stored = await storage?.get?.(HOSTED_ROOMS_STORAGE_KEY);
      return asObject(asObject(stored?.[HOSTED_ROOMS_STORAGE_KEY])[key]);
    } catch {
      return {};
    }
  }
  async function writeAll(rooms) {
    let stored = {};
    try {
      stored = asObject(await storage?.get?.(HOSTED_ROOMS_STORAGE_KEY));
    } catch {
      stored = {};
    }
    const all = { ...asObject(stored[HOSTED_ROOMS_STORAGE_KEY]), [key]: rooms };
    await storage?.set?.({ [HOSTED_ROOMS_STORAGE_KEY]: all });
  }
  return {
    async read(roomId) {
      const row = asObject((await readAll())[clean(roomId)]);
      return validIdentifier(row.roomId) ? row : null;
    },
    async write(roomId, binding) {
      const rooms = await readAll();
      rooms[clean(roomId)] = binding;
      await writeAll(rooms);
    },
    async forget(roomId) {
      const rooms = await readAll();
      delete rooms[clean(roomId)];
      await writeAll(rooms);
    },
  };
}

function sameMembers(a = [], b = []) {
  const left = asList(a).map((name) => clean(name).toLowerCase());
  const right = asList(b).map((name) => clean(name).toLowerCase());
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('Group turn stopped by user', 'AbortError')
    : Object.assign(new Error('Group turn stopped by user'), { name: 'AbortError' });
}

export function createHostedGroupRuntime({
  client,
  profile = '',
  bindings,
  onActivity = () => undefined,
  onMessage = () => undefined,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  randomId = defaultRandomId,
  pollMs = HOSTED_ROOM_POLL_MS,
  timeoutMs = HOSTED_TURN_TIMEOUT_MS,
} = {}) {
  if (!client?.request) throw new TypeError('A Hermes dashboard client is required.');
  if (!bindings?.read || !bindings?.write) throw new TypeError('A hosted room binding store is required.');
  const hostProfile = clean(profile);
  let turnRunning = false;

  function request(method, params = {}, binding = null) {
    const profileName = clean(binding?.profile) || hostProfile;
    return client.request(method, profileName ? { ...params, profile: profileName } : params);
  }

  async function createRoom(roomId, groupName, roster) {
    const hostedRoomId = randomId();
    const name = clean(groupName).slice(0, NAME_MAX) || 'Group chat';
    const seated = hostedRoomMembers(roster);
    await request('groups.create', { room_id: hostedRoomId, name, members: seated });
    const binding = {
      roomId: hostedRoomId,
      profile: hostProfile,
      members: roster.map((member) => member.name),
      handles: Object.fromEntries(seated.map((member) => [member.profile, member.handle])),
      createdAt: Number(now()) || Date.now(),
    };
    await bindings.write(roomId, binding);
    return binding;
  }

  // The hosted room behind a panel room: the stored one while it still answers for the same
  // roster, else a new one. A room this sign-in no longer owns reads as permission_denied.
  async function ensureRoom({ roomId = '', groupName = '', members = [] } = {}) {
    const panelRoomId = clean(roomId);
    if (!panelRoomId) throw new Error('A group room id is required.');
    const roster = normalizeRoster(members);
    if (roster.length < MEMBER_MIN || roster.length > MEMBER_MAX) {
      throw Object.assign(new Error('A Hermes group room needs two to six bots.'), { code: 'member-count' });
    }
    const invalid = roster.find((member) => !validIdentifier(member.name));
    if (invalid) throw new Error(`Hermes cannot seat the profile "${invalid.name}" in a group room.`);
    const stored = await bindings.read(panelRoomId);
    if (stored && sameMembers(stored.members, roster.map((member) => member.name))) {
      try {
        await request('groups.state', { room_id: stored.roomId }, stored);
        return stored;
      } catch (error) {
        const reason = rpcReason(error);
        if (!['permission_denied', 'room_history_expired', 'invalid_params'].includes(reason)) throw error;
      }
    }
    return createRoom(panelRoomId, groupName, roster);
  }

  async function readLog(binding, sinceSeq = 0) {
    const events = [];
    let cursor = Math.max(0, Number(sinceSeq) || 0);
    for (let page = 0; page < 1_000; page += 1) {
      const result = asObject(await request('groups.log', { room_id: binding.roomId, since_seq: cursor, limit: LOG_PAGE }, binding));
      events.push(...asList(result.events));
      const next = Number(result.cursor);
      if (!result.has_more || !Number.isFinite(next) || next <= cursor) break;
      cursor = next;
    }
    return events;
  }

  async function prepare({ roomId = '', groupName = '', members = [] } = {}) {
    try {
      await ensureRoom({ roomId, groupName, members });
      return { ok: true, sessions: [], failures: [] };
    } catch (error) {
      if (error?.code === 'member-count') return { ok: false, reason: 'member-count', sessions: [], failures: [] };
      return { ok: false, sessions: [], failures: [{ member: '', error: failureText(error) }] };
    }
  }

  // The hosted room's own messages for display, or [] before the room exists. `createdAt` says
  // when the hosted room took over, so older panel rows can be kept beside it.
  async function readHistory({ roomId = '', members = [] } = {}) {
    const binding = await bindings.read(clean(roomId));
    if (!binding) return { messages: [], createdAt: 0 };
    const events = await readLog(binding, 0);
    return { messages: displayMessagesFromHostedLog(events, members), createdAt: Number(binding.createdAt) || 0 };
  }

  // Follow one discussion (or one retried task) through the log until it is over. Returns the
  // member replies it published and the members that failed.
  async function follow(binding, { userEventId = '', userSeq = 0, thread = '', taskId = '', roster, signal, working }) {
    const failures = [];
    const announced = new Map();
    const deadline = (Number(now()) || Date.now()) + timeoutMs;
    let cursor = Math.max(0, Number(userSeq) || 0);
    let done = false;
    const label = (memberId) => roster.find((member) => member.name === memberId)?.title || memberId;
    const concerns = (payload) => (taskId ? clean(payload.task_id) === taskId : clean(payload.discussion_event_id) === userEventId);
    while (!done) {
      if (signal?.aborted) {
        await request('groups.stop', { room_id: binding.roomId, cancel_id: randomId() }, binding).catch(() => undefined);
        throw abortError();
      }
      if ((Number(now()) || Date.now()) > deadline) {
        failures.push({ member: '', roleLabel: '', error: 'Hermes did not finish this group turn in time.' });
        break;
      }
      const state = asObject(await request('groups.state', { room_id: binding.roomId }, binding));
      const driver = asObject(state.driver_status);
      for (const activity of asList(driver.member_activity)) {
        const memberId = clean(activity?.member_id);
        const status = clean(activity?.status);
        if (!memberId || status === 'queued' || announced.get(memberId) === status) continue;
        announced.set(memberId, status);
        await onActivity({ kind: 'working', member: memberId, roleLabel: label(memberId) });
      }
      for (const action of asList(driver.pending_actions)) {
        if (clean(action?.kind) !== 'approval') continue;
        const memberId = clean(action.member_id);
        const key = `approval:${clean(action.request_id)}`;
        if (announced.has(key)) continue;
        announced.set(key, true);
        const approval = asObject(action.approval);
        await onActivity({
          kind: 'approval',
          member: memberId,
          roleLabel: label(memberId),
          command: clean(approval.command) || clean(approval.description),
        });
      }
      const latest = Number(asObject(state.room).latest_seq);
      if (!Number.isFinite(latest) || latest > cursor) {
        const events = await readLog(binding, cursor);
        for (const event of events) {
          const seq = Number(event?.seq) || 0;
          if (seq > cursor) cursor = seq;
          const kind = clean(event?.kind);
          const payload = asObject(event?.payload);
          if (kind === 'room.stop_requested' && seq > userSeq) {
            done = true;
            continue;
          }
          if (!taskId && kind === 'message.user' && seq > userSeq && clean(payload.thread_id) === thread) {
            done = true; // A newer message in this thread supersedes the discussion.
            continue;
          }
          if (!concerns(payload)) continue;
          const memberId = clean(payload.member_id) || clean(asObject(event?.actor).id);
          if (kind === 'message.member') {
            const [message] = displayMessagesFromHostedLog([event], roster);
            working.push(message);
            await onMessage(message, { kind: 'reply', member: memberId, roleLabel: message.roleLabel });
          } else if (kind === 'turn.settled') {
            if (payload.passed === true) await onActivity({ kind: 'pass', member: memberId, roleLabel: label(memberId) });
            if (taskId) done = true;
          } else if (kind === 'turn.failed' || kind === 'turn.cancelled' || kind === 'turn.deferred') {
            const reason = clean(payload.error) || clean(payload.reason) || clean(payload.reason_code)
              || (kind === 'turn.cancelled' ? 'cancelled' : 'member unavailable');
            const failure = { member: memberId, roleLabel: label(memberId), error: reason };
            failures.push(failure);
            await onActivity({ kind: 'failed', ...failure });
            if (taskId) done = true;
          } else if (kind === 'room.activity') {
            done = true;
          }
        }
      }
      if (!done) await sleep(pollMs);
    }
    return failures;
  }

  async function send({ roomId = '', groupName = '', members = [], messages = [], text = '', signal, thread = '' } = {}) {
    const roster = normalizeRoster(members);
    const baseMessages = asList(messages).filter(Boolean);
    const trimmed = clean(text);
    if (roster.length < MEMBER_MIN || roster.length > MEMBER_MAX) return { ok: false, reason: 'member-count', messages: baseMessages, failures: [] };
    if (!trimmed) return { ok: false, reason: 'empty', messages: baseMessages, failures: [] };
    if (signal?.aborted) return { ok: false, reason: 'aborted', messages: baseMessages, failures: [] };
    if (turnRunning) throw new Error('The group is still answering. Wait for the current turn to finish.');
    const turnThread = validIdentifier(thread) ? clean(thread) : 'main';
    const working = [...baseMessages, { role: 'user', roleLabel: 'You', content: trimmed, ts: Number(now()) || Date.now(), thread: turnThread }];
    turnRunning = true;
    try {
      let binding;
      let ack;
      try {
        binding = await ensureRoom({ roomId, groupName, members: roster });
        const outgoing = hostedMentionText(trimmed, roster, binding.handles);
        if (new TextEncoder().encode(outgoing).length > TEXT_MAX_BYTES) {
          throw new Error('This message is too long for a Hermes group room.');
        }
        const params = { room_id: binding.roomId, event_id: randomId(), payload: { text: outgoing, thread_id: turnThread } };
        try {
          ack = asObject(await request('groups.send', params, binding));
        } catch (error) {
          // The same event id and payload are idempotent: one retry after a transient refusal.
          if (!['runtime_coordination_required', 'storage_unavailable'].includes(rpcReason(error))) throw error;
          await sleep(pollMs);
          ack = asObject(await request('groups.send', params, binding));
        }
      } catch (error) {
        // Nothing reached the room: the caller may hand the draft back.
        error.notSent = true;
        throw error;
      }
      await onMessage(working.at(-1), { kind: 'user' });
      await onActivity({
        kind: 'turn_start',
        thread: turnThread,
        members: hostedRespondents(trimmed, roster, binding.handles).map((member) => ({ member: member.name, roleLabel: member.title || member.name })),
      });
      const event = asObject(ack.event);
      const failures = await follow(binding, {
        userEventId: clean(event.event_id),
        userSeq: Number(event.seq) || 0,
        thread: turnThread,
        roster,
        signal,
        working,
      });
      await onActivity({ kind: 'idle' });
      return { ok: true, messages: working, failures, syncFailures: [] };
    } finally {
      turnRunning = false;
    }
  }

  // Run a member again where Hermes offers it: a turn it deferred because the member could not be
  // confirmed. A failed turn has nothing to retry on a hosted room; mention the member again.
  async function retryMember({ roomId = '', members = [], messages = [], member, signal } = {}) {
    const roster = normalizeRoster(members);
    const name = clean(typeof member === 'string' ? member : member?.name);
    const baseMessages = asList(messages).filter(Boolean);
    const target = roster.find((entry) => entry.name === name);
    if (!target) return { ok: false, reason: 'member', messages: baseMessages, failures: [] };
    if (turnRunning) return { ok: false, reason: 'turn-busy', messages: baseMessages, failures: [] };
    const binding = await bindings.read(clean(roomId));
    if (!binding) throw new Error('This group room has not started on Hermes yet. Send a message first.');
    const state = asObject(await request('groups.state', { room_id: binding.roomId }, binding));
    const action = asList(asObject(state.driver_status).pending_actions)
      .find((entry) => clean(entry?.kind) === 'retry' && clean(entry?.member_id) === name);
    if (!action) {
      throw new Error(`Hermes has nothing to retry for ${target.title || name}. Mention @${target.title || name} in a new message instead.`);
    }
    turnRunning = true;
    try {
      const working = [...baseMessages];
      await onActivity({ kind: 'retry', member: name, roleLabel: target.title || name });
      await request('groups.retry', {
        room_id: binding.roomId,
        member_id: clean(action.member_id),
        task_id: clean(action.task_id),
        execution_generation: Number(action.execution_generation),
      }, binding);
      const failures = await follow(binding, {
        taskId: clean(action.task_id),
        userSeq: Number(asObject(state.room).latest_seq) || 0,
        roster,
        signal,
        working,
      });
      await onActivity({ kind: 'idle' });
      return { ok: true, messages: working, failures, syncFailures: [] };
    } finally {
      turnRunning = false;
    }
  }

  // Each bot answers a hosted room on its own profile settings: there is no per-room model.
  async function readMemberModel() {
    return { state: 'no-session' };
  }

  async function setMemberModel() {
    return { state: 'unavailable', error: HOSTED_MEMBER_SETTINGS_NOTE };
  }

  async function resetMemberModel() {
    return { state: 'unavailable', error: HOSTED_MEMBER_SETTINGS_NOTE };
  }

  async function readMemberRuntimeOptions() {
    return { state: 'unavailable', error: HOSTED_MEMBER_SETTINGS_NOTE };
  }

  async function setMemberRuntimeOption() {
    return { state: 'unavailable', error: HOSTED_MEMBER_SETTINGS_NOTE };
  }

  function getMemberSession() {
    return null;
  }

  return Object.freeze({
    hosted: true,
    prepare,
    send,
    retryMember,
    readHistory,
    getMemberSession,
    readMemberModel,
    setMemberModel,
    resetMemberModel,
    readMemberRuntimeOptions,
    setMemberRuntimeOption,
  });
}
