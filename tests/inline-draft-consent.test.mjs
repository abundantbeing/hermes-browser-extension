import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gateInlineDraftRequestContext,
} from '../extension/lib/inline-draft-consent.mjs';
import {
  contextConsentIdentity,
  withContextConsent,
} from '../extension/lib/context-consent.mjs';

const REQUEST = Object.freeze({
  schema: 'hermes.browser.inline-draft.v1',
  version: '1.0.0',
  mode: 'draft-copy-only',
  requestId: 'request-1234',
  documentId: 'document-1234',
  actionId: 'draft-for-context',
  actionLabel: 'Draft for this field',
  route: 'background',
  autoReplace: false,
  draftText: '',
  fieldKind: 'textarea',
  fieldLabel: 'Reply',
  pageContext: 'private ambient page context',
  adapterId: 'generic',
  pageUrl: 'https://example.com/editor',
  createdAt: '2026-08-11T17:00:00.000Z',
});

const REMOTE_SETTINGS = Object.freeze({
  gatewayUrl: 'https://remote.example.com',
  connectionTransport: 'remote-api',
  activeProfile: 'work',
  ['api' + 'Key']: 'fixture-credential-a',
});

const CONTROLLER = 'extension-controller';

async function grantedLedger(settings = REMOTE_SETTINGS) {
  const gated = await gateInlineDraftRequestContext({
    request: REQUEST,
    settings,
    ledger: null,
    controller: CONTROLLER,
  });
  const identity = contextConsentIdentity({
    gatewayUrl: settings.gatewayUrl,
    principal: gated.principal,
    profile: settings.activeProfile,
    controller: CONTROLLER,
    transport: settings.connectionTransport,
  });
  return withContextConsent(null, identity, true, 1);
}

test('service-worker inline drafts strip ambient page metadata but preserve explicit user payload on non-loopback without exact consent', async () => {
  const explicitDraft = 'Please make my own draft clearer.';
  const result = await gateInlineDraftRequestContext({
    request: { ...REQUEST, draftText: explicitDraft },
    settings: REMOTE_SETTINGS,
    ledger: null,
    controller: CONTROLLER,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.request.pageContext, '');
  assert.equal(result.request.pageUrl, '');
  assert.equal(result.request.fieldLabel, '');
  assert.equal(result.request.draftText, explicitDraft);
  assert.equal(result.request.actionId, REQUEST.actionId);
});

test('service-worker inline drafts preserve page context only for the exact API identity', async () => {
  const ledger = await grantedLedger();
  const granted = await gateInlineDraftRequestContext({
    request: REQUEST,
    settings: REMOTE_SETTINGS,
    ledger,
    controller: CONTROLLER,
  });
  assert.equal(granted.allowed, true);
  assert.equal(granted.request.pageContext, REQUEST.pageContext);

  const rotated = await gateInlineDraftRequestContext({
    request: REQUEST,
    settings: { ...REMOTE_SETTINGS, ['api' + 'Key']: 'fixture-credential-b' },
    ledger,
    controller: CONTROLLER,
  });
  assert.equal(rotated.allowed, false);
  assert.equal(rotated.request.pageContext, '');
});

test('service-worker dashboard paths fail closed without a freshly verified principal', async () => {
  const result = await gateInlineDraftRequestContext({
    request: REQUEST,
    settings: {
      gatewayUrl: 'https://dashboard.example.com',
      connectionTransport: 'remote-dashboard',
      activeProfile: 'default',
    },
    ledger: null,
    controller: CONTROLLER,
  });
  assert.equal(result.principal, '');
  assert.equal(result.allowed, false);
  assert.equal(result.request.pageContext, '');
});

test('service-worker loopback inline drafts preserve page context without a ledger grant', async () => {
  const result = await gateInlineDraftRequestContext({
    request: REQUEST,
    settings: {
      gatewayUrl: 'http://127.0.0.1:8642',
      connectionTransport: 'local-api',
      activeProfile: 'default',
    },
    ledger: null,
    controller: CONTROLLER,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.request.pageContext, REQUEST.pageContext);
});
