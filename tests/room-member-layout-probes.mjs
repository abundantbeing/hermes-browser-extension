// Rendered layout guard for the group-chat "Bots in this room" popover and the
// room-member model picker. Catches: overlapping/squeezed name+model+buttons,
// rounded corners (the brand is square), and a picker that opens off-screen.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APPEARANCE_THEMES } from '../extension/lib/appearance-themes.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BUILD = `(() => {
  const p = document.getElementById('roomMemberPopover'); p.hidden = false;
  const list = document.getElementById('roomMemberPopoverList'); list.replaceChildren();
  const mk = (name, model, bound) => {
    const row = document.createElement('div'); row.className = 'room-member-row'; row.tabIndex = 0; row.setAttribute('role', 'listitem');
    const av = document.createElement('span'); av.className = 'room-member-avatar'; av.textContent = name[0];
    const nm = document.createElement('span'); nm.className = 'room-member-name'; nm.textContent = name;
    const md = document.createElement('span'); md.className = 'room-member-model'; md.textContent = model;
    const act = document.createElement('span'); act.className = 'room-member-actions';
    if (bound) { const d = document.createElement('span'); d.className = 'room-member-dot'; act.append(d); const r = document.createElement('button'); r.type = 'button'; r.className = 'room-member-change room-member-reset'; r.textContent = 'Reset to profile default'; act.append(r); }
    const c = document.createElement('button'); c.type = 'button'; c.className = 'room-member-change'; c.textContent = 'Change'; act.append(c);
    row.append(av, nm, md, act); list.append(row);
  };
  mk('Roxas', 'gemini-3.8-flash-high · custom', false);
  mk('Luxord', 'gpt-5.6-luna-max-reasoning · openai-codex', true);
  mk('Riku', 'Unknown', false);
  return true;
})()`;

const MEASURE = `(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
  const pop = document.getElementById('roomMemberPopover'); const pr = box(pop);
  const problems = []; const radii = new Set();
  radii.add(getComputedStyle(pop).borderTopLeftRadius);
  for (const row of pop.querySelectorAll('.room-member-row')) {
    const rr = box(row); radii.add(getComputedStyle(row).borderTopLeftRadius);
    const parts = [...row.querySelectorAll('.room-member-name, .room-member-model, .room-member-change')].map((e) => ({ e, b: box(e), cls: e.className }));
    for (const p of parts) { radii.add(getComputedStyle(p.e).borderTopLeftRadius); if (p.b.r > rr.r + 0.5 || p.b.l < rr.l - 0.5) problems.push('outside row: ' + p.cls); }
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hit(parts[i].b, parts[j].b)) problems.push('overlap: ' + parts[i].cls + ' x ' + parts[j].cls);
    const name = row.querySelector('.room-member-name'); if (name.clientWidth < 40) problems.push('name squeezed: ' + name.clientWidth);
  }
  return { popover: pr, inViewport: pr.t >= 0 && pr.b <= innerHeight && pr.l >= 0 && pr.r <= innerWidth, radii: [...radii], problems };
})()`;

const MENU = `(() => {
  const m = document.getElementById('modelMenu');
  document.body.append(m); m.dataset.selectionTarget = 'room-member'; m.style.removeProperty('top'); m.style.removeProperty('bottom'); m.style.removeProperty('max-height'); m.hidden = false;
  const r = m.getBoundingClientRect(); const cs = getComputedStyle(m);
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, vh: innerHeight, vw: innerWidth, position: cs.position, radius: cs.borderTopLeftRadius };
})()`;

export async function verifyRoomMemberLayout({ client, evidence, qaDir, saveScreenshot }) {
  const outDir = path.join(qaDir, 'room-layout'); await mkdir(outDir, { recursive: true });
  await client.call('Page.bringToFront');
  await client.evaluate(BUILD);
  const results = []; const failures = [];
  for (const theme of APPEARANCE_THEMES.map((t) => t.value)) {
    for (const mode of ['light', 'dark']) {
      await client.evaluate(`(() => { const r = document.documentElement; r.dataset.hermesTheme = ${JSON.stringify(theme)}; r.dataset.hermesMode = ${JSON.stringify(mode)}; r.dataset.hermesColorMode = ${JSON.stringify(mode)}; })()`);
      await pause(40);
      const layout = await client.evaluate(MEASURE);
      const menu = await client.evaluate(MENU);
      const menuOk = menu.top >= 0 && menu.bottom <= menu.vh + 0.5 && menu.left >= 0 && menu.right <= menu.vw + 0.5 && menu.h > 150 && menu.position === 'fixed' && menu.radius === '0px';
      const radiusOk = layout.radii.every((x) => x === '0px');
      const ok = layout.problems.length === 0 && layout.inViewport && menuOk && radiusOk;
      results.push({ theme, mode, ok, layout, menu });
      if (!ok) failures.push({ theme, mode, problems: layout.problems, inViewport: layout.inViewport, radii: layout.radii, menu });
      if (['nous', 'anti-nous'].includes(theme) && mode === 'light') {
        await saveScreenshot(client, path.join(outDir, `${theme}-${mode}-popover.png`));
        await client.evaluate(`document.getElementById('modelMenu').hidden = false`);
      }
      await client.evaluate(`document.getElementById('modelMenu').hidden = true`);
    }
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ results, failures }, null, 2));
  evidence.checks.roomMemberLayoutOk = failures.length === 0;
  return { palettes: results.length, failures };
}
