import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// Vivid UI end to end: the saved choice, what every turn tells the model, and
// what the renderer guarantees whatever the model sends back.

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = window;

const {
  VIVID_CONTRACT,
  lockAssistantResponseStyles,
  preserveAssistantResponseStyles,
  resolveMessageResponseStyle,
  responsePresentationFromSettings,
  responseStyleInstructions,
  responseStyleTurnContract,
  withResponsePresentationUpdate,
} = await import('../extension/lib/response-presentation.mjs');
const { buildBrowserTurnEnvelope, serializeBrowserTurnEnvelope } = await import('../extension/lib/browser-context-protocol.mjs');
const { messageDisplayText } = await import('../extension/lib/common.mjs');
const { containsAdaptiveBlocks, parseAdaptiveFence, stripAdaptiveFences } = await import('../extension/lib/adaptive-ui.mjs');
const { renderMarkdownSafe, renderResponseSafe } = await import('../extension/lib/sanitizer.mjs');

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const fence = (value, lang = 'hermes-ui') => `\`\`\`${lang}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``;
const envelope = (blocks) => ({ schema: 'hermes.adaptive-ui', version: 1, blocks });
const vivid = (text, options = {}) => renderResponseSafe(text, { style: 'vivid', streaming: false, ...options });
const dom = (html) => {
  const host = window.document.createElement('div');
  host.innerHTML = html;
  return host;
};
const types = (html) => [...dom(html).querySelectorAll('[data-haui-type]')].map((node) => node.dataset.hauiType);
const showsJson = (html) => /"schema"|"blocks"\s*:|hermes\.adaptive-ui|<code data-lang="(hermes-ui|json)"/.test(html);

const turn = (responseStyle, humanInput = 'Summarize this article') => buildBrowserTurnEnvelope({
  humanInput,
  activeTab: { id: 1, title: 'Example', url: 'https://example.com/post' },
  pageContext: { title: 'Example', url: 'https://example.com/post', text: 'Body text.' },
  contextScope: { mode: 'current-tab' },
  responseStyle,
});

// ---------------------------------------------------------------------------
// The contract the model receives.

test('the Vivid contract is an obligation, not an optional hint', () => {
  assert.doesNotMatch(VIVID_CONTRACT, /you may add|may add one|skip the block|when useful|if useful/i);
  assert.match(VIVID_CONTRACT, /output contract, not a suggestion/);
  assert.match(VIVID_CONTRACT, /Every substantive reply includes at least one block/);
  assert.match(VIVID_CONTRACT, /never ask whether they want cards/);
  assert.match(VIVID_CONTRACT, /"schema":"hermes.adaptive-ui","version":1/);
});

test('the contract adapts components to the question and forbids padding', () => {
  for (const pattern of [/Article, blog post or web page/, /YouTube video/, /transcript/, /Weather/, /Numbers to compare/, /Code: keep code in normal fenced code blocks/, /brief conversational reply/, /no oversized dashboards, no decorative cards or buttons/]) {
    assert.match(VIVID_CONTRACT, pattern);
  }
});

test('the contract keeps evidence honest: no invented data, explicit gaps and failures', () => {
  assert.match(VIVID_CONTRACT, /Never invent data to fill a component/);
  assert.match(VIVID_CONTRACT, /never report an action as done unless a tool did it/);
  assert.match(VIVID_CONTRACT, /only from data a tool returned in this turn/);
  assert.match(VIVID_CONTRACT, /With no transcript, say so in a `notice`/);
  assert.match(VIVID_CONTRACT, /failed tools: a `notice`/);
});

test('every block type the contract names is one the renderer validates', () => {
  const named = [...VIVID_CONTRACT.split('Block types:')[1].matchAll(/^- (\w+): /gm)].map((match) => match[1]);
  assert.deepEqual(named, ['stat', 'list', 'key_value', 'comparison', 'table', 'chart', 'notice', 'disclosure', 'actions']);
  for (const type of named) {
    const parsed = parseAdaptiveFence('hermes-ui', JSON.stringify(envelope([{ type, fallback: 'x' }])));
    assert.ok(!parsed.errors.some((error) => error.includes('unknown block type')), type);
  }
});

test('turn contract: Vivid always, Rich only to switch off after Vivid replies, Plain keeps its system note', () => {
  const on = responseStyleTurnContract('vivid');
  assert.equal(on.id, 'vivid');
  assert.equal(on.required, true);
  assert.equal(on.contract, VIVID_CONTRACT);
  assert.equal(responseStyleTurnContract('rich'), null, 'Rich text requests stay exactly as before');
  assert.match(responseStyleTurnContract('rich', { conversationHasVivid: true }).contract, /turned Vivid UI off[\s\S]*add no hermes-ui blocks/);
  assert.match(responseStyleTurnContract('rich', { conversationHasPlain: true }).contract, /switched from Plain text to Rich text[\s\S]*normal Markdown/);
  assert.equal(responseStyleTurnContract('plain'), null);
  assert.match(responseStyleTurnContract('plain', { conversationHasVivid: true }).contract, /switched to Plain text[\s\S]*no hermes-ui blocks/);
  assert.match(responseStyleTurnContract('plain', { conversationHasRich: true }).contract, /switched to Plain text[\s\S]*no Markdown/);
  assert.match(responseStyleInstructions('plain'), /plain text only/);
  assert.equal(responseStyleInstructions('vivid'), '');
  assert.equal(responseStyleTurnContract(undefined), null, 'no saved style is Rich text');
});

// ---------------------------------------------------------------------------
// Preference to request.

test('the saved choice survives a reload and a later unrelated settings write', () => {
  const saved = withResponsePresentationUpdate({ gatewayUrl: 'http://127.0.0.1:8642', sessionId: 's1' }, { responseStyle: 'vivid' });
  const reopened = JSON.parse(JSON.stringify(saved));
  assert.equal(responsePresentationFromSettings(reopened).responseStyle, 'vivid');
  const later = withResponsePresentationUpdate({ ...reopened, sessionId: 's2' }, { messageLayout: 'user-bubble' });
  assert.equal(later.responseStyle, 'vivid', 'a layout change keeps the style');
  assert.equal(responsePresentationFromSettings(withResponsePresentationUpdate(later, { responseStyle: 'rich' })).responseStyle, 'rich');
});

test('every Browser turn carries the contract as the user setting, on every transport', () => {
  const sent = turn(responseStyleTurnContract('vivid'));
  assert.deepEqual(Object.keys(sent.response_style), ['id', 'name', 'source', 'required', 'contract']);
  assert.equal(sent.response_style.source, 'user_setting');
  assert.equal(sent.response_style.contract, VIVID_CONTRACT, 'the contract is never trimmed or redacted');
  assert.ok(Object.keys(sent).indexOf('response_style') < Object.keys(sent).indexOf('browser_context'), 'it sits before the untrusted page data');
  assert.ok(sent.source_receipt.budgets.serialized_chars <= 48_000);
});

test('the turn is unchanged when no contract applies, and people still see only their words', () => {
  const plain = turn(null);
  assert.equal(Object.hasOwn(plain, 'response_style'), false);
  const text = serializeBrowserTurnEnvelope({ humanInput: 'What does this page say?', responseStyle: responseStyleTurnContract('vivid') });
  assert.equal(messageDisplayText('user', text), 'What does this page say?');
});

test('side panel: composer and right-click turns carry the contract; inline drafts never do', () => {
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /function currentResponseStyleTurnContract\(\) \{[\s\S]{0,600}responseStyleTurnContract\(settings\.responseStyle, \{ conversationHasVivid, conversationHasRich, conversationHasPlain \}\)/);
  assert.equal(panel.match(/responseStyle: currentResponseStyleTurnContract\(\),/g)?.length, 2, 'askHermes and the context-menu turn');
  // The system prompt (session create, inline drafts, background tasks) has no Vivid text.
  assert.match(panel, /const styleNote = responseStyleInstructions\(settings\.responseStyle\);/);
  // Another window's choice is adopted, so a stale full write can't revert it.
  assert.match(panel, /adoptStoredResponsePresentation\(next\);/);
});

// ---------------------------------------------------------------------------
// Model output to rendered reply. Each fixture is what a model plausibly sends.

const ARTICLE = `The post argues that small models now win on cost for most support workloads.

${fence(envelope([
  { id: 'sum', type: 'list', title: 'Key points', items: ['Small models resolve 82% of tickets in the study.', 'Latency fell from 2.1 s to 0.6 s.', 'Hard cases still go to a large model.'] },
  { id: 'facts', type: 'key_value', items: [{ key: 'Author', value: 'Dana Ruiz' }, { key: 'Published', value: '12 Oct 2026' }] },
  { id: 'act', type: 'actions', items: [{ label: 'Read the post', action: 'open_url', value: 'https://example.com/post' }, { label: 'How was it measured?', action: 'ask', value: 'How did the study measure resolution?' }] },
]))}`;

test('article question: summary list, facts and source actions, prose kept', () => {
  const html = vivid(ARTICLE);
  assert.deepEqual(types(html), ['list', 'key_value', 'actions']);
  assert.match(html, /<p>The post argues/);
  assert.match(html, /href="https:\/\/example\.com\/post"/);
  assert.equal(showsJson(html), false);
});

test('YouTube with a transcript: timestamped takeaways', () => {
  const html = vivid(`Three takeaways from the talk.\n\n${fence(envelope([{ id: 't', type: 'list', ordered: true, title: 'Takeaways', items: [{ text: 'Start with the data contract.', meta: '02:14' }, { text: 'Cache at the edge.', meta: '11:40' }] }]))}`);
  const list = dom(html).querySelector('ol.haui-list-items');
  assert.equal(list.children.length, 2);
  assert.equal(list.querySelector('.haui-list-meta').textContent, '02:14');
});

test('YouTube without a transcript, and a failed tool: the gap is a visible notice', () => {
  const html = vivid(`I couldn't read this video's words.\n\n${fence(envelope([
    { id: 'n1', type: 'notice', tone: 'warning', title: 'No transcript available', body: 'Captions are off for this video, so only the title and description were read.' },
    { id: 'n2', type: 'notice', tone: 'error', title: 'Weather lookup failed', body: 'The weather tool returned an error.' },
  ]))}`);
  const notices = [...dom(html).querySelectorAll('.haui-notice')];
  assert.deepEqual(notices.map((node) => node.dataset.tone), ['warning', 'error']);
  assert.equal(notices[0].getAttribute('role'), 'note');
  assert.match(notices[1].textContent, /returned an error/);
});

test('weather from real tool data: condition cards and a forecast line chart', () => {
  const html = vivid(`Light rain in Leeds now (Met Office, 14:00).\n\n${fence(envelope([
    { id: 'now', type: 'stat', label: 'Now', value: '11°C', caption: 'Light rain' },
    { id: 'wind', type: 'stat', label: 'Wind', value: '19 km/h' },
    { id: 'fc', type: 'chart', kind: 'line', title: 'Next 5 days', labels: ['Thu', 'Fri', 'Sat', 'Sun', 'Mon'], series: [{ name: 'High', values: [12, 13, 11, 10, 12] }], unit: '°C' },
  ]))}`);
  assert.deepEqual(types(html), ['stat', 'chart']);
  assert.equal(dom(html).querySelectorAll('.haui-stat').length, 2);
  assert.match(html, /<polyline class="haui-line haui-s0"/);
});

test('numerical comparison: a table, and a numeric Markdown table gains a chart of the same numbers', () => {
  const drawn = vivid(`Phone B has the larger battery.\n\n${fence(envelope([{ id: 'tb', type: 'table', columns: ['Phone', 'Battery (mAh)', 'Price'], rows: [['A', 4500, '$799'], ['B', 5000, '$699']] }]))}`);
  assert.deepEqual(types(drawn), ['table']);
  const markdown = vivid('| City | Rainfall (mm) |\n| --- | --- |\n| Leeds | 66 |\n| York | 54 |\n| Hull | 49 |\n\nLeeds is wettest.');
  assert.match(markdown, /<table/);
  assert.match(markdown, /haui-derived/);
  assert.match(markdown, /<rect class="haui-s0"[^>]*><title>Rainfall \(mm\) · Leeds: 66<\/title>/, 'the chart reuses the table numbers');
});

test('coding answer: code stays a readable code block next to a small list', () => {
  const html = vivid(`Use a guard clause.\n\n\`\`\`js\nif (!user) return null;\n\`\`\`\n\n${fence(envelope([{ id: 'c', type: 'list', title: 'What changed', items: ['Early return when no user'] }]))}`);
  assert.match(html, /<pre[^>]*><code[^>]*data-lang="js"/);
  assert.deepEqual(types(html), ['list']);
});

test('short reply: prose only, nothing invented around it', () => {
  const html = vivid('Yes, that works.');
  assert.equal(html, '<p>Yes, that works.</p>');
  assert.deepEqual(types(html), []);
});

test('an omitted block still gets the Vivid presentation of what the model wrote', () => {
  const html = vivid('Here is the release.\n\n- **Version:** 4.2\n- **Released:** 3 October 2026\n- **License:** MIT\n\nSources:\n\n- [Changelog](https://example.com/changelog)\n- [Release notes](https://example.com/notes)\n\nThat is all.');
  assert.deepEqual(types(html), ['key_value', 'actions']);
  assert.match(html, /<dt>License<\/dt><dd>MIT<\/dd>/);
  assert.match(html, /<p>That is all\.<\/p>/);
  const css = read('../extension/lib/adaptive-ui.css');
  assert.match(css, /\.message\.assistant\[data-response-style="vivid"\] \.message-content/, 'every Vivid reply gets the Vivid prose surface');
});

test('malformed blocks: no raw JSON, the card words kept as text, the rest of the reply intact', () => {
  const broken = vivid(`Before.\n\n${fence('{"schema":"hermes.adaptive-ui","version":1,"blocks":[{"type":"stat","label":"Users","value":"1,204"')}\n\nAfter.`);
  assert.equal(showsJson(broken), false);
  assert.match(broken, /class="haui-block haui-salvage"/);
  assert.match(broken, /<li>Users<\/li><li>1,204<\/li>/);
  assert.match(broken, /<p>Before\.<\/p>[\s\S]*<p>After\.<\/p>/);
  const invalidProps = vivid(fence(envelope([{ id: 'p', type: 'chart', kind: 'pie', title: 'Share', labels: ['A'], series: [{ name: 'x', values: [1] }] }])));
  assert.equal(showsJson(invalidProps), false);
  assert.match(invalidProps, /Shown as text: this card could not be drawn\./);
  assert.match(invalidProps, /<li>Share<\/li>/);
});

test('common slips are repaired: json label, trailing commas, curly quotes, bare blocks, missing version', () => {
  const stat = { id: 's', type: 'stat', label: 'Visitors', value: '9,400' };
  const cases = [
    fence(envelope([stat]), 'json'),
    fence(`{"schema":"hermes.adaptive-ui","version":1,"blocks":[${JSON.stringify(stat)},]}`),
    fence(`{\u201cschema\u201d:\u201chermes.adaptive-ui\u201d,\u201cversion\u201d:1,\u201cblocks\u201d:[${JSON.stringify(stat)}]}`),
    fence([stat]),
    fence(stat),
    fence({ blocks: [stat] }),
    fence(envelope([stat]), 'hermes_ui'),
  ];
  for (const text of cases) assert.deepEqual(types(vivid(`Traffic.\n\n${text}`)), ['stat'], text.slice(0, 50));
  const otherJson = vivid(fence({ name: 'package', version: '1.0.0' }, 'json'));
  assert.match(otherJson, /<code data-lang="json">/, 'ordinary JSON code stays code');
  assert.equal(parseAdaptiveFence('hermes-ui', JSON.stringify({ ...envelope([stat]), version: 2 })).ok, false, 'a future version is not guessed at');
});

test('streaming: an unfinished block waits; the settled reply never spins forever', () => {
  const cut = `Numbers.\n\n\`\`\`hermes-ui\n${JSON.stringify(envelope([{ id: 's', type: 'stat', label: 'Users', value: '12' }]))}`;
  assert.match(vivid(cut, { streaming: true }), /class="haui-pending"/);
  const settled = vivid(cut);
  assert.doesNotMatch(settled, /haui-pending/);
  assert.deepEqual(types(settled), ['stat'], 'a reply that ended without its closing fence still draws');
  const truncated = vivid('Numbers.\n\n```hermes-ui\n{"schema":"hermes.adaptive-ui","version"');
  assert.doesNotMatch(truncated, /haui-pending|"schema"/);
  assert.match(truncated, /haui-salvage/);
});

test('restored history draws exactly what the live reply settled on', () => {
  const live = vivid(ARTICLE);
  const restored = renderResponseSafe(JSON.parse(JSON.stringify({ content: ARTICLE })).content, { style: 'vivid', streaming: false });
  assert.equal(restored, live);
});

test('switching Vivid off: Rich and Plain are unchanged and Plain hides blocks', () => {
  const sample = `Intro\n\n${fence(envelope([{ id: 's', type: 'stat', label: 'A', value: '1' }]))}\n\n**Bold** text`;
  assert.equal(renderResponseSafe(sample, { style: 'rich' }), renderMarkdownSafe(sample), 'Rich text is exactly the Markdown renderer');
  assert.doesNotMatch(renderResponseSafe(sample, { style: 'plain' }), /hermes-ui|haui|<strong>/);
  assert.equal(containsAdaptiveBlocks(sample), true);
  assert.equal(containsAdaptiveBlocks('Just prose.'), false);
  assert.equal(stripAdaptiveFences(`a\n\n\`\`\`json\n${JSON.stringify(envelope([]))}\n\`\`\``), 'a', 'copy text drops a json-labelled HAUI block too');
});

test('streaming reaches the renderer from the side panel stream updater', () => {
  const panel = read('../extension/sidepanel.js');
  assert.match(panel, /node\.hermesStreamRecord = record;\s*node\.hermesStreaming = true;/);
  assert.match(panel, /node\.hermesStreaming = false;\s*setMessageContent\(node, pending\);/);
  assert.match(panel, /const streaming = assistant\?\.hermesStreaming === true;/);
});

test('switching styles mid-session keeps earlier replies in their own style and applies the new style to the next reply', () => {
  const vividCardReply = `Here is where things stand.\n\n${fence(envelope([
    {
      id: 'candidacy-current-picture',
      type: 'key_value',
      title: 'Where things stand',
      items: [
        { key: 'Product role', value: 'Not moving forward, confirmed by Max.' },
        { key: 'Another possibility', value: 'The team wants to explore a different role.' },
      ],
    },
  ]))}`;
  const vividTableReply = 'Here are the numbers:\n\n| Quarter | Revenue |\n| --- | --- |\n| Q1 | 10 |\n| Q2 | 15 |\n| Q3 | 22 |\n\nGrowth held steady.';
  const richTableReply = '**Summary**\n\n| Item | Status |\n| --- | --- |\n| API | Ready |\n| UI | Done |';
  const plainReply = 'First step complete.\n\nSecond step complete.';

  const messages = [
    { role: 'user', content: 'Update me' },
    { role: 'assistant', content: vividCardReply },
    { role: 'user', content: 'Show revenue' },
    { role: 'assistant', content: vividTableReply },
  ];

  // User had Vivid UI selected when the first two replies arrived, then switched to Rich text.
  lockAssistantResponseStyles(messages, 'vivid');
  assert.equal(messages[1].responseStyle, 'vivid');
  assert.equal(messages[3].responseStyle, 'vivid');

  // Next message arrives under Rich text, then the user switches to Plain text.
  messages.push({ role: 'user', content: 'Rich table please' });
  messages.push({ role: 'assistant', content: richTableReply, responseStyle: 'rich' });
  lockAssistantResponseStyles(messages, 'rich');

  // Next message arrives under Plain text, then the user switches back to Vivid UI.
  messages.push({ role: 'user', content: 'Plain summary please' });
  messages.push({ role: 'assistant', content: plainReply, responseStyle: 'plain' });
  lockAssistantResponseStyles(messages, 'plain');

  const styles = messages.filter((m) => m.role === 'assistant').map((m) => resolveMessageResponseStyle(m, 'vivid'));
  assert.deepEqual(styles, ['vivid', 'vivid', 'rich', 'plain']);

  // Each message renders in the style it was stored with, regardless of the current setting.
  const renderedVividCard = renderResponseSafe(messages[1].content, { style: resolveMessageResponseStyle(messages[1], 'rich'), streaming: false });
  assert.equal(showsJson(renderedVividCard), false, 'switching to Rich text never turns an existing Vivid card into raw JSON');
  assert.deepEqual(types(renderedVividCard), ['key_value']);

  const renderedVividTable = renderResponseSafe(messages[3].content, { style: resolveMessageResponseStyle(messages[3], 'plain'), streaming: false });
  assert.match(renderedVividTable, /haui-derived/, 'switching to Plain text never strips the chart from an existing Vivid table reply');

  const renderedRichTable = renderResponseSafe(messages[5].content, { style: resolveMessageResponseStyle(messages[5], 'plain'), streaming: false });
  assert.match(renderedRichTable, /<table/, 'switching to Plain text keeps the Markdown table on an earlier Rich text reply');
  assert.doesNotMatch(renderedRichTable, /haui-derived/, 'switching back to Vivid UI later does not retroactively add a Vivid chart to a Rich reply');

  const renderedPlain = renderResponseSafe(messages[7].content, { style: resolveMessageResponseStyle(messages[7], 'vivid'), streaming: false });
  assert.match(renderedPlain, /class="plain-response"/, 'switching to Vivid UI keeps an earlier Plain text reply in plain style');

  // Even an older untagged reply with adaptive blocks keeps its Vivid rendering after a switch to Rich or Plain.
  assert.equal(resolveMessageResponseStyle({ role: 'assistant', content: vividCardReply }, 'rich'), 'vivid');
  assert.equal(resolveMessageResponseStyle({ role: 'assistant', content: vividCardReply }, 'plain'), 'vivid');

  // Gateway history reconciliation preserves local styles and recovers styles from Browser turn envelopes.
  const gatewayHistory = [
    { role: 'user', content: serializeBrowserTurnEnvelope({ humanInput: 'Update me', responseStyle: responseStyleTurnContract('vivid') }) },
    { role: 'assistant', content: vividTableReply },
    { role: 'user', content: serializeBrowserTurnEnvelope({ humanInput: 'Rich table please', responseStyle: responseStyleTurnContract('rich', { conversationHasVivid: true }) }) },
    { role: 'assistant', content: richTableReply },
    { role: 'user', content: serializeBrowserTurnEnvelope({ humanInput: 'Plain summary please', responseStyle: responseStyleTurnContract('plain', { conversationHasVivid: true }) }) },
    { role: 'assistant', content: plainReply },
  ];
  const reconciled = preserveAssistantResponseStyles(gatewayHistory, [], { fallbackStyle: 'vivid' });
  assert.deepEqual(
    reconciled.filter((m) => m.role === 'assistant').map((m) => m.responseStyle),
    ['vivid', 'rich', 'plain'],
  );
});
