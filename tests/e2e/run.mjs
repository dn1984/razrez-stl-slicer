// E2E-тест: приложение открывается в Chromium по file://, режет модели,
// отдаёт STL — Node проверяет, что части замкнуты и совпадают по объёму.
//
// Фикстуры строятся в Node тем же ядром manifold, поэтому они гарантированно
// замкнуты: тест проверяет приложение, а не качество тестовых данных.

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Module from 'manifold-3d';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(ROOT, 'dist/index.html');
const OUT = path.join(ROOT, 'tests/e2e/out');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Users/Ingener/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('Не найден Chromium/Chrome/Edge. Укажите CHROME_PATH.');
}

const wasm = await Module();
wasm.setup();
const { Manifold, Mesh } = wasm;

/* ---------------------------------------------------------- фикстуры (Node) */

/** Бинарный STL из Manifold-тела. */
function stlFromManifold(m) {
  const mesh = m.getMesh();
  const count = mesh.numTri;
  const buf = Buffer.alloc(84 + count * 50);
  buf.write('razrez fixture', 0, 'ascii');
  buf.writeUInt32LE(count, 80);
  const stride = mesh.numProp;
  let o = 84;
  for (let t = 0; t < count; t++) {
    const ids = [mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]];
    const v = ids.map((i) => [
      mesh.vertProperties[i * stride],
      mesh.vertProperties[i * stride + 1],
      mesh.vertProperties[i * stride + 2],
    ]);
    const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
    const vx = v[2][0] - v[0][0], vy = v[2][1] - v[0][1], vz = v[2][2] - v[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    o += 12;
    for (const p of v) {
      buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8);
      o += 12;
    }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  return buf;
}

/**
 * Деталь-кронштейн: корпус с поперечным отверстием и бобышкой сверху.
 * Невыпуклая, с настоящей дыркой — честная проверка булевых операций.
 */
function buildBracket() {
  const body = Manifold.cube([64, 44, 36], true);
  const sideHole = Manifold.cylinder(80, 11, 11, 64, true).rotate([90, 0, 0]);
  const boss = Manifold.cylinder(16, 9, 9, 48, false).translate(22, 0, -18);
  const bossHole = Manifold.cylinder(20, 5, 5, 32, false).translate(22, 0, -20);
  return body.subtract(sideHole).add(boss).subtract(bossHole);
}

const fixtures = [
  { key: 'cube', name: 'куб', solid: Manifold.cube([60, 60, 40], true) },
  { key: 'bracket', name: 'кронштейн', solid: buildBracket() },
  { key: 'torus', name: 'тор', solid: Manifold.cube([1, 1, 1]).subtract(Manifold.cube([2, 2, 2])) },
];
// Тор: тело вращения окружности вокруг оси Z.
{
  const { CrossSection } = wasm;
  const ring = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push([26 + 9 * Math.cos(a), 9 * Math.sin(a)]);
  }
  fixtures[2].solid = new CrossSection([ring], 'NonZero').revolve(72);
}

/* ------------------------------------------------------------ проверка STL */

function checkSTL(buffer) {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = dv.getUint32(80, true);
  if (84 + count * 50 !== buffer.byteLength) {
    return { ok: false, reason: `размер файла не совпадает: ${count} треугольников, ${buffer.byteLength} байт` };
  }
  const positions = [];
  const map = new Map();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const x = dv.getFloat32(base + v * 12, true);
      const y = dv.getFloat32(base + v * 12 + 4, true);
      const z = dv.getFloat32(base + v * 12 + 8, true);
      const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        map.set(key, id);
        positions.push(x, y, z);
      }
      ids.push(id);
    }
  }
  if (positions.length === 0) return { ok: false, reason: 'в файле нет вершин' };
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(positions), triVerts: new Uint32Array(ids) });
  mesh.merge();
  let m;
  try {
    m = Manifold.ofMesh(mesh);
  } catch (err) {
    return { ok: false, reason: `ядро отказало: ${err.code ?? err}` };
  }
  const status = m.status();
  if (status !== 'NoError') return { ok: false, reason: `сетка не замкнута: ${status}` };
  const result = { ok: true, volume: m.volume(), triangles: count, genus: m.genus() };
  m.delete();
  return result;
}

/* ------------------------------------------------------------------- прогон */

const failures = [];
let checks = 0;
const check = (cond, message) => {
  checks++;
  if (cond) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}`);
    failures.push(message);
  }
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: findChrome(),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--allow-file-access-from-files',
  ],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
});

const downloads = [];
page.on('download', async (d) => {
  const target = path.join(OUT, d.suggestedFilename());
  await d.saveAs(target);
  downloads.push(target);
});

const modalText = () =>
  page.evaluate(() => {
    const modal = document.getElementById('modal');
    if (modal.hidden) return null;
    return `${document.getElementById('modal-title').textContent} — ${document.getElementById('modal-text').textContent}`;
  });

console.log('Открываю приложение из dist/index.html (file://)…');
await page.goto(`file:///${DIST.replace(/\\/g, '/')}`);
await page.waitForFunction(() => Boolean(window.__RAZREZ__), null, { timeout: 60_000 });
check(true, 'приложение загрузилось');

// Кнопка «Открыть STL» должна РАБОТАТЬ до загрузки модели: раньше input[type=file]
// попадал под общее отключение полей, и клик по кнопке ничего не делал.
{
  const cubeStl = stlFromManifold(fixtures[0].solid);
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await page.click('#drop');
  const chooser = await chooserPromise;
  check(chooser !== null, 'клик по «Открыть STL» открывает выбор файла');
  if (chooser) {
    await chooser.setFiles({
      name: 'куб.stl',
      mimeType: 'model/stl',
      buffer: cubeStl,
    });
    await page.waitForFunction(() => Boolean(window.__RAZREZ__.state.model), null, { timeout: 30_000 });
    const loadedByClick = await page.evaluate(() => window.__RAZREZ__.state.model?.name ?? null);
    check(loadedByClick === 'куб', `модель открылась через кнопку (${loadedByClick})`);
  }
}

for (const fixture of fixtures) {
  const stl = stlFromManifold(fixture.solid);
  writeFileSync(path.join(OUT, `${fixture.key}.stl`), stl);

  console.log(`\n=== ${fixture.name} · ${fixture.solid.numTri()} тр. · ${(fixture.solid.volume() / 1000).toFixed(1)} см³ ===`);

  await page.evaluate(
    async ({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await window.__RAZREZ__.openFile(new File([bytes], name, { type: 'model/stl' }));
    },
    { base64: stl.toString('base64'), name: `${fixture.name}.stl` },
  );

  const modal = await modalText();
  check(modal === null, modal ?? 'модель принята без ошибок');
  const loaded = await page.evaluate(() => window.__RAZREZ__.state.model);
  check(Boolean(loaded), 'модель загружена');
  if (!loaded) continue;

  await page.evaluate(() => {
    const s = window.__RAZREZ__.state;
    s.profileShape = 'dome';
    s.profileHeight = 3;
    s.stepEnabled = true;
    s.stepWidth = 4;
    s.stepHeight = 1.5;
    s.pinsEnabled = true;
    s.pinDiameter = 4;
    s.pinDepth = 6;
    s.pinCount = 3;
    s.pinClearance = 0.2;
    s.tongueEnabled = false;
    s.extraEnabled = false;
  });

  await page.evaluate(() => window.__RAZREZ__.runCut());
  await page.waitForFunction(() => window.__RAZREZ__.stats().length > 0, null, { timeout: 120_000 });

  const cutModal = await modalText();
  check(cutModal === null, cutModal ?? 'рез без диалогов об ошибке');

  const stats = await page.evaluate(() => window.__RAZREZ__.stats());
  const parts = await page.evaluate(() =>
    window.__RAZREZ__.parts().map((p) => ({ id: p.id, side: p.side, volume: p.volume, triangles: p.triangles })),
  );
  const st = stats[0] ?? {};

  check(st.ok === true, 'рез выполнен');
  check(parts.length === 2, `частей: ${parts.length}`);
  // Замки намеренно меняют объём (выступы добавляют, выемки с зазором убирают
  // чуть больше). Проверяем настоящий инвариант: изменение не выходит за
  // пределы добавленного и вычтенного.
  const actual = (st.volumeAfter ?? 0) - (st.volumeBefore ?? 0);
  const added = st.jointVolumeAdded ?? 0;
  const removed = st.jointVolumeRemoved ?? 0;
  check(
    actual <= added + Math.max(0.5, (st.volumeBefore ?? 0) * 1e-3) &&
      actual >= -removed - Math.max(0.5, (st.volumeBefore ?? 0) * 1e-3),
    `объём изменился на ${actual.toFixed(0)} мм³ при добавленных ${added.toFixed(0)} и вычтенных ${removed.toFixed(0)} мм³`,
  );
  check(
    (st.intersectionVolume ?? 1) < Math.max(0.05, (st.volumeBefore ?? 0) * 1e-5),
    `части не пересекаются (${(st.intersectionVolume ?? 0).toFixed(4)} мм³)`,
  );
  check(st.stepApplied === true, 'ступенька построена');
  check((st.pinCount ?? 0) > 0, `штифтов: ${st.pinCount}`);

  const before = downloads.length;
  await page.click('#save-parts-loose');
  await page.waitForTimeout(1500);
  const newFiles = downloads.slice(before);
  check(newFiles.length === parts.length, `скачано файлов: ${newFiles.length} из ${parts.length}`);

  let sum = 0;
  for (const file of newFiles) {
    const result = checkSTL(readFileSync(file));
    if (result.ok) {
      sum += result.volume;
      check(true, `${path.basename(file)} — замкнутая деталь, ${(result.volume / 1000).toFixed(2)} см³, ${result.triangles} тр.`);
    } else {
      check(false, `${path.basename(file)} — ${result.reason}`);
    }
  }
  if (newFiles.length > 0 && sum > 0) {
    // Пересобранные из STL части должны давать тот же объём, что показало
    // приложение: экспорт ничего не теряет и не добавляет.
    const appSum = parts.reduce((s, p) => s + p.volume, 0);
    const d = Math.abs(sum - appSum) / Math.max(appSum, 1);
    check(d < 0.002, `сумма сохранённых STL совпадает с частями в приложении (${(d * 100).toFixed(3)} %)`);
  }

  await page.screenshot({ path: path.join(OUT, `screen-${fixture.key}.png`) });
}

/* -------------------------------------- отдельный сценарий: вогнутый профиль */

console.log('\n=== вогнутый профиль и растаскивание ===');
await page.evaluate(() => {
  const s = window.__RAZREZ__.state;
  s.profileShape = 'dish';
  s.profileHeight = 4;
  s.pinsEnabled = false;
  s.stepEnabled = true;
  s.explode = 0;
});
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(1200);
const dishStats = await page.evaluate(() => window.__RAZREZ__.stats());
check(dishStats[0]?.ok === true, 'вогнутый профиль режется');
const dishModal = await modalText();
check(dishModal === null, dishModal ?? 'без ошибок');

await page.evaluate(() => {
  const slider = document.getElementById('explode');
  slider.value = '40';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'screen-dish-explode.png') });
check(true, 'снимок с растаскиванием сохранён');

/* ------------------------------------------------ второй рез и шип-паз */

console.log('\n=== шип-паз и второй рез ===');
// Берём сплошную деталь: на торе сечение — кольцо, и цельный шип там
// физически не помещается (приложение честно об этом предупреждает).
const cube = fixtures.find((f) => f.key === 'cube');
await page.evaluate(
  async ({ base64, name }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    await window.__RAZREZ__.openFile(new File([bytes], name, { type: 'model/stl' }));
  },
  { base64: stlFromManifold(cube.solid).toString('base64'), name: 'куб.stl' },
);
await page.evaluate(() => {
  const s = window.__RAZREZ__.state;
  s.profileShape = 'flat';
  s.stepEnabled = false;
  s.pinsEnabled = false;
  s.tongueEnabled = true;
  s.tongueWidth = 14;
  s.tongueDepth = 5;
  s.explode = 0;
});
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(1200);
const tongueStats = await page.evaluate(() => window.__RAZREZ__.stats());
check(
  tongueStats[0]?.tongueApplied === true,
  `шип-паз построен${tongueStats[0]?.tongueApplied ? '' : `: ${JSON.stringify(tongueStats[0]?.warnings)}`}`,
);

await page.evaluate(() => {
  const s = window.__RAZREZ__.state;
  s.extraEnabled = true;
  s.extraPos = 0;
  s.tongueEnabled = false;
});
await page.evaluate(() => window.__RAZREZ__.runCut());
await page.waitForTimeout(1500);
const twoStats = await page.evaluate(() => window.__RAZREZ__.stats());
const twoParts = await page.evaluate(() => window.__RAZREZ__.parts().length);
check(twoStats.length === 2 && twoStats.every((s) => s.ok), 'оба реза выполнены');
check(twoParts === 4, `после двух резов частей: ${twoParts}`);
await page.screenshot({ path: path.join(OUT, 'screen-two-cuts.png') });

check(
  consoleErrors.length === 0,
  consoleErrors.length ? `ошибки консоли: ${consoleErrors.slice(0, 3).join(' | ')}` : 'в консоли нет ошибок',
);

await browser.close();

console.log(`\nПроверок: ${checks}, провалов: ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('ВСЁ ПРОШЛО');
