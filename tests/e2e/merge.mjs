// Проверка склейки частей: режем насквозь, потом сшиваем лишнее обратно.
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

// Два реза насквозь: X и Z — получаем четыре части.
await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'x';
  st.planePos = 28.5;
  st.planeAngle = 0;
  st.cutAreaEnabled = false;
  st.extraEnabled = true;
  st.extraAxis = 'z';
  st.extraPos = 0;
  st.extraAngle = 0;
  st.extraAreaEnabled = false;
  st.stepEnabled = false;
});
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(2500);
const before = await page.evaluate(() => window.__RAZREZ__.parts().map((p) => ({ id: p.id, label: p.label, cm3: +(p.volume / 1000).toFixed(1) })));
console.log('до склейки:', JSON.stringify(before));

// Отмечаем все части, кроме первой (её оставляем отдельно), и склеиваем.
await page.evaluate((ids) => {
  for (const id of ids) {
    const box = document.querySelector(`[data-pick="${id}"]`);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, before.slice(1).map((p) => p.id));
await page.waitForTimeout(200);
const btnState = await page.evaluate(() => document.getElementById('merge-parts')?.disabled);
console.log('кнопка активна:', btnState === false);

await page.click('#merge-parts');
await page.waitForTimeout(2500);
const after = await page.evaluate(() => window.__RAZREZ__.parts().map((p) => ({ label: p.label, cm3: +(p.volume / 1000).toFixed(1) })));
const sumBefore = before.reduce((s, p) => s + p.cm3, 0);
const sumAfter = after.reduce((s, p) => s + p.cm3, 0);
console.log('после склейки:', JSON.stringify(after));
console.log('сумма до/после:', sumBefore.toFixed(1), '/', sumAfter.toFixed(1));

await page.evaluate(() => {
  const s = document.getElementById('explode');
  s.value = '45';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  window.__RAZREZ__.state.explode = 45;
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'merged-parts.png') });

const ok = after.length === 2 && Math.abs(sumAfter - sumBefore) < 1;
console.log(ok ? 'OK: части склеены без потери объёма' : 'ПРОВАЛ: склейка не сошлась');
await browser.close();
process.exit(ok ? 0 : 1);
