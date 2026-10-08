// Exhaustive hover/focus contrast guard.
//
// ROOT CAUSE this guards against: sidepanel.css has a global `button:hover`
// rule that fills EVERY button with --hermes-primary-bg. Any component rule that
// then overrides only one half of the pair (e.g. `.x:hover { color: var(--hermes-fg) }`)
// leaves foreground and fill from different families. On Nous light both are the
// same blue, on Anti-Nous light the same red, so the label simply vanishes.
//
// Reading CSS can not prove a pair is readable. Only the rendered result can.
// So this walks every interactive control in every surface, in EVERY theme and
// BOTH color modes, hovers/focuses it for real, and measures label contrast.
// Any label below HARD_MIN fails. New buttons/features are covered automatically
// because the controls are discovered from the DOM, not listed by name.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APPEARANCE_THEMES } from '../extension/lib/appearance-themes.mjs';

export const HARD_MIN = 3;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors the markup the renderers in sidepanel.js produce, so rows exist
// without needing a live gateway roster. Keep in sync with renderBotModeRoster,
// renderBotModeGroupChats, renderPetGrid and renderNewGroupBotList.
const FIXTURES = `(() => {
  const el = (tag, cls, text, attrs = {}) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const botRow = (name, selected) => {
    const b = el('button', 'bot-mode-row', '', { type: 'button', role: 'option', 'aria-selected': String(selected), 'data-guard-fixture': '1' });
    const avatar = el('span', 'bot-mode-avatar'); avatar.append(el('span', 'bot-mode-avatar-fallback', name[0]));
    const copy = el('span', 'bot-mode-row-copy'); const nr = el('span', 'bot-mode-row-name-row');
    nr.append(el('strong', '', name), el('span', 'bot-mode-row-stamp', '2m ago'));
    copy.append(nr, el('span', 'bot-mode-row-preview', 'Ready for operations.'));
    const st = el('span', 'bot-mode-row-state'); st.append(el('i', 'presence-dot'));
    b.append(avatar, copy, st); return b;
  };
  const groupRow = (name) => {
    const d = el('div', 'bot-mode-row group-row', '', { role: 'option', 'aria-selected': 'false', tabindex: '0', 'data-guard-fixture': '1' });
    const fs = el('span', 'face-stack'); const f = el('span'); f.style.setProperty('--i', 0); f.append(el('span', 'bot-mode-avatar-fallback', 'A')); fs.append(f);
    const copy = el('span', 'bot-mode-row-copy'); copy.append(el('strong', '', name), el('span', 'bot-mode-row-meta', '3 members'), el('span', 'bot-mode-row-preview', 'Synced group projection.'));
    const act = el('span', 'group-row-actions'); const top = el('span', 'group-row-top'); top.append(el('span', 'group-row-stamp', '5m ago'));
    const bot = el('span', 'group-row-bottom'); const gs = el('button', 'group-settings-btn', '', { type: 'button', 'aria-label': 'Group settings' }); gs.textContent = '*';
    bot.append(el('span', 'room-pill', 'Synced room'), gs); act.append(top, bot); d.append(fs, copy, act); return d;
  };
  const roster = document.getElementById('botModeRoster'); const groups = document.getElementById('botModeGroupList');
  if (roster) { roster.append(botRow('Alpha', true), botRow('Beta', false), botRow('Gamma', false)); }
  if (groups) { groups.append(groupRow('Launch room'), groupRow('Ops room')); }
  const grid = document.getElementById('botModePetGrid');
  if (grid) for (const n of ['Cat', 'Fox']) { const t = el('button', 'bot-mode-pet-tile', '', { type: 'button', role: 'option', 'aria-selected': 'false', 'data-guard-fixture': '1' }); t.append(el('span', 'bot-mode-pet-thumb'), el('span', 'bot-mode-pet-name', n)); grid.append(t); }
  const ng = document.getElementById('newGroupBotList');
  if (ng) for (const n of ['Alpha', 'Beta']) { const l = el('label', 'new-group-bot-row', '', { 'data-guard-fixture': '1' }); const av = el('span', 'bot-mode-avatar bot-mode-avatar-mini'); const c = el('span', 'new-group-bot-copy'); c.append(el('strong', '', n), el('span', '', '@' + n.toLowerCase())); const cb = el('input'); cb.type = 'checkbox'; l.append(av, c, cb); ng.append(l); }
  return true;
})()`;

const SCOPES = [
  { name: 'bot-mode-agents', open: `(() => { const p = document.getElementById('botModePanel'); p.hidden = false; document.getElementById('botModeViewAgents')?.click(); return '#botModePanel'; })()` },
  { name: 'bot-mode-groups', open: `(() => { const p = document.getElementById('botModePanel'); p.hidden = false; document.getElementById('botModeViewGroups')?.click(); return '#botModePanel'; })()` },
  { name: 'bot-mode-sheet', open: `(() => { const p = document.getElementById('botModeSheet'); if (!p) return null; p.hidden = false; return '#botModeSheet'; })()` },
  { name: 'pet-picker', open: `(() => { const d = document.getElementById('botModePetPicker'); if (!d) return null; document.getElementById('botModeSheet').hidden = false; d.open = true; return '#botModePetPicker'; })()` },
  { name: 'new-group-modal', open: `(() => { const p = document.getElementById('newGroupModal'); if (!p) return null; p.hidden = false; return '#newGroupModal'; })()` },
  { name: 'group-settings-modal', open: `(() => { const p = document.getElementById('groupSettingsModal'); if (!p) return null; p.hidden = false; return '#groupSettingsModal'; })()` },
  { name: 'settings-home', open: `(() => { document.getElementById('settingsButton')?.click(); return '#settingsDialog'; })()` },
  { name: 'composer-thread-actions', open: `(() => { const a = document.querySelector('.composer-actions'); if (!a) return null; a.querySelectorAll('.bot-mode-threads-button, .bot-mode-new-thread-button').forEach((b) => { b.hidden = false; b.disabled = false; }); return '.composer-actions'; })()` },
  { name: 'composer-dock', open: `(() => '.desktop-bar')()` },
  { name: 'room-popover', open: `(() => { const p = document.getElementById('roomMemberPopover'); if (!p) return null; p.hidden = false; const l = document.getElementById('roomMemberPopoverList'); const row = document.createElement('div'); row.className = 'room-member-row'; row.tabIndex = 0; row.setAttribute('data-guard-fixture', '1'); row.innerHTML = '<span class="room-member-avatar"></span><span class="room-member-name">Alpha</span><span class="room-member-model">model · provider</span><span class="room-member-actions"><button type="button" class="room-member-change room-member-reset">Reset to profile default</button><button type="button" class="room-member-change">Change</button></span>'; l.append(row); return '#roomMemberPopover'; })()` },
];

const COLLECT = (rootSelector) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSelector)});
  if (!root) return [];
  const sel = 'button, [role=option], [role=tab], summary, a[href], label.new-group-bot-row, .room-member-row, .settings-category-card, .branded-select-option';
  const seen = new Set(); const out = [];
  for (const el of root.querySelectorAll(sel)) {
    if (seen.has(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    seen.add(el); out.push(el);
  }
  window.__guardTargets = out;
  return out.map((el, i) => ({ i, id: el.id ? '#' + el.id : '', cls: String(el.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 3).join('.'), tag: el.tagName.toLowerCase() }));
})()`;

const MEASURE = (index) => `(() => {
  const el = window.__guardTargets[${index}];
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
  const blend = (front, back) => { const a = front[3] / 255; return front.slice(0, 3).map((v, i) => v * a + back[i] * (1 - a)); };
  const lum = (rgb) => rgb.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const leaves = []; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (n.textContent.trim() && n.parentElement) leaves.push(n.parentElement); }
  if (!leaves.length && el.matches('input[type=checkbox]')) return { hovered: el.matches(':hover'), items: [] };
  const items = [];
  for (const leaf of new Set(leaves)) {
    const cs0 = getComputedStyle(leaf);
    if (cs0.visibility === 'hidden' || cs0.display === 'none' || leaf.getClientRects().length === 0) continue;
    const chain = []; for (let e = leaf; e; e = e.parentElement) chain.unshift(e);
    let bg = [255, 255, 255]; let opacity = 1;
    for (const e of chain) { const s = getComputedStyle(e); bg = blend(rgba(s.backgroundColor), bg); opacity *= parseFloat(s.opacity); }
    const ink = rgba(cs0.color); ink[3] *= opacity;
    const fg = blend(ink, bg); const a = lum(fg), b = lum(bg);
    items.push({ text: leaf.textContent.trim().slice(0, 28), color: cs0.color, bg: bg.map(Math.round), contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
  }
  const r = el.getBoundingClientRect();
  return { hovered: el.matches(':hover'), focused: el.matches(':focus-visible'), x: r.x + r.width / 2, y: r.y + r.height / 2, items };
})()`;

async function setPalette(client, theme, mode) {
  await client.evaluate(`(() => { const r = document.documentElement; r.dataset.hermesTheme = ${JSON.stringify(theme)}; r.dataset.hermesMode = ${JSON.stringify(mode)}; r.dataset.hermesColorMode = ${JSON.stringify(mode)}; })()`);
  await pause(60);
}

export async function verifyHoverContrastEverywhere({ client, evidence, qaDir, saveScreenshot }) {
  const outDir = path.join(qaDir, 'hover-guard');
  await mkdir(outDir, { recursive: true });
  await client.call('Page.bringToFront');
  await client.evaluate(`(() => { const s = document.createElement('style'); s.id = 'guard-no-motion'; s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.append(s); return true; })()`);
  await client.evaluate(FIXTURES);
  const themes = APPEARANCE_THEMES.map((theme) => theme.value);
  const report = { themes: themes.length, palettes: 0, controls: 0, measurements: 0, skipped: 0, failures: [], warnings: 0 };
  const shots = new Set();
  for (const scope of SCOPES) {
    const rootSelector = await client.evaluate(scope.open);
    if (!rootSelector) { report.skipped += 1; continue; }
    await pause(80);
    for (const theme of themes) {
      for (const mode of ['light', 'dark']) {
        await setPalette(client, theme, mode);
        report.palettes += 1;
        const targets = await client.evaluate(COLLECT(rootSelector));
        report.controls += targets.length;
        for (const target of targets) {
          for (const state of ['hover', 'focus']) {
            await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
            await client.evaluate(`document.activeElement?.blur?.()`);
            const pre = await client.evaluate(`(() => { const el = window.__guardTargets[${target.i}]; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: (() => { const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!t && (t === el || el.contains(t)); })() }; })()`);
            if (state === 'hover') {
              if (!pre.top) { report.skipped += 1; continue; }
              await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pre.x, y: pre.y });
            } else {
              const ok = await client.evaluate(`(() => { const el = window.__guardTargets[${target.i}]; el.focus({ focusVisible: true }); return el.matches(':focus-visible'); })()`);
              if (!ok) { report.skipped += 1; continue; }
            }
            await pause(25);
            const m = await client.evaluate(MEASURE(target.i));
            if (state === 'hover' && !m.hovered) { report.skipped += 1; continue; }
            for (const item of m.items) {
              report.measurements += 1;
              if (item.contrast < 4.5) report.warnings += 1;
              if (item.contrast < HARD_MIN) {
                const record = { scope: scope.name, theme, mode, state, control: `${target.tag}${target.id}.${target.cls}`, text: item.text, contrast: Number(item.contrast.toFixed(2)), color: item.color, bg: item.bg };
                report.failures.push(record);
                const key = `${scope.name}-${theme}-${mode}-${state}-${target.i}`;
                if (shots.size < 8 && !shots.has(key)) { shots.add(key); await saveScreenshot(client, path.join(outDir, `FAIL-${key}.png`)); }
              }
            }
          }
        }
      }
    }
    await client.evaluate(`(() => { document.activeElement?.blur?.(); for (const id of ['botModePanel','botModeSheet','newGroupModal','groupSettingsModal','roomMemberPopover']) { const n = document.getElementById(id); if (n) n.hidden = true; } document.getElementById('closeSettingsButton')?.click(); document.querySelectorAll('[data-guard-fixture]').forEach((n) => { if (n.classList.contains('room-member-row')) n.remove(); }); return true; })()`);
  }
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  evidence.hoverGuard = { ...report, failures: report.failures.length };
  evidence.checks.hoverFocusReadableEverywhere = report.failures.length === 0 && report.controls > 0;
  return report;
}
