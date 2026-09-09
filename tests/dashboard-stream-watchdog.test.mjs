import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createDashboardStreamWatchdog,
  isDashboardIdleTimeout,
} from '../extension/lib/dashboard-stream-watchdog.mjs';

test('dashboard stream watchdog only times out after idle, not after continuous tool activity', () => {
  const calls = [];
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const watchdog = createDashboardStreamWatchdog((error) => calls.push(error.message), {
    idleMs: 1_000,
    setTimeoutFn: (fn, delay) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
  });

  const flush = (advance) => {
    now += advance;
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.due <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };

  flush(900);
  watchdog.ping();
  flush(900);
  watchdog.ping();
  flush(900);
  assert.deepEqual(calls, []);
  flush(1_000);
  assert.deepEqual(calls, ['Dashboard response timed out.']);
  watchdog.stop();
});

test('dashboard idle timeout is distinct from a dropped connection', () => {
  assert.equal(isDashboardIdleTimeout(new Error('Dashboard response timed out.')), true);
  assert.equal(isDashboardIdleTimeout(new Error('Dashboard connection closed mid-turn.')), false);
});

test('side panel and Hermes Web reset the dashboard idle watchdog on live turn activity', () => {
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
  for (const source of [panel, web]) {
    assert.match(source, /createDashboardStreamWatchdog/);
    assert.match(source, /watchdog\.ping\(\)/);
    assert.match(source, /watchdog\.stop\(\)/);
    assert.match(source, /\.on\('\*'/);
  }
  assert.match(panel, /isDashboardIdleTimeout\(streamError\)/);
});
