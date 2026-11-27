// Наглядная проверка: рисуемое окно и реальный рез совпадают.
// Настройки со скриншота: X, 28.5 мм, 1°, окно 114×100, сдвиг -46.
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
  st.planePos = 28.5;
  st.planeAngle = 1;
  st.profileShape = 'flat';
  st.stepEnabled = true;
  st.pinsEnabled = false;
  st.tongueEnabled = false;
  st.cutAreaEnabled = true;
  st.cutWidth = 114;
  st.cutHeight = 100;
  st.cutOffsetU = -46;
  st.cutOffsetV = 0;
});
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, 'b17-window-before.png') });

// Разнести, чтобы видно было, что отрезано.
await page.evaluate(() => {
  const s = document.getElementById('explode');
  s.value = '70';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  window.__RAZREZ__.state.explode = 70;
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'b17-window-after.png') });

const data = await page.evaluate(() => ({
  parts: window.__RAZREZ__.parts().map((p) => ({
    label: p.label,
    vol: +(p.volume / 1000).toFixed(1),
    y: [+p.bboxMin[1].toFixed(1), +p.bboxMax[1].toFixed(1)],
  })),
  warnings: window.__RAZREZ__.stats()[0]?.warnings ?? [],
}));
console.log(JSON.stringify(data));
await browser.close();
