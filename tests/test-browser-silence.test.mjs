// A test browser must never make noise.
//
// Every Chrome launch in the test suite has to mute its audio output. A
// browser that plays sound during a test is a bug in the test, and the person
// running it is the one who hears it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const TESTS_DIR = path.join(import.meta.dirname);

function launchSites() {
  const sites = [];
  for (const name of readdirSync(TESTS_DIR)) {
    if (!name.endsWith('.mjs')) continue;
    const file = path.join(TESTS_DIR, name);
    const content = readFileSync(file, 'utf8');
    // Only files that actually spawn a browser are checked.
    if (!/spawn\(\s*chromeExecutable\(/.test(content)) continue;
    sites.push({ name, content });
  }
  return sites;
}

test('every test browser launches muted', () => {
  const sites = launchSites();
  assert.ok(sites.length > 0, 'expected at least one test browser launch site');
  const loud = sites
    .filter((site) => !site.content.includes('--mute-audio'))
    .map((site) => site.name);
  assert.deepEqual(loud, [], `these test browsers would make sound: ${loud.join(', ')}`);
});

test('media that may autoplay with sound is still muted at the output', () => {
  // A test may need autoplay (a WebRTC peer, a video that has to start).
  // It must never reach the speakers, so those browsers also mute their
  // output.
  const sites = launchSites();
  const loud = sites
    .filter((site) => site.content.includes('--autoplay-policy=no-user-gesture-required'))
    .filter((site) => !site.content.includes('--mute-audio'))
    .map((site) => site.name);
  assert.deepEqual(loud, [], `these test browsers allow autoplay with sound and are not muted: ${loud.join(', ')}`);
});

test('no test script plays a tone through the speakers', () => {
  // A tone generator is a loudspeaker in a test suite. The only AudioContext
  // left must feed a WebRTC stream, not the sound card.
  const offenders = [];
  for (const name of readdirSync(TESTS_DIR)) {
    if (!name.endsWith('.mjs')) continue;
    const content = readFileSync(path.join(TESTS_DIR, name), 'utf8');
    if (!/createOscillator/.test(content)) continue;
    // A voice test routes its tone into a media stream destination, which
    // never reaches the speakers.
    if (/createMediaStreamDestination/.test(content)) continue;
    offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these scripts make a tone through the speakers: ${offenders.join(', ')}`);
});
