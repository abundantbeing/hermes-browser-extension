// A test browser must never make noise.
//
// A check that opens a video or a live stream would otherwise play it through
// the speakers of whoever runs the check. Every browser a script starts goes
// through launchChrome() (tests/e2e-chrome-env.mjs), which adds --mute-audio,
// so the rule lives in one place:
//   - the launcher is tested directly, including that a caller cannot drop the flag;
//   - no script in tests/ or scripts/ may start a browser any other way, whatever
//     the form of the call (spawn(chromeExecutable(), ...), spawn(CHROME, ...),
//     spawn(process.env.CHROME_PATH, ...), a browser-automation library);
//   - no script plays a tone through the speakers.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MUTE_AUDIO_FLAG, chromeLaunchArgs, launchChrome } from './e2e-chrome-env.mjs';

const TESTS_DIR = import.meta.dirname;
const SCRIPTS_DIR = path.join(TESTS_DIR, '..', 'scripts');
// The launcher defines the rule, and this file spells out the patterns it forbids.
const EXEMPT = new Set(['e2e-chrome-env.mjs', 'test-browser-silence.test.mjs']);

function sourceFiles() {
  const found = [];
  for (const dir of [TESTS_DIR, SCRIPTS_DIR]) {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs') || EXEMPT.has(entry.name)) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      found.push({ name: path.relative(path.join(TESTS_DIR, '..'), file).replaceAll(path.sep, '/'), source: readFileSync(file, 'utf8') });
    }
  }
  return found;
}

// The text of each `name(...)` call in `source`, up to its closing parenthesis.
// Parentheses inside string and template literals do not count.
export function callsTo(source, name) {
  const calls = [];
  const opener = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
  for (const match of source.matchAll(opener)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    let index = start;
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
      } else if (char === '\'' || char === '"' || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

const BROWSER_PROGRAM = /chrome|chromium|msedge|browser/i;
const BROWSER_FLAG = /--(?:headless|remote-debugging-port|user-data-dir|load-extension|disable-extensions-except|no-first-run|use-fake-device-for-media-stream)/;
const PROCESS_CALLS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];

// Starts a browser without launchChrome(): the program is a browser, or the call carries a browser's flags.
// Conservative on purpose: a call spelled out in a string or a comment is flagged too, and the fix is to reword it.
function directBrowserLaunches(source) {
  return PROCESS_CALLS.flatMap((name) => callsTo(source, name))
    .filter((call) => BROWSER_PROGRAM.test(call.split(',')[0]) || BROWSER_FLAG.test(call));
}

test('the launcher puts the mute flag first, once, and a caller cannot drop it', () => {
  const given = ['--headless=new', '--mute-audio', '--no-sandbox', '--mute-audio', 'chrome-extension://abc/page.html'];
  const before = [...given];

  assert.deepEqual(chromeLaunchArgs(given), [MUTE_AUDIO_FLAG, '--headless=new', '--no-sandbox', 'chrome-extension://abc/page.html']);
  assert.deepEqual(given, before, 'the caller\'s array is left alone');
  assert.deepEqual(chromeLaunchArgs(), [MUTE_AUDIO_FLAG]);
  assert.deepEqual(chromeLaunchArgs(['--autoplay-policy=no-user-gesture-required']), [MUTE_AUDIO_FLAG, '--autoplay-policy=no-user-gesture-required']);
});

test('launchChrome starts the program with the muted arguments and the caller\'s options', () => {
  const started = [];
  const child = { pid: 1 };
  const recorder = (...call) => { started.push(call); return child; };
  const options = { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true };

  assert.equal(launchChrome('/opt/chrome', ['--headless=new'], options, recorder), child);
  assert.deepEqual(started, [['/opt/chrome', [MUTE_AUDIO_FLAG, '--headless=new'], options]]);
});

test('the scan finds a browser started without the launcher, whatever the form of the call', () => {
  const direct = [
    'chrome = spawn(chromeExecutable(), [\'--headless=new\']);',
    'const chrome = spawn(CHROME, [\'--no-sandbox\']);',
    'chrome = spawn(process.env.CHROME_PATH, [...args]);',
    'const child = spawn(chromeExe, args);',
    'execFile(browserPath, [\'--remote-debugging-port=0\']);',
    'spawnSync(program, [\'--user-data-dir=/tmp/p\']);',
    'spawn(`${root}/chrome`, [\')\', \'--headless\']);',
  ];
  for (const source of direct) assert.equal(directBrowserLaunches(source).length, 1, source);

  const harmless = [
    'spawn(AGENT_PYTHON, [SERVER_SCRIPT], { cwd: AGENT_ROOT });',
    'spawnSync(process.execPath, [\'scripts/windows-setup.mjs\', \'--dry-run\']);',
    'execFileSync(\'git\', [\'rev-parse\', \'HEAD\']);',
    'launchChrome(chromeExecutable(), [\'--headless=new\']);',
    'await rm(chromeProfileDir, { recursive: true });',
  ];
  for (const source of harmless) assert.equal(directBrowserLaunches(source).length, 0, source);
});

test('every script that opens a browser does it through launchChrome', () => {
  const files = sourceFiles();
  assert.ok(files.length > 20, 'expected to scan the test and script files');

  const direct = files
    .filter(({ source }) => directBrowserLaunches(source).length > 0)
    .map(({ name }) => name);
  assert.deepEqual(direct, [], `these scripts start a browser that is not muted; use launchChrome() from tests/e2e-chrome-env.mjs: ${direct.join(', ')}`);

  const launchers = files.filter(({ source }) => callsTo(source, 'launchChrome').length > 0);
  assert.ok(launchers.length >= 10, `expected the e2e scripts to launch through launchChrome, found ${launchers.length}`);
  const unimported = launchers
    .filter(({ source }) => !/import\s*\{[^}]*\blaunchChrome\b[^}]*\}\s*from\s*'[./]*(?:tests\/)?e2e-chrome-env\.mjs'/.test(source)
      && !/\blaunchChrome as \w+/.test(source))
    .map(({ name }) => name);
  assert.deepEqual(unimported, [], `these scripts call launchChrome without importing it: ${unimported.join(', ')}`);
});

test('no browser-automation library starts a browser outside the launcher', () => {
  const offenders = sourceFiles()
    .filter(({ source }) => /\b(?:chromium|firefox|webkit)\.launch(?:PersistentContext)?\s*\(|\bpuppeteer\.launch\s*\(/.test(source))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], `these scripts launch a browser through a library, bypassing launchChrome(): ${offenders.join(', ')}`);
});

test('no test script plays a tone through the speakers', () => {
  // A tone generator is a loudspeaker in a test suite. The only AudioContext
  // left must feed a WebRTC stream, not the sound card.
  const offenders = sourceFiles()
    .filter(({ source }) => /createOscillator/.test(source) && !/createMediaStreamDestination/.test(source))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], `these scripts make a tone through the speakers: ${offenders.join(', ')}`);
});
