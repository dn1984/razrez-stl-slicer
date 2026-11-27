// Объёмная рамка окна реза: снимок с разных сторон.
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

// Окно вокруг крыла — маленькое, не задевает фюзеляж.
await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'x';
  st.planePos = 28.5;
  st.planeAngle = 0;
  st.cutAreaEnabled = true;
  st.cutWidth = 72;
  st.cutHeight = 120;
  st.cutOffsetU = 52;
  st.cutOffsetV = -10;
  st.extraEnabled = false;
});
await page.evaluate(() => window.__RAZREZ__.refresh());
await page.waitForTimeout(1000);

// Вид сбоку-сверху, чтобы была видна глубина рамки.
await page.mouse.move(820, 450);
await page.mouse.down();
await page.mouse.move(1010, 560, { steps: 16 });
await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'window-box.png') });

const info = await page.evaluate(() => document.getElementById('cut-area-bounds')?.textContent?.replace(/\s+/g, ' ').trim());
console.log('границы:', info);
await browser.close();
