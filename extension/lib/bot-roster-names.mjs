import { normalizeBotProfileList } from './bot-mode.mjs';

// Stock Hermes serves no GET /v1/profiles, so a client holding only the API
// credential can confirm profile NAMES (health routes) but not their titles,
// pictures or colours. Those names are still enough to list each bot and open
// its Bot Chat over REST, so Bot Mode shows them instead of an empty roster and
// says plainly what is missing.

export const NAMES_ONLY_ROSTER_NOTE_KEY = 'bot_mode.roster_names_only';
export const NAMES_ONLY_ROSTER_ACTION_KEY = 'bot_mode.roster_names_only_action';

function cleanName(value) {
  return String(value ?? '').trim();
}

// Roster rows for a names-only gateway. A name the browser already knew in full
// (a previous rich roster) keeps its details; any other name becomes a plain
// row. Rows built here carry `namesOnly: true` so the roster can explain
// itself. `bots` is an optional list of raw profile rows ({name,
// canonical_session}) whose Bot Chat lookup already ran.
export function buildNamesOnlyRoster({ names = [], bots = [], richRows = [], sourceId = 'current', now = Date.now() } = {}) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = cleanName(typeof raw === 'string' ? raw : raw?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  const rich = new Map();
  for (const row of Array.isArray(richRows) ? richRows : []) {
    const name = cleanName(row?.profileName);
    if (name && !row.namesOnly && !rich.has(name)) rich.set(name, row);
  }
  const rawByName = new Map();
  for (const bot of Array.isArray(bots) ? bots : []) {
    const name = cleanName(bot?.name);
    if (name) rawByName.set(name, bot);
  }
  const plain = normalizeBotProfileList(
    unique.map((name) => ({ ...(rawByName.get(name) || {}), name })),
    { sourceId, now },
  ).rows;
  const plainByName = new Map(plain.map((row) => [row.profileName, row]));
  const rows = unique.map((name) => rich.get(name) || { ...plainByName.get(name), namesOnly: true });
  return {
    rows,
    // The roster is not the full one, so the load is degraded, never ready.
    state: 'degraded',
    detail: unique.length === 1 ? '1 PROFILE LISTED BY NAME.' : `${unique.length} PROFILES LISTED BY NAME.`,
    noteKey: NAMES_ONLY_ROSTER_NOTE_KEY,
    actionKey: NAMES_ONLY_ROSTER_ACTION_KEY,
  };
}

export function rosterHasNamesOnlyRows(rows = []) {
  return Array.isArray(rows) && rows.some((row) => row?.namesOnly === true);
}
