import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mediaDisplayName,
  mediaSourcePlan,
  resolveDisplayableMediaSource,
} from '../extension/lib/media-source.mjs';

const BASE_URL = 'http://127.0.0.1:8765';
const MANAGED_IMAGE = 'C:/Users/Jaybo/.hermes/cache/images/img_26c20aef5209.jpg';
const MANAGED_VIDEO = 'C:/Users/Jaybo/.hermes/cache/videos/clip_01.mp4';
const SPACED_MANAGED_IMAGE = 'D:/Hermes/.hermes/images/HBE MARKETING GFX/a b.png';
const SPACED_MANAGED_VIDEO = 'D:/Hermes/.hermes/cache/videos/HBE MARKETING GFX/a b.mp4';
const UNMANAGED_IMAGE = 'D:/Documents/HBE MARKETING GFX/a b.png';

test('mediaSourcePlan passes raster data URLs through as direct', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  assert.deepEqual(mediaSourcePlan(dataUrl), {
    transport: 'direct',
    url: dataUrl,
    kind: 'image',
    reason: 'direct-url',
  });
});

test('mediaSourcePlan passes https URLs through as direct', () => {
  const httpsUrl = 'https://example.com/generated/pic.png';
  assert.deepEqual(mediaSourcePlan(httpsUrl), {
    transport: 'direct',
    url: httpsUrl,
    kind: 'image',
    reason: 'direct-url',
  });
  assert.equal(mediaSourcePlan('https://example.com/clips/demo.mp4').kind, 'video');
});

test('mediaSourcePlan never trusts unsafe schemes as direct sources', () => {
  for (const value of [
    'file:///D:/Documents/a.png',
    'blob:https://example.com/1234',
    'javascript:alert(1)',
    'ftp://example.com/a.png',
    'data:image/svg+xml;base64,AAAA',
    'data:text/html;base64,AAAA',
  ]) {
    const plan = mediaSourcePlan(value);
    assert.equal(plan.transport, 'none', value);
    assert.equal(plan.url, '', value);
    assert.equal(plan.reason, 'path-not-media-managed', value);
  }
});

test('mediaSourcePlan routes managed media to policy-scoped dashboard endpoints', () => {
  assert.deepEqual(mediaSourcePlan(MANAGED_IMAGE, { baseUrl: BASE_URL }), {
    transport: 'dashboard-media',
    url: `${BASE_URL}/api/media?path=${encodeURIComponent(MANAGED_IMAGE)}`,
    kind: 'image',
    reason: 'hermes-managed-image',
  });
  // A trailing slash on baseUrl must not produce a double slash.
  assert.deepEqual(mediaSourcePlan(MANAGED_VIDEO, { baseUrl: `${BASE_URL}/` }), {
    transport: 'dashboard-stream',
    url: `${BASE_URL}/api/files/stream?path=${encodeURIComponent(MANAGED_VIDEO)}`,
    kind: 'video',
    reason: 'hermes-managed-video',
  });
  // No baseUrl yields a root-relative URL.
  assert.equal(mediaSourcePlan(MANAGED_IMAGE).url, `/api/media?path=${encodeURIComponent(MANAGED_IMAGE)}`);
});

test('mediaSourcePlan emits exact encodeURIComponent query strings for paths with spaces', () => {
  assert.equal(
    mediaSourcePlan(SPACED_MANAGED_IMAGE, { baseUrl: BASE_URL }).url,
    'http://127.0.0.1:8765/api/media?path=D%3A%2FHermes%2F.hermes%2Fimages%2FHBE%20MARKETING%20GFX%2Fa%20b.png',
  );
  assert.equal(
    mediaSourcePlan(SPACED_MANAGED_VIDEO, { baseUrl: BASE_URL }).url,
    'http://127.0.0.1:8765/api/files/stream?path=D%3A%2FHermes%2F.hermes%2Fcache%2Fvideos%2FHBE%20MARKETING%20GFX%2Fa%20b.mp4',
  );
});

test('mediaSourcePlan preserves Windows separators and only percent-encodes them', () => {
  const winPath = 'C:\\Users\\Jaybo\\.hermes\\cache\\images\\img 1.png';
  assert.equal(
    mediaSourcePlan(winPath, { baseUrl: BASE_URL }).url,
    'http://127.0.0.1:8765/api/media?path=C%3A%5CUsers%5CJaybo%5C.hermes%5Ccache%5Cimages%5Cimg%201.png',
  );
});

test('an unmanaged path (the exact "a b.png" example) is refused with no fetch', async () => {
  assert.deepEqual(mediaSourcePlan(UNMANAGED_IMAGE, { baseUrl: BASE_URL }), {
    transport: 'none',
    url: '',
    kind: 'image',
    reason: 'path-not-media-managed',
  });
  let fetchCalls = 0;
  const result = await resolveDisplayableMediaSource(UNMANAGED_IMAGE, {
    baseUrl: BASE_URL,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'path-not-media-managed' });
  assert.equal(fetchCalls, 0);
});

test('managed cache image resolves the dashboard data_url payload', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ data_url: 'data:image/jpeg;base64,AAAA' }) };
  };
  const signal = new AbortController().signal;
  const result = await resolveDisplayableMediaSource(MANAGED_IMAGE, { baseUrl: BASE_URL, fetchImpl, signal });

  assert.deepEqual(result, { ok: true, url: 'data:image/jpeg;base64,AAAA', transport: 'dashboard-media' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/api/media?path=${encodeURIComponent(MANAGED_IMAGE)}`);
  assert.equal(calls[0].options.signal, signal);
});

test('the resolver fetches the exact encoded URL for a spaced managed path', async () => {
  let received = '';
  const fetchImpl = async (url) => {
    received = url;
    return { ok: true, status: 200, json: async () => ({ data_url: 'data:image/png;base64,AAAA' }) };
  };
  const result = await resolveDisplayableMediaSource(SPACED_MANAGED_IMAGE, { baseUrl: BASE_URL, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(
    received,
    'http://127.0.0.1:8765/api/media?path=D%3A%2FHermes%2F.hermes%2Fimages%2FHBE%20MARKETING%20GFX%2Fa%20b.png',
  );
});

test('managed video resolves to a blob object URL from the stream endpoint', async () => {
  const calls = [];
  const blob = { size: 12, type: 'video/mp4' };
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, blob: async () => blob };
  };
  const result = await resolveDisplayableMediaSource(MANAGED_VIDEO, {
    baseUrl: BASE_URL,
    fetchImpl,
    createObjectUrl: (received) => {
      assert.equal(received, blob);
      return 'blob:http://127.0.0.1:8765/fake-object-1';
    },
  });

  assert.deepEqual(result, { ok: true, url: 'blob:http://127.0.0.1:8765/fake-object-1', transport: 'dashboard-stream' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `${BASE_URL}/api/files/stream?path=${encodeURIComponent(MANAGED_VIDEO)}`);
});

test('managed video falls back to the platform URL.createObjectURL for real blobs', async () => {
  const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'video/webm' });
  const result = await resolveDisplayableMediaSource(MANAGED_VIDEO, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({ ok: true, status: 200, blob: async () => blob }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport, 'dashboard-stream');
  assert.match(result.url, /^blob:/);
});

test('non-2xx dashboard responses fail with the status in the reason', async () => {
  for (const status of [403, 404, 500]) {
    const result = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
      baseUrl: BASE_URL,
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => {
          throw new Error('a failed response must never be parsed');
        },
      }),
    });
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.reason, `http-${status}`);
  }
});

test('malformed JSON from /api/media fails honestly', async () => {
  const throws = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }),
  });
  assert.deepEqual(throws, { ok: false, reason: 'invalid-json' });

  const notAnObject = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => '<html>not json</html>' }),
  });
  assert.deepEqual(notAnObject, { ok: false, reason: 'invalid-json' });
});

test('a missing or non-image data_url fails honestly', async () => {
  const cases = [
    [{}, 'missing-media-data-url'],
    [{ data_url: 42 }, 'missing-media-data-url'],
    [{ data_url: '' }, 'missing-media-data-url'],
    [{ data_url: 'data:text/html;base64,AAAA' }, 'invalid-media-data-url'],
    [{ data_url: 'https://example.com/pic.png' }, 'invalid-media-data-url'],
  ];
  for (const [payload, reason] of cases) {
    const result = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
      baseUrl: BASE_URL,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }),
    });
    assert.deepEqual(result, { ok: false, reason }, JSON.stringify(payload));
  }
});

test('https and raster data URLs resolve directly without any fetch', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('fetch must never be called for a direct source');
  };
  const dataUrl = 'data:image/png;base64,AAAA';
  assert.deepEqual(await resolveDisplayableMediaSource(dataUrl, { fetchImpl }), {
    ok: true,
    url: dataUrl,
    transport: 'direct',
  });
  const httpsUrl = 'https://example.com/generated/pic.webp';
  assert.deepEqual(await resolveDisplayableMediaSource(httpsUrl, { fetchImpl }), {
    ok: true,
    url: httpsUrl,
    transport: 'direct',
  });
  assert.equal(fetchCalls, 0);
});

test('empty and garbage inputs fail without any fetch', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200 };
  };
  for (const value of ['', '   ', null, undefined, {}, 'not a media path']) {
    const result = await resolveDisplayableMediaSource(value, { baseUrl: BASE_URL, fetchImpl });
    assert.equal(result.ok, false, String(value));
    assert.equal(result.reason, 'path-not-media-managed', String(value));
  }
  assert.equal(fetchCalls, 0);
});

test('thrown errors, aborts, and malformed responses never throw and never return a URL', async () => {
  const network = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
    baseUrl: BASE_URL,
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.deepEqual(network, { ok: false, reason: 'fetch-failed' });

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const aborted = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
    baseUrl: BASE_URL,
    fetchImpl: async () => {
      throw abort;
    },
  });
  assert.deepEqual(aborted, { ok: false, reason: 'aborted' });

  const emptyResponse = await resolveDisplayableMediaSource(MANAGED_IMAGE, {
    baseUrl: BASE_URL,
    fetchImpl: async () => undefined,
  });
  assert.deepEqual(emptyResponse, { ok: false, reason: 'fetch-failed' });
});

test('stream failures (throwing blob, empty blob, junk object URL) fail honestly', async () => {
  const blobThrows = await resolveDisplayableMediaSource(MANAGED_VIDEO, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      blob: async () => {
        throw new Error('stream died mid-download');
      },
    }),
  });
  assert.deepEqual(blobThrows, { ok: false, reason: 'media-read-failed' });

  const emptyBlob = await resolveDisplayableMediaSource(MANAGED_VIDEO, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({ ok: true, status: 200, blob: async () => ({ size: 0 }) }),
  });
  assert.deepEqual(emptyBlob, { ok: false, reason: 'empty-media-stream' });

  const junkObjectUrl = await resolveDisplayableMediaSource(MANAGED_VIDEO, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({ ok: true, status: 200, blob: async () => ({ size: 4 }) }),
    createObjectUrl: () => 'https://not-a-blob.example/x',
  });
  assert.deepEqual(junkObjectUrl, { ok: false, reason: 'object-url-unavailable' });
});

test('mediaDisplayName derives captions from the basename with kind fallbacks', () => {
  assert.equal(mediaDisplayName(UNMANAGED_IMAGE), 'a b.png');
  assert.equal(mediaDisplayName('C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg'), 'img_26c20aef5209.jpg');
  assert.equal(mediaDisplayName('https://example.com/pics/photo.webp?token=abc#frag'), 'photo.webp');
  assert.equal(mediaDisplayName(MANAGED_VIDEO), 'clip_01.mp4');

  assert.equal(mediaDisplayName(''), 'Image');
  assert.equal(mediaDisplayName('   '), 'Image');
  assert.equal(mediaDisplayName(null), 'Image');
  assert.equal(mediaDisplayName(undefined), 'Image');
  assert.equal(mediaDisplayName({}), 'Image');
  assert.equal(mediaDisplayName('data:image/png;base64,AAAA'), 'Image');
  // Scheme-like basenames can never leak into captions; the kind drives the fallback.
  assert.equal(mediaDisplayName('C:\\clips\\season:2.mp4'), 'Video');
});

test('wrapping quotes are stripped before planning and naming', () => {
  const quoted = `"${MANAGED_IMAGE}"`;
  assert.equal(mediaSourcePlan(quoted, { baseUrl: BASE_URL }).transport, 'dashboard-media');
  assert.equal(mediaDisplayName(quoted), 'img_26c20aef5209.jpg');
});
