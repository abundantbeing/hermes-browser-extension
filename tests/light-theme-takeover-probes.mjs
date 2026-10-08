import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APPEARANCE_THEMES } from '../extension/lib/appearance-themes.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const provider = '#modelProviderList .model-provider-option:not(.selected)';
const selectedProvider = '#modelProviderList .model-provider-option.selected';
const model = '#modelMenuList .model-option:not(.selected)';
const selectedModel = '#modelMenuList .model-option.selected';
const effort = '#modelOptionsList .model-effort-option:not(.selected)';
const selectedEffort = '#modelOptionsList .model-effort-option.selected';

async function setPalette(client, theme, mode) {
  await client.evaluate(`(() => { const r = document.documentElement; r.dataset.hermesTheme = ${JSON.stringify(theme)}; r.dataset.hermesMode = ${JSON.stringify(mode)}; r.dataset.hermesColorMode = ${JSON.stringify(mode)}; })()`);
  await pause(170);
}

async function measureRow(client, selector, state, labels) {
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await client.evaluate(`document.activeElement?.blur()`);
  if (state.includes('focus')) {
    await client.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus({ focusVisible: true })`);
    const focused = await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).matches(':focus-visible')`);
    assert.ok(focused, `${selector} must have real keyboard focus styling`);
  }
  if (state.includes('hover')) {
    const point = await client.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  }
  await pause(150);
  return client.evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    const rgba = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const blend = (front, back) => { const a = front[3] / 255; return front.slice(0, 3).map((v, i) => v * a + back[i] * (1 - a)); };
    const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const items = ${JSON.stringify(labels)}.map((selector) => {
      const el = row.querySelector(selector); if (!el?.textContent.trim()) return null;
      const ancestors = []; for (let e = el; e; e = e.parentElement) ancestors.unshift(e);
      let bg = [255, 255, 255], opacity = 1;
      for (const e of ancestors) { const s = getComputedStyle(e); bg = blend(rgba(s.backgroundColor), bg); opacity *= parseFloat(s.opacity); }
      const s = getComputedStyle(el), ink = rgba(s.color); ink[3] *= opacity;
      const fg = blend(ink, bg), a = luminance(fg), b = luminance(bg);
      return { text: el.textContent.trim(), color: s.color, background: bg, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), visible: el.getClientRects().length > 0 };
    }).filter(Boolean);
    return { hovered: row.matches(':hover'), focused: row.matches(':focus-visible'), items };
  })()`);
}

async function captureElement(client, selector, file, saveScreenshot) {
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
  await pause(100);
  const rect = await client.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  assert.ok(rect.width > 0 && rect.height > 0, `${selector} must be visible`);
  await saveScreenshot(client, file, { captureBeyondViewport: true, clip: rect });
  return client.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(e), r = e.getBoundingClientRect(); return { width: r.width, height: r.height, color: s.color, background: s.backgroundImage, font: s.font, border: s.borderTopColor }; })()`);
}

export async function verifyLightThemeTakeover({ client, evidence, qaDir, saveScreenshot, phase = 'after' }) {
  const outDir = path.join(qaDir, 'theme-takeover', phase);
  await mkdir(outDir, { recursive: true });
  const proof = { phase, palettes: [], hero: [] };
  evidence.themeTakeover = proof;
  const themes = phase === 'before' ? ['nous', 'anti-nous'] : APPEARANCE_THEMES.map((theme) => theme.value);
  assert.equal(new Set(themes).size, themes.length);
  if (phase !== 'before') assert.equal(themes.length, 12);
  await client.call('Page.bringToFront');
  await client.evaluate(`document.querySelector('#modelMenuButton').click()`);
  if (await client.evaluate(`document.querySelector('#modelMenu').hidden`)) await client.evaluate(`document.querySelector('#modelMenuButton').click()`);
  await client.evaluate(`document.querySelector('[data-effort-view="buttons"]').click()`);
  await pause(80);
  const cases = [
    ['provider-hover', provider, 'hover', ['.model-provider-name', '.model-provider-count']],
    ['provider-focus', provider, 'focus', ['.model-provider-name', '.model-provider-count']],
    ['selected-provider-hover', selectedProvider, 'hover', ['.model-provider-name', '.model-provider-count']],
    ['model-hover', model, 'hover', ['.model-option-name', '.model-option-meta']],
    ['model-focus', model, 'focus', ['.model-option-name', '.model-option-meta']],
    ['model-focus-hover', model, 'focus-hover', ['.model-option-name', '.model-option-meta']],
    ['selected-model-focus', selectedModel, 'focus', ['.model-option-name', '.model-option-meta']],
    ['composer-model-hover', '#modelMenuButton', 'hover', ['#currentModelName', '#currentModelEffort']],
    ['composer-context-hover', '#contextBarButton', 'hover', ['#contextCompactLabel', '#contextPercentLabel']],
    ['effort-hover', effort, 'hover', ['span', 'strong']],
    ['effort-focus', effort, 'focus', ['span', 'strong']],
    ['selected-effort-focus', selectedEffort, 'focus', ['span', 'strong']],
  ];
  for (const theme of themes) {
    await setPalette(client, theme, 'light');
    const records = [];
    for (const [name, selector, state, labels] of cases) {
      const result = await measureRow(client, selector, state, labels);
      records.push({ name, ...result });
      if (['nous', 'anti-nous'].includes(theme) && ['provider-hover', 'model-focus', 'effort-focus'].includes(name)) {
        await saveScreenshot(client, path.join(outDir, `${theme}-light-${name}.png`));
      }
    }
    proof.palettes.push({ theme, records });
    await writeFile(path.join(outDir, 'picker.json'), JSON.stringify(proof.palettes, null, 2));
  }
  const failures = proof.palettes.flatMap(({ theme, records }) => records.flatMap((record) => record.items.filter((item) => !item.visible || item.contrast < 4.5).map((item) => ({ theme, state: record.name, ...item }))));
  proof.failures = failures;
  if (phase !== 'before') {
    evidence.checks.allLightPickerStatesReadable = failures.length === 0;
    evidence.checks.allLightThemesChecked = proof.palettes.length === 12 && proof.palettes.every((palette) => palette.records.length === cases.length);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await client.evaluate(`document.activeElement?.blur(); document.querySelector('[data-effort-view="slider"]').click(); document.querySelector('#modelMenuCloseButton').click()`);
  await client.evaluate(`(async () => { const art = 'assets/img/sidecar-art/automation.webp'; await new Promise((resolve, reject) => { const i = new Image(); i.onload = resolve; i.onerror = reject; i.src = art; }); document.documentElement.style.setProperty('--sidecar-art', 'url("' + art + '")'); await document.fonts.ready; })()`);
  for (const theme of ['nous', 'anti-nous']) {
    for (const mode of ['light', 'dark']) {
      await setPalette(client, theme, mode);
      const hero = await captureElement(client, '#browserIntroHero', path.join(outDir, `${theme}-${mode}-hero.png`), saveScreenshot);
      await saveScreenshot(client, path.join(outDir, `${theme}-${mode}-panel.png`));
      await client.evaluate(`document.querySelector('#settingsButton').click(); document.querySelector('#settingsBackButton')?.click()`);
      await pause(150);
      const banner = await captureElement(client, '.release-sidecar', path.join(outDir, `${theme}-${mode}-settings-banner.png`), saveScreenshot);
      proof.hero.push({ theme, mode, hero, banner });
      await client.evaluate(`document.querySelector('#closeSettingsButton').click()`);
    }
  }
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(proof, null, 2));
  await setPalette(client, 'mono', 'dark');
  await client.evaluate(`document.querySelector('#modelMenuButton').click()`);
  if (phase !== 'before') assert.deepEqual(failures, [], 'light picker states must keep readable labels, metadata, counts and checkmarks');
}
