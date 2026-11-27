// Сценарий пользователя: первый рез ограничен окном, второй включён.
// Проверяем, что второй рез больше не режет всю деталь молча.
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

// Как у пользователя: X, -29.7, окно 100×100 со сдвигом -39.
await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'x';
  st.planePos = -29.7;
  st.planeAngle = 0;
  st.cutAreaEnabled = true;
  st.cutWidth = 100;
  st.cutHeight = 100;
  st.cutOffsetU = -39;
  st.cutOffsetV = 0;
  st.stepEnabled = true;
  st.profileShape = 'flat';
});
await page.evaluate(() => window.__RAZREZ__.refresh());

// Включаем второй рез через настоящее событие change (как клик по переключателю).
await page.evaluate(() => {
  const el = document.getElementById('extra-enabled');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(600);
const afterEnable = await page.evaluate(() => ({
  extraAreaEnabled: window.__RAZREZ__.state.extraAreaEnabled,
  extraWidth: window.__RAZREZ__.state.extraWidth,
  extraHeight: window.__RAZREZ__.state.extraHeight,
  areaSwitchChecked: document.getElementById('extra-area-enabled')?.checked ?? null,
  info: document.getElementById('extra-info')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
}));
console.log('после включения второго реза:', JSON.stringify(afterEnable));

await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(2000);
const res = await page.evaluate(() => ({
  parts: window.__RAZREZ__.parts().map((p) => ({ label: p.label, cm3: +(p.volume / 1000).toFixed(1) })),
  cuts: window.__RAZREZ__.stats().map((s) => ({ name: s.name, ok: s.ok, splits: s.splitCount, warnings: s.warnings })),
}));
console.log('результат:', JSON.stringify(res));
await page.evaluate(() => {
  const s = document.getElementById('explode');
  s.value = '40';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  window.__RAZREZ__.state.explode = 40;
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'two-cuts-bounded.png') });
await browser.close();
