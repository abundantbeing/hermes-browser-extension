import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const effortCss = readFileSync(new URL('../extension/lib/effort-control.css', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('model option hover pairs the visible label with a compatible background', () => {
  const rule = panelCss.match(/\.model-menu \.model-toggle-option:hover,[\s\S]*?\{([^}]+)\}/)?.[1] || '';
  assert.ok(/background:\s*rgba\(var\(--hermes-fg-rgb\),\s*0\.0[68]\)/.test(rule), 'hover must not inherit the inverse primary background under a foreground-colored label');
  assert.ok(/color:\s*var\(--hermes-fg\)/.test(rule));
});

test('only the signature font uses a smaller effort value', () => {
  const rule = effortCss.match(/html\[data-hermes-font-profile="signature"\] \.effort-control-value\s*\{([^}]+)\}/)?.[1] || '';
  assert.ok(/font-size:\s*calc\(11\.5px \* var\(--hermes-text-zoom/.test(rule), 'signature effort labels have a bounded font-specific size');
  assert.ok(/\.effort-control-value\s*\{\s*font-size:\s*calc\(13px/.test(effortCss), 'other fonts retain their original size');
});

test('endpoint ticks are inset rather than straddling the rail edge', () => {
  const rule = effortCss.match(/\.effort-control-stop\s*\{([^}]+)\}/)?.[1] || '';
  assert.ok(/left:\s*clamp\(2px,\s*var\(--effort-stop\),\s*calc\(100% - 2px\)\)/.test(rule));
});

test('spark emitter width is bounded by the selected filled track', () => {
  const rule = effortCss.match(/\.effort-control-sparks\s*\{([^}]+)\}/)?.[1] || '';
  assert.ok(/width:\s*calc\(\(100% - 16px\) \* var\(--effort-progress\)\)/.test(rule), 'Max must leave the unfilled Ultra segment free of particles');
  assert.ok(/overflow:\s*hidden/.test(rule), 'horizontal particle drift cannot escape the emitter');
});

test('Ultra is denser rather than sub-second frantic motion', () => {
  const rule = [...effortCss.matchAll(/\.effort-control\[data-effort-charge="ultra"\]\s*\{([^}]+)\}/g)].at(-1)?.[1] || '';
  const duration = Number(rule.match(/--flow-duration:\s*(\d+)ms/)?.[1] || 0);
  assert.ok(duration >= 2000, `Ultra flow must take at least two seconds, received ${duration}ms`);
  assert.ok(/animation:\s*effort-ultra-spark\s*3\d{3}ms/.test(effortCss), 'Ultra particles drift over seconds instead of firing upward in under one second');
});
