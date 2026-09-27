/**
 * Truthful gateway failure diagnostics and recovery contract.
 *
 * The extension must never claim a cause it cannot prove: an ambiguous fetch
 * failure is not "the API server is not listening", a Python init failure is
 * not a computer_use tool fault, and no diagnostic copy may carry a raw
 * traceback, a local filesystem path, or a secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classifyGatewayError,
  gatewayConnectionTroubleshooting,
  sanitizeGatewayDiagnosticText,
} from '../extension/lib/common.mjs';
import { gatewayFailureRecoveryPlan } from '../extension/lib/turn-recovery.mjs';
import { buildSupportDiagnostics } from '../extension/lib/support-diagnostics.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const sidepanelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

const DASH_PATTERN = /[\u2013\u2014]/;

function diagnosticCopy(diagnostic) {
  return [diagnostic.title, diagnostic.detail, diagnostic.userMessage, diagnostic.hint || ''].join(' ');
}

test('sanitizeGatewayDiagnosticText strips tracebacks, local paths, and secrets', () => {
  const raw = [
    'Traceback (most recent call last):',
    '  File "/home/example/hermes/.venv/lib/python3.11/site-packages/openai/_client.py", line 42, in __init__',
    '    raise OpenAIError("Failed to initialize OpenAI client")',
    'ImportError: pydantic_core/_pydantic_core.cp311-win_amd64.pyd is not a valid Win32 application',
    'C:\\Users\\Example\\AppData\\Local\\hermes\\venv\\Lib\\site-packages\\pydantic_core\\_pydantic_core.cp311-win_amd64.pyd',
    'Authorization: Bearer ***',
    'api_key=super-secret-value',
  ].join('\n');

  const safe = sanitizeGatewayDiagnosticText(raw, { maxLength: 240 });

  assert.doesNotMatch(safe, /Traceback/i);
  assert.doesNotMatch(safe, /site-packages/);
  assert.doesNotMatch(safe, /\/home\/example/);
  assert.doesNotMatch(safe, /C:\\Users\\Example/i);
  assert.doesNotMatch(safe, /super-secret-value/);
  assert.doesNotMatch(safe, /Authorization/);
  assert.doesNotMatch(safe, /\n/);
  assert.ok(safe.length <= 243, `sanitized copy must stay short, received ${safe.length} chars`);
  assert.match(safe, /Failed to initialize OpenAI client/);
});

test('an ambiguous fetch failure is reported as ambiguous, never as a server that is not listening', () => {
  const diagnostic = classifyGatewayError('http://127.0.0.1:8642 · Failed to fetch', {
    url: 'http://127.0.0.1:8642',
  });

  assert.equal(diagnostic.kind, 'network-ambiguous');
  assert.equal(diagnostic.probeStatus, 'unreachable');
  assert.equal(diagnostic.evidence, 'message');
  assert.equal(diagnostic.recovery, 'probe-health');
  assert.equal(diagnostic.retryable, true);
  assert.equal(diagnostic.serverReachable, null);
  assert.match(diagnostic.detail, /refused|blocked/i);
  assert.match(diagnostic.detail, /cannot tell/i);
  assert.equal(diagnostic.deliveryUnknown, true);
  assert.doesNotMatch(diagnosticCopy(diagnostic), /not listening|aiohttp|v0\.18|refused connection is the only/i);
  assert.doesNotMatch(diagnosticCopy(diagnostic), /nothing was sent|nothing was delivered/i);
});

test('a pre-flight refusal is not delivered, but a mid-flight reset or timeout is unconfirmed', () => {
  const refused = classifyGatewayError('net::ERR_CONNECTION_REFUSED');
  assert.equal(refused.kind, 'network-refused');
  assert.equal(refused.evidence, 'message');
  assert.equal(refused.deliveryUnknown, false);
  assert.match(refused.detail, /refused/i);
  assert.doesNotMatch(diagnosticCopy(refused), /CORS|aiohttp/i);

  // A reset happens after the request left the browser, so Hermes may already
  // hold the turn. The copy must never claim nothing was delivered.
  const reset = classifyGatewayError(new Error('Failed to fetch: ERR_CONNECTION_RESET'));
  assert.equal(reset.kind, 'network-interrupted');
  assert.equal(reset.deliveryUnknown, true);
  assert.doesNotMatch(diagnosticCopy(reset), /nothing was delivered|nothing was sent/i);
  assert.match(reset.userMessage, /duplicate/i);

  const timeout = classifyGatewayError('Hermes request failed: the connection timed out');
  assert.equal(timeout.kind, 'network-timeout');
  assert.equal(timeout.deliveryUnknown, true);
  assert.match(timeout.detail, /timed out/i);
  assert.doesNotMatch(diagnosticCopy(timeout), /nothing was delivered|nothing was sent|CORS/i);
});

test('CORS wording requires explicit CORS evidence even when health answers', () => {
  const explicit = classifyGatewayError('TypeError: Failed to fetch because CORS blocked the request');
  assert.equal(explicit.kind, 'network-cors');
  assert.match(explicit.detail, /origin|CORS/i);

  const afterHealthProbe = classifyGatewayError('TypeError: Failed to fetch', { healthOk: true });
  assert.equal(afterHealthProbe.kind, 'network-ambiguous');
  assert.equal(afterHealthProbe.deliveryUnknown, true);
  assert.doesNotMatch(afterHealthProbe.detail, /was blocked before Hermes could see it/i);
  assert.equal(afterHealthProbe.serverReachable, true);
  assert.match(afterHealthProbe.detail, /health/i);
  assert.match(afterHealthProbe.userMessage, /duplicate/i);

  const stillAmbiguous = classifyGatewayError('TypeError: Failed to fetch', { healthOk: false });
  assert.equal(stillAmbiguous.kind, 'network-ambiguous');
});

test('dashboard attach renders classified copy rather than an unfiltered error', () => {
  const attachStart = sidepanelSource.indexOf('async function connectTicketTransport(');
  const attachEnd = sidepanelSource.indexOf('async function connectToHermes()', attachStart);
  assert.ok(attachStart >= 0 && attachEnd > attachStart);
  const attach = sidepanelSource.slice(attachStart, attachEnd);
  assert.match(attach, /els\.connectStatus\.textContent = diagnostic\.detail/);
  assert.match(attach, /Dashboard Attach failed', diagnostic\.userMessage/);
  assert.doesNotMatch(attach, /els\.connectStatus\.textContent = error\?\.message/);
});

test('a gateway Python init failure is a server runtime fault, not a computer_use fault', () => {
  const diagnostic = classifyGatewayError(
    new Error('Failed to initialize OpenAI client: pydantic_core._pydantic_core ImportError'),
    { status: 500, url: 'http://127.0.0.1:8642' },
  );

  assert.equal(diagnostic.kind, 'server-runtime');
  assert.equal(diagnostic.probeStatus, 'degraded');
  assert.equal(diagnostic.status, 500);
  assert.equal(diagnostic.evidence, 'http-status');
  assert.equal(diagnostic.serverReachable, true);
  assert.equal(diagnostic.recovery, 'update-runtime');
  assert.match(diagnostic.detail, /gateway is running/i);
  assert.match(diagnostic.detail, /pydantic_core/i);
  assert.match(diagnostic.detail, /Python version/i);
  assert.doesNotMatch(diagnosticCopy(diagnostic), /computer_use|cua-driver|computer-use doctor/i);
});

test('a computer_use traceback is named as a hint instead of being blamed for every gateway exception', () => {
  const diagnostic = classifyGatewayError(
    "Traceback (most recent call last): File 'common.mjs', line 1, in run int() argument must be a string, a bytes-like object or a real number, not 'NoneType' computer_use",
  );

  assert.equal(diagnostic.kind, 'server-runtime');
  assert.equal(diagnostic.probeStatus, 'degraded');
  assert.match(diagnostic.title, /runtime/i);
  assert.match(diagnostic.hint, /computer-use doctor/i);
  assert.doesNotMatch(diagnostic.detail, /computer_use|cua-driver/i);
  assert.doesNotMatch(diagnosticCopy(diagnostic), /Traceback/);
  assert.equal(diagnostic.retryable, false);
});

test('authenticated 5xx, auth, and missing-route statuses stay in their own buckets', () => {
  for (const status of [502, 503, 504]) {
    const gatewayResponse = classifyGatewayError('', { status });
    assert.equal(gatewayResponse.kind, 'upstream-unconfirmed');
    assert.equal(gatewayResponse.status, status);
    assert.equal(gatewayResponse.serverReachable, null);
    assert.doesNotMatch(diagnosticCopy(gatewayResponse), /so the gateway is running|Hermes answered/i);
  }
  const serverError = classifyGatewayError('', { status: 500 });
  assert.equal(serverError.kind, 'server-runtime');
  assert.equal(serverError.probeStatus, 'degraded');
  assert.equal(serverError.status, 500);
  assert.equal(serverError.serverReachable, true);
  assert.equal(serverError.retryable, true);

  const auth = classifyGatewayError('401: Unauthorized');
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.status, 401);
  assert.equal(auth.recovery, 'fix-auth');
  assert.equal(auth.retryable, false);

  const structuredAuth = classifyGatewayError('', { status: 403 });
  assert.equal(structuredAuth.kind, 'auth');

  const missing = classifyGatewayError('404: Not Found');
  assert.equal(missing.kind, 'route-missing');
  assert.equal(missing.recovery, 'check-route');
  assert.doesNotMatch(diagnosticCopy(missing), /aiohttp/);
});

test('raw gateway exception text never reaches the diagnostic copy', () => {
  const diagnostic = classifyGatewayError(
    new Error('boom at C:\\Users\\Example\\hermes\\gateway.py:41 with Authorization: Bearer ***'),
  );

  assert.equal(diagnostic.kind, 'unknown');
  assert.doesNotMatch(diagnostic.detail, /C:\\Users\\Example|Authorization/i);
  assert.doesNotMatch(diagnostic.userMessage, /C:\\Users\\Example|Authorization/i);
  assert.ok(diagnostic.detail.length <= 363, 'unknown diagnostics must be clamped before display');
});

test('gateway connection troubleshooting never claims a false cause for a local probe', () => {
  const ambiguous = gatewayConnectionTroubleshooting({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    state: 'unreachable',
    probeDetail: 'http://127.0.0.1:8642 · Failed to fetch',
  });
  assert.match(ambiguous, /127\.0\.0\.1:8642/);
  assert.match(ambiguous, /cannot tell|refused|blocked/i);
  assert.match(ambiguous, /check connection/i);
  assert.doesNotMatch(ambiguous, /API server is not listening/i);
  assert.doesNotMatch(ambiguous, /aiohttp|Hermes Agent v0\.18/i);
  assert.doesNotMatch(ambiguous, /API_SERVER_KEY|Bearer|token/i);

  const refused = gatewayConnectionTroubleshooting({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    state: 'unreachable',
    probeDetail: 'net::ERR_CONNECTION_REFUSED',
  });
  assert.match(refused, /refused/i);
  assert.doesNotMatch(refused, /aiohttp/i);

  const structured = gatewayConnectionTroubleshooting({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    state: 'unreachable',
    probeDetail: 'health returned 500',
    probeDiagnostic: classifyGatewayError('', { status: 500, url: 'http://127.0.0.1:8642' }),
  });
  assert.match(structured, /gateway is running/i);
  assert.doesNotMatch(structured, /not listening|aiohttp/i);

  const remote = gatewayConnectionTroubleshooting({
    gatewayMode: 'remote-api',
    gatewayUrl: 'http://host.ts.net:8642',
    state: 'unreachable',
    probeDetail: 'timeout',
  });
  // Precise evidence wins over the generic remote copy: the message names the
  // host and the timeout instead of guessing at the cause.
  assert.match(remote, /http:\/\/host\.ts\.net:8642/);
  assert.match(remote, /timed out/i);
  assert.doesNotMatch(remote, /aiohttp|v0\.18/i);

  const remoteUnknown = gatewayConnectionTroubleshooting({
    gatewayMode: 'remote-api',
    gatewayUrl: 'http://host.ts.net:8642',
    state: 'unreachable',
    probeDetail: 'Hermes gateway handshake failed without a recognizable reason',
  });
  assert.match(remoteUnknown, /Remote Hermes API is not reachable/i);
  assert.doesNotMatch(remoteUnknown, /aiohttp|v0\.18/i);
});

test('degraded gateway copy reports the server runtime fault instead of a silent capability warning', () => {
  const copy = gatewayConnectionTroubleshooting({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    state: 'degraded',
    probeDetail: "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
  });

  assert.match(copy, /gateway is running/i);
  assert.match(copy, /gateway log/i);
  assert.doesNotMatch(copy, /aiohttp|not listening|Traceback|NoneType/i);
});

test('no gateway copy instructs an OS restart or an automatic transport fallback', () => {
  const samples = [
    gatewayConnectionTroubleshooting({ gatewayMode: 'local-api', state: 'unreachable', probeDetail: 'Failed to fetch' }),
    gatewayConnectionTroubleshooting({ gatewayMode: 'remote-api', gatewayUrl: 'http://host.ts.net:8642', state: 'unreachable', probeDetail: 'timeout' }),
    gatewayConnectionTroubleshooting({ gatewayMode: 'remote-dashboard', gatewayUrl: 'https://dash.example.com', state: 'unreachable', probeDetail: 'socket closed' }),
    gatewayConnectionTroubleshooting({ gatewayMode: 'local-api', state: 'degraded', probeDetail: 'provider validation failure' }),
  ];

  for (const copy of samples) {
    assert.doesNotMatch(copy, /(?:restart|reboot)\s+(?:the\s+)?(?:computer|machine|system|pc|windows|os)\b/i);
    assert.doesNotMatch(copy, /automatically\s+(?:switch|fall\s?back|use)/i);
  }
});

test('gateway failure copy never carries em dash or en dash characters', () => {
  const values = [
    classifyGatewayError('Failed to fetch'),
    classifyGatewayError('net::ERR_CONNECTION_REFUSED'),
    classifyGatewayError('The connection timed out'),
    classifyGatewayError('', { status: 500 }),
    classifyGatewayError('', { status: 401 }),
    classifyGatewayError('', { status: 404 }),
    classifyGatewayError('Failed to initialize OpenAI client pydantic_core'),
    classifyGatewayError('mystery failure with a secret Bearer abc123'),
    gatewayConnectionTroubleshooting({ gatewayMode: 'local-api', state: 'unreachable', probeDetail: 'Failed to fetch' }),
    gatewayConnectionTroubleshooting({ gatewayMode: 'local-api', state: 'degraded', probeDetail: 'Failed to fetch' }),
    gatewayConnectionTroubleshooting({ gatewayMode: 'remote-api', url: 'http://host.ts.net:8642', state: 'unreachable', probeDetail: '' }),
  ];

  for (const value of values) {
    const copy = typeof value === 'string' ? value : diagnosticCopy(value);
    assert.doesNotMatch(copy, DASH_PATTERN, `copy must use plain hyphens: ${copy}`);
  }
});

test('gatewayFailureRecoveryPlan keeps a provably undelivered draft safe to resend', () => {
  const undelivered = gatewayFailureRecoveryPlan({
    error: new Error('net::ERR_CONNECTION_REFUSED'),
    diagnostic: { kind: 'network-refused', recovery: 'check-network', deliveryUnknown: false, userMessage: 'Browser could not open a connection to the Hermes API.' },
  });
  assert.deepEqual(undelivered, {
    kind: 'network-refused',
    preserveDraft: true,
    resendSafe: true,
    duplicateSendRisk: false,
    autoRetry: false,
    recoveryAction: 'check-network',
    detail: '',
    userMessage: 'Browser could not open a connection to the Hermes API.',
  });

  // Uncertain delivery (reset, hangup, timeout, ambiguous fetch): the draft is
  // preserved and never replayed, but a manual resend could duplicate the turn.
  const uncertain = gatewayFailureRecoveryPlan({
    error: new Error('Failed to fetch: ERR_CONNECTION_RESET'),
    diagnostic: { kind: 'network-interrupted', recovery: 'probe-health', deliveryUnknown: true, userMessage: 'The connection to Hermes was interrupted.' },
  });
  assert.equal(uncertain.preserveDraft, true);
  assert.equal(uncertain.resendSafe, false);
  assert.equal(uncertain.duplicateSendRisk, true);
  assert.equal(uncertain.autoRetry, false);

  const accepted = gatewayFailureRecoveryPlan({
    error: Object.assign(new Error('socket closed'), { requestAccepted: true }),
    diagnostic: { kind: 'unknown' },
  });
  assert.equal(accepted.preserveDraft, false);
  assert.equal(accepted.resendSafe, false);
  assert.equal(accepted.duplicateSendRisk, true);
  assert.equal(accepted.autoRetry, false);
});

test('the gateway failure turn branch restores the unsent draft and shows sanitized copy', () => {
  const branchStart = sidepanelSource.indexOf("const recoveryPlan = gatewayFailureRecoveryPlan(");
  assert.ok(branchStart > 0, 'the gateway failure branch must consult the recovery plan');
  const branchEnd = sidepanelSource.indexOf('Hermes Browser Extension error:', branchStart);
  const branch = sidepanelSource.slice(branchStart, branchEnd);

  assert.match(branch, /recoveryPlan\.preserveDraft/);
  assert.match(branch, /els\.input\.value = commentPack\.consumed/);
  assert.match(branch, /persistCurrentComposerDraft\(\{ immediate: true \}\)/);
  assert.match(branch, /diagnostic\.userMessage/);
  assert.doesNotMatch(branch, /error\?\.message \|\| String\(error\)/);
  assert.doesNotMatch(branch, /autoSend:\s*true/);
  assert.doesNotMatch(branch, /gatewayConnectionTroubleshooting/);
});

test('the panel exposes a recovery action that re-runs the connection probe with the structured diagnostic', () => {
  assert.match(sidepanelHtml, /id="statusActions"/);
  assert.match(sidepanelHtml, /id="statusRetryProbeButton"/);
  assert.match(sidepanelSource, /statusRetryProbeButton: \$\('#statusRetryProbeButton'\)/);
  assert.match(sidepanelSource, /els\.statusRetryProbeButton\.textContent = translateUiText\('Check connection'\)/);
  assert.match(
    sidepanelSource,
    /statusRetryProbeButton\?\.addEventListener\('click',[\s\S]{0,120}probeGatewayLiveness\(\{ quiet: false \}\)/,
  );
  assert.match(sidepanelSource, /connectionProbeDiagnostic/);
  assert.match(sidepanelSource, /probeDiagnostic: connectionProbeDiagnostic/);
  assert.doesNotMatch(sidepanelSource, /statusRetryProbeButton\?\.addEventListener\('click',[\s\S]{0,120}automatically/i);
});

test('support diagnostics carry the structured gateway failure classification', () => {
  const diagnostics = buildSupportDiagnostics({
    extensionVersion: '0.3.3',
    settings: { gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642' },
    connection: { state: 'unreachable' },
    gatewayDiagnostic: classifyGatewayError('Failed to initialize OpenAI client pydantic_core', { status: 500 }),
  });

  assert.match(diagnostics.markdown, /## Gateway failure classification/);
  assert.match(diagnostics.markdown, /Kind: server-runtime/);
  assert.match(diagnostics.markdown, /HTTP status: 500/);
  assert.match(diagnostics.markdown, /Server reachable: yes/);
  assert.match(diagnostics.markdown, /Recovery: update-runtime/);
  assert.doesNotMatch(diagnostics.markdown, /Traceback|site-packages/i);
});

test('side panel feeds the structured gateway diagnostic into support diagnostics', () => {
  assert.match(sidepanelSource, /gatewayDiagnostic: lastGatewayDiagnostic/);
  assert.match(sidepanelSource, /lastGatewayDiagnostic = connectionProbeDiagnostic/);
});

test('a three-digit number that is not an HTTP status is not read as one', () => {
  // A port or id near a failure must not become a phantom status.
  const refusedOnPort = classifyGatewayError('net::ERR_CONNECTION_REFUSED to host port 443');
  assert.equal(refusedOnPort.kind, 'network-refused');
  assert.equal(refusedOnPort.status, null);

  const urlOnly = classifyGatewayError('Failed to fetch http://127.0.0.1:8642/api/sessions');
  assert.equal(urlOnly.status, null);

  // Statuses framed the way a gateway really reports them still parse.
  assert.equal(classifyGatewayError('401: Unauthorized').status, 401);
  assert.equal(classifyGatewayError('health returned 500').status, 500);
  assert.equal(classifyGatewayError('HTTP 503 Service Unavailable').status, 503);
});

test('rate-limited and request-timeout statuses stay out of the 5xx server-runtime bucket', () => {
  const limited = classifyGatewayError('', { status: 429, url: 'http://127.0.0.1:8642' });
  assert.equal(limited.kind, 'rate-limited');
  assert.equal(limited.status, 429);
  assert.equal(limited.serverReachable, true);
  assert.equal(limited.retryable, true);
  assert.notEqual(limited.kind, 'server-runtime');

  const timedOut = classifyGatewayError('', { status: 408, url: 'http://127.0.0.1:8642' });
  assert.equal(timedOut.kind, 'request-timeout');
  assert.equal(timedOut.status, 408);
  assert.equal(timedOut.serverReachable, true);
  assert.equal(timedOut.deliveryUnknown, true);
  assert.notEqual(timedOut.kind, 'server-runtime');
});

test('the gateway failure branch warns about a possible duplicate instead of claiming an unsent turn', () => {
  const branchStart = sidepanelSource.indexOf('const recoveryPlan = gatewayFailureRecoveryPlan(');
  assert.ok(branchStart > 0, 'the gateway failure branch must consult the recovery plan');
  const branchEnd = sidepanelSource.indexOf('Hermes Browser Extension error:', branchStart);
  const branch = sidepanelSource.slice(branchStart, branchEnd);

  assert.match(branch, /recoveryPlan\.duplicateSendRisk/);
  assert.match(branch, /could duplicate it/);
  assert.match(branch, /markGatewayUnreachable\(error, diagnostic\)/);
  // The old dead branch returned before marking the connection state, so the
  // duplicate warning could never actually run.
  assert.doesNotMatch(branch, /did not restore the draft for resending/);
});

test('a degraded server runtime surfaces a warning status so Check connection is offered', () => {
  const degradedBranchStart = sidepanelSource.indexOf("if (state.state === 'degraded') {", sidepanelSource.indexOf('function updateConnectionPrompt'));
  assert.ok(degradedBranchStart > 0, 'the degraded connection branch must exist');
  const degradedBranch = sidepanelSource.slice(degradedBranchStart, degradedBranchStart + 420);
  assert.match(degradedBranch, /setStatus\('warn'/);
});
