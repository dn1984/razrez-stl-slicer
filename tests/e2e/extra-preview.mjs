// Проверка: второй рез показывает свой контур и своё окно реза.
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
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)); });
await page.goto(`file:///${path.join(root, 'dist/index.html').replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60000 });

const chooser = page.waitForEvent('filechooser');
await page.click('#drop');
await (await chooser).setFiles({ name: 'B-17F_Final.stl', mimeType: 'model/stl', buffer: file });
await page.waitForFunction(() => Boolean(window.__RAZREZ__.state.model), null, { timeout: 120000 });

// Первый рез — X без окна. Второй — Z с большим окном (покрывает всё).
await page.evaluate(() => {
  const st = window.__RAZREZ__.state;
  st.axis = 'x';
  st.planePos = 28.5;
  st.planeAngle = 0;
  st.profileShape = 'flat';
  st.stepEnabled = false;
  st.pinsEnabled = false;
  st.tongueEnabled = false;
  st.cutAreaEnabled = false;
  st.extraEnabled = true;
  st.extraAxis = 'z';
  st.extraPos = 0;
  st.extraAngle = 0;
  st.extraParallel = false;
  st.extraVisible = true;
  st.extraAreaEnabled = true;
  st.extraWidth = 400;
  st.extraHeight = 300;
  st.extraOffsetU = 0;
  st.extraOffsetV = 0;
});
await page.waitForTimeout(300);
await page.evaluate(() => window.__RAZREZ__.refresh());
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, 'extra-preview.png') });

// Взгляд сверху: оба контура реза видны целиком.
await page.mouse.move(820, 450);
await page.mouse.down();
await page.mouse.move(820, 690, { steps: 18 });
await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'extra-preview-top.png') });

const info = await page.evaluate(() => {
  const v = window.__RAZREZ__;
  return { cuts: v.state.extraEnabled, parts: v.parts().length, counts: v.debugCounts() };
});
console.log('состояние:', JSON.stringify(info));
const problems = [];
if (!(info.counts.second > 0)) problems.push('контур второго реза пуст');
if (!info.counts.secondVisible) problems.push('контур второго реза скрыт');
if (!(info.counts.first > 0)) problems.push('контур первого реза пуст');
if (problems.length > 0) {
  console.log('ПРОВАЛ: ' + problems.join('; '));
  await browser.close();
  process.exit(1);
}
console.log('OK: оба контура нарисованы');

// Режем и проверяем, что второй рез реально ограничен своим окном.
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(2000);
const res = await page.evaluate(() => ({
  stats: window.__RAZREZ__.stats().map((s) => ({ id: s.id, ok: s.ok, err: s.error, pins: s.pinCount, va: +s.volumeAfter.toFixed(1), w: s.warnings })),
  parts: window.__RAZREZ__.parts().map((p) => ({
    label: p.label,
    mm3: +p.volume.toFixed(2),
    z: [+p.bboxMin[2].toFixed(1), +p.bboxMax[2].toFixed(1)],
    y: [+p.bboxMin[1].toFixed(1), +p.bboxMax[1].toFixed(1)],
  })),
}));
console.log('после реза:', JSON.stringify(res));
await page.evaluate(() => {
  const s = document.getElementById('explode');
  s.value = '60';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  window.__RAZREZ__.state.explode = 60;
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'extra-cut.png') });
await browser.close();
