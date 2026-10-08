import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function probeEffortColors({ client, qaDir, saveScreenshot, theme = 'anti-nous', mode = 'dark' }) {
  const outDir = path.join(qaDir, 'effort-color'); await mkdir(outDir, { recursive: true });
  await client.evaluate(`(() => { const r = document.documentElement; r.dataset.hermesTheme = ${JSON.stringify(theme)}; r.dataset.hermesMode = ${JSON.stringify(mode)}; r.dataset.hermesColorMode = ${JSON.stringify(mode)}; document.querySelector('[data-effort-view="slider"]')?.click(); })()`);
  await pause(150);
  const report = [];
  for (const level of [2, 4, 5, 6]) {
    await client.evaluate(`(() => { const r = document.querySelector('.effort-control-range'); r.value = '${level}'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await pause(250);
    const data = await client.evaluate(`(() => {
      const root = document.querySelector('.effort-control'); const cs = getComputedStyle(root);
      const fill = getComputedStyle(root.querySelector('.effort-control-fill')).backgroundColor;
      const thumb = getComputedStyle(root.querySelector('.effort-control-range'), '::-webkit-slider-thumb').backgroundColor;
      return { value: root.dataset.effortValue, effortColor: cs.getPropertyValue('--effort-color').trim(), fill, thumb };
    })()`);
    report.push(data);
    const rect = await client.evaluate(`(() => { const r = document.querySelector('.effort-control').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    await saveScreenshot(client, path.join(outDir, `${theme}-${mode}-${data.value}.png`), { clip: rect });
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
