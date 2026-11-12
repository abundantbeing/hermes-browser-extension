import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');
const guide = read('guides/connection-guide.md');
const agent = read('guides/agent-setup.md');
const troubleshooting = read('guides/troubleshooting.md');
const pluginDocs = read('companion-plugin/README.md') + read('companion-plugin/install.md');
const { version } = JSON.parse(read('package.json'));

test('the README Quick start sets up Hermes first, then installs, then connects, then adds the plugin', () => {
  const quick = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Connect to Hermes'));
  const order = ['### 1. Give Hermes an API key', '### 2. Install the extension', '### 3. Connect', '### 4. Optional: let Hermes operate your tabs'];
  const positions = order.map((heading) => quick.indexOf(heading));
  assert.ok(positions.every((position) => position >= 0), `every step is there: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in this order');
  assert.match(quick, /Manual setup/);
  assert.match(quick, /stock Hermes does not ship/, 'it says plainly that one-click pairing is not on stock Hermes');
});

test('the docs state the key rule Hermes enforces, and do not present API_SERVER_ENABLED as the switch', () => {
  for (const [name, text] of [['README.md', readme], ['connection-guide.md', guide], ['agent-setup.md', agent]]) {
    assert.match(text, /16 (?:or more )?characters|shorter than 16/, `${name} says the key needs 16+ characters`);
    assert.doesNotMatch(text, /API_SERVER_ENABLED/, `${name}: Hermes turns the API server on from the key`);
  }
});

test('the connection guide covers every place Hermes runs, with a command for each', () => {
  for (const heading of [
    '### On this computer',
    '### In WSL2, with the browser on Windows',
    '### In Docker',
    '### On a VPS or another computer, over Tailscale',
    '### On a VPS or another computer, over an SSH tunnel',
    '### On another computer on your home or office network',
    '### Behind an HTTPS reverse proxy',
    '### Several Hermes bots (named profiles)',
    '### Hermes Cloud',
  ]) {
    assert.ok(guide.includes(heading), heading);
  }
  assert.match(guide, /ssh -N -L 18642:127\.0\.0\.1:8642/);
  assert.match(guide, /tailscale serve --bg 8642/);
  assert.match(guide, /-p 127\.0\.0\.1:8642:8642/, 'Docker publishes on loopback only');
  assert.match(guide, /proxy_buffering off/, 'streamed replies need buffering off');
  assert.match(guide, /\/p\/<profile>/);
});

test('the compatibility matrix names the current version', () => {
  assert.match(guide, new RegExp(`\\| Surface \\| Supported in v${version.replace(/\./g, '\\.')} \\|`));
});

test('CORS is the fallback, not a setup step, and every doc that mentions it says when it is needed', () => {
  const quick = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Connect to Hermes'));
  assert.doesNotMatch(quick, /^API_SERVER_CORS_ORIGINS=/m, 'no CORS line in the Quick start .env');
  assert.match(guide, /## If a message is refused with a 403/);
  assert.match(troubleshooting, /## Cannot connect/);
  assert.match(troubleshooting, /Automatic pairing isn't available on this Hermes installation yet/);
});

test('the plugin docs offer the catalog name and do not say the catalog has no entry', () => {
  assert.doesNotMatch(pluginDocs, /catalog has no entry/);
  assert.match(pluginDocs, /hermes plugins install hermes-browser-extension --enable/);
  assert.doesNotMatch(pluginDocs, /does not pair with the extension/);
});

test('an agent pointed at the repository finds its setup steps', () => {
  assert.match(readme, /\]\(\.\/guides\/agent-setup\.md\)/);
  assert.match(agent, /Only the person can do these/);
  assert.match(agent, /Ask the person before you restart/, 'a gateway restart interrupts every bot');
  assert.match(agent, /Never paste the key into a chat log/);
});
