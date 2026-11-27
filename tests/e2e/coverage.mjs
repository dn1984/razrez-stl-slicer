// Проверка предупреждения о большом окне и подсказки с границами.
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

async function check(name, settings, shot) {
  await page.evaluate((s) => {
    const st = window.__RAZREZ__.state;
    st.axis = 'x';
    st.planePos = 33.3;
    st.planeAngle = 0;
    st.cutAreaEnabled = true;
    st.extraEnabled = false;
    st.stepEnabled = true;
    st.profileShape = 'flat';
    Object.assign(st, s);
  }, settings);
  await page.evaluate(() => window.__RAZREZ__.refresh());
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const warn = document.getElementById('cut-area-full');
    const bounds = document.getElementById('cut-area-bounds');
    return {
      warnHidden: warn?.classList.contains('hidden'),
      warnText: warn?.textContent?.replace(/\s+/g, ' ').trim(),
      bounds: bounds?.textContent?.replace(/\s+/g, ' ').trim(),
    };
  });
  console.log(`\n${name}:`, JSON.stringify(info));
  await page.screenshot({ path: path.join(out, `coverage-${shot}.png`) });

  await page.evaluate(() => window.__RAZREZ__.runCut());
  await page.waitForTimeout(1800);
  const res = await page.evaluate(() => ({
    parts: window.__RAZREZ__.parts().map((p) => ({ label: p.label, cm3: +(p.volume / 1000).toFixed(1) })),
  }));
  console.log(`${name} результат:`, JSON.stringify(res));
}

// Как у пользователя: окно 100×100 со сдвигами.
await check('большое окно', { cutWidth: 100, cutHeight: 100, cutOffsetU: -42, cutOffsetV: -23 }, 'big');
// Только крыло.
await check('только крыло', { cutWidth: 72, cutHeight: 120, cutOffsetU: 52, cutOffsetV: -10 }, 'wing');

await browser.close();
