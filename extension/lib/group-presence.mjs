// Pure reducer turning Bot Mode runtime activity into per-member presence.
// The typing line, the failure notices and the in-thread live bubble all read this single state.

const TERMINAL = new Set(['replied', 'passed', 'failed']);
const ACTIVE = new Set(['working', 'typing', 'tool']);
// Only these kinds can move a member. Anything else (a future payload, a
// transport-level diagnostic) must not invent a member or reopen a turn.
const MEMBER_KINDS = new Set(['working', 'typing', 'tool_start', 'tool_complete', 'reply', 'pass', 'failed', 'retry']);

export function createPresenceState() {
  return { members: [], order: [], phase: 'idle' };
}

function cloneMembers(state) {
  return asList(state?.members).map((entry) => ({ ...entry }));
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function upsert(members, order, member, roleLabel, now) {
  const name = String(member ?? '');
  let index = members.findIndex((entry) => entry.member === name);
  if (index === -1) {
    members.push({
      member: name,
      roleLabel: roleLabel ?? name,
      state: 'working',
      tool: '',
      error: '',
      text: '',
      changedAt: now,
    });
    order.push(name);
    index = members.length - 1;
  } else if (roleLabel) {
    members[index].roleLabel = roleLabel;
  }
  return index;
}

function setState(entry, next, now, patch = {}) {
  entry.state = next;
  entry.changedAt = now;
  Object.assign(entry, patch);
}

export function reducePresence(state, activity = {}, { now = Date.now() } = {}) {
  const base = state && typeof state === 'object' ? state : createPresenceState();
  const members = cloneMembers(base);
  const order = asList(base.order).slice();
  let phase = base.phase || 'idle';
  const kind = activity?.kind;

  if (kind === 'turn_start') {
    const roster = asList(activity.members);
    members.length = 0;
    order.length = 0;
    for (const row of roster) {
      const name = String(row?.member ?? '');
      members.push({
        member: name,
        roleLabel: row?.roleLabel ?? name,
        state: 'queued',
        tool: '',
        error: '',
        text: '',
        changedAt: now,
      });
      order.push(name);
    }
    phase = 'running';
    return { members, order, phase };
  }

  if (kind === 'idle') {
    return { members, order, phase: 'done' };
  }

  const name = String(activity?.member ?? '');
  if (!name) return { members, order, phase };
  if (!MEMBER_KINDS.has(String(kind))) return { members, order, phase };

  const index = upsert(members, order, name, activity?.roleLabel, now);
  const entry = members[index];
  if (phase === 'idle') phase = 'running';

  switch (kind) {
    case 'working':
      // Only the start of a member's turn says `working`, so a member that already answered is
      // working again: Hermes gave it another round because a bot mentioned it. Late typing and
      // tool frames still cannot reopen it.
      setState(entry, 'working', now, { tool: '', text: '', error: '' });
      break;
    case 'retry':
      // A per-member retry reopens ONLY that member: reset it to queued (a
      // terminal failure would otherwise reject the following working frame)
      // and clear the stale reason, without disturbing the other members or
      // the room order. Phase returns to running so the strip stays visible.
      setState(entry, 'queued', now, { error: '', tool: '', text: '' });
      phase = 'running';
      break;
    case 'typing':
      // A late typing frame must not resurrect a member that already finished.
      if (!TERMINAL.has(entry.state)) setState(entry, 'typing', now, { text: String(activity.text ?? '') });
      break;
    case 'tool_start':
      if (!TERMINAL.has(entry.state)) setState(entry, 'tool', now, { tool: String(activity.tool ?? '') });
      break;
    case 'tool_complete':
      if (!TERMINAL.has(entry.state)) {
        const back = entry.text ? 'typing' : 'working';
        setState(entry, back, now, { tool: '' });
      }
      break;
    case 'reply':
      setState(entry, 'replied', now, { text: '', tool: '' });
      break;
    case 'pass':
      setState(entry, 'passed', now, { text: '', tool: '' });
      break;
    case 'failed':
      setState(entry, 'failed', now, { error: String(activity.error ?? ''), tool: '' });
      break;
    default:
      break;
  }
  return { members, order, phase };
}

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

// Collapse a raw runtime failure into one short, human reason. Usage/quota and
// rate-limit signals (HTTP 402/429, "usage limit", "rate limit", quota, too many
// requests) share a single actionable line; everything else is generic. Pure and
// exported so the mapping is unit tested and every caller reads the same copy.
const USAGE_LIMIT_RE = /(?:usage|rate|token|request|plan)[\s_-]*limit|quota|too many requests|\b429\b|\b402\b|insufficient (?:quota|credit|credits|funds)/i;

export function failureReason(error, { translate = (s) => s } = {}) {
  const t = typeof translate === 'function' ? translate : (s) => s;
  const text = String(error ?? '');
  if (text && USAGE_LIMIT_RE.test(text)) return t('Usage limit reached, try again later');
  return t('Something went wrong');
}

const DUE = new Set(['queued', ...ACTIVE]);

// What the one-line typing indicator under the thread shows while a turn runs, or null when it
// shows nothing. The line cycles through `frames`: everyone the turn is still waiting on as one
// group line (when that is more than one member), then each member answering right now. A running
// turn with nobody due, while Hermes decides whether a bot's mention earns another round, is a
// single `wrapping` frame.
export function presenceLine(state) {
  const members = asList(state?.members);
  if (!members.length || state?.phase !== 'running') return null;
  const due = members.filter((entry) => DUE.has(entry.state));
  if (!due.length) return { frames: [{ kind: 'wrapping' }] };
  const frames = due.length > 1 ? [{ kind: 'group', members: due }] : [];
  const active = due.filter((entry) => ACTIVE.has(entry.state));
  for (const entry of active) frames.push({ kind: 'member', member: entry });
  if (!frames.length) frames.push({ kind: 'member', member: due[0] });
  return { frames };
}

// The words of one frame: the group line names up to three members, a member frame says what that
// member is doing. Names are display names; the caller colours and lays them out.
export function presenceFrameText(frame, { translate = (s) => s } = {}) {
  const t = typeof translate === 'function' ? translate : (s) => s;
  if (frame?.kind === 'wrapping') return t('Wrapping up…');
  if (frame?.kind === 'group') {
    const names = asList(frame.members).map((entry) => entry.roleLabel || entry.member);
    if (names.length === 2) return fill(t('{first} and {second} are working…'), { first: names[0], second: names[1] });
    if (names.length === 3) return fill(t('{first}, {second}, and {third} are working…'), { first: names[0], second: names[1], third: names[2] });
    return fill(t('{first}, {second}, and {count} more are working…'), { first: names[0], second: names[1], count: names.length - 2 });
  }
  const entry = frame?.member || {};
  if (entry.state === 'typing') return t('Typing…');
  if (entry.state === 'tool' && entry.tool) return fill(t('Using {tool}…'), { tool: entry.tool });
  return t('Working…');
}
