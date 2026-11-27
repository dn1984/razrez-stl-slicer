// Воркер геометрии: всё тяжёлое считается здесь, главный поток только рисует.

import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold, manifoldFromPositions, manifoldToPart, safeVolume, getAPI } from '../geometry/manifold.ts';
import type { Manifold } from '../geometry/manifold.ts';
import { runCuts } from '../geometry/cut.ts';
import { buildProfile } from '../geometry/profile.ts';
import { basisFromNormal, localToWorldMatrix, worldToLocalMatrix } from '../geometry/math.ts';
import type { CutPreview, CutSettings, Vec3 } from '../geometry/types.ts';
import type { WorkerRequest } from './protocol.ts';

let source: Manifold | null = null;
let sourceName = 'модель';

const post = (msg: unknown, transfer: Transferable[] = []) => self.postMessage(msg, transfer as never);

async function boot() {
  const resp = await fetch(wasmUrl);
  const bin = await resp.arrayBuffer();
  await initManifold(bin);
}

const ready = boot();

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    await ready;
    switch (msg.type) {
      case 'load':
        handleLoad(msg);
        break;
      case 'compute':
        handleCompute(msg);
        break;
      case 'preview':
        handlePreview(msg);
        break;
      case 'merge':
        handleMerge(msg);
        break;
      case 'reset':
        source?.delete();
        source = null;
        post({ type: 'loaded', id: msg.id, ok: true, status: 'NoError', triangles: 0, weldedVertices: 0, degenerate: 0, duplicate: 0, volume: 0, bboxMin: [0, 0, 0], bboxMax: [0, 0, 0], positions: new Float32Array(), indices: new Uint32Array(), ms: 0 });
        break;
      default:
        post({ type: 'error', id: 0, message: 'Неизвестный запрос.' });
    }
  } catch (err) {
    post({ type: 'error', id: (msg as { id?: number }).id ?? 0, message: String((err as Error)?.message ?? err) });
  }
};

function handleLoad(msg: Extract<WorkerRequest, { type: 'load' }>) {
  const started = performance.now();
  const positions = msg.positions;
  let size = 0;
  for (let i = 0; i < positions.length; i += 3) {
    size = Math.max(size, Math.abs(positions[i]), Math.abs(positions[i + 1]), Math.abs(positions[i + 2]));
  }
  const { manifold, status, report } = manifoldFromPositions(positions, Math.max(1, size * 2));
  const ms = performance.now() - started;

  if (!manifold) {
    post({
      type: 'loaded',
      id: msg.id,
      ok: false,
      error: describeStatus(status),
      status,
      triangles: report.inputTriangles,
      weldedVertices: report.weldedVertices,
      degenerate: report.degenerate,
      duplicate: report.duplicate,
      volume: 0,
      bboxMin: [0, 0, 0],
      bboxMax: [0, 0, 0],
      positions: new Float32Array(),
      indices: new Uint32Array(),
      ms,
    });
    return;
  }

  source?.delete();
  source = manifold;
  sourceName = msg.name;

  const part = manifoldToPart(manifold, 'source', sourceName, 'A');
  post(
    {
      type: 'loaded',
      id: msg.id,
      ok: true,
      status,
      triangles: report.inputTriangles,
      weldedVertices: report.weldedVertices,
      degenerate: report.degenerate,
      duplicate: report.duplicate,
      volume: part.volume,
      bboxMin: part.bboxMin,
      bboxMax: part.bboxMax,
      positions: part.positions,
      indices: part.indices,
      ms,
    },
    [part.positions.buffer, part.indices.buffer],
  );
}

function describeStatus(status: string): string {
  switch (status) {
    case 'NotManifold':
      return 'Сетка не замкнута: у модели есть дырки или лишние грани. Откройте её в программе-источнике и включите «сделать водонепроницаемой» (в Meshmixer, PrusaSlicer, Blender или 3D Builder).';
    case 'NonFiniteVertex':
      return 'В файле есть некорректные координаты (NaN или бесконечность) — файл повреждён.';
    case 'VertexOutOfBounds':
      return 'Слишком большие координаты для расчёта. Уменьшите масштаб модели.';
    default:
      return `Не удалось подготовить модель к нарезке (код: ${status}).`;
  }
}

function handleCompute(msg: Extract<WorkerRequest, { type: 'compute' }>) {
  if (!source) {
    post({ type: 'result', id: msg.id, ok: false, error: 'Модель не загружена.', parts: [], stats: [], previews: [], ms: 0, sourceVolume: 0 });
    return;
  }
  const started = performance.now();
  const out = runCuts({ manifold: source, cuts: msg.cuts, verify: true });
  const parts: ReturnType<typeof manifoldToPart>[] = [];
  let a = 0;
  let b = 0;
  for (const p of out.parts) {
    const idx = p.side === 'A' ? ++a : ++b;
    parts.push(manifoldToPart(p.manifold, `${p.side}${idx}`, `${sourceName} ${p.side}${idx}`, p.side));
  }
  const transfer: Transferable[] = [];
  for (const p of parts) {
    transfer.push(p.positions.buffer, p.indices.buffer);
  }
  // Держим тела последнего реза: они нужны, чтобы склеивать части обратно.
  releaseLastParts();
  lastParts = out.parts.map((p) => p.manifold);
  lastPartsSides = out.parts.map((p) => p.side);

  post(
    {
      type: 'result',
      id: msg.id,
      ok: true,
      parts,
      stats: out.stats,
      previews: out.previews,
      ms: performance.now() - started,
      sourceVolume: safeVolume(source),
    },
    transfer,
  );
}

/** Тела последнего реза (для объединения частей обратно). */
let lastParts: Manifold[] = [];
let lastPartsSides: Array<'A' | 'B'> = [];

function releaseLastParts() {
  for (const m of lastParts) m.delete();
  lastParts = [];
  lastPartsSides = [];
}

/**
 * Склеивает выбранные части обратно в одну.
 *
 * Это ответ на «плоскость всегда режет дальше, чем нужно»: режем плоскостью
 * насквозь (стенок окна нет вообще), а потом сшиваем обратно те куски, которые
 * должны остаться одним телом. Стык совпадает точь-в-точь, поэтому шов
 * исчезает, а нужная граница остаётся плоской.
 */
function handleMerge(msg: Extract<WorkerRequest, { type: 'merge' }>) {
  if (!source || lastParts.length === 0) {
    post({ type: 'result', id: msg.id, ok: false, error: 'Сначала разрежьте модель.', parts: [], stats: [], previews: [], ms: 0, sourceVolume: 0 });
    return;
  }
  const started = performance.now();
  const picked = msg.indices.filter((i) => i >= 0 && i < lastParts.length);
  if (picked.length < 2) {
    post({
      type: 'result',
      id: msg.id,
      ok: false,
      error: 'Выберите хотя бы две части, чтобы склеить их.',
      parts: [],
      stats: [],
      previews: [],
      ms: 0,
      sourceVolume: safeVolume(source),
    });
    return;
  }

  // Объединяем по порядку; при неудаче оставляем что получилось.
  const set = new Set(picked);
  let merged: Manifold | null = null;
  for (const i of picked) {
    merged = merged ? merged.add(lastParts[i]) : lastParts[i];
    if (!merged || merged.status() !== 'NoError' || merged.isEmpty()) {
      merged?.delete();
      merged = null;
      break;
    }
  }
  if (!merged) {
    post({ type: 'result', id: msg.id, ok: false, error: 'Не удалось склеить части: ядро вернуло ошибку.', parts: [], stats: [], previews: [], ms: 0, sourceVolume: safeVolume(source) });
    return;
  }

  const nextParts: Manifold[] = [];
  const nextSides: Array<'A' | 'B'> = [];
  let inserted = false;
  for (let i = 0; i < lastParts.length; i++) {
    if (set.has(i)) {
      if (!inserted) {
        nextParts.push(merged);
        nextSides.push(lastPartsSides[i] ?? 'A');
        inserted = true;
      }
    } else {
      nextParts.push(lastParts[i]);
      nextSides.push(lastPartsSides[i] ?? 'A');
    }
  }
  // Старые тела, не попавшие в новый список, освобождаем.
  for (let i = 0; i < lastParts.length; i++) {
    if (!nextParts.includes(lastParts[i])) lastParts[i].delete();
  }
  lastParts = nextParts;
  lastPartsSides = nextSides;

  const parts: ReturnType<typeof manifoldToPart>[] = [];
  let a = 0;
  let b = 0;
  for (let i = 0; i < lastParts.length; i++) {
    const side = lastPartsSides[i];
    const idx = side === 'A' ? ++a : ++b;
    parts.push(manifoldToPart(lastParts[i], `${side}${idx}`, `${sourceName} ${side}${idx}`, side));
  }
  const transfer: Transferable[] = [];
  for (const p of parts) transfer.push(p.positions.buffer, p.indices.buffer);

  post({
    type: 'result',
    id: msg.id,
    ok: true,
    parts,
    stats: [],
    previews: [],
    ms: performance.now() - started,
    sourceVolume: safeVolume(source),
  }, transfer);
}

/**
 * Быстрый предпросмотр одной плоскости: контур сечения, точки штифтов и
 * параметры профиля. Модель не режется, поэтому это дёшево и годится для
 * перетаскивания плоскости мышью.
 */
function handlePreview(msg: Extract<WorkerRequest, { type: 'preview' }>) {
  const started = performance.now();
  if (!source) {
    post({ type: 'preview', id: msg.id, ok: false, error: 'Модель не загружена.', preview: null, extraPreview: null, ms: 0 });
    return;
  }
  const preview = computePreview(source, msg.cut);
  // Второй рез показываем тем же предпросмотром — своя линия на модели.
  const extraPreview = msg.extra ? computePreview(source, msg.extra) : null;
  post({
    type: 'preview',
    id: msg.id,
    ok: true,
    preview,
    extraPreview,
    ms: performance.now() - started,
  });
}

function computePreview(m: Manifold, cut: CutSettings): CutPreview {
  const basis = basisFromNormal(cut.plane.normal);
  const origin = cut.plane.point;
  const toLocal = worldToLocalMatrix(basis, origin);
  const local = m.transform(toLocal);
  // После перевода в локальную систему координат плоскость среза — это z = 0,
  // поэтому пересечение проверяется по локальному габариту. Раньше здесь
  // мировая нормаль умножалось на локальные точки: тест почти всегда давал
  // «плоскость вне модели», и контур среза не рисовался вовсе.
  const box = local.boundingBox();
  const minS = box.min[2];
  const maxS = box.max[2];
  const result: CutPreview = {
    id: cut.id,
    section: [],
    pins: [],
    pinAxes: [],
    profileCenter: origin,
    profileRadius: 0,
    profilePeak: 0,
    planeDistance: { min: minS, max: maxS },
    area: null,
    ok: false,
  };
  if (!(minS < 0 && maxS > 0)) {
    local.delete();
    return result;
  }

  let cs = local.slice(0.0001);
  if (cs.isEmpty() || cs.numContour() === 0) cs = local.slice(-0.0001);
  if (cs.isEmpty() || cs.numContour() === 0) cs = local.slice(0);
  if (cs.isEmpty() || cs.numContour() === 0) {
    local.delete();
    return result;
  }
  const polygons = cs.toPolygons() as [number, number][][];
  const b = cs.bounds();
  const center: [number, number] = [((b.min[0] + b.max[0]) / 2), ((b.min[1] + b.max[1]) / 2)];
  let maxRadius = 0;
  for (const poly of polygons) {
    for (const p of poly) {
      maxRadius = Math.max(maxRadius, Math.hypot(p[0] - center[0], p[1] - center[1]));
    }
  }
  const profile = buildProfile(cut.profile, maxRadius);
  result.profileRadius = profile.radius;
  result.profilePeak = profile.peak;
  const toWorld = localToWorldMatrix(basis, origin);
  const toWorldPoint = (u: number, v: number, z: number): Vec3 => {
    const p = applyMatrix(toWorld, [u, v, z]);
    return [p[0], p[1], p[2]];
  };
  result.profileCenter = toWorldPoint(center[0], center[1], 0);

  // Ограниченная область: показываем контур только внутри окна реза, иначе
  // предпросмотр обещает разрез там, где деталь останется целой.
  let shown = polygons;
  let fraction: number | undefined;
  const area = cut.area;
  if (area?.enabled) {
    const w = Math.max(0.5, area.width);
    const h = Math.max(0.5, area.height);
    // Same reference point as the boolean cutter: the plane origin, not the
    // section centroid, so the drawn window is exactly the cut window.
    const cx = area.offsetU ?? 0;
    const cy = area.offsetV ?? 0;
    const rect: [number, number][] = [
      [cx - w / 2, cy - h / 2],
      [cx + w / 2, cy - h / 2],
      [cx + w / 2, cy + h / 2],
      [cx - w / 2, cy + h / 2],
    ];
    try {
      const { CrossSection } = getAPI();
      const region = new CrossSection(polygons, 'NonZero');
      const window = new CrossSection([rect], 'NonZero');
      const clipped = region.intersect(window);
      if (!clipped.isEmpty() && clipped.numContour() > 0) {
        shown = clipped.toPolygons() as [number, number][][];
        // Доля сечения внутри окна: сразу видно, режется «только крыло» или
        // окно накрывает всю деталь вместе с фюзеляжем.
        const total = cs.area();
        fraction = total > 1e-9 ? Math.min(1, clipped.area() / total) : 0;
      } else {
        shown = [];
        fraction = 0;
      }
    } catch {
      shown = polygons;
    }
    const coversSection =
      cx - w / 2 <= b.min[0] + 1e-6 &&
      cx + w / 2 >= b.max[0] - 1e-6 &&
      cy - h / 2 <= b.min[1] + 1e-6 &&
      cy + h / 2 >= b.max[1] - 1e-6;
    // Мировые координаты границ окна — чтобы их можно было сверить с моделью.
    const cornerMin = toWorldPoint(cx - w / 2, cy - h / 2, 0);
    const cornerMax = toWorldPoint(cx + w / 2, cy + h / 2, 0);
    const axisOf = (vec: Vec3): number => {
      if (Math.abs(Math.abs(vec[0]) - 1) < 0.02) return 0;
      if (Math.abs(Math.abs(vec[1]) - 1) < 0.02) return 1;
      return 2;
    };
    const ai = axisOf(basis.u);
    const aj = axisOf(basis.v);
    result.area = {
      width: w,
      height: h,
      center: toWorldPoint(cx, cy, 0),
      coversSection,
      fraction,
      uAxis: basis.u,
      vAxis: basis.v,
      uMin: Math.min(cornerMin[ai], cornerMax[ai]),
      uMax: Math.max(cornerMin[ai], cornerMax[ai]),
      vMin: Math.min(cornerMin[aj], cornerMax[aj]),
      vMax: Math.max(cornerMin[aj], cornerMax[aj]),
    };
  }

  result.section = shown.map((poly) =>
    poly.map(([u, v]) => toWorldPoint(u, v, profile.height(Math.hypot(u - center[0], v - center[1])))),
  );
  result.ok = true;
  local.delete();
  return result;
}

function applyMatrix(m: number[], p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
