// Проверка на файле пользователя: 3 штифта должны появиться все три.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'tests/e2e/out');
mkdirSync(OUT, { recursive: true });
const stl = readFileSync('C:/Users/Ingener/Downloads/CHEPCalibrationCube.stl');

const browser = await chromium.launch({
  executablePath: 'C:/Users/Ingener/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });
await page.goto(`file:///${path.join(ROOT, 'dist/index.html').replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60000 });

// Открываем именно кнопкой, как пользователь.
const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
await page.click('#drop');
await (await chooser).setFiles({ name: 'CHEPCalibrationCube.stl', mimeType: 'model/stl', buffer: stl });
await page.waitForFunction(() => Boolean(window.__RAZREZ__.state.model), null, { timeout: 30000 });
console.log('загружено через кнопку:', await page.evaluate(() => window.__RAZREZ__.state.model.name));

for (const [count, diameter, depth, height] of [
  [3, 2, 2, 5.5],
  [4, 4, 6, 0],
  [6, 3, 4, 0],
]) {
  await page.evaluate(({ count, diameter, depth, height }) => {
    const s = window.__RAZREZ__.state;
    s.profileShape = height > 0 ? 'dome' : 'flat';
    s.profileHeight = height;
    s.stepEnabled = false;
    s.pinsEnabled = true;
    s.pinDiameter = diameter;
    s.pinDepth = depth;
    s.pinCount = count;
    s.pinClearance = 0.2;
    s.tongueEnabled = false;
    s.extraEnabled = false;
    s.explode = 0;
  }, { count, diameter, depth, height });
  await page.evaluate(() => window.__RAZREZ__.runCut());
  await page.waitForTimeout(1200);
  const stats = await page.evaluate(() => window.__RAZREZ__.stats().map((s) => ({
    pins: s.pinCount, inter: +s.intersectionVolume.toFixed(4), warnings: s.warnings,
  })));
  const previewPins = await page.evaluate(() => window.__RAZREZ__.parts().length);
  console.log(`просили ${count} штифтов (⌀${diameter}, глубина ${depth}, купол ${height}):`, JSON.stringify(stats), 'частей', previewPins);
}

await page.evaluate(() => {
  const s = window.__RAZREZ__.state;
  s.profileShape = 'dome'; s.profileHeight = 5.5;
  s.pinDiameter = 2; s.pinDepth = 2; s.pinCount = 3;
});
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const s = document.getElementById('explode');
  s.value = '20';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  window.__RAZREZ__.state.explode = 20;
});
await page.waitForTimeout(400);
await page.mouse.move(820, 450);
await page.mouse.down();
await page.mouse.move(1180, 380, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'chep-3pins.png') });
console.log('снимок: tests/e2e/out/chep-3pins.png');
await browser.close();
