import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOT_CHAT_TITLE,
  botModeAvailability,
  botProfileRowsToHermesProfiles,
  botModeRouteKey,
  botModeSessionParams,
  canSwitchBotProfile,
  cronRelativeTime,
  cronScheduleTag,
  normalizeCronJobRows,
  normalizeBotProfileList,
  scopedBotSessionKey,
  shouldUseBotDashboardTransport,
} from '../extension/lib/bot-mode.mjs';

const PROFILE_PAYLOAD = {
  bot_mode_protocol: true,
  profiles: [
    {
      name: 'roxas',
      path: 'C:/Users/example/.hermes/profiles/roxas',
      display_name: 'Roxas',
      description: 'Architect',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      skill_count: 42,
      has_avatar: true,
      ui_meta: { 'hermes-bots': { title: 'Architect', color: '#d7d594' } },
      ui_meta_revisions: { 'hermes-bots': 12 },
      canonical_session: {
        id: 'bot-chat-root',
        resolved_id: 'bot-chat-tip',
        root_title: BOT_CHAT_TITLE,
        title: 'Bot Chat · continuation',
        preview: 'Train 2 is ready',
        started_at: 100,
        last_active: 990,
        message_count: 8,
      },
      worker_session: { id: 'worker-1', source: 'kanban', last_active: 995 },
    },
    {
      name: 'namine',
      display_name: 'Naminé',
      canonical_session: null,
      worker_session: null,
      last_session: { id: 'scratch', title: 'Ordinary chat', last_active: 980 },
    },
    {
      name: 'mismatch',
      canonical_session: {
        id: 'wrong',
        resolved_id: 'wrong',
        root_title: 'Ordinary chat',
        title: 'Ordinary chat',
      },
    },
  ],
};

test('Bot Mode normalizes a bounded verified roster without leaking profile paths', () => {
  const result = normalizeBotProfileList(PROFILE_PAYLOAD, {
    sourceId: 'local-main',
    now: 1_000_000,
    activityWindowMs: 60_000,
  });

  assert.equal(result.protocolAvailable, true);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0], {
    rosterKey: 'local-main::roxas',
    sourceId: 'local-main',
    profileName: 'roxas',
    displayName: 'Architect',
    title: 'Architect',
    description: 'Architect',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    skillCount: 42,
    hasAvatar: true,
    avatar: null,
    metadataRevision: 12,
    canonical: {
      title: BOT_CHAT_TITLE,
      durableId: 'bot-chat-root',
      resolvedRuntimeId: 'bot-chat-tip',
      preview: 'Train 2 is ready',
      startedAt: 100,
      lastActive: 990,
      messageCount: 8,
      status: 'ready',
    },
    preview: 'Train 2 is ready',
    lastActive: 995,
    activity: {
      lastActive: 995,
      lastActiveText: 'now',
      activeNow: true,
      unread: 0,
      attention: false,
    },
  });
  assert.equal('path' in result.rows[0], false);
  assert.equal(result.rows[1].canonical.status, 'missing');
  assert.equal(result.rows[2].canonical.status, 'mismatch');
  assert.notEqual(result.rows[1].canonical.durableId, 'scratch');
});

test('Bot Mode converts verified roster rows into settings profile records', () => {
  const roster = normalizeBotProfileList(PROFILE_PAYLOAD, { sourceId: 'local-main' });

  assert.deepEqual(botProfileRowsToHermesProfiles(roster.rows, 'namine'), [
    { name: 'roxas', active: false, model: 'gpt-5.6-sol', provider: 'openai-codex', description: 'Architect', gatewayRunning: false, skillCount: 42 },
    { name: 'namine', active: true, model: '', provider: '', description: '', gatewayRunning: false, skillCount: 0 },
    { name: 'mismatch', active: false, model: '', provider: '', description: '', gatewayRunning: false, skillCount: 0 },
  ]);
});

test('Bot Mode route and state keys isolate gateway, transport, profile, and session', () => {
  const roxas = botModeRouteKey({ connectionId: 'gateway-A', transport: 'local-api', profile: 'roxas' });
  const namine = botModeRouteKey({ connectionId: 'gateway-A', transport: 'local-api', profile: 'namine' });
  const remote = botModeRouteKey({ connectionId: 'gateway-B', transport: 'remote-dashboard', profile: 'roxas' });
  assert.notEqual(roxas, namine);
  assert.notEqual(roxas, remote);
  assert.notEqual(
    scopedBotSessionKey({ routeKey: roxas, durableSessionId: 'shared-id' }),
    scopedBotSessionKey({ routeKey: namine, durableSessionId: 'shared-id' }),
  );
});

test('Bot Mode session requests always carry the selected profile', () => {
  assert.deepEqual(botModeSessionParams('namine', { title: BOT_CHAT_TITLE, hidden: true }), {
    title: BOT_CHAT_TITLE,
    hidden: true,
    profile: 'namine',
  });
  assert.throws(() => botModeSessionParams('', { title: BOT_CHAT_TITLE }), /profile/i);
});

test('Desktop Bot and group sessions stay on dashboard WebSocket transport', () => {
  assert.equal(shouldUseBotDashboardTransport({ gatewayMode: 'remote-dashboard' }), true);
  assert.equal(shouldUseBotDashboardTransport({ gatewayMode: 'local-api', source: 'hermes_bot_mode' }), true);
  assert.equal(shouldUseBotDashboardTransport({ gatewayMode: 'local-api', source: 'hermes_bot_group' }), true);
  assert.equal(shouldUseBotDashboardTransport({ gatewayMode: 'local-api', source: 'hermes_browser' }), false);
  assert.equal(shouldUseBotDashboardTransport({ gatewayMode: 'local-api', transport: 'dashboard-ws' }), true);
});

test('Bot Mode profile switching blocks active turns and treats selection as future-session scope', () => {
  assert.deepEqual(canSwitchBotProfile({ running: true, currentProfile: 'roxas', selectedProfile: 'namine' }), {
    allowed: false,
    reason: 'turn-active',
  });
  assert.deepEqual(canSwitchBotProfile({ running: false, currentProfile: 'roxas', selectedProfile: 'namine' }), {
    allowed: true,
    reason: 'new-session-required',
  });
  assert.deepEqual(canSwitchBotProfile({ running: false, currentProfile: 'roxas', selectedProfile: 'roxas' }), {
    allowed: true,
    reason: 'already-selected',
  });
});

test('Bot Mode availability is truthful and off means no probes', () => {
  assert.deepEqual(botModeAvailability({ enabled: false }), { state: 'off', shouldProbe: false });
  assert.deepEqual(botModeAvailability({ enabled: true, authenticated: false }), { state: 'authentication-required', shouldProbe: false });
  assert.deepEqual(botModeAvailability({ enabled: true, authenticated: true, rosterRead: false }), { state: 'runtime-update-required', shouldProbe: false });
  assert.deepEqual(botModeAvailability({ enabled: true, authenticated: true, rosterRead: true }), { state: 'loading', shouldProbe: true });
});


test('Bot Mode display name mirrors the desktop precedence: ui_meta title first', () => {
  const result = normalizeBotProfileList(
    {
      profiles: [
        { name: 'default', ui_meta: { 'hermes-bots': { title: 'Roxas' } } },
        { name: 'namine', display_name: 'Naminé' },
        { name: 'riku' },
      ],
    },
    { sourceId: 'local' },
  );
  const byName = new Map(result.rows.map((row) => [row.profileName, row.displayName]));
  assert.equal(byName.get('default'), 'Roxas');
  assert.equal(byName.get('namine'), 'Naminé');
  assert.equal(byName.get('riku'), 'Riku');
});

test('cron job rows normalize from the Jobs API payload with schedule tags and status', () => {
  const now = 1_800_000_000_000;
  const rows = normalizeCronJobRows(
    {
      jobs: [
        {
          id: 'review-watch',
          name: 'review-watch',
          prompt: 'Watch upstream reviews and summarize deltas.',
          schedule: { every_seconds: 1800 },
          paused: false,
          last_run: { status: 'success', timestamp: now - 300_000 },
          next_run_at: now + 1_500_000,
        },
        {
          id: 'scouts',
          name: 'scouts',
          prompt: 'Run competitor scouts.',
          schedule: '*/15 * * * *',
          last_run: { status: 'failed', timestamp: now - 7_200_000, error: 'gateway restart required' },
        },
        {
          id: 'digest',
          name: 'digest',
          prompt: 'Deliver the morning digest.',
          schedule: '0 9 * * *',
          paused: true,
        },
      ],
    },
    { sourceId: 'gw', now },
  );
  assert.equal(rows.length, 3);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get('review-watch').scheduleTag, 'every 30m');
  assert.equal(byId.get('review-watch').status, 'active');
  assert.equal(byId.get('review-watch').lastRunAt, now - 300_000);
  assert.ok(byId.get('review-watch').nextRunAt > 0);
  assert.equal(byId.get('scouts').scheduleTag, '*/15 * * * *');
  assert.equal(byId.get('scouts').status, 'error');
  assert.match(byId.get('scouts').lastRunError, /gateway restart/);
  assert.equal(byId.get('digest').status, 'paused');
  assert.equal(byId.get('digest').lastRunAt, 0);
});

test('cron job rows tolerate alternate payload shapes and skip duplicates', () => {
  const rows = normalizeCronJobRows(
    [
      { job_id: 'a', name: 'Alpha', schedule: { expression: '5 4 * * *' } },
      { id: 'a', name: 'Alpha duplicate' },
      { name: 'Beta', schedule: { at: '2026-09-01T09:00:00Z' } },
      { name: 'Gamma', schedule: { every_seconds: 900 } },
      {},
    ],
    { sourceId: 'gw', now: 1_000 },
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].scheduleTag, '5 4 * * *');
  assert.equal(rows[1].scheduleTag, 'at 2026-09-01T09:00:00Z');
  assert.equal(cronScheduleTag({ schedule: { every_seconds: 86400 } }), 'every 1d');
});

test('cron job rows parse ISO next-fire fields from current gateway payloads', () => {
  const rows = normalizeCronJobRows(
    {
      jobs: [
        { job_id: 'iso-next-run', next_run_at: '2027-01-15T12:30:00.000Z' },
        { job_id: 'iso-next-fire', next_fire_time: '2027-01-15T13:45:00.000Z' },
      ],
    },
    { now: Date.parse('2027-01-15T12:00:00.000Z') },
  );
  assert.equal(rows[0].nextRunAt, Date.parse('2027-01-15T12:30:00.000Z'));
  assert.equal(rows[1].nextRunAt, Date.parse('2027-01-15T13:45:00.000Z'));
});

test('cronRelativeTime renders compact human labels', () => {
  const now = 1_800_000_000_000;
  assert.equal(cronRelativeTime(now - 10_000, now), 'just now');
  assert.equal(cronRelativeTime(now - 300_000, now), '5m ago');
  assert.equal(cronRelativeTime(now - 7_200_000, now), '2h ago');
  assert.equal(cronRelativeTime(now - 86_400_000 * 3, now), '3d ago');
  assert.equal(cronRelativeTime(now + 25 * 60_000, now), 'in 25m');
  assert.equal(cronRelativeTime(now + 2 * 3_600_000, now), 'in 2h');
  assert.equal(cronRelativeTime(now + 3 * 86_400_000, now), 'in 3d');
  assert.equal(cronRelativeTime(0, now), '');
});

