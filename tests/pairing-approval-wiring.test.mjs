import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const js = read('extension/sidepanel.js');
const html = read('extension/sidepanel.html');
const css = read('extension/sidepanel.css');

const pairing = js.match(/async function connectApiWithPairing\(\) \{[\s\S]*?\n\}/)?.[0] || '';
const show = js.match(/function showPairingApproval\(payload\) \{[\s\S]*?\n\}/)?.[0] || '';
const dismiss = js.match(/function dismissPairingApproval\(\) \{[\s\S]*?\n\}/)?.[0] || '';
const poll = js.match(/async function pollPairing\([\s\S]*?\n\}/)?.[0] || '';

test('the pairing request names the extension that is asking', () => {
  assert.match(pairing, /body: JSON\.stringify\(pairingStartBody\(browserApi\.runtime\)\)/);
  assert.doesNotMatch(pairing, /extensionId: browserApi\.runtime\?\.id/, 'the id alone is no longer the whole request');
});

test('Connect shows the approval page in the panel and falls back to a tab', () => {
  const frameIndex = pairing.indexOf('showPairingApproval(pairingPayload)');
  const tabIndex = pairing.indexOf('if (!inPanel) await openApprovalUrl(pairingPayload.approval_url)');
  const pollIndex = pairing.indexOf('await pollPairing(pairingPayload.pairing_id)');
  assert.ok(frameIndex >= 0 && frameIndex < tabIndex && tabIndex < pollIndex, 'frame first, a tab only when it could not be framed, then poll');
  assert.match(pairing, /finally \{\s*dismissPairingApproval\(\);\s*\}/, 'the page goes away however the wait ends');
  assert.match(pairing, /t\('pairing\.approve_below'\)/, 'the status points at the page');
});

test('the frame is used only for an approval link the gateway offered to be framed', () => {
  assert.match(show, /const url = approvalFrameUrl\(payload, settings\.gatewayUrl\);\s*if \(!url\) return false;/);
  assert.match(show, /onboardingFlow\?\.isOpen/, "setup's Connect step");
  assert.match(show, /connectDialogShowing\(\) && els\.connectApprovalSlot/, 'the Connect pop-up');
  assert.match(show, /\} else \{\s*return false;\s*\}/, 'neither on screen is a tab, as before');
  assert.match(show, /els\.manualSettingsButton\?\.before\(pairingApproval\.tab\)/, 'in the pop-up the tab button joins its actions');
  assert.match(show, /pairingApproval\.show\(url\)/);
  assert.ok(show.indexOf('setApproval(pairingApproval.node)') < show.indexOf('pairingApproval.show(url)'), 'the iframe is in place before it loads');
  assert.match(js, /translate: \(key\) => t\(key\),\s*onOpenTab: \(\) => \{ void openApprovalUrl\(pairingApprovalTabUrl\); \}/, 'the way out opens the same page in a tab');
});

test('a frame the extension policy refuses opens the tab instead of a blank box', () => {
  assert.match(js, /document\.addEventListener\('securitypolicyviolation', \(event\) => \{[\s\S]*?startsWith\('frame-src'\)[\s\S]*?dismissPairingApproval\(\);\s*void openApprovalUrl\(url\);/);
});

test('dismissing clears both places the page can be', () => {
  assert.match(dismiss, /onboardingFlow\?\.setApproval\(null\)/);
  assert.match(dismiss, /classList\.remove\('is-approving'\)/);
  assert.match(dismiss, /pairingApproval\.hide\(\)/);
});

test('polling keeps its 1.5 second beat and 90 tries, and does not talk over the page', () => {
  assert.match(poll, /attempts = 90, delay = 1500/);
  assert.match(poll, /if \(!pairingApproval\?\.showing\) els\.connectStatus\.textContent = translateUiText\('Waiting for Hermes Desktop approval\.\.\.'\)/);
  assert.match(poll, /await sleep\(delay\)/);
});

test('the Connect pop-up has a place for the page, and the HTML itself never carries a frame', () => {
  const { document } = parseHTML(html);
  const card = document.querySelector('#connectPanel .connect-panel-card');
  const slot = card.querySelector('#connectApprovalSlot');
  assert.ok(slot, 'a slot inside the pop-up card');
  assert.ok(slot.compareDocumentPosition(card.querySelector('.connect-actions')) & 4, 'above the buttons');
  assert.equal(document.querySelector('iframe'), null, 'the iframe is made on demand, by lib/pairing-approval.mjs');
  assert.match(js, /connectApprovalSlot: \$\('#connectApprovalSlot'\)/);
});

test('the pop-up and setup make room for the page, and the page has a size', () => {
  assert.match(css, /\.connect-panel-card\.is-approving > ol,\s*\.connect-panel-card\.is-approving #connectButton \{ display: none; \}/, 'the pop-up keeps Open in a tab and Manual setup, not a disabled Connecting button');
  assert.match(css, /\.pairing-approval-tab \{ width: 100%; min-height: 36px;/, 'the same size as the buttons around it');
  assert.match(css, /\.onboarding\.is-approving \.onboarding-preview,\s*\.onboarding-connect\.is-approving \.onboarding-connect-actions \{ display: none; \}/);
  assert.match(css, /\.pairing-approval-frame \{[^}]*width: 100%;[^}]*height: min\(340px, 56dvh\);/s);
  assert.match(css, /\.pairing-approval\[hidden\] \{ display: none; \}/);
});

test('a pairing denied in the panel says so, not that it expired', () => {
  const denied = poll.indexOf("payload?.error?.code === 'pairing_denied'");
  const expired = poll.indexOf("response.status === 410");
  assert.ok(denied >= 0 && denied < expired, 'the gateway answers a denial with 410 too, so it is told apart first');
  assert.match(poll, /throw new Error\(t\('pairing\.denied'\)\)/);
});
