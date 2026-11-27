// Проверка ограниченной области реза на «модели-самолёте»: длинная балка
// (фюзеляж+хвост) и поперечная консоль (крыло). Плоскость проходит через
// всё, но окно должно захватить только крыло.
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

// Фюзеляж вдоль X, крыло вдоль Y, сверху маленький киль на хвосте.
const body = Manifold.cube([160, 16, 16], true);
const wing = Manifold.cube([24, 150, 5], true).translate(20, 0, 6);
const tail = Manifold.cube([30, 6, 40], true).translate(-60, 0, 26);
const plane = body.add(wing).add(tail);

const browser = await chromium.launch({
  executablePath: 'C:/Users/Ingener/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)); });
await page.goto(`file:///${path.join(ROOT, 'dist/index.html').replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60000 });

await page.evaluate(async ({ base64 }) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  await window.__RAZREZ__.openFile(new File([bytes], 'самолёт.stl', { type: 'model/stl' }));
}, { base64: stl(plane).toString('base64') });

async function cut(settings, shot) {
  await page.evaluate((s) => {
    const st = window.__RAZREZ__.state;
    st.profileShape = 'flat';
    st.stepEnabled = false;
    st.pinsEnabled = false;
    st.tongueEnabled = false;
    st.extraEnabled = false;
    Object.assign(st, s);
  }, settings);
  await page.evaluate(() => window.__RAZREZ__.runCut());
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const st = window.__RAZREZ__.stats()[0];
    return {
      ok: st.ok,
      error: st.error ?? null,
      pins: st.pinCount,
      inter: +st.intersectionVolume.toFixed(4),
      parts: window.__RAZREZ__.parts().map((p) => ({
        label: p.label,
        vol: +(p.volume / 1000).toFixed(2),
        x: [+p.bboxMin[0].toFixed(1), +p.bboxMax[0].toFixed(1)],
        y: [+p.bboxMin[1].toFixed(1), +p.bboxMax[1].toFixed(1)],
        z: [+p.bboxMin[2].toFixed(1), +p.bboxMax[2].toFixed(1)],
      })),
    };
  });
  console.log(`\n${shot}:`, JSON.stringify(info));
  await page.evaluate(() => {
    const s = document.getElementById('explode');
    s.value = '18';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    window.__RAZREZ__.state.explode = 18;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `area-${shot}.png`) });
}

// Плоскость по Y: делит фюзеляж пополам вдоль X. Без окна задевает хвост.
await cut(
  { axis: 'y', planePos: 0, planeAngle: 0, cutAreaEnabled: false, cutWidth: 100, cutHeight: 100, cutOffsetU: 0, cutOffsetV: 0 },
  'full',
);

// Окно только на крыло. Крыло — консоль вдоль Y на x=+20; ось u плоскости
// с нормалью +Y направлена в -X, поэтому сдвиг окна к крылу — отрицательный.
await cut(
  {
    axis: 'y', planePos: 0, planeAngle: 0,
    cutAreaEnabled: true, cutWidth: 40, cutHeight: 30, cutOffsetU: -20, cutOffsetV: 0,
  },
  'window',
);

await browser.close();
console.log('\nготово');
