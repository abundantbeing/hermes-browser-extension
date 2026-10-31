// Review finding 7: the Projects tab fetches when the drawer is open, not on every roster tick behind a closed drawer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

function harness({ drawerHidden }) {
  const calls = [];
  const controller = {
    state: { view: 'list', query: '', list: { status: 'idle' } },
    resolve() {},
    availability: () => ({ available: true }),
  };
  const context = vm.createContext({
    getProjectsController: () => controller,
    projectsActivating: false,
    activateProjectsTab: async () => { calls.push('activate'); },
    t: (key) => key,
    getLocale: () => 'en',
    renderProjectsPanel: () => calls.push('render'),
    els: {
      sessionMenu: { hidden: drawerHidden },
      sessionSearchInput: { hidden: false, placeholder: '', value: '' },
      projectsFooter: { hidden: false },
      newProjectButton: { disabled: false },
    },
  });
  vm.runInContext(functionSource('renderProjectsTab'), context);
  return { context, calls };
}

test('a roster tick behind a closed drawer does not start a projects fetch', () => {
  const h = harness({ drawerHidden: true });
  h.context.renderProjectsTab();
  assert.equal(h.calls.includes('activate'), false);
});

test('an open drawer on an idle Projects tab does fetch', () => {
  const h = harness({ drawerHidden: false });
  h.context.renderProjectsTab();
  assert.equal(h.calls.includes('activate'), true);
});
