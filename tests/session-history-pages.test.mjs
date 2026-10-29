import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fetchSessionHistoryPages } from '../extension/lib/session-history-pages.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// A gateway that pages like Hermes: `latest` counts from the newest and returns each page in order.
function gateway(total, { pages = true } = {}) {
  const all = Array.from({ length: total }, (_, index) => ({ id: index + 1, content: `m${index + 1}` }));
  const queries = [];
  const fetchPage = async (query) => {
    queries.push(query);
    const params = new URLSearchParams(query);
    const limit = params.has('limit') ? Math.min(Number(params.get('limit')), 500) : 500;
    const offset = Number(params.get('offset') || 0);
    const end = all.length - offset;
    const data = all.slice(Math.max(0, end - limit), Math.max(0, end));
    return pages
      ? { data, session: { id: 's' }, pagination: { limit, offset, order: params.get('order') || 'latest', returned: data.length } }
      : { data: all, session: { id: 's' } };
  };
  return { fetchPage, queries };
}

test('a short chat is one request', async () => {
  const { fetchPage, queries } = gateway(120);
  const result = await fetchSessionHistoryPages(fetchPage);
  assert.equal(result.rows.length, 120);
  assert.deepEqual(queries, ['']);
  assert.equal(result.truncated, false);
});

test('a long chat loads every page, oldest first, with the first answer kept', async () => {
  const { fetchPage, queries } = gateway(1234);
  const result = await fetchSessionHistoryPages(fetchPage);
  assert.equal(result.rows.length, 1234);
  assert.deepEqual(result.rows.slice(0, 2).map((row) => row.id), [1, 2]);
  assert.equal(result.rows.at(-1).id, 1234);
  assert.deepEqual(queries, ['', 'order=latest&limit=500&offset=500', 'order=latest&limit=500&offset=1000']);
  assert.deepEqual(result.payload.session, { id: 's' });
  assert.equal(result.truncated, false);
});

test('exactly a page more ends on the empty page; the cap keeps the newest rows and says so', async () => {
  const exact = gateway(1000);
  assert.equal((await fetchSessionHistoryPages(exact.fetchPage)).rows.length, 1000);
  const capped = await fetchSessionHistoryPages(gateway(5000).fetchPage, { maxPages: 3 });
  assert.equal(capped.rows.length, 1500);
  assert.equal(capped.rows.at(-1).id, 5000, 'the newest rows are the ones kept');
  assert.equal(capped.truncated, true);
});

test('a gateway that does not page keeps its single answer', async () => {
  const { fetchPage, queries } = gateway(700, { pages: false });
  const result = await fetchSessionHistoryPages(fetchPage);
  assert.equal(result.rows.length, 700);
  assert.deepEqual(queries, ['']);
});

test('a row seen twice across a page boundary is kept once', async () => {
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    if (calls === 1) {
      return { data: Array.from({ length: 500 }, (_, i) => ({ id: 501 + i })), pagination: { order: 'latest', offset: 0 } };
    }
    return { data: Array.from({ length: 300 }, (_, i) => ({ id: 202 + i })), pagination: { order: 'latest', offset: 500 } };
  };
  const result = await fetchSessionHistoryPages(fetchPage);
  assert.equal(result.rows.length, 799);
  assert.equal(new Set(result.rows.map((row) => row.id)).size, 799);
});

test('opening and refreshing a REST chat read the whole history; background reads stay one page', () => {
  const quiet = source.slice(source.indexOf('async function fetchSessionMessagesQuietly('), source.indexOf('// Dashboard history for background reconciliation'));
  assert.match(quiet, /allPages = false/);
  assert.match(quiet, /fetchSessionHistoryPages\(/);
  assert.match(source, /fetchSessionMessagesQuietly\(sessionId, \{ transport, connection: activeDashboardWsConnection \|\| connection, allPages: true \}\)/);
  assert.match(source, /: await fetchSessionMessagesQuietly\(sessionId, \{ allPages: true \}\);/);
});
