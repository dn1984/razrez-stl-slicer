// Проверка подписи осей габаритом и сценария «только хвостовое крыло».
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

const labels = await page.evaluate(() =>
  [...document.querySelectorAll('[data-axis]')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim()),
);
console.log('подписи осей:', JSON.stringify(labels));
const sizes = await page.evaluate(() => ({
  x: +(window.__RAZREZ__.state.model.bboxMax[0] - window.__RAZREZ__.state.model.bboxMin[0]).toFixed(0),
  y: +(window.__RAZREZ__.state.model.bboxMax[1] - window.__RAZREZ__.state.model.bboxMin[1]).toFixed(0),
  z: +(window.__RAZREZ__.state.model.bboxMax[2] - window.__RAZREZ__.state.model.bboxMin[2]).toFixed(0),
}));
console.log('габарит по осям:', JSON.stringify(sizes));

// Режем по Y (длина) позади крыла — должен отделиться только хвост.
await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'y';
  st.planePos = 55;
  st.planeAngle = 0;
  st.cutAreaEnabled = false;
  st.extraEnabled = false;
  st.stepEnabled = false;
});
await page.evaluate(() => window.__RAZREZ__.refresh());
await page.waitForTimeout(700);
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(2500);
const res = await page.evaluate(() =>
  window.__RAZREZ__.parts().map((p) => ({
    label: p.label,
    cm3: +(p.volume / 1000).toFixed(1),
    y: [+p.bboxMin[1].toFixed(0), +p.bboxMax[1].toFixed(0)],
  })),
);
console.log('рез по Y позади крыла:', JSON.stringify(res));
await page.screenshot({ path: path.join(out, 'axis-y-tail.png') });
await browser.close();
