import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_GATEWAY_CAPABILITIES,
  dashboardWsGatewayCapabilities,
  normalizeGatewayCapabilities,
} from '../extension/lib/capabilities.mjs';
import { PROMPT_EVENT_NAMES } from '../extension/lib/gateway-prompts.mjs';
import { BROWSER_RUNTIME_EVENT_NAMES } from '../extension/lib/runtime-events.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sidepanel = read('extension/sidepanel.js');

test('runtime event names and prompt event names agree', () => {
  assert.equal(BROWSER_RUNTIME_EVENT_NAMES.approvalRequested, PROMPT_EVENT_NAMES.approvalRequest);
  assert.equal(BROWSER_RUNTIME_EVENT_NAMES.approvalResponded, PROMPT_EVENT_NAMES.approvalResponded);
  assert.equal(BROWSER_RUNTIME_EVENT_NAMES.approvalSettled, PROMPT_EVENT_NAMES.approvalSettled);
  assert.equal(BROWSER_RUNTIME_EVENT_NAMES.approvalCancelled, PROMPT_EVENT_NAMES.approvalCancelled);
  assert.equal(BROWSER_RUNTIME_EVENT_NAMES.clarifyRequested, PROMPT_EVENT_NAMES.clarifyRequest);
  assert.equal(BROWSER_RUNTIME_EVENT_NAMES.clarifySettled, PROMPT_EVENT_NAMES.clarifySettled);
});

test('capabilities expose the run approval route the gateway advertises', () => {
  const advertised = normalizeGatewayCapabilities({
    platform: 'hermes-agent',
    features: { run_approval_response: true, approval_events: true },
    endpoints: { run_approval: { method: 'POST', path: '/v1/runs/{run_id}/approval' } },
  }, { healthOk: true });
  assert.equal(advertised.runApproval, true);
  assert.equal(advertised.approvalEvents, true);
  assert.equal(advertised.runClarify, false, 'clarify has no route of its own in /v1/capabilities');

  const bare = normalizeGatewayCapabilities({ platform: 'hermes-agent', features: {}, endpoints: {} }, { healthOk: true });
  assert.equal(bare.runApproval, false);

  const endpointOnly = normalizeGatewayCapabilities({
    platform: 'hermes-agent', features: {}, endpoints: { run_approval: { path: '/v1/runs/{run_id}/approval' }, run_clarify: { path: '/v1/runs/{run_id}/clarify' } },
  }, { healthOk: true });
  assert.equal(endpointOnly.runApproval, true);
  assert.equal(endpointOnly.runClarify, true);

  const refused = normalizeGatewayCapabilities({ platform: 'hermes-agent', features: { run_approval_response: false }, endpoints: { run_approval: { path: '/x' } } }, { healthOk: true });
  assert.equal(refused.runApproval, false, 'an explicit feature flag wins over the route listing');

  assert.equal(DEFAULT_GATEWAY_CAPABILITIES.runApproval, false);
  assert.equal(normalizeGatewayCapabilities(null).runApproval, false);
  assert.equal(dashboardWsGatewayCapabilities().runApproval, false, 'WebSocket prompts do not depend on the REST route');
});

test('the side panel mounts the card and loads its stylesheet', () => {
  for (const [html, label] of [[read('extension/sidepanel.html'), 'sidepanel']]) {
    assert.match(html, /<section id="agentPromptCard" class="agent-prompt-card"[^>]*hidden><\/section>/, label);
    assert.match(html, /lib\/agent-prompt-card\.css/, label);
    assert.equal((html.match(/id="agentPromptCard"/g) || []).length, 1, label);
  }
  const css = read('extension/lib/agent-prompt-card.css');
  assert.match(css, /\.agent-prompt-card\[hidden\]\s*\{\s*display:\s*none/);
});

test('the side panel reads prompt events from the run stream and threads them through every REST path', () => {
  assert.match(sidepanel, /} else if \(isPromptEventName\(event\.type\)\) \{\s*onPrompt\?\.\(event\.type, data\);/);
  for (const pattern of [
    /async function streamSessionChat\([^)]*onPrompt/,
    /async function streamSessionChatRest\([^)]*onPrompt/,
    /async function streamChatCompletions\([^)]*onPrompt/,
    /async function readSseResponse\([^)]*onPrompt/,
    /streamSessionChatRest\(prompt, onDelta, onTool, \{[^}]*onPrompt/,
    /streamChatCompletions\(prompt, onDelta, onTool, \{[^}]*onPrompt/,
    /readSseResponse\(response, onDelta, onTool, \{ signal, onRun, onSteerQueued, onRuntime, onPrompt/,
  ]) assert.match(sidepanel, pattern);
});

test('the side panel says it is waiting for the user, not the model', () => {
  assert.match(sidepanel, /exec_approval\.waiting/);
  assert.match(sidepanel, /clarify\.waiting/);
  const timer = sidepanel.slice(sidepanel.indexOf('const armSlowReplyTimer'), sidepanel.indexOf('promptPoller = createRestPromptPoller'));
  assert.match(timer, /promptController\.hasPending\(promptViewedSessionIds\(\)\)/, 'the slow-reply notice is held back while a prompt is open');
  assert.match(timer, /armSlowReplyTimer\(\);\s*return;/, 'and re-armed instead of dropped');
  assert.match(sidepanel, /if \(isPromptRequestEvent\(type\)\) noteReplyActivity\(\);/);
});

test('a REST run is polled for prompts only when status is advertised and the stream goes quiet', () => {
  assert.match(sidepanel, /if \(!dashboardTransport && gatewayCapabilities\.runStatus\) \{\s*promptPoller = createRestPromptPoller/);
  assert.match(sidepanel, /promptPoller\?\.start\(\);/);
  assert.match(sidepanel, /promptPoller\?\.stop\(\);\s*if \(promptRunId\) promptController\.settleScope\('rest', promptRunId\);\s*if \(localSessionStream/);
  assert.match(sidepanel, /if \(isClarifyToolEvent\(tool\)\) promptPoller\?\.poke\(\);/, 'a clarify tool call triggers an early status read');
});

test('REST answers go to the run routes and carry the prompt id', () => {
  for (const source of [sidepanel]) {
    assert.match(source, /\/v1\/runs\/\$\{encodeURIComponent\(entry\.scope\)\}\/\$\{route\}/);
    assert.match(source, /const route = entry\.kind === 'clarify' \? 'clarify' : 'approval';/);
    assert.match(source, /getCapabilities: \(\) => gatewayCapabilities/);
  }
});

test('live gateway session ids are bound to the browser session that owns them', () => {
  assert.match(sidepanel, /promptController\.bindSession\(liveId, storedId\);/);
});

test('a closed chat connection drops its prompts', () => {
  assert.match(sidepanel, /gatewayClient\.on\('close', \(\) => promptController\.dropClient\(gatewayClient\)\);/);
});

test('switching sessions re-evaluates which prompt belongs on screen', () => {
  assert.match(sidepanel, /function updateSessionLabel\(\) \{\s*promptController\.refresh\(\);/);
});

test('nothing in the prompt path can approve on its own', () => {
  for (const file of ['gateway-prompts', 'prompt-controller', 'prompt-card']) {
    const source = read(`extension/lib/${file}.mjs`);
    assert.doesNotMatch(source, /answerApproval\([^)]*['"](?:once|session|always)['"]/, `${file} never calls answerApproval with a grant`);
    assert.doesNotMatch(source, /\beval\(|new Function\(|innerHTML/, `${file} never parses text as code or markup`);
  }
});
