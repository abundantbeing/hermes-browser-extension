import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseHTML } from 'linkedom';
import { fileURLToPath } from 'node:url';
import { redactSensitiveTextWithCount } from '../extension/lib/content-extraction-core.mjs';
import { hasCredentialBearingUrl, redactSensitiveText } from '../extension/lib/redaction.mjs';
import { buildInlineDraftRequest, normalizeInlineDraftRequest, INLINE_DRAFT_MODE, INLINE_DRAFT_SCHEMA, INLINE_DRAFT_VERSION } from '../extension/lib/inline-draft-policy.mjs';
import { normalizeBrowserRuntimeEvent } from '../extension/lib/runtime-events.mjs';
import { buildBrowserContextPrompt, serializeBrowserTurnEnvelope } from '../extension/lib/browser-context-protocol.mjs';

// Fixtures are assembled at run time from obviously fake parts, so no line here looks like a real key.
const join = (...parts) => parts.join('');
const alnum = (count) => 'Ab3'.repeat(Math.ceil(count / 3)).slice(0, count);
const hex = (count) => 'a1'.repeat(Math.ceil(count / 2)).slice(0, count);

// The provider, tool and chat-platform key shapes Hermes Agent's own redactor (agent/redact.py) knows,
// which the extension did not redact before.
const TOKENS = {
  telegramBot: join('123456789', ':', 'AA', alnum(33)),
  discordBot: join('M', alnum(25), '.', alnum(6), '.', alnum(38)),
  slackApp: join('xa', 'pp-1-', 'A0', alnum(30)),
  slackRefresh: join('xo', 'xe-1-', alnum(40)),
  groq: join('gs', 'k_', alnum(40)),
  xai: join('xa', 'i-', alnum(40)),
  replicate: join('r8', '_', alnum(36)),
  perplexity: join('pp', 'lx-', alnum(40)),
  tavily: join('tv', 'ly-dev-', alnum(32)),
  firecrawl: join('fc', '-', hex(32)),
  fal: join('fa', 'l_', alnum(32)),
  browserbase: join('bb', '_live_', alnum(30)),
  notion: join('nt', 'n_', alnum(46)),
  notionLegacy: join('sec', 'ret_', alnum(43)),
  linear: join('li', 'n_api_', alnum(40)),
  pypi: join('py', 'pi-AgEIcHlwaS5vcmc', alnum(60)),
  elevenLabs: join('sk', '_', hex(48)),
  fireworks: join('fw', '_', alnum(30)),
  matrix: join('sy', 't_', alnum(8), '_', alnum(20), '_', alnum(6)),
  langfuse: join('pk', '-lf-', alnum(32)),
  codexEncrypted: join('gAA', 'AAA', alnum(60)),
  gitlabDeploy: join('gl', 'dt-', alnum(24)),
  gitlabRunner: join('gl', 'rt-', alnum(24)),
  googleRefresh: join('1/', '/0', alnum(60)),
  atlassian: join('ATA', 'TT3', alnum(60)),
  postman: join('PM', 'AK-', hex(24), '-', hex(34)),
  digitalOceanOAuth: join('do', 'o_v1_', hex(64)),
};

// Key bodies that carry the separators the shared redactor allows: hyphens (a UUID-shaped Langfuse key,
// Slack app tokens), underscores, dots and `=` padding. The inline trust check and the companion URL guard
// keep their own copies of these shapes and must not be stricter than the shared redactor on any of them.
const uuid = join('12345678', '-', '1234', '-', '1234', '-', '1234', '-', '123456789abc');
const SEPARATED_TOKENS = {
  langfuseUuid: join('pk', '-lf-', uuid),
  langfuseHyphenAfterFive: join('pk', '-lf-', 'abcde', '-', alnum(24)),
  slackAppDashed: join('xa', 'pp-1-', 'A0BCDEFGH', '-', '1234567890123', '-', hex(32)),
  slackAppShortBody: join('xa', 'pp-1-', 'A0', alnum(8)),
  slackRefreshDashed: join('xo', 'xe-1-', 'My0', '-', alnum(12), '-', alnum(12)),
  slackRefreshShortBody: join('xo', 'xe-', 'A0', alnum(10)),
  pypiSeparated: join('py', 'pi-AgEIcHlwaS5vcmc', alnum(10), '_', alnum(10), '-', alnum(10)),
  codexEncryptedSeparated: join('gAA', 'AAA', alnum(20), '_', alnum(10), '=', alnum(10), '-', alnum(5)),
  atlassianSeparated: join('ATA', 'TT3', alnum(20), '_', alnum(10), '=', alnum(10), '-', alnum(5)),
  gitlabDotted: join('gl', 'pat-', alnum(10), '.', alnum(10), '_', alnum(5), '-', alnum(5)),
  gitlabAgentSeparated: join('gl', 'agent-', alnum(12), '_', alnum(12)),
  gitlabOauthSeparated: join('gl', 'oas-', alnum(12), '.', alnum(12)),
  grafanaSeparated: join('GR', '1348941', alnum(10), '_', alnum(10), '-', alnum(5)),
  googleRefreshSeparated: join('1/', '/0', alnum(20), '-', alnum(10), '_', alnum(15)),
};
const ALL_TOKENS = { ...TOKENS, ...SEPARATED_TOKENS };

// Credentials that are not a plain key: webhook URLs carry the secret as a path segment, and the gateway
// key is an assignment. The inline trust check keeps its own copy of these shapes as well.
const WEBHOOKS = {
  slackWebhook: `https://hooks.slack.com/services/T0ABCDEFGH/B0ABCDEFGH/${alnum(24)}`,
  discordWebhook: `https://discord.com/api/webhooks/123456789012345678/${alnum(68)}`,
  discordWebhookVersioned: `https://discord.com/api/v10/webhooks/123456789012345678/${alnum(68)}`,
  gatewayKeyAssignment: `API_SERVER_KEY=${alnum(40)}`,
  gatewayKeyAssignmentColon: `export API_SERVER_KEY: ${alnum(40)}`,
};

// The same shapes with their separators percent-encoded, as a URL sitting inside a query string or a
// sentence of page text carries them.
const ENCODED = {
  telegramColon: `https://api.telegram.org/bot${join('123456789', '%3A', 'AA', alnum(33))}/getMe`,
  telegramColonLower: `https://api.telegram.org/bot${join('123456789', '%3a', 'AA', alnum(33))}/getMe`,
  telegramDoubleEncoded: `https://api.telegram.org/bot${join('123456789', '%253A', 'AA', alnum(33))}/getMe`,
  telegramBareColon: join('123456789', '%3A', 'AA', alnum(33)),
  telegramEncodedSlash: `https%3A%2F%2Fapi.telegram.org%2Fbot${join('123456789', '%3A', 'AA', alnum(33))}%2FgetMe`,
  slackWebhookEncoded: `https://hooks.slack.com%2Fservices%2FT0ABCDEFGH%2FB0ABCDEFGH%2F${alnum(24)}`,
  discordWebhookEncoded: `https://discord.com%2Fapi%2Fwebhooks%2F123456789012345678%2F${alnum(68)}`,
};

// A Discord bot token with each kind of character right before it: `-`, `_`, `.` and `/` are all
// boundaries, and a hyphen in particular must not hide it.
const discordToken = TOKENS.discordBot;
const DISCORD_AFTER = Object.fromEntries(['/', '-', '_', '.', '--', '/-', '-_.'].map((lead) => [`after ${lead}`, `${lead}${discordToken}`]));

const draft = (draftText) => ({
  schema: INLINE_DRAFT_SCHEMA,
  version: INLINE_DRAFT_VERSION,
  mode: INLINE_DRAFT_MODE,
  requestId: 'request-0001',
  documentId: 'document-0001',
  actionId: 'improve',
  draftText,
});

test('page text redaction covers the key shapes Hermes Agent redacts', () => {
  for (const [name, token] of Object.entries(ALL_TOKENS)) {
    const { text, count } = redactSensitiveTextWithCount(`before ${token} after`);
    assert.ok(count > 0, `${name} was not counted`);
    assert.doesNotMatch(text, new RegExp(token.slice(-16).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), `${name} survived redaction`);
    assert.match(text, /^before .*\[REDACTED_SECRET\].* after$/, `${name} redaction kept the surrounding text`);
  }
});

test('Hermes Agent gateway key assignments are redacted', () => {
  const value = alnum(40);
  assert.equal(redactSensitiveText(`API_SERVER_KEY=${value}`), 'API_SERVER_KEY=[REDACTED_SECRET]');
});

test('a Telegram bot API URL keeps its shape but loses the token', () => {
  const url = `https://api.telegram.org/bot${TOKENS.telegramBot}/getMe`;
  assert.equal(redactSensitiveText(url), 'https://api.telegram.org/bot[REDACTED_SECRET]/getMe');
});

test('Slack and Discord webhook URLs lose their secret path segment', () => {
  const slack = `https://hooks.slack.com/services/T0ABCDEFGH/B0ABCDEFGH/${alnum(24)}`;
  const discord = `https://discord.com/api/webhooks/123456789012345678/${alnum(68)}`;
  assert.equal(redactSensitiveText(slack), 'https://hooks.slack.com/services/T0ABCDEFGH/B0ABCDEFGH/[REDACTED_SECRET]');
  assert.equal(redactSensitiveText(discord), 'https://discord.com/api/webhooks/123456789012345678/[REDACTED_SECRET]');
});

test('URLs that carry the secret in the path are credential bearing', () => {
  assert.equal(hasCredentialBearingUrl(`https://api.telegram.org/bot${TOKENS.telegramBot}/sendMessage`), true);
  assert.equal(hasCredentialBearingUrl(`https://api.telegram.org/file/bot${TOKENS.telegramBot}/photos/1.jpg`), true);
  assert.equal(hasCredentialBearingUrl(`https://hooks.slack.com/services/T0ABCDEFGH/B0ABCDEFGH/${alnum(24)}`), true);
  assert.equal(hasCredentialBearingUrl(`https://discord.com/api/webhooks/123456789012345678/${alnum(68)}`), true);
  assert.equal(hasCredentialBearingUrl(`https://discord.com/api/v10/webhooks/123456789012345678/${alnum(68)}/messages/1`), true);
});

test('ordinary URLs and words that only resemble a key shape are left alone', () => {
  for (const url of [
    'https://core.telegram.org/bots/api',
    'https://discord.com/channels/123456789012345678/123456789012345678',
    'https://discord.com/developers/docs/resources/webhook',
    'https://api.slack.com/messaging/webhooks',
    'https://example.com/posts/sk-learn-tutorial-for-beginners',
    'https://en.wikipedia.org/wiki/Rust_(programming_language)',
  ]) assert.equal(hasCredentialBearingUrl(url), false, url);

  for (const text of [
    'Use xai-grok-4-fast-reasoning for this',
    'Call hf_hub_download_function first',
    'secret_santa_list_for_2026',
    'fc-barcelona won again',
    'xoxo-hugs-and-kisses-from-everyone',
    'Microsoft.Windows.Foundation',
    'snake_case_variable_name and fw_config_loader_module',
    'Order 12345678: shipped',
  ]) assert.equal(redactSensitiveText(text), text, text);
});

test('the inline Assist trust check refuses every shape the shared redactor knows', () => {
  // inline-draft-policy.mjs is import-free and keeps its own copy of these prefixes: the two must agree.
  for (const [name, token] of Object.entries(ALL_TOKENS)) {
    assert.equal(normalizeInlineDraftRequest(draft(`Please polish: ${token}`)), null, `${name} passed the inline trust check`);
  }
  assert.ok(normalizeInlineDraftRequest(draft('Use xai-grok-4-fast-reasoning and hf_hub_download_function here')), 'ordinary text still passes');
});

test('tool event previews use the full redactor', () => {
  for (const [name, token] of Object.entries(ALL_TOKENS)) {
    const event = normalizeBrowserRuntimeEvent({ type: 'tool.started', data: { tool_name: 'terminal', preview: `export KEY=${token}` } });
    assert.doesNotMatch(event.preview, new RegExp(token.slice(-16).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), `${name} survived in a tool preview`);
  }
});

// Runs the companion plugin's `_blocked_url` over a map of name -> URL and returns name -> blocked. Prefers
// python3, falls back to python (the Windows launcher name), and skips only when neither can be launched.
function runCompanionGuard(t, urls) {
  const pluginDir = fileURLToPath(new URL('../companion-plugin', import.meta.url));
  const probe = `
import importlib.util, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('probe_plugin', root / '__init__.py', submodule_search_locations=[str(root)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
control_tools = sys.modules['probe_plugin.control_tools']
print(json.dumps({name: control_tools._blocked_url(url) is not None for name, url in json.loads(sys.argv[2]).items()}))
`;
  let run = null;
  for (const command of ['python3', 'python']) {
    const attempt = spawnSync(command, ['-c', probe, pluginDir, JSON.stringify(urls)], { encoding: 'utf8' });
    if (attempt.error?.code === 'ENOENT') continue;
    run = { command, ...attempt };
    break;
  }
  if (!run) {
    t.skip('no Python interpreter (python3 or python) is available to run the companion plugin check');
    return null;
  }
  assert.ifError(run.error);
  assert.equal(run.status, 0, `${run.command} exited with status ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('the companion plugin refuses to navigate to a URL carrying one of these secrets', (t) => {
  const urls = Object.fromEntries(Object.entries(ALL_TOKENS).map(([name, token]) => [name, `https://attacker.example/collect?v=${token}`]));
  urls.telegramPath = `https://api.telegram.org/bot${TOKENS.telegramBot}/getMe`;
  urls.slackWebhook = WEBHOOKS.slackWebhook;
  urls.discordWebhook = WEBHOOKS.discordWebhook;
  for (const [name, value] of Object.entries(ENCODED)) urls[`encoded ${name}`] = `https://attacker.example/collect?v=${encodeURIComponent(value)}`;
  urls.ordinaryDocs = 'https://core.telegram.org/bots/api';
  urls.ordinaryChannel = 'https://discord.com/channels/123456789012345678/123456789012345678';
  const blocked = runCompanionGuard(t, urls);
  if (!blocked) return;
  for (const name of Object.keys(urls)) {
    assert.equal(blocked[name], !name.startsWith('ordinary'), `${name}: ${urls[name]}`);
  }
});

test('the companion plugin refuses a Discord bot token anywhere in a URL path, after any punctuation', (t) => {
  const urls = {};
  for (const [name, text] of Object.entries(DISCORD_AFTER)) urls[`path ${name}`] = `https://attacker.example/collect${text}`;
  for (const lead of ['/', '-', '_', '.', 'x', '9']) urls[`glued ${lead}`] = `https://attacker.example/collect/id${lead}${discordToken}`;
  urls['trailing characters'] = `https://attacker.example/collect/${discordToken}${alnum(10)}`;
  urls['encoded slash and hyphen'] = `https://attacker.example/collect%2F-${discordToken}`;
  urls.ordinaryPath = 'https://attacker.example/collect/Microsoft.Windows.Foundation';
  const blocked = runCompanionGuard(t, urls);
  if (!blocked) return;
  for (const name of Object.keys(urls)) {
    assert.equal(blocked[name], name !== 'ordinaryPath', `${name}: ${urls[name]}`);
  }
});

test('inline requests refuse webhook URLs and gateway key assignments in the draft and in the page context', () => {
  const options = { action: { id: 'improve', label: 'Improve', mode: INLINE_DRAFT_MODE }, requestId: 'request-0001', documentId: 'document-0001' };
  const field = parseHTML('<html><body><textarea aria-label="Reply"></textarea></body></html>').document.body.firstElementChild;
  for (const [name, secret] of Object.entries(WEBHOOKS)) {
    assert.equal(normalizeInlineDraftRequest(draft(`Please polish: ${secret}`)), null, `${name} passed in draftText`);
    assert.equal(normalizeInlineDraftRequest({ ...draft('Polish this'), pageContext: `Seen on the page: ${secret}` }), null, `${name} passed in pageContext`);
    field.value = `Please polish: ${secret}`;
    assert.equal(buildInlineDraftRequest(field, options).ok, false, `${name} passed buildInlineDraftRequest draftText`);
    field.value = 'Polish this';
    assert.equal(buildInlineDraftRequest(field, { ...options, pageContext: `Seen on the page: ${secret}` }).ok, false, `${name} passed buildInlineDraftRequest pageContext`);
  }
  assert.ok(normalizeInlineDraftRequest(draft('See https://hooks.slack.com/services and https://discord.com/api/webhooks docs; set API_SERVER_KEY in your env')), 'ordinary mentions still pass');
});

test('the inline trust check refuses percent-encoded token shapes in the draft and in the page context', () => {
  for (const [name, secret] of Object.entries(ENCODED)) {
    assert.equal(normalizeInlineDraftRequest(draft(`Please polish: ${secret}`)), null, `${name} passed the inline trust check`);
    assert.equal(normalizeInlineDraftRequest({ ...draft('Polish this'), pageContext: `Seen on the page: ${secret}` }), null, `${name} passed in pageContext`);
  }
});

test('percent-encoded token shapes inside a sentence are redacted from page text', () => {
  for (const [name, secret] of Object.entries(ENCODED)) {
    const { text, count } = redactSensitiveTextWithCount(`Open the link ${secret} in your browser, then check the status.`);
    assert.ok(count > 0, `${name} was not counted`);
    assert.doesNotMatch(text, new RegExp(alnum(30)), `${name} survived redaction`);
    assert.match(text, /^Open the link .*\[REDACTED_SECRET\].* in your browser, then check the status\.$/, `${name} lost the surrounding text`);
  }
  assert.match(redactSensitiveText(ENCODED.telegramColon), /^https:\/\/api\.telegram\.org\/bot\[REDACTED_SECRET\]\/getMe$/);
  assert.equal(redactSensitiveText('Order 12345678%3A shipped, ref 123456789%3Ashort'), 'Order 12345678%3A shipped, ref 123456789%3Ashort');
});

test('the prompt and the turn envelope builders redact percent-encoded token shapes in page text', () => {
  const settings = { contextDepth: 'normal', includeTabs: true, includePageText: true, includeSelectedText: true, maxTabs: 12 };
  const pageContext = {
    text: `Docs say to call ${ENCODED.telegramColon} and ${ENCODED.slackWebhookEncoded} from a script.`,
    selectedText: `Selected: ${ENCODED.telegramEncodedSlash}`,
    meta: {},
  };
  const activeTab = { id: 1, active: true, title: 'Public docs', url: 'https://example.com/docs' };
  const leaked = new RegExp(alnum(30));
  const prompt = buildBrowserContextPrompt({ userText: 'Summarize this page.', activeTab, pageContext, settings });
  assert.doesNotMatch(prompt, leaked);
  assert.match(prompt, /\[REDACTED_SECRET\]/);
  const serialized = serializeBrowserTurnEnvelope({ humanInput: 'Summarize this page.', activeTab, tabs: [activeTab], pageContext, settings });
  assert.doesNotMatch(serialized, leaked);
  assert.match(serialized, /\[REDACTED_SECRET\]/);
});

test('a Discord bot token is redacted and refused wherever punctuation precedes it', () => {
  for (const [name, lead] of Object.entries(DISCORD_AFTER)) {
    const { text, count } = redactSensitiveTextWithCount(`see https://example.com/x${lead} now`);
    assert.ok(count > 0, `${name} was not counted`);
    assert.doesNotMatch(text, new RegExp(alnum(20)), `${name} survived redaction`);
    assert.equal(normalizeInlineDraftRequest(draft(`Polish https://example.com/x${lead}`)), null, `${name} passed the inline trust check`);
  }
});
