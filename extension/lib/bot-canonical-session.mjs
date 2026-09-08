export const BOT_CHAT_TITLE = 'Bot Chat';

function clean(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function profileFrom(value) {
  const row = asObject(value);
  return clean(
    row.profile
      || row.profile_name
      || row.effective_profile
      || row.session_profile
      || row.info?.profile_name,
  );
}

function durableIdFrom(value) {
  const row = asObject(value);
  return clean(row.id || row.durableId || row.stored_session_id || row.storedId);
}

function runtimeIdFrom(value, durableId = durableIdFrom(value)) {
  const row = asObject(value);
  return clean(
    row.resolved_id
      || row.resolvedId
      || row.resolvedRuntimeId
      || row.runtimeId
      || durableId,
  );
}

function canonicalFrom(row) {
  const value = asObject(row);
  return value.canonical ?? value.canonical_session ?? null;
}

function parseArguments(rowOrProfile, canonicalOrList, maybeList) {
  if (typeof canonicalOrList === 'function') {
    const row = asObject(rowOrProfile);
    return {
      profile: clean(row.profile || row.profileName || row.name),
      canonical: canonicalFrom(row),
      listSessions: canonicalOrList,
    };
  }

  const row = asObject(rowOrProfile);
  return {
    profile: clean(typeof rowOrProfile === 'string' ? rowOrProfile : (row.profile || row.profileName || row.name)),
    canonical: typeof rowOrProfile === 'string' ? canonicalOrList : canonicalFrom(row) ?? canonicalOrList,
    listSessions: maybeList || row.listSessions,
  };
}

function sessionRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.sessions)) return payload.data.sessions;
  throw new Error('Canonical Bot Chat lookup returned an invalid session list.');
}

function isCanonicalTitle(row) {
  const value = asObject(row);
  const rootTitle = clean(value.root_title || value.rootTitle);
  const title = clean(value.title);
  return rootTitle === BOT_CHAT_TITLE || (!rootTitle && title === BOT_CHAT_TITLE);
}

function canonicalIsKnown(canonical) {
  return Boolean(durableIdFrom(canonical));
}

function assertProfileMatch(value, expectedProfile) {
  const actualProfile = profileFrom(value);
  if (actualProfile && actualProfile !== expectedProfile) {
    throw new Error(
      `Canonical Bot Chat profile mismatch: expected ${expectedProfile}, received ${actualProfile}.`,
    );
  }
}

/**
 * Resolve a Bot Mode row to the profile-scoped canonical chat.
 *
 * The primary interface accepts a normalized roster row (`profileName` plus
 * `canonical`) and an async list callback. The callback receives the exact
 * profile/title lookup requested from the gateway and may return an array or a
 * gateway response containing `sessions`/`data`.
 *
 * Existing chats return their durable registry id and current compression tip.
 * `null` means the lookup positively found no exact canonical title. Lookup
 * failures and contradictory roster/list state throw so callers cannot create
 * a forked chat.
 *
 * For callers that already keep the fields separate, the positional form
 * `(profile, canonical, listSessions)` is also accepted.
 */
export async function resolveCanonicalBotSession(rowOrProfile, canonicalOrList, maybeList) {
  const { profile, canonical, listSessions } = parseArguments(rowOrProfile, canonicalOrList, maybeList);

  if (!profile) throw new Error('A verified Hermes profile is required to resolve Bot Chat.');
  if (typeof listSessions !== 'function') throw new TypeError('An async Bot Chat list function is required.');

  assertProfileMatch(canonical, profile);

  let payload;
  try {
    payload = await listSessions({
      profile,
      title: BOT_CHAT_TITLE,
      include_hidden: true,
    });
  } catch (error) {
    const detail = clean(error?.message || error);
    throw new Error(
      `Canonical Bot Chat lookup failed for ${profile}${detail ? `: ${detail}` : ''}.`,
      { cause: error },
    );
  }

  const rows = sessionRows(payload);
  const matches = rows.filter(isCanonicalTitle);

  for (const match of matches) assertProfileMatch(match, profile);

  if (matches.length > 1) {
    throw new Error(`Canonical Bot Chat lookup returned multiple exact rows for ${profile}.`);
  }

  const match = matches[0];
  if (match) {
    const durableId = durableIdFrom(match);
    if (!durableId) {
      throw new Error(`Canonical Bot Chat lookup returned an exact row without a durable id for ${profile}.`);
    }
    return {
      durableId,
      runtimeId: runtimeIdFrom(match, durableId),
    };
  }

  if (canonicalIsKnown(canonical)) {
    throw new Error(`Could not confirm ${profile}'s canonical Bot Chat registry.`);
  }

  return null;
}

export const resolveCanonicalBotChat = resolveCanonicalBotSession;
