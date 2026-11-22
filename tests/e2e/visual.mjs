// Визуальная проверка трёх исправленных случаев: шип-паз, штифты на куполе,
// штифты на тонкой детали. Сохраняет снимки в tests/e2e/out/.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Module from 'manifold-3d';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'tests/e2e/out');
mkdirSync(OUT, { recursive: true });

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;

function stl(m) {
  const mesh = m.getMesh();
  const count = mesh.numTri;
  const buf = Buffer.alloc(84 + count * 50);
  buf.write('razrez', 0, 'ascii');
  buf.writeUInt32LE(count, 80);
  const stride = mesh.numProp;
  let o = 84;
  for (let t = 0; t < count; t++) {
    const ids = [mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]];
    const v = ids.map((i) => [mesh.vertProperties[i * stride], mesh.vertProperties[i * stride + 1], mesh.vertProperties[i * stride + 2]]);
    const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
    const vx = v[2][0] - v[0][0], vy = v[2][1] - v[0][1], vz = v[2][2] - v[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / len, o); buf.writeFloatLE(ny / len, o + 4); buf.writeFloatLE(nz / len, o + 8);
    o += 12;
    for (const p of v) { buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8); o += 12; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

const browser = await chromium.launch({
  executablePath: 'C:/Users/Ingener/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });

await page.goto(`file:///${path.join(ROOT, 'dist/index.html').replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60000 });

const model = stl(Manifold.cube([60, 60, 40], true));

async function load() {
  await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    await window.__RAZREZ__.openFile(new File([bytes], 'деталь.stl', { type: 'model/stl' }));
  }, { base64: model.toString('base64') });
}

async function cut(settings, shot) {
  await page.evaluate((s) => {
    const st = window.__RAZREZ__.state;
    Object.assign(st, s);
  }, settings);
  await page.evaluate(() => window.__RAZREZ__.runCut());
  await page.waitForTimeout(1400);
  const stats = await page.evaluate(() => window.__RAZREZ__.stats().map((s) => ({
    ok: s.ok, pins: s.pinCount, step: s.stepApplied, tongue: s.tongueApplied, w: s.warnings, inter: s.intersectionVolume,
  })));
  const parts = await page.evaluate(() => window.__RAZREZ__.parts().length);
  console.log(`${shot}: parts=${parts}`, JSON.stringify(stats));
  // Разнести части, чтобы замки были видны.
  await page.evaluate(() => {
    const s = document.getElementById('explode');
    s.value = '26';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    window.__RAZREZ__.state.explode = 26;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `fix-${shot}.png`) });
  // Обернуть камеру, чтобы увидеть стык со стороны части A.
  await page.mouse.move(820, 450);
  await page.mouse.down();
  await page.mouse.move(1160, 350, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `fix-${shot}-flip.png`) });
}

await load();
await cut(
  { profileShape: 'flat', profileHeight: 0, stepEnabled: false, pinsEnabled: false, tongueEnabled: true, tongueWidth: 14, tongueDepth: 6, explode: 0 },
  'tongue',
);
await cut(
  { profileShape: 'dome', profileHeight: 4, stepEnabled: true, pinsEnabled: true, pinDiameter: 4, pinDepth: 6, pinCount: 4, tongueEnabled: false, explode: 0 },
  'dome-pins',
);
await cut(
  { profileShape: 'dish', profileHeight: 4, stepEnabled: false, pinsEnabled: true, pinDiameter: 5, pinDepth: 8, pinCount: 4, tongueEnabled: false, explode: 0 },
  'dish-pins',
);

// Тонкая пластина 1,5 мм
const plate = stl(Manifold.cube([50, 50, 1.5], true));
await page.evaluate(async ({ base64 }) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  await window.__RAZREZ__.openFile(new File([bytes], 'пластина.stl', { type: 'model/stl' }));
}, { base64: plate.toString('base64') });
await cut(
  { profileShape: 'flat', profileHeight: 0, stepEnabled: true, stepWidth: 4, stepHeight: 1.5, pinsEnabled: true, pinDiameter: 4, pinDepth: 6, pinCount: 4, tongueEnabled: true, explode: 0 },
  'thin',
);

await browser.close();
console.log('готово');
