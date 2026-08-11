import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_SURFACE_SOURCES,
  foreignSessionSourceLabel,
  requiresSessionOwnershipConfirmation,
  sessionMessageCount,
  sessionOwnedBySurface,
  sessionOwnershipNotice,
} from '../extension/lib/session-ownership.mjs';

test('each Browser surface owns only its own durable session source', () => {
  const approved = new Set();
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'browser-1', source: 'hermes_browser' },
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
    approvedSessionIds: approved,
  }), false);
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'web-1', source: 'hermes_web' },
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
    approvedSessionIds: approved,
  }), true);
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'browser-1', source: 'hermes_browser' },
    expectedSource: SESSION_SURFACE_SOURCES.FULL_TAB,
    approvedSessionIds: approved,
  }), true);
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'web-1', source: 'hermes_web' },
    expectedSource: SESSION_SURFACE_SOURCES.FULL_TAB,
    approvedSessionIds: approved,
  }), false);
});

test('new or nullable session input never triggers the foreign-session guard', () => {
  assert.equal(requiresSessionOwnershipConfirmation({
    session: null,
    expectedSource: SESSION_SURFACE_SOURCES.FULL_TAB,
  }), false);
  assert.equal(sessionOwnedBySurface(null, SESSION_SURFACE_SOURCES.FULL_TAB), false);
  assert.equal(sessionMessageCount(null), null);
});

test('an explicit approval is exact-session and ephemeral policy input', () => {
  const approved = new Set(['cli-1']);
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'cli-1', source: 'cli' },
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
    approvedSessionIds: approved,
  }), false);
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'cli-2', source: 'cli' },
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
    approvedSessionIds: approved,
  }), true);
});

test('message count uses runtime truth without creating a safety threshold', () => {
  assert.equal(sessionMessageCount({ message_count: 2 }), 2);
  assert.equal(sessionMessageCount({ messageCount: 101 }), 101);
  assert.equal(sessionMessageCount({ messages: [{}, {}, {}] }), 3);
  assert.equal(sessionMessageCount({ message_count: -1 }), null);
  assert.equal(requiresSessionOwnershipConfirmation({
    session: { id: 'api-1', source: 'api', message_count: 0 },
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
  }), true, 'concurrent writers are unsafe even before a long transcript exists');
});

test('ownership copy states source, exact blast radius, and overwrite/reorder risk', () => {
  const notice = sessionOwnershipNotice({
    session: { id: 'web-1', source: 'hermes_web', message_count: 2 },
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
  });
  assert.equal(notice.sourceLabel, 'Hermes Web');
  assert.match(notice.title, /Hermes Web session selected/);
  assert.match(notice.detail, /already contains 2 messages/);
  assert.match(notice.detail, /overwrite or reorder transcript updates/);
  assert.equal(notice.newChatLabel, 'New Browser chat');
  assert.equal(notice.continueLabel, 'Continue in Hermes Web');

  const unknown = sessionOwnershipNotice({
    session: { id: 'external-1', source: 'external' },
    expectedSource: SESSION_SURFACE_SOURCES.FULL_TAB,
  });
  assert.match(unknown.detail, /message count is unavailable/);
  assert.equal(unknown.newChatLabel, 'New Hermes Web chat');
});

test('source labels are stable and user-facing', () => {
  assert.equal(foreignSessionSourceLabel({ source: 'hermes_browser' }), 'Hermes Browser Extension');
  assert.equal(foreignSessionSourceLabel({ source: 'hermes_web' }), 'Hermes Web');
  assert.equal(foreignSessionSourceLabel({ source: 'webui' }), 'Hermes Web');
  assert.equal(foreignSessionSourceLabel({ source: 'api' }), 'API');
  assert.equal(foreignSessionSourceLabel({ source: 'cli' }), 'CLI');
});
