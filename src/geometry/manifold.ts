// Обёртка над manifold-3d: загрузка WASM, сварка вершин, преобразование
// в/из «части» (плоские массивы для передачи в главный поток).

import Module from 'manifold-3d';
import type { Manifold as ManifoldT, ManifoldToplevel, Mesh as MeshT } from 'manifold-3d';
import type { PartGeometry, Vec3 } from './types.ts';

export type Manifold = ManifoldT;
export type Mesh = MeshT;

export interface ManifoldAPI {
  Manifold: ManifoldToplevel['Manifold'];
  Mesh: ManifoldToplevel['Mesh'];
  CrossSection: ManifoldToplevel['CrossSection'];
}

let api: ManifoldAPI | null = null;

export async function initManifold(wasmBinary?: ArrayBuffer): Promise<ManifoldAPI> {
  if (api) return api;
  const wasm = await (wasmBinary ? Module({ wasmBinary } as never) : Module());
  wasm.setup();
  api = { Manifold: wasm.Manifold, Mesh: wasm.Mesh, CrossSection: wasm.CrossSection };
  return api;
}

export function getAPI(): ManifoldAPI {
  if (!api) throw new Error('Геометрическое ядро не загружено.');
  return api;
}

export interface WeldReport {
  inputTriangles: number;
  weldedVertices: number;
  triangles: number;
  degenerate: number;
  duplicate: number;
}

/**
 * Сварка вершин треугольной «каши» и отбрасывание вырожденных/дублирующихся
 * треугольников. Квантование по габариту: две вершины ближе q считаются одной.
 */
export function weldPositions(positions: Float32Array, bboxSize: number): { mesh: Mesh; report: WeldReport } {
  const { Mesh } = getAPI();
  const q = Math.max(1e-6, bboxSize * 1e-6);
  const inv = 1 / q;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const ids = new Uint32Array(positions.length / 3);
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const key = `${Math.round(positions[i] * inv)},${Math.round(positions[i + 1] * inv)},${Math.round(positions[i + 2] * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(positions[i], positions[i + 1], positions[i + 2]);
    }
    ids[v] = id;
  }

  const tri: number[] = [];
  let degenerate = 0;
  const seen = new Set<string>();
  let duplicate = 0;
  for (let t = 0; t < ids.length; t += 3) {
    const a = ids[t], b = ids[t + 1], c = ids[t + 2];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    // Ключ без учёта направления: обратные копии треугольника — тоже дубликаты.
    const sorted = [a, b, c].sort((x, y) => x - y);
    const key = `${sorted[0]},${sorted[1]},${sorted[2]}`;
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    tri.push(a, b, c);
  }

  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tri),
  });
  mesh.merge();

  return {
    mesh,
    report: {
      inputTriangles: positions.length / 9,
      weldedVertices: mesh.numVert,
      triangles: mesh.numTri,
      degenerate,
      duplicate,
    },
  };
}

export interface BuildResult {
  manifold: Manifold | null;
  status: string;
  report: WeldReport;
}

export function manifoldFromPositions(positions: Float32Array, bboxSize: number): BuildResult {
  const { Manifold } = getAPI();
  const { mesh, report } = weldPositions(positions, bboxSize);
  let manifold: Manifold | null = null;
  let status = 'NoError';
  try {
    manifold = Manifold.ofMesh(mesh);
    status = manifold.status();
    if (status !== 'NoError') {
      manifold.delete();
      manifold = null;
    }
  } catch (err) {
    status = (err as { code?: string }).code ?? String(err);
    manifold = null;
  }
  return { manifold, status, report };
}

/** Manifold → PartGeometry (плоские массивы, готовые к передаче). */
export function manifoldToPart(
  m: Manifold,
  id: string,
  label: string,
  side: 'A' | 'B',
): PartGeometry {
  const mesh = m.getMesh();
  const numTri = mesh.numTri;
  const props = mesh.vertProperties;
  const stride = mesh.numProp;
  let positions: Float32Array;
  if (stride === 3) {
    positions = new Float32Array(props);
  } else {
    // Оставляем только координаты, если у сетки появились дополнительные свойства.
    const count = mesh.numVert;
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = props[i * stride];
      positions[i * 3 + 1] = props[i * stride + 1];
      positions[i * 3 + 2] = props[i * stride + 2];
    }
  }
  const indices = new Uint32Array(mesh.triVerts);
  const box = m.boundingBox();
  return {
    id,
    label,
    side,
    positions,
    indices,
    volume: m.volume(),
    triangles: numTri,
    bboxMin: [box.min[0], box.min[1], box.min[2]] as Vec3,
    bboxMax: [box.max[0], box.max[1], box.max[2]] as Vec3,
  };
}

/** Объём, устойчивый к ошибкам статуса. */
export function safeVolume(m: Manifold): number {
  try {
    const v = m.volume();
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
