import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function press(client, key) {
  const code = { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39 }[key];
  await client.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
}

async function selectStep(client, index) {
  await client.evaluate(`document.querySelector('#modelOptionsList .effort-control-range').focus()`);
  await press(client, 'Home');
  for (let step = 0; step < index; step += 1) await press(client, 'ArrowRight');
}

async function motionState(client) {
  return client.evaluate(`(() => {
    const control = document.querySelector('#modelOptionsList .effort-control');
    const fill = control.querySelector('.effort-control-fill');
    const running = control.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running');
    const before = getComputedStyle(fill, '::before');
    const after = getComputedStyle(fill, '::after');
    const sparks = control.querySelector('.effort-control-sparks').getBoundingClientRect();
    const filled = fill.getBoundingClientRect();
    return {
      charge: control.dataset.effortCharge,
      running: running.length,
      infinite: running.filter((animation) => animation.effect.getTiming().iterations === Infinity).length,
      chargeAnimation: before.animationName,
      chargeTransform: before.transform,
      flowAnimation: after.animationName,
      flowTransform: after.transform,
      flowDuration: parseFloat(after.animationDuration) * 1000,
      emitterRight: sparks.right,
      filledRight: filled.right,
      visibleParticles: [...control.querySelectorAll('.effort-control-spark')].filter((spark) => getComputedStyle(spark).display !== 'none').length,
    };
  })()`);
}

export async function verifyEffortPolish({ client, evidence, qaDir, saveScreenshot }) {
  const checks = evidence.checks;
  const proof = { themeHover: [], typography: [], motion: {} };
  evidence.polish = proof;
  await client.call('Page.bringToFront');
  await client.evaluate(`document.activeElement?.blur()`);
  for (const theme of ['nous', 'anti-nous']) {
    await client.evaluate(`(() => { const r = document.documentElement; r.dataset.hermesTheme = ${JSON.stringify(theme)}; r.dataset.hermesMode = 'light'; })()`);
    await pause(160);
    for (const option of ['thinking', 'fast']) {
      const point = await client.evaluate(`(() => { const r = document.querySelector('#modelOptionsList [data-toggle="${option}"]').getBoundingClientRect(); return { x: r.x + 15, y: r.y + r.height / 2 }; })()`);
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await pause(160);
      const result = await client.evaluate(`(() => {
        const button = document.querySelector('#modelOptionsList [data-toggle="${option}"]');
        const css = getComputedStyle(button);
        const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d');
        const rgba = (color) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
        const composite = (front, back) => { const a = front[3] / 255; return front.slice(0, 3).map((v, i) => v * a + back[i] * (1 - a)); };
        let background = [255, 255, 255];
        const ancestors = []; for (let node = button; node; node = node.parentElement) ancestors.unshift(node);
        for (const node of ancestors) background = composite(rgba(getComputedStyle(node).backgroundColor), background);
        const foreground = composite(rgba(css.color), background);
        const lum = (color) => color.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const l1 = lum(foreground), l2 = lum(background);
        return { text: button.textContent.trim(), hovered: button.matches(':hover'), color: css.color, background: css.backgroundColor, contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) };
      })()`);
      proof.themeHover.push({ theme, option, ...result });
      await saveScreenshot(client, path.join(qaDir, `${theme}-light-${option}-hover.png`));
    }
  }
  checks.lightThemeToggleHoverReadable = proof.themeHover.every((row) => row.hovered && row.contrast >= 4.5);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });

  for (const profile of ['signature', 'mono', 'system-sans']) {
    await client.evaluate(`(async () => { const { applyAppearancePreferences } = await import(chrome.runtime.getURL('lib/appearance-preferences.mjs')); applyAppearancePreferences(document.documentElement, { fontProfile: ${JSON.stringify(profile)}, textZoomPercent: 100, customFontFamily: '' }); })()`);
    const font = await client.evaluate(`(() => { const s = getComputedStyle(document.querySelector('#modelOptionsList .effort-control-value')); return { size: parseFloat(s.fontSize), family: s.fontFamily, weight: s.fontWeight }; })()`);
    proof.typography.push({ profile, ...font });
  }
  checks.signatureEffortValueSizedSeparately = proof.typography[0].size === 11.5 && proof.typography.slice(1).every((font) => font.size === 13);
  await client.evaluate(`(async () => { const { applyAppearancePreferences } = await import(chrome.runtime.getURL('lib/appearance-preferences.mjs')); applyAppearancePreferences(document.documentElement, { fontProfile: 'signature', textZoomPercent: 100, customFontFamily: '' }); document.documentElement.dataset.hermesTheme = 'mono'; document.documentElement.dataset.hermesMode = 'dark'; })()`);

  proof.tickBounds = await client.evaluate(`(() => { const rail = document.querySelector('#modelOptionsList .effort-control-lane').getBoundingClientRect(); return [...document.querySelectorAll('#modelOptionsList .effort-control-stop')].map((stop) => { const r = stop.getBoundingClientRect(); return { left: r.left, right: r.right, railLeft: rail.left, railRight: rail.right, inside: r.left >= rail.left && r.right <= rail.right }; }); })()`);
  checks.endpointTicksInsideRail = proof.tickBounds.every((stop) => stop.inside);

  // Trusted pointer drag: the preview must not change persisted runtime effort.
  await selectStep(client, 0);
  const start = await client.evaluate(`(async () => { const s = document.querySelector('#modelOptionsList .effort-control-range'); const r = s.getBoundingClientRect(); const settings = (await chrome.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings; return { x: r.left + 7, y: r.top + r.height / 2, endX: r.right - 7, effort: settings.reasoningEffort }; })()`);
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.endX, y: start.y, button: 'left', buttons: 1 });
  proof.dragPreview = await client.evaluate(`(async () => ({ value: document.querySelector('#modelOptionsList .effort-control-range').value, stored: (await chrome.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings.reasoningEffort }))()`);
  checks.trustedDragPreviewDoesNotCommit = proof.dragPreview.value === '6' && proof.dragPreview.stored === start.effort;
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.endX, y: start.y, button: 'left', buttons: 0, clickCount: 1 });
  await pause(100);
  proof.dragReleased = await client.evaluate(`(async () => ({ stored: (await chrome.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings.reasoningEffort, menuOpen: !document.querySelector('#modelMenu').hidden }))()`);
  checks.trustedDragReleaseCommits = proof.dragReleased.stored === 'ultra' && proof.dragReleased.menuOpen;

  proof.effortSelections = [];
  for (const [step, value] of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].entries()) {
    await selectStep(client, step);
    await pause(180);
    const selection = await client.evaluate(`(() => { const c = document.querySelector('#modelOptionsList .effort-control'); return { value: c.dataset.effortValue, releaseNodes: c.querySelectorAll('.effort-control-release, .effort-control-release-particle').length, particleAnimations: c.querySelector('.effort-control-sparks').getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length }; })()`);
    const motion = await motionState(client);
    proof.effortSelections.push({ expected: value, ...selection, infinite: motion.infinite, flow: motion.flowAnimation });
  }
  checks.noIncrementalReleaseParticles = proof.effortSelections.every((row) => row.value === row.expected && row.releaseNodes === 0);
  checks.lowerEffortsHaveNoParticleAnimations = proof.effortSelections.slice(0, 5).every((row) => row.particleAnimations === 0 && row.infinite === 0 && row.flow === 'none');
  await selectStep(client, 3);
  await client.evaluate(`document.activeElement?.blur()`);
  await saveScreenshot(client, path.join(qaDir, 'high-without-release-particles.png'));

  for (const [name, step] of [['max', 5], ['ultra', 6]]) {
    await selectStep(client, step);
    await pause(4300);
    const first = await motionState(client);
    await pause(250);
    const second = await motionState(client);
    proof.motion[name] = { first, second };
    checks[`${name}ContinuesAnimating`] = first.infinite > 0 && second.infinite > 0;
    checks[`${name}BarItselfAnimates`] = first.chargeAnimation === 'effort-bar-charge' && first.flowAnimation === 'effort-bar-flow'
      && (first.chargeTransform !== second.chargeTransform || first.flowTransform !== second.flowTransform);
    if (name === 'max') checks.maxParticlesStayInsideFill = second.emitterRight <= second.filledRight + 0.5;
    await client.evaluate(`document.activeElement?.blur()`);
    await saveScreenshot(client, path.join(qaDir, `${name}-polished.png`));
    const frameDir = path.join(qaDir, `${name}-frames`);
    await mkdir(frameDir, { recursive: true });
    const rect = await client.evaluate(`(() => { const r = document.querySelector('#modelOptionsList').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const timeline = [];
    for (let frame = 0; frame < 36; frame += 1) {
      const file = `${String(frame).padStart(3, '0')}.png`;
      timeline.push({ file, capturedAt: Date.now() });
      await saveScreenshot(client, path.join(frameDir, file), { captureBeyondViewport: true, clip: rect });
      await pause(75);
    }
    await writeFile(path.join(frameDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  }
  checks.ultraCalmerButDenser = proof.motion.ultra.second.flowDuration >= 2000 && proof.motion.ultra.second.visibleParticles > proof.motion.max.second.visibleParticles;

  await client.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  proof.reducedMotion = await motionState(client);
  checks.reducedMotionStopsAnimations = proof.reducedMotion.infinite === 0 && proof.reducedMotion.chargeAnimation === 'none';
  await client.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await client.evaluate(`document.querySelector('#modelMenuCloseButton').click()`);
  proof.closed = await client.evaluate(`(() => ({ hidden: document.querySelector('#modelMenu').hidden, running: document.querySelector('#modelOptionsList .effort-control').getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length }))()`);
  checks.closedMenuStopsAnimations = proof.closed.hidden && proof.closed.running === 0;
  await client.evaluate(`document.querySelector('#modelMenuButton').click()`);

  // Actual model-target switch: Assist must update its own effort, not Chat's.
  const chatEffort = await client.evaluate(`(async () => (await chrome.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings.reasoningEffort)()`);
  await client.evaluate(`document.querySelector('#modelMenuCloseButton').click(); document.querySelector('#settingsButton').click()`);
  await client.evaluate(`document.querySelector('[data-settings-category="assist"]')?.click(); document.querySelector('#inlineAssistModelButton').click()`);
  await pause(150);
  await selectStep(client, 1);
  proof.assistIsolation = await client.evaluate(`(async () => { const settings = (await chrome.storage.local.get('hermesBrowserSettings')).hermesBrowserSettings; return { chat: settings.reasoningEffort, assist: settings.inlineAssistReasoningEffort }; })()`);
  checks.assistDoesNotMutateChat = proof.assistIsolation.chat === chatEffort && proof.assistIsolation.assist === 'low';
  await client.evaluate(`document.querySelector('#modelMenuCloseButton').click(); document.querySelector('#closeSettingsButton').click(); document.querySelector('#modelMenuButton').click()`);
  assert.ok(evidence.polish, 'real browser polish evidence was collected');
}
