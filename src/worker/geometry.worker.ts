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
  // Результат реза больше не нужен — освобождаем WASM-память.
  for (const p of out.parts) p.manifold.delete();

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

/**
 * Быстрый предпросмотр одной плоскости: контур сечения, точки штифтов и
 * параметры профиля. Модель не режется, поэтому это дёшево и годится для
 * перетаскивания плоскости мышью.
 */
function handlePreview(msg: Extract<WorkerRequest, { type: 'preview' }>) {
  const started = performance.now();
  if (!source) {
    post({ type: 'preview', id: msg.id, ok: false, error: 'Модель не загружена.', preview: null, ms: 0 });
    return;
  }
  const preview = computePreview(source, msg.cut);
  post({ type: 'preview', id: msg.id, ok: true, preview, ms: performance.now() - started });
}

function computePreview(m: Manifold, cut: CutSettings): CutPreview {
  const basis = basisFromNormal(cut.plane.normal);
  const origin = cut.plane.point;
  const toLocal = worldToLocalMatrix(basis, origin);
  const local = m.transform(toLocal);
  const box = local.boundingBox();
  const n = basis.n;
  const d = n[0] * origin[0] + n[1] * origin[1] + n[2] * origin[2];
  let minS = Infinity;
  let maxS = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max[0] : box.min[0];
    const y = i & 2 ? box.max[1] : box.min[1];
    const z = i & 4 ? box.max[2] : box.min[2];
    const s = n[0] * x + n[1] * y + n[2] * z - d;
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
  }
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
      } else {
        shown = [];
      }
    } catch {
      shown = polygons;
    }
    const coversSection =
      cx - w / 2 <= b.min[0] + 1e-6 &&
      cx + w / 2 >= b.max[0] - 1e-6 &&
      cy - h / 2 <= b.min[1] + 1e-6 &&
      cy + h / 2 >= b.max[1] - 1e-6;
    result.area = {
      width: w,
      height: h,
      center: toWorldPoint(cx, cy, 0),
      coversSection,
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
