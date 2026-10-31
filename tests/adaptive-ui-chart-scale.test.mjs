import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A chart value can be a finite number that no axis can hold (1.7e308 rounds its top tick past the largest
// number), and drawing it used to loop forever. The drawing runs in a child process with a time limit, so a
// regression fails this test instead of freezing the test run.
const root = fileURLToPath(new URL('..', import.meta.url));

const script = `
import { JSDOM } from 'jsdom';
globalThis.window = new JSDOM('<!doctype html><html><body></body></html>').window;
const { renderChartSvg } = await import('./extension/lib/adaptive-ui.mjs');
const { renderResponseSafe } = await import('./extension/lib/sanitizer.mjs');
const charts = JSON.parse(process.argv[1]);
const fence = (value) => '\`\`\`hermes-ui\\n' + JSON.stringify(value) + '\\n\`\`\`';
console.log(JSON.stringify(charts.map((chart, index) => ({
  svg: renderChartSvg(chart),
  html: renderResponseSafe(fence({ schema: 'hermes.adaptive-ui', version: 1, blocks: [{ id: 'c' + index, type: 'chart', ...chart }] }), { style: 'vivid' }),
}))));
`;

const chart = (values, kind = 'bar') => ({ kind, title: 'Sizes', labels: values.map((_value, index) => `L${index}`), series: [{ name: 'size', values }], unit: '' });

function drawn(charts) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(charts)], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.error, undefined, `the chart took too long to draw: ${run.error?.message}`);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('numbers no axis can hold are shown as the table, not drawn', () => {
  const extreme = [
    chart([1, 1.7e308]),
    chart([1.7e308, 1.7e308], 'line'),
    chart([-1.7e308, -1]),
    chart([-1.7e308, 1.7e308]),
    chart([-1e308, 0.7e308]),
    chart([5e-324, 5e-324]),
  ];
  const results = drawn(extreme);
  results.forEach((result, index) => {
    const label = JSON.stringify(extreme[index].series[0].values);
    assert.equal(result.svg, '', label);
    assert.doesNotMatch(result.html, /<svg/, label);
    assert.doesNotMatch(result.html, /haui-view-toggle/, `${label}: nothing to toggle`);
    assert.match(result.html, /data-haui-type="chart"/, label);
    assert.match(result.html, /<table class="haui-data-table">/, `${label}: the numbers are still shown`);
    assert.doesNotMatch(result.html, /NaN|Infinity/, label);
  });
});

test('ordinary and large charts are still drawn with an axis', () => {
  const results = drawn([chart([10, 20, 15]), chart([0, 1e15, 2e15]), chart([-3, 4, 0.5], 'line'), chart([0.001, 0.002, 0.0015])]);
  for (const result of results) {
    assert.match(result.svg, /^<svg class="haui-chart-svg"/);
    assert.doesNotMatch(result.svg, /NaN|Infinity/);
    assert.match(result.html, /haui-view-toggle/);
    assert.match(result.html, /haui-chart-canvas/);
  }
});
