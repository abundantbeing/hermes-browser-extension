import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { loadExtensionFile } from './inline-assist-dom.mjs';
import { createSettingsSaveHarness, sidepanelSource } from './helpers/settings-save-harness.mjs';
import { inlineSiteFromInput } from '../extension/lib/site-adapters.mjs';

test('Settings → Hermes Assist has the Sites list, which saves itself, with a line saying what each choice means', () => {
  const section = new JSDOM(loadExtensionFile('sidepanel.html')).window.document.querySelector('.inline-assist-settings');
  assert.ok(section.querySelector('.inline-assist-sites[data-settings-live] #inlineAssistSites'), 'the list');
  assert.ok(section.querySelector('#inlineAssistAddSite'), 'the Add this site button');
  assert.equal(section.querySelector('#inlineAssistSitesValue')?.type, 'hidden');
  assert.ok(section.querySelector('#inlineAssistSitesValue').closest('[data-settings-live]'), 'no Save needed');
  const legend = section.querySelector('#inlineAssistSitesLegend');
  assert.match(legend.textContent, /Reads thread:.*This field only:.*Circle hidden:.*right away/s);
  const css = loadExtensionFile('sidepanel.css');
  assert.doesNotMatch(css, /\.inline-assist-site-name::after/, 'no separator dot that reads as a full stop after the name');
  // One site per row, the name taking the room and the choice beside it, so a name is not cut short.
  assert.match(css, /\.inline-assist-sites-chips \{[^}]*flex-direction: column;/);
  assert.match(css, /\.inline-assist-site \{[^}]*display: flex;[^}]*width: 100%;/);
  assert.match(css, /\.inline-assist-site-name \{[^}]*flex: 1 1 auto;/);
  assert.match(css, /\.inline-assist-site \.branded-select \{[^}]*flex: none; width: auto;/, 'the choice keeps its own width');
});

// The real sidepanel functions against the real markup (see helpers/settings-save-harness.mjs).
// eslint-disable-next-line no-new-func
const constant = (name) => new Function(`return ${sidepanelSource.match(new RegExp(`^const ${name} = (.+);$`, 'm'))[1]}`)();

async function sitesPanel({ hidden = [], contextPrefs = {}, tabs = [] } = {}) {
  const h = await createSettingsSaveHarness();
  // branded-select.mjs builds its button with the page's own document and events.
  globalThis.document = h.document;
  globalThis.Event = h.document.defaultView.Event;
  globalThis.MutationObserver = h.document.defaultView.MutationObserver;
  h.scope.inlineAssistHiddenSites = hidden;
  h.scope.INLINE_ASSIST_SITE_STATES = constant('INLINE_ASSIST_SITE_STATES');
  h.scope.inlineSiteContextPreferences = contextPrefs;
  h.scope.inlineAssistOpenSite = '';
  h.scope.settingsBaseline = null;
  h.scope.Event = h.document.defaultView.Event;
  h.scope.browserApi.tabs = { query: async () => tabs };
  h.scope.browserApi.storage.onChanged = { addListener() {} };
  // As bindEvents() wires them.
  h.els.inlineAssistSites.addEventListener('change', h.fn('handleInlineAssistSiteChange'));
  h.els.inlineAssistSites.addEventListener('click', h.fn('handleInlineAssistSiteRemove'));
  h.fn('syncInlineAssistSitesForm')();
  const rows = () => [...h.els.inlineAssistSites.querySelectorAll('.inline-assist-site')];
  const row = (site) => rows().find((item) => item.dataset.site === site);
  const model = () => h.fn('readInlineAssistSitesModel')();
  const edits = [];
  h.els.inlineAssistSitesValue.addEventListener('input', () => edits.push(h.els.inlineAssistSitesValue.value));
  return { h, rows, row, model, edits };
}

test('each site shows its setting: known sites pick thread reading or hidden, other hosts read Circle hidden', async () => {
  const { rows, row } = await sitesPanel({ hidden: ['page.example'], contextPrefs: { gmail: 'visible', x: 'draft' } });
  assert.deepEqual(rows().map((item) => item.dataset.site), ['gmail', 'page.example', 'x']);
  assert.deepEqual(rows().map((item) => item.querySelector('.inline-assist-site-name').textContent), ['Gmail', 'page.example', 'X']);
  assert.equal(row('gmail').querySelector('select').value, 'visible');
  assert.deepEqual([...row('x').querySelector('select').options].map((option) => option.value), ['visible', 'draft', 'hidden']);
  assert.equal(row('x').querySelector('select').value, 'draft');
  assert.equal(row('page.example').querySelector('select'), null);
  assert.match(row('page.example').textContent, /Circle hidden/);
  assert.ok(row('page.example').querySelector('button.inline-assist-site-remove'));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('changing a site saves it straight away, with nothing left for Save', async () => {
  const { h, row, model, edits } = await sitesPanel({ contextPrefs: { gmail: 'visible', x: 'draft' } });
  const select = row('x').querySelector('select');
  select.value = 'hidden';
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual([...model().hidden], ['x']);
  assert.deepEqual(h.store.hermesInlineAssistHiddenSites, ['x']);
  assert.deepEqual(h.store.hermesInlineSiteContextPreferences, { gmail: 'visible' });
  assert.equal(edits.length, 0, 'not an unsaved edit');
  assert.equal(row('x').querySelector('select'), select, 'the row stays, so focus stays on the select');
});

test('Remove drops the site from both lists and saves', async () => {
  const { h, rows, model } = await sitesPanel({ hidden: ['page.example', 'gmail'], contextPrefs: { gmail: 'visible' } });
  rows().find((item) => item.dataset.site === 'gmail').querySelector('button.inline-assist-site-remove').click();
  await settle();
  assert.deepEqual(rows().map((item) => item.dataset.site), ['page.example']);
  assert.deepEqual([...model().hidden], ['page.example']);
  assert.deepEqual({ ...model().contextPrefs }, {});
  assert.deepEqual(h.store.hermesInlineAssistHiddenSites, ['page.example']);
  assert.equal(h.document.activeElement?.closest?.('.inline-assist-site')?.dataset.site, 'page.example');
});

for (const [url, site, label, state] of [['https://www.x.com/home', 'x', 'X', 'draft'], ['https://forum.page.example/new', 'forum.page.example', 'forum.page.example', 'hidden']]) {
  test(`Add this site names ${label}, adds it as ${state} and saves it`, async () => {
    const { h, row, model } = await sitesPanel({ tabs: [{ id: 3, url, title: 'Page' }] });
    await h.fn('refreshInlineAssistOpenSite')();
    assert.equal(h.els.inlineAssistAddSite.textContent, `assist.sites.add ${JSON.stringify({ site: label })}`, 'the button says which site');
    await h.fn('addActiveSiteToInlineAssistSites')();
    await settle();
    assert.ok(row(site), 'the row');
    if (state === 'hidden') assert.deepEqual(h.store.hermesInlineAssistHiddenSites, [site]);
    else assert.deepEqual(h.store.hermesInlineSiteContextPreferences, { [site]: state });
    if (state === 'hidden') assert.deepEqual([...model().hidden], [site]);
    assert.equal(h.els.inlineAssistAddSite.hidden, true, 'and then steps aside: the row is there');
  });
}

test('a typed site resolves to a site Assist knows by name or address, or to any other website', () => {
  assert.equal(inlineSiteFromInput('Facebook'), 'facebook');
  assert.equal(inlineSiteFromInput('facebook.com'), 'facebook');
  assert.equal(inlineSiteFromInput('https://www.linkedin.com/feed/'), 'linkedin');
  assert.equal(inlineSiteFromInput('twitter'), 'x');
  assert.equal(inlineSiteFromInput('  News.YCombinator.com/item?id=1 '), 'news.ycombinator.com');
  assert.equal(inlineSiteFromInput('hello'), '');
  assert.equal(inlineSiteFromInput('not a site!'), '');
  assert.equal(inlineSiteFromInput(''), '');
});

test('Add a site adds any website typed in: a known site with its choices, any other hidden', async () => {
  const { h, row } = await sitesPanel();
  const add = async (text, viaEnter = false) => {
    h.els.inlineAssistSiteInput.value = text;
    if (viaEnter) h.fn('handleInlineAssistSiteInputKey')({ key: 'Enter', preventDefault() {} });
    else await h.fn('addTypedSiteToInlineAssistSites')();
    await settle();
  };
  await add('facebook.com');
  assert.deepEqual([...row('facebook').querySelector('select').options].map((option) => option.value), ['visible', 'draft', 'hidden']);
  assert.deepEqual(h.store.hermesInlineSiteContextPreferences, { facebook: 'draft' });
  assert.equal(h.els.inlineAssistSiteInput.value, '', 'the box empties for the next one');
  await add('news.ycombinator.com', true);
  assert.match(row('news.ycombinator.com').textContent, /Circle hidden/);
  assert.deepEqual(h.store.hermesInlineAssistHiddenSites, ['news.ycombinator.com']);
  await add('facebook');
  assert.equal(h.els.inlineAssistSites.querySelectorAll('.inline-assist-site[data-site="facebook"]').length, 1, 'no second Facebook row');
  await add('hello');
  assert.equal(h.els.inlineAssistSiteInputHint.hidden, false, 'says to type a web address');
  assert.equal(h.els.inlineAssistSiteInput.value, 'hello', 'and keeps what was typed');
});

test('the Sites rows are one box each: the choice and a square remove button inside it, the same height', () => {
  const html = new JSDOM(loadExtensionFile('sidepanel.html')).window.document;
  const box = html.querySelector('.inline-assist-sites .inline-assist-site-new');
  assert.ok(box.querySelector('input#inlineAssistSiteInput[type="text"]'), 'a box to type a site in');
  assert.ok(box.querySelector('button#inlineAssistAddTyped'), 'with Add beside it');
  const css = loadExtensionFile('sidepanel.css');
  assert.match(css, /\.inline-assist-site \.branded-select-button \{[^}]*min-height: 34px;/);
  assert.match(css, /\.inline-assist-site-remove \{[^}]*width: 34px;[^}]*height: 34px;[^}]*border: 1px solid/);
});

test('Add this site on a page that is not a website says so and adds nothing', async () => {
  const { h, rows, edits } = await sitesPanel({ tabs: [{ id: 3, url: 'chrome://extensions/', title: 'Extensions' }] });
  await h.fn('addActiveSiteToInlineAssistSites')();
  assert.equal(rows().length, 0);
  assert.equal(edits.length, 0);
  assert.equal(h.els.inlineAssistSitesHint.hidden, false);
});

test('Save writes hidden sites into the settings and thread reading into its own key', async () => {
  const { h, row } = await sitesPanel({ hidden: ['page.example'], contextPrefs: { gmail: 'visible', x: 'draft' } });
  const select = row('x').querySelector('select');
  select.value = 'hidden';
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
  await h.save();
  assert.deepEqual(h.store.hermesInlineAssistHiddenSites, ['page.example', 'x']);
  assert.equal(Object.hasOwn(h.store.hermesBrowserSettings, 'inlineAssistHiddenSites'), false, 'not in the settings record');
  assert.deepEqual(h.store.hermesInlineSiteContextPreferences, { gmail: 'visible' });
});

test('a change from a page follows into the list, after the list\'s own saved changes too', async () => {
  const fresh = await sitesPanel({ hidden: ['page.example'] });
  fresh.h.fn('adoptInlineAssistSitesChange')({ hidden: ['page.example', 'new.example'] });
  assert.deepEqual(fresh.rows().map((item) => item.dataset.site), ['new.example', 'page.example']);
  fresh.h.fn('adoptInlineAssistSitesChange')({ contextPrefs: { reddit: 'draft' } });
  assert.ok(fresh.row('reddit'));

  const edited = await sitesPanel({ hidden: ['page.example'] });
  edited.rows()[0].querySelector('button.inline-assist-site-remove').click();
  await settle();
  edited.h.fn('adoptInlineAssistSitesChange')({ hidden: ['new.example'] });
  assert.deepEqual(edited.rows().map((item) => item.dataset.site), ['new.example']);
});

test('each site’s setting uses the side panel’s branded dropdown, not the browser’s select list', async () => {
  const { row } = await sitesPanel({ contextPrefs: { gmail: 'visible' } });
  const select = row('gmail').querySelector('select');
  assert.ok(select.brandedSelect, 'mounted as a branded select');
  assert.ok(row('gmail').querySelector('.branded-select'), 'the branded button sits in the row');
});
