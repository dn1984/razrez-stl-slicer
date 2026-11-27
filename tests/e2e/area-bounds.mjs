// Воспроизведение настроек со скриншота и вывод того, что попадает в окно.
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

// Второй рез как на скриншоте: X, 33.3 мм, окно 100×126, сдвиг (-42, -8).
await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'x';
  st.planePos = 28.5;
  st.planeAngle = 0;
  st.cutAreaEnabled = true;
  st.cutWidth = 100;
  st.cutHeight = 100;
  st.cutOffsetU = -39;
  st.cutOffsetV = 0;
  st.extraEnabled = true;
  st.extraAxis = 'x';
  st.extraPos = 33.3;
  st.extraAngle = 0;
  st.extraAreaEnabled = true;
  st.extraWidth = 100;
  st.extraHeight = 126;
  st.extraOffsetU = -42;
  st.extraOffsetV = -8;
});
await page.evaluate(() => window.__RAZREZ__.refresh());
await page.waitForTimeout(1200);
const text = await page.evaluate(() => document.getElementById('cut-area-bounds')?.textContent?.replace(/\s+/g, ' ').trim());
console.log('подсказка:', text);

// Проверим, что окно реально накрывает фюзеляж: модель по Y.
const model = await page.evaluate(() => ({
  min: window.__RAZREZ__.state.model.bboxMin,
  max: window.__RAZREZ__.state.model.bboxMax,
}));
console.log('габарит модели:', JSON.stringify(model));
await page.screenshot({ path: path.join(out, 'area-bounds.png') });
await browser.close();
