import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as helpers from '../extension/lib/subagent-stack.mjs';

for (const surface of ['sidepanel', 'app']) {
  test(`${surface}: completed rows leave and rerenders preserve log scroll`, () => {
    const dom = new JSDOM('<section id="stack"><button id="toggle"></button><span id="summary"></span><ol id="list"></ol><div id="detail"></div></section>');
    const document = dom.window.document;
    const els = Object.fromEntries(Object.entries({ subagentStack: 'stack', subagentStackToggle: 'toggle', subagentStackSummary: 'summary', subagentStackList: 'list', subagentStackDetail: 'detail' }).map(([key, id]) => [key, document.getElementById(id)]));
    const items = [{ id: 'done', status: 'completed', goal: 'Finished', startedAt: 1 }, { id: 'live', status: 'running', goal: 'Working', startedAt: 1, stream: [{ text: 'log' }] }];
    const source = readFileSync(new URL(`../extension/${surface}.js`, import.meta.url), 'utf8');
    const start = source.indexOf('function renderSubagentStack()');
    const renderer = source.slice(start, source.indexOf('\nasync function captureTaskToolEvent', start));
    // Exercise the actual renderer in an isolated DOM without booting gateway connections.
    // eslint-disable-next-line no-new-func
    const factory = new Function('document', 'els', 'items', 'helpers', `
      const { activeSubagentView, subagentStackSummary, formatSubagentElapsed, SUBAGENT_STEER_ICON, SUBAGENT_STOP_ICON } = helpers;
      let subagentSelectedId = 'live', subagentExpanded = true, subagentControlBusy = false, subagentControlError = '', subagentSteerDraft = '';
      const currentSubagentItems = () => items;
      const ensureSubagentTimer = () => {};
      const runSelectedSubagentControl = () => {};
      ${renderer}
      return renderSubagentStack;
    `);
    const render = factory(document, els, items, helpers);
    render();
    assert.equal(els.subagentStackList.children.length, 1);
    assert.equal(els.subagentStackList.firstChild.dataset.subagentId, 'live');
    els.subagentStackList.scrollTop = 25;
    const stream = els.subagentStackDetail.querySelector('ol');
    stream.scrollTop = 45;
    stream.scrollLeft = 30;
    render();
    assert.equal(els.subagentStackList.scrollTop, 25);
    assert.equal(els.subagentStackDetail.querySelector('ol').scrollTop, 45);
    assert.equal(els.subagentStackDetail.querySelector('ol').scrollLeft, 30);
    items[1].status = 'completed';
    render();
    assert.equal(els.subagentStack.hidden, true);
    assert.equal(els.subagentStackList.children.length, 0);
    dom.window.close();
  });
}
