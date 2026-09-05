export const BOT_CHAT_TITLE = 'Bot Chat';
const BOT_MODE_ROUTE_VERSION = 1;
const DEFAULT_ACTIVITY_WINDOW_MS = 90_000;

function clean(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestampMs(value) {
  if (typeof value === 'string') {
    const parsedDate = Date.parse(value);
    if (!Number.isNaN(parsedDate) && parsedDate > 0) return parsedDate;
  }
  const parsed = finiteNumber(value, 0);
  return parsed > 0 && parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

// Desktop-parity relative stamp: "now", "5m ago", "2h ago", "3d ago" — matches
// the desktop roster's recency column.
export function relativeTimeFromTs(ts, now = Date.now()) {
  const stamp = finiteNumber(ts, 0);
  if (stamp <= 0) return '';
  const delta = Math.max(0, Math.max(0, finiteNumber(now, Date.now())) - stamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  return `${Math.floor(delta / day)}d ago`;
}

function canonicalSession(value) {
  if (value == null) {
    return {
      title: BOT_CHAT_TITLE,
      durableId: '',
      resolvedRuntimeId: '',
      preview: '',
      startedAt: 0,
      lastActive: 0,
      messageCount: 0,
      status: 'missing',
    };
  }
  const row = asObject(value);
  const durableId = clean(row.id || row.durableId);
  const resolvedRuntimeId = clean(row.resolved_id || row.resolvedId || durableId);
  const rootTitle = clean(row.root_title || row.rootTitle);
  const title = clean(row.title);
  const titleMatches = !rootTitle || rootTitle === BOT_CHAT_TITLE || title === BOT_CHAT_TITLE || title.includes(BOT_CHAT_TITLE) || !title;
  return {
    title: BOT_CHAT_TITLE,
    durableId,
    resolvedRuntimeId,
    preview: clean(row.preview).slice(0, 240),
    startedAt: finiteNumber(row.started_at ?? row.startedAt, 0),
    lastActive: finiteNumber(row.last_active ?? row.lastActive, 0),
    messageCount: Math.max(0, Math.floor(finiteNumber(row.message_count ?? row.messageCount, 0))),
    status: durableId && resolvedRuntimeId && (titleMatches || row.status === 'ready') ? 'ready' : (row.status === 'ready' ? 'ready' : 'mismatch'),
  };
}

function metadataForProfile(profile) {
  const uiMeta = asObject(profile.ui_meta);
  const botMeta = asObject(uiMeta['hermes-bots']);
  const revisions = asObject(profile.ui_meta_revisions);
  return {
    title: clean(botMeta.title || profile.title),
    avatar: botMeta.avatar && typeof botMeta.avatar === 'object' ? botMeta.avatar : null,
    revision: Math.max(0, Math.floor(finiteNumber(revisions['hermes-bots'], 0))),
  };
}

export function botModeRouteKey({ connectionId = '', gatewayUrl = '', transport = '', profile = '' } = {}) {
  const source = clean(connectionId || gatewayUrl);
  const selectedProfile = clean(profile);
  if (!source || !selectedProfile) return '';
  return `bot-route-v${BOT_MODE_ROUTE_VERSION}:${JSON.stringify([clean(transport), source, selectedProfile])}`;
}

export function scopedBotSessionKey({ routeKey = '', durableSessionId = '' } = {}) {
  const route = clean(routeKey);
  const session = clean(durableSessionId);
  return route && session ? `${route}::${session}` : '';
}

export function botModeSessionParams(profile, params = {}) {
  const selectedProfile = clean(profile);
  if (!selectedProfile) throw new Error('A verified Hermes profile is required.');
  return { ...asObject(params), profile: selectedProfile };
}

export function shouldUseBotDashboardTransport({ gatewayMode = '', source = '', transport = '' } = {}) {
  if (clean(transport).toLowerCase() === 'dashboard-ws') return true;
  if (clean(gatewayMode).toLowerCase() === 'remote-dashboard') return true;
  return ['hermes_bot_mode', 'hermes_bot_group'].includes(clean(source).toLowerCase());
}

export function canSwitchBotProfile({ running = false, currentProfile = '', selectedProfile = '' } = {}) {
  const selected = clean(selectedProfile);
  if (!selected) return { allowed: false, reason: 'profile-required' };
  if (running) return { allowed: false, reason: 'turn-active' };
  if (selected === clean(currentProfile)) return { allowed: true, reason: 'already-selected' };
  return { allowed: true, reason: 'new-session-required' };
}

export function botModeAvailability({ enabled = false, authenticated = false, rosterRead = false } = {}) {
  if (!enabled) return { state: 'off', shouldProbe: false };
  if (!authenticated) return { state: 'authentication-required', shouldProbe: false };
  if (!rosterRead) return { state: 'runtime-update-required', shouldProbe: false };
  return { state: 'loading', shouldProbe: true };
}

export function normalizeBotProfileList(payload = {}, {
  sourceId = 'current',
  now = Date.now(),
  activityWindowMs = DEFAULT_ACTIVITY_WINDOW_MS,
} = {}) {
  const source = clean(sourceId) || 'current';
  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.profiles)
      ? payload.profiles
      : Array.isArray(payload?.data?.profiles)
        ? payload.data.profiles
        : [];
  const rows = [];
  const seen = new Set();
  for (const raw of rawRows) {
    const profile = asObject(raw);
    const profileName = clean(profile.name);
    if (!profileName || seen.has(profileName)) continue;
    seen.add(profileName);
    const meta = metadataForProfile(profile);
    const botMetaTitle = clean(meta.title);
    const canonical = canonicalSession(profile.canonical_session);
    const worker = asObject(profile.worker_session);
    const workerLastActive = finiteNumber(worker.last_active ?? worker.lastActive, 0);
    const lastActive = Math.max(canonical.lastActive, workerLastActive);
    const activeNow = lastActive > 0
      && Math.max(0, finiteNumber(now, Date.now()) - timestampMs(lastActive)) <= Math.max(0, finiteNumber(activityWindowMs, DEFAULT_ACTIVITY_WINDOW_MS));
    // Desktop roster row parity: the Bot's own bot-meta title/handle plus the
    // last Bot Chat preview and relative recency. canonical_session.preview /
    // last_active come straight from the gateway profiles.list row.
    const previewText = clean(canonical.preview);
    const rawLastActive = Number(timestampMs(lastActive)) || 0;
    rows.push({
      rosterKey: `${source}::${profileName}`,
      sourceId: source,
      profileName,
      // Desktop Bot Mode display precedence: ui_meta title (the Bot's chosen
      // name, e.g. "Roxas" for profile "default") first, then the profile's
      // display_name, then the canonical persona name if "default".
      displayName: clean(botMetaTitle || profile.display_name || profile.displayName || (profileName.toLowerCase() === 'default' ? 'Roxas' : (profileName.charAt(0).toUpperCase() + profileName.slice(1)))),
      title: meta.title || (profileName.toLowerCase() === 'default' ? 'Architect' : ''),
      description: clean(profile.description).slice(0, 500),
      provider: clean(profile.provider),
      model: clean(profile.model),
      skillCount: Math.max(0, Math.floor(finiteNumber(profile.skill_count ?? profile.skillCount, 0))),
      hasAvatar: profile.has_avatar === true,
      avatar: meta.avatar,
      metadataRevision: meta.revision,
      canonical,
      preview: previewText,
      lastActive,
      activity: {
        lastActive,
        lastActiveText: rawLastActive ? relativeTimeFromTs(rawLastActive, now) : '',
        activeNow,
        unread: 0,
        attention: canonical.status === 'mismatch',
      },
    });
  }
  return {
    protocolAvailable: payload?.bot_mode_protocol === true,
    rows,
  };
}

export function botProfileRowsToHermesProfiles(rows = [], selectedProfile = '') {
  const activeProfile = clean(selectedProfile);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => clean(row?.profileName))
    .map((row) => ({
      name: clean(row.profileName),
      active: activeProfile ? clean(row.profileName) === activeProfile : false,
      model: clean(row.model),
      provider: clean(row.provider),
      description: clean(row.description),
      gatewayRunning: Boolean(row.gatewayRunning),
      skillCount: Math.max(0, Number(row.skillCount) || 0),
    }));
}

// ---------------------------------------------------------------------------
// Group chats vs agent profiles
//
// Group chats (e.g. the "Browser launch room" synced from hermes-bots-groups)
// are NOT agent profiles. They must never enter the profile roster, the
// settings profile picker, or the startup "profiles loaded" count. These
// helpers partition a roster payload into agent rows and group-chat rows and
// normalize the released bounded group projection for the Bot Mode deck.
// ---------------------------------------------------------------------------

const GROUP_PROJECTION_MAX_CHARS = 48_000;
const GROUP_PROJECTION_MAX_MESSAGES = 16;
const GROUP_PROJECTION_MAX_TEXT_CHARS = 1_200;
const GROUP_PROJECTION_MAX_IMAGE_CHARS = 24_000;
const GROUP_MEMBER_MIN = 2;
const GROUP_MEMBER_MAX = 6;

function isGroupChatEntry(raw) {
  const entry = asObject(raw);
  const type = clean(entry.type || entry.kind || entry.entry_type || entry.entity_type).toLowerCase();
  if (type === 'group' || type === 'group_chat' || type === 'groupchat') return true;
  if (entry.is_group === true || entry.is_group_chat === true || entry.isGroupChat === true) return true;
  // A members roster without provider/model is a group projection, not a
  // runnable agent profile.
  const hasMembers = Array.isArray(entry.members) && entry.members.length > 0;
  const hasRuntime = Boolean(clean(entry.provider) || clean(entry.model) || entry.canonical_session || entry.worker_session);
  return hasMembers && !hasRuntime;
}

function normalizeGroupChatMembers(value) {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.keys(value).filter((key) => value[key])
      : [];
  const members = [];
  const seen = new Set();
  for (const entry of raw) {
    const name = clean(typeof entry === 'string' ? entry : asObject(entry).name || asObject(entry).profile).toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    members.push(name);
  }
  return members;
}

function groupChatSession(value) {
  const row = asObject(value);
  const durableId = clean(row.id || row.session_id || row.sessionId);
  return {
    title: clean(row.title),
    durableId,
    resolvedRuntimeId: clean(row.resolved_id || row.resolvedId || durableId),
    preview: clean(row.preview).slice(0, 240),
    startedAt: finiteNumber(row.started_at ?? row.startedAt, 0),
    lastActive: finiteNumber(row.last_active ?? row.lastActive, 0),
    messageCount: Math.max(0, Math.floor(finiteNumber(row.message_count ?? row.messageCount, 0))),
    status: durableId ? 'ready' : 'missing',
  };
}

function normalizeGroupChatMessages(value) {
  return (Array.isArray(value) ? value : [])
    .map((raw) => {
      const message = asObject(raw);
      const from = asObject(message.from);
      const text = clean(message.text).slice(0, GROUP_PROJECTION_MAX_TEXT_CHARS);
      const at = finiteNumber(message.at, 0);
      if (!text || !at) return null;
      const rawName = clean(from.name).slice(0, 128);
      // Synced desktop logs carry raw profile names ("default"). "default" is
      // never a display identity: map it to the canonical primary bot name.
      const memberName = /^default$/i.test(rawName) ? 'Roxas' : rawName;
      return {
        id: clean(message.id).slice(0, 160),
        from: {
          kind: clean(from.kind) === 'user' ? 'user' : 'member',
          name: memberName,
          source: clean(from.source).slice(0, 128),
        },
        text,
        at,
        thread: clean(message.thread).slice(0, 128),
      };
    })
    .filter(Boolean)
    .slice(-GROUP_PROJECTION_MAX_MESSAGES);
}

export function groupProjectionMessagesForDisplay(row = {}) {
  return normalizeGroupChatMessages(asObject(row).messages)
    .map((message) => ({
      role: message.from.kind === 'user' ? 'user' : 'assistant',
      content: message.text,
      ts: message.at,
      // Thread id rides along so the threads view can group the log; display
      // labels are already normalized (never "default") by the normalizer.
      thread: message.thread,
      roleLabel: message.from.kind === 'user' ? message.from.name : capitalizeMemberName(message.from.name),
    }));
}

// Group reply labels read like desktop: "Roxas", "Naminé", "Riku" — never a
// raw lowercase profile slug.
function capitalizeMemberName(name) {
  const value = clean(name);
  if (!value) return 'Hermes';
  if (value.toLowerCase() === 'namine') return 'Naminé';
  if (value.toLowerCase() === 'riku') return 'Riku';
  if (value.toLowerCase() === 'roxas') return 'Roxas';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Desktop-parity thread grouping: the room log is a flat list where each entry
// carries a `thread` id. Group entries by thread, preserve first-appearance
// order, and expose reply counts + latest activity per thread.
export function groupThreadsFromProjection(row = {}) {
  const messages = normalizeGroupChatMessages(asObject(row).messages);
  const threads = [];
  const byId = new Map();
  for (const message of messages) {
    const threadId = clean(message.thread) || 'main';
    let thread = byId.get(threadId);
    if (!thread) {
      thread = { id: threadId, root: message, replies: [], latestAt: message.at };
      byId.set(threadId, thread);
      threads.push(thread);
    } else {
      thread.replies.push(message);
      thread.latestAt = Math.max(thread.latestAt, message.at);
    }
  }
  return threads;
}

export function groupThreadMenuEntries(row = {}) {
  const source = asObject(row);
  const roomId = clean(source.roomId || source.id || source.name) || 'group';
  const roomLabel = clean(source.displayName || source.display_name || source.name || roomId);
  return groupThreadsFromProjection(source).map((thread) => {
    const rootText = clean(thread.root?.text);
    const fallbackText = clean(thread.replies.at(-1)?.text);
    const preview = rootText || fallbackText;
    const title = thread.id === 'main' ? 'Main room' : (rootText || `Thread ${thread.id}`);
    return {
      id: `bot-thread:${roomId}:${thread.id}`,
      roomId,
      roomLabel,
      threadId: thread.id,
      title: title.slice(0, 160),
      preview: preview.slice(0, 240),
      source: 'hermes_bot_group_threads',
      sourceLabel: 'Group Chat Threads',
      messageCount: 1 + thread.replies.length,
      replyCount: thread.replies.length,
      lastActive: thread.latestAt,
    };
  });
}

export function botModeExitStateForRegularSession(settings = {}, fallbackProfile = '') {
  const current = asObject(settings);
  const remoteDashboardSession = asObject(current.remoteDashboardSession);
  return {
    returnProfile: clean(current.botModeReturnProfile || fallbackProfile),
    nextSettings: {
      ...current,
      botModeSelectedProfile: '',
      botModeReturnProfile: '',
      sessionId: '',
      pendingProfileContextHandoff: '',
      pendingProfileContextHandoffSessionId: '',
      extensionPreferredModel: null,
      extensionPreferredModelOptions: null,
      remoteDashboardSession: {
        ...remoteDashboardSession,
        storedSessionId: '',
      },
    },
  };
}

function projectedGroupChatEntries(profiles = []) {
  const entries = [];
  for (const rawProfile of Array.isArray(profiles) ? profiles : []) {
    const profile = asObject(rawProfile);
    // Desktop writes the group projection under its own ui_meta key on the
    // default profile; older builds also mirrored it at the top level.
    const uiMeta = asObject(profile.ui_meta);
    let snapshot = asObject(uiMeta['hermes-bots-groups']);
    if (finiteNumber(snapshot.version, 0) !== 3) {
      // Fallback: some runtimes mirror the projection at the payload root.
      snapshot = asObject(asObject(profile)['hermes-bots-groups']);
    }
    if (finiteNumber(snapshot.version, 0) !== 3) continue;
    let snapshotSize = 0;
    try {
      snapshotSize = JSON.stringify(snapshot).length;
    } catch {
      snapshotSize = GROUP_PROJECTION_MAX_CHARS + 1;
    }
    if (snapshotSize > GROUP_PROJECTION_MAX_CHARS) continue;
    const rooms = asObject(snapshot.rooms);
    const deleted = asObject(snapshot.deleted);
    for (const [roomKey, rawRoom] of Object.entries(rooms)) {
      const room = asObject(rawRoom);
      const revision = Math.max(0, Math.floor(finiteNumber(room.revision, 0)));
      const deletedRevision = deleted[roomKey];
      if (roomKey.startsWith('id:') && deletedRevision != null) continue;
      if (deletedRevision != null && finiteNumber(deletedRevision, 0) >= revision) continue;
      const messages = normalizeGroupChatMessages(room.log);
      const members = normalizeGroupChatMembers(room.members);
      entries.push({
        id: clean(room.roomId || roomKey.replace(/^(?:id|name):/, '')),
        roomId: clean(room.roomId),
        roomKey,
        type: 'group',
        display_name: clean(room.name),
        title: `${members.length} member${members.length === 1 ? '' : 's'} · synced projection`,
        members: room.members,
        image: typeof room.image === 'string' ? room.image.slice(0, GROUP_PROJECTION_MAX_IMAGE_CHARS) : null,
        revision,
        messages,
        last_active: messages.reduce((latest, message) => Math.max(latest, message.at), 0),
      });
    }
  }
  return entries;
}

export function normalizeGroupChatList(payload = {}, { sourceId = 'current', now = Date.now(), activityWindowMs = DEFAULT_ACTIVITY_WINDOW_MS } = {}) {
  const source = clean(sourceId) || 'current';
  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.group_chats)
      ? payload.group_chats
      : Array.isArray(payload?.groups)
        ? payload.groups
        : Array.isArray(payload?.data?.group_chats)
          ? payload.data.group_chats
          : [];
  const rows = [];
  const seen = new Set();
  for (const raw of rawRows) {
    if (!isGroupChatEntry(raw)) continue;
    const entry = asObject(raw);
    const id = clean(entry.roomId || entry.id || entry.name).toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = clean(entry.display_name || entry.displayName || entry.title || id);
    const members = normalizeGroupChatMembers(entry.members);
    if (members.length < GROUP_MEMBER_MIN || members.length > GROUP_MEMBER_MAX) continue;
    const messages = normalizeGroupChatMessages(entry.messages || entry.log);
    const canonical = groupChatSession(entry.canonical_session ?? entry.session ?? null);
    const rawAgeMs = entry.age_ms ?? entry.ageMs;
    const ageDerivedLastActive = rawAgeMs == null ? 0 : finiteNumber(now, Date.now()) - finiteNumber(rawAgeMs, 0);
    const lastActive = Math.max(
      canonical.lastActive,
      finiteNumber(entry.last_active ?? entry.lastActive, 0),
      ageDerivedLastActive,
    );
    const activeNow = lastActive > 0
      && Math.max(0, finiteNumber(now, Date.now()) - timestampMs(lastActive)) <= Math.max(0, finiteNumber(activityWindowMs, DEFAULT_ACTIVITY_WINDOW_MS));
    rows.push({
      rosterKey: `${source}::group::${id}`,
      sourceId: source,
      id,
      profileName: id,
      type: 'group',
      displayName,
      title: clean(entry.title) || `${members.length} member${members.length === 1 ? '' : 's'} · synced projection`,
      description: clean(entry.description).slice(0, 500),
      members,
      image: typeof entry.image === 'string' ? entry.image.slice(0, GROUP_PROJECTION_MAX_IMAGE_CHARS) : null,
      revision: Math.max(0, Math.floor(finiteNumber(entry.revision, 0))),
      roomKey: clean(entry.roomKey),
      messages,
      canonical,
      activity: {
        lastActive,
        activeNow,
        unread: 0,
        attention: false,
      },
    });
  }
  return rows;
}

export function splitBotRosterRows(payload = {}, options = {}) {
  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.profiles)
      ? payload.profiles
      : Array.isArray(payload?.data?.profiles)
        ? payload.data.profiles
        : [];
  const agentPayload = rawRows.filter((raw) => !isGroupChatEntry(raw));
  const normalized = normalizeBotProfileList(agentPayload, options);
  const groupChats = [
    ...normalizeGroupChatList(rawRows, options),
    ...normalizeGroupChatList(payload, options),
    ...normalizeGroupChatList(projectedGroupChatEntries(rawRows), options),
  ];
  return {
    protocolAvailable: normalized.protocolAvailable,
    agents: normalized.rows,
    groupChats: mergeGroupChatLists(groupChats),
  };
}

export function mergeGroupChatLists(...lists) {
  const merged = new Map();
  const hasRealSyncedRooms = lists.some((list) =>
    Array.isArray(list) && list.some((row) => row && row.type === 'group' && row.sourceId && row.sourceId !== 'canonical')
  );

  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || row.type !== 'group' || !row.id || clean(row.sourceId).toLowerCase() === 'device') continue;
      // If we have real synced rooms from the connected runtime, drop synthetic canonical fallback rooms
      if (hasRealSyncedRooms && row.sourceId === 'canonical') continue;

      const normalizedName = clean(row.displayName || row.name || '').toLowerCase();
      const normalizedRoomId = clean(row.roomId || '').toLowerCase();
      const normalizedRoomKey = clean(row.roomKey || '').toLowerCase().replace(/^(?:id|name):/, '');
      const normalizedId = clean(row.id || '').toLowerCase().replace(/^(?:id|name):/, '');

      let matchKey = null;
      for (const [key, existing] of merged.entries()) {
        const existingName = clean(existing.displayName || existing.name || '').toLowerCase();
        const existingRoomId = clean(existing.roomId || '').toLowerCase();
        const existingRoomKey = clean(existing.roomKey || '').toLowerCase().replace(/^(?:id|name):/, '');
        const existingId = clean(existing.id || '').toLowerCase().replace(/^(?:id|name):/, '');

        if (normalizedId && existingId === normalizedId) { matchKey = key; break; }
        if (normalizedRoomId && existingRoomId && existingRoomId === normalizedRoomId) { matchKey = key; break; }
        if (normalizedRoomKey && existingRoomKey && existingRoomKey === normalizedRoomKey) { matchKey = key; break; }
        if (normalizedName && existingName && existingName === normalizedName) { matchKey = key; break; }
      }

      if (matchKey) {
        const existing = merged.get(matchKey);
        const existingIsCanonical = existing.sourceId === 'canonical';
        const incomingNotCanonical = row.sourceId !== 'canonical';
        const incomingRevision = Math.max(0, Number(row.revision || 0));
        const existingRevision = Math.max(0, Number(existing.revision || 0));
        const incomingActive = row.activity?.lastActive || 0;
        const existingActive = existing.activity?.lastActive || 0;

        if (
          (existingIsCanonical && incomingNotCanonical) ||
          incomingRevision > existingRevision ||
          (incomingRevision === existingRevision && incomingActive >= existingActive)
        ) {
          merged.delete(matchKey);
          const primaryKey = normalizedRoomId || normalizedRoomKey || normalizedId || normalizedName;
          merged.set(primaryKey, row);
        }
      } else {
        const primaryKey = normalizedRoomId || normalizedRoomKey || normalizedId || normalizedName;
        merged.set(primaryKey, row);
      }
    }
  }
  return [...merged.values()].sort((a, b) => (b.activity?.lastActive || 0) - (a.activity?.lastActive || 0));
}



// ---------------------------------------------------------------------------
// Active Cron Jobs (scheduled tasks viewer)
//
// Backed by the gateway Jobs API (GET /api/jobs — the same jobs.json surface
// `hermes cron list` reads). All reads are profile-scoped by the transport, so
// the viewer shows the active agent's own scheduled tasks. The normalizer is
// deliberately tolerant: the jobs surface has grown fields over time.
// ---------------------------------------------------------------------------

function cronScheduleParts(value) {
  if (typeof value === 'string') return { expression: value, type: '' };
  const row = asObject(value);
  return {
    expression: clean(row.expression || row.cron || row.expr || row.spec),
    everySeconds: Math.max(0, Math.floor(finiteNumber(row.every_seconds ?? row.everySeconds ?? row.interval_seconds ?? row.intervalSeconds, 0))),
    at: clean(row.at || row.run_at || row.runAt),
    type: clean(row.type || row.kind).toLowerCase(),
  };
}

function humanizeEverySeconds(seconds = 0) {
  const total = Math.max(1, Math.floor(seconds));
  if (total % 86400 === 0) return `every ${total / 86400}d`;
  if (total % 3600 === 0) return `every ${total / 3600}h`;
  if (total % 60 === 0) return `every ${total / 60}m`;
  return `every ${total}s`;
}

export function cronScheduleTag(job = {}) {
  const schedule = cronScheduleParts(job.schedule);
  if (schedule.expression) return schedule.expression;
  if (schedule.everySeconds) return humanizeEverySeconds(schedule.everySeconds);
  if (schedule.at) return `at ${schedule.at}`;
  return clean(job.schedule_human || job.scheduleHuman || job.frequency || '');
}

function cronRunRecord(value) {
  const row = asObject(value);
  return {
    status: clean(row.status || row.state || row.result).toLowerCase(),
    timestamp: timestampMs(finiteNumber(row.timestamp ?? row.ts ?? row.started_at ?? row.startedAt ?? row.finished_at ?? row.finishedAt ?? row.run_at ?? row.runAt, 0)),
    error: clean(row.error || row.error_message || row.errorMessage || row.last_fire_error || row.lastFireError),
  };
}

function cronJobStatus({ paused = false, running = false, lastRun = {}, lastFireError = '' } = {}) {
  if (running) return 'running';
  if (paused) return 'paused';
  if (lastFireError) return 'error';
  if (['failed', 'error', 'missed'].includes(lastRun.status)) return 'error';
  if (lastRun.timestamp > 0) return 'active';
  return 'active';
}

export function normalizeCronJobRows(payload = {}, { sourceId = 'gateway', now = Date.now() } = {}) {
  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.jobs)
      ? payload.jobs
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.data?.jobs)
          ? payload.data.jobs
          : [];
  const rows = [];
  const seen = new Set();
  for (const raw of rawRows) {
    const job = asObject(raw);
    const id = clean(job.id || job.job_id || job.jobId || job.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const runHistory = Array.isArray(job.runs) ? job.runs : Array.isArray(job.history) ? job.history : [];
    const lastRunRaw = job.last_run ?? job.lastRun ?? job.last_fire ?? runHistory[runHistory.length - 1];
    const lastRun = cronRunRecord(lastRunRaw);
    if (!lastRun.timestamp) {
      lastRun.timestamp = timestampMs(job.last_run_at ?? job.lastRunAt ?? job.last_fire_at ?? job.lastFireAt ?? job.last_run_time);
    }
    if (!lastRun.status) {
      lastRun.status = clean(job.last_status || job.lastStatus || (lastRun.timestamp ? 'ok' : ''));
    }
    if (!lastRun.error) lastRun.error = clean(job.last_fire_error || job.lastFireError || job.last_delivery_error || job.lastDeliveryError);
    const paused = job.paused === true || job.enabled === false || job.state === 'paused';
    const running = job.running === true || job.in_flight === true || job.state === 'running';
    rows.push({
      sourceId,
      id,
      name: clean(job.name || job.title || id).slice(0, 120),
      prompt: clean(job.prompt || job.prompt_preview || job.description || job.summary).slice(0, 240),
      scheduleTag: cronScheduleTag(job),
      status: cronJobStatus({ paused, running, lastRun }),
      paused,
      profile: clean(job.profile || job.profile_name || job.profileName),
      lastRunAt: lastRun.timestamp,
      lastRunStatus: lastRun.status,
      lastRunError: lastRun.error,
      nextRunAt: timestampMs(job.next_run_at ?? job.nextRunAt ?? job.next_fire_at ?? job.nextFireAt ?? job.next_fire_time ?? job.nextFireTime),
      fetchedAt: Math.max(0, Math.floor(finiteNumber(now, Date.now()))),
    });
  }
  return rows;
}

export function cronRelativeTime(timestamp = 0, now = Date.now()) {
  const ts = timestampMs(timestamp);
  if (!ts) return '';
  const delta = Math.max(0, Math.floor(finiteNumber(now, Date.now()))) - ts;
  const future = delta < 0;
  const minutes = Math.floor(Math.abs(delta) / 60_000);
  if (minutes < 1) return future ? 'in <1m' : 'just now';
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`;
  const months = Math.floor(days / 30);
  return future ? `in ${months}mo` : `${months}mo ago`;
}
