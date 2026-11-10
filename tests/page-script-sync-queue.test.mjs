import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeaderRuleSync } from '../extension/lib/connection-headers.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('queued page-script sync applies the newest settings after slow reads', async () => {
  let revision = 0;
  const applied = [];
  const sync = createHeaderRuleSync({
    read: async () => {
      const current = ++revision;
      if (current === 1) await delay(40);
      return { revision: current };
    },
    apply: async (settings) => {
      applied.push(settings.revision);
    },
  });
  const first = sync();
  const second = sync();
  await Promise.all([first, second]);
  assert.deepEqual(applied, [1, 2]);
});
