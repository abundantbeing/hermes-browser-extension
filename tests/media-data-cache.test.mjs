import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedMediaCache, createGatewayMediaReader, GATEWAY_MEDIA_RETRY_MS } from '../extension/lib/media-data-cache.mjs';

const pictureUrl = (name) => `data:image/png;base64,${name}`;

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

test('a loaded picture is served from memory without loading it again', async () => {
  const cache = createBoundedMediaCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return pictureUrl('AAAA');
  };
  assert.equal(await cache.getOrLoad('gw|a.png', load), pictureUrl('AAAA'));
  assert.equal(await cache.getOrLoad('gw|a.png', load), pictureUrl('AAAA'));
  assert.equal(loads, 1);
});

test('callers that arrive during one download share that download', async () => {
  const cache = createBoundedMediaCache();
  const release = gate();
  let loads = 0;
  const load = async () => {
    loads += 1;
    await release.wait;
    return pictureUrl('BBBB');
  };
  const first = cache.getOrLoad('gw|b.png', load);
  const second = cache.getOrLoad('gw|b.png', load);
  release.open();
  assert.deepEqual(await Promise.all([first, second]), [pictureUrl('BBBB'), pictureUrl('BBBB')]);
  assert.equal(loads, 1);
});

test('empty and failed downloads are not stored, so the next call retries', async () => {
  const cache = createBoundedMediaCache();
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    if (attempts === 1) return '';
    if (attempts === 2) throw new Error('gateway unreachable');
    return pictureUrl('CCCC');
  };
  assert.equal(await cache.getOrLoad('gw|c.png', load), '');
  assert.equal(await cache.getOrLoad('gw|c.png', load), '');
  assert.equal(cache.has('gw|c.png'), false);
  assert.equal(await cache.getOrLoad('gw|c.png', load), pictureUrl('CCCC'));
  assert.equal(attempts, 3);
});

test('a loader that throws synchronously cannot leave a stuck download behind', async () => {
  const cache = createBoundedMediaCache();
  let attempts = 0;
  const load = () => {
    attempts += 1;
    if (attempts === 1) throw new Error('boom');
    return pictureUrl('DDDD');
  };
  assert.equal(await cache.getOrLoad('gw|d.png', load), '');
  assert.equal(await cache.getOrLoad('gw|d.png', load), pictureUrl('DDDD'));
  assert.equal(attempts, 2);
});

test('the least recently used picture is evicted, and a read counts as a use', async () => {
  const cache = createBoundedMediaCache({ maxEntries: 2 });
  await cache.getOrLoad('a', async () => pictureUrl('a'));
  await cache.getOrLoad('b', async () => pictureUrl('b'));
  // Reading a again makes b the least recently used entry.
  await cache.getOrLoad('a', async () => {
    throw new Error('a should come from memory');
  });
  await cache.getOrLoad('c', async () => pictureUrl('c'));
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.size, 2);
});

test('a picture larger than the entry bound is returned but not stored', async () => {
  const cache = createBoundedMediaCache({ maxEntryChars: 16 });
  const big = pictureUrl('E'.repeat(64));
  assert.equal(await cache.getOrLoad('gw|big.png', async () => big), big);
  assert.equal(cache.has('gw|big.png'), false);
});

// A stub /api/media: `files` maps identity -> path -> data URL, so each connection sees
// only its own pictures. `status` overrides the response for a path.
function stubGateway({ files = {}, status = {} } = {}) {
  const calls = [];
  let identity = '';
  return {
    calls,
    as(next) { identity = next; },
    request: async (filePath) => {
      calls.push([identity, filePath]);
      if (status[filePath] === 'throw') throw new Error('gateway unreachable');
      if (status[filePath]) return { ok: false, status: status[filePath] };
      const dataUrl = files[identity]?.[filePath];
      return dataUrl ? { ok: true, status: 200, json: async () => ({ data_url: dataUrl }) } : { ok: false, status: 404 };
    },
  };
}

test('a picture belongs to the connection that read it', async () => {
  const gateway = stubGateway({ files: { alice: { 'p.png': pictureUrl('ALICE') }, bob: { 'p.png': pictureUrl('BOB') } } });
  const reader = createGatewayMediaReader({ request: gateway.request });
  gateway.as('alice');
  assert.equal(await reader.read('p.png', 'alice'), pictureUrl('ALICE'));
  gateway.as('bob');
  // Same gateway, same path, another account: the gateway is asked again, and answers for bob.
  assert.equal(await reader.read('p.png', 'bob'), pictureUrl('BOB'));
  gateway.as('alice');
  assert.equal(await reader.read('p.png', 'alice'), pictureUrl('ALICE'));
  assert.deepEqual(gateway.calls, [['alice', 'p.png'], ['bob', 'p.png']]);
});

test('a miss on one connection does not hide the picture from another', async () => {
  const gateway = stubGateway({ files: { bob: { 'p.png': pictureUrl('BOB') } } });
  const reader = createGatewayMediaReader({ request: gateway.request });
  gateway.as('alice');
  assert.equal(await reader.read('p.png', 'alice'), '');
  gateway.as('bob');
  assert.equal(await reader.read('p.png', 'bob'), pictureUrl('BOB'));
});

test('downloads in flight are shared only within one connection', async () => {
  const release = gate();
  const calls = [];
  const reader = createGatewayMediaReader({
    request: async (filePath) => {
      const call = calls.push(filePath);
      await release.wait;
      return { ok: true, status: 200, json: async () => ({ data_url: pictureUrl(String(call)) }) };
    },
  });
  const first = reader.read('p.png', 'alice');
  const same = reader.read('p.png', 'alice');
  const other = reader.read('p.png', 'bob');
  release.open();
  const [a, b, c] = await Promise.all([first, same, other]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(calls.length, 2);
});

test('404 and 405 are remembered: that path is not asked again', async () => {
  let clock = 1_000;
  const gateway = stubGateway({ status: { 'gone.png': 404, 'old.png': 405 } });
  const reader = createGatewayMediaReader({ request: gateway.request, now: () => clock });
  assert.equal(await reader.read('gone.png', 'gw'), '');
  assert.equal(await reader.read('old.png', 'gw'), '');
  clock += 24 * 60 * 60 * 1000;
  assert.equal(await reader.read('gone.png', 'gw'), '');
  assert.equal(await reader.read('old.png', 'gw'), '');
  assert.equal(gateway.calls.length, 2);
});

test('any other failure waits ten seconds before the next try', async () => {
  let clock = 1_000;
  let mode = 500;
  const calls = [];
  const reader = createGatewayMediaReader({
    now: () => clock,
    request: async () => {
      calls.push(clock);
      if (mode === 'throw') throw new Error('gateway unreachable');
      if (mode === 'bad') return { ok: true, status: 200, json: async () => ({ data_url: 'javascript:alert(1)' }) };
      if (mode === 'ok') return { ok: true, status: 200, json: async () => ({ data_url: pictureUrl('OK') }) };
      return { ok: false, status: mode };
    },
  });
  for (const next of [500, 'throw', 'bad']) {
    mode = next;
    assert.equal(await reader.read('p.png', 'gw'), '', `${next} gives no picture`);
    clock += GATEWAY_MEDIA_RETRY_MS - 1;
    assert.equal(await reader.read('p.png', 'gw'), '', `${next}: still waiting`);
    clock += 1;
  }
  assert.equal(calls.length, 3, 'one request per failure, none while waiting');
  mode = 'ok';
  assert.equal(await reader.read('p.png', 'gw'), pictureUrl('OK'));
  assert.equal(await reader.read('p.png', 'gw'), pictureUrl('OK'));
  assert.equal(calls.length, 4, 'the picture is then served from memory');
});

test('a blank path asks nothing', async () => {
  const gateway = stubGateway();
  const reader = createGatewayMediaReader({ request: gateway.request });
  assert.equal(await reader.read('', 'gw'), '');
  assert.equal(await reader.read('   ', 'gw'), '');
  assert.equal(gateway.calls.length, 0);
});

// Lesson: a cache of authenticated responses is keyed by everything the request is made as.
// The side panel's request() reads its connection fields; each one must be in the key.
test('the side panel keys pictures by every connection field a gateway request uses', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const client = await readFile(new URL('../extension/lib/hermes-client.mjs', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const request = client.slice(client.indexOf('async function request('), client.indexOf('async function listSessions('));
  const fields = [...new Set([...request.matchAll(/connection\.(\w+)/g)].map((match) => match[1]))];
  assert.ok(fields.includes('apiKey') && fields.includes('activeProfile') && fields.includes('gatewayUrl'));
  const identitySource = panel.slice(panel.indexOf('function gatewayMediaIdentity()'), panel.indexOf('function fetchGatewayMediaDataUrl('));
  assert.ok(identitySource, 'sidepanel.js has gatewayMediaIdentity');
  const identityFor = (settings) => vm.runInNewContext(`${identitySource}; gatewayMediaIdentity()`, { settings });
  const base = { gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'key-one', activeProfile: 'default' };
  for (const field of fields) {
    assert.notEqual(identityFor(base), identityFor({ ...base, [field]: `${base[field] || ''}-changed` }),
      `a change of ${field} must give pictures a new key`);
  }
  assert.match(panel, /gatewayMediaReader\.read\(filePath, gatewayMediaIdentity\(\)\)/);
  assert.equal((panel.match(/createBoundedMediaCache\(|createGatewayMediaReader\(/g) || []).length, 1,
    'the panel reads gateway pictures through one reader only');
});
