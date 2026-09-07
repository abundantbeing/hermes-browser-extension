import test from 'node:test';
import assert from 'node:assert/strict';

import { chromeExecutableCandidates } from './e2e-code-highlighting-support.mjs';

test('Linux Chrome candidates exclude Windows executables and WSL-mounted paths', () => {
  const candidates = chromeExecutableCandidates({
    envPath: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    home: '/home/hermes',
    platform: 'linux',
  });

  assert.deepEqual(candidates, [
    '/home/hermes/opt/chrome-for-testing/chrome-linux64/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ]);
});

test('native Windows candidates retain configured and system browsers', () => {
  const candidates = chromeExecutableCandidates({
    envPath: 'D:\\Chrome\\chrome.exe',
    home: 'C:\\Users\\Hermes',
    platform: 'win32',
  });

  assert.equal(candidates[0], 'D:\\Chrome\\chrome.exe');
  assert.ok(candidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.equal(candidates.some((candidate) => candidate.startsWith('/usr/')), false);
});
