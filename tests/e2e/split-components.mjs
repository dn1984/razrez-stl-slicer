// Сценарий пользователя: рез по X (размах) мимо центра.
// Ожидание: отрезанные куски (крыло, стабилизатор) — ОТДЕЛЬНЫЕ детали.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'tests/e2e/out');
mkdirSync(out, { recursive: true });
const file = readFileSync('C:/Users/Ingener/Downloads/B-17F_Final.stl');

const browser = await chromium.launch({
  executablePath: 'C:/Users/Ingener/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`file:///${path.join(root, 'dist/index.html').replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60000 });
const chooser = page.waitForEvent('filechooser');
await page.click('#drop');
await (await chooser).setFiles({ name: 'B-17F_Final.stl', mimeType: 'model/stl', buffer: file });
await page.waitForFunction(() => Boolean(window.__RAZREZ__.state.model), null, { timeout: 120000 });

await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'x';
  st.planePos = -15.1;
  st.planeAngle = 0;
  st.cutAreaEnabled = false;
  st.extraEnabled = false;
  st.stepEnabled = false;
});
await page.evaluate(() => window.__RAZREZ__.refresh());
await page.waitForTimeout(600);
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(2500);

const parts = await page.evaluate(() =>
  window.__RAZREZ__.parts().map((p) => ({
    label: p.label,
    cm3: +(p.volume / 1000).toFixed(1),
    x: [+p.bboxMin[0].toFixed(0), +p.bboxMax[0].toFixed(0)],
  })),
);
console.log('частей:', parts.length);
for (const p of parts) console.log(' ', p.label, p.cm3, 'см³  x[' + p.x.join('; ') + ']');

await page.evaluate(() => {
  const s = document.getElementById('explode');
  s.value = '40';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  window.__RAZREZ__.state.explode = 40;
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'split-components.png') });

const ok = parts.length >= 3;
console.log(ok ? 'OK: несвязанные куски стали отдельными частями' : 'ПРОВАЛ: куски всё ещё слиты');
await browser.close();
process.exit(ok ? 0 : 1);
