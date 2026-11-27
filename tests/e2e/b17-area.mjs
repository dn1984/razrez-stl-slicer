// Реальный регрессионный сценарий: B-17F с ограниченным окном реза.
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
await page.goto(`file:///${path.join(root, 'dist/index.html').replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60000 });
const chooser = page.waitForEvent('filechooser');
await page.click('#drop');
await (await chooser).setFiles({ name: 'B-17F_Final.stl', mimeType: 'model/stl', buffer: file });
await page.waitForFunction(() => Boolean(window.__RAZREZ__.state.model), null, { timeout: 120000 });

const cases = [
  { name: 'screen', area: false, width: 306, height: 104, u: -23, v: -11 },
  { name: 'window', area: true, width: 306, height: 104, u: -23, v: -11 },
  { name: 'small-window', area: true, width: 120, height: 70, u: -23, v: -11 },
];
for (const c of cases) {
  await page.evaluate((s) => {
    const st = window.__RAZREZ__.state;
    st.axis = 'x'; st.planePos = 20; st.planeAngle = 0;
    st.profileShape = 'flat'; st.stepEnabled = true; st.pinsEnabled = false; st.tongueEnabled = false;
    st.cutAreaEnabled = s.area; st.cutWidth = s.width; st.cutHeight = s.height; st.cutOffsetU = s.u; st.cutOffsetV = s.v;
  }, c);
  await page.evaluate(() => window.__RAZREZ__.runCut());
  await page.waitForTimeout(1300);
  const data = await page.evaluate(() => ({
    stats: window.__RAZREZ__.stats().map((s) => ({ ok: s.ok, err: s.error, warnings: s.warnings, area: s.sectionArea, inter: s.intersectionVolume })),
    parts: window.__RAZREZ__.parts().map((p) => ({ label: p.label, volume: p.volume, min: p.bboxMin, max: p.bboxMax })),
  }));
  console.log(c.name, JSON.stringify(data));
  await page.screenshot({ path: path.join(out, `b17-area-${c.name}.png`) });
}
await browser.close();
