// Небольшая математика: векторы и матрицы в соглашениях manifold-3d.
// Матрицы — 4×4, column-major; трансляция лежит в элементах 12,13,14.

import type { Vec2, Vec3 } from './types.ts';

export type { Vec3 };
export type Mat4 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-12) return [0, 0, 1];
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Ортонормированный базис, у которого третья ось совпадает с нормалью. */
export interface Basis {
  /** Ось u (локальный X) в мировых координатах. */
  u: Vec3;
  /** Ось v (локальный Y) в мировых координатах. */
  v: Vec3;
  /** Ось n (локальный Z) в мировых координатах. */
  n: Vec3;
}

export function basisFromNormal(normal: Vec3): Basis {
  const n = normalize(normal);
  // Опорный вектор выбираем так, чтобы не быть коллинеарным нормали.
  // Для нормали вдоль Z получается u = +X, v = +Y — координаты сечения
  // совпадают с мировыми X/Y, это удобно для ручных позиций штифтов.
  const helper: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = normalize(cross(helper, n));
  const v = cross(n, u);
  return { u, v, n };
}

/** Матрица «мир → локальная система плоскости» (плоскость становится z=0). */
export function worldToLocalMatrix(basis: Basis, origin: Vec3): Mat4 {
  const { u, v, n } = basis;
  const tx = -(u[0] * origin[0] + u[1] * origin[1] + u[2] * origin[2]);
  const ty = -(v[0] * origin[0] + v[1] * origin[1] + v[2] * origin[2]);
  const tz = -(n[0] * origin[0] + n[1] * origin[1] + n[2] * origin[2]);
  return [
    u[0], v[0], n[0], 0,
    u[1], v[1], n[1], 0,
    u[2], v[2], n[2], 0,
    tx, ty, tz, 1,
  ];
}

/** Матрица «локальная система плоскости → мир». */
export function localToWorldMatrix(basis: Basis, origin: Vec3): Mat4 {
  const { u, v, n } = basis;
  return [
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    n[0], n[1], n[2], 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

/** Точка локальной системы (u,v,z) → мир. */
export function localPointToWorld(basis: Basis, origin: Vec3, p: Vec3): Vec3 {
  return [
    origin[0] + basis.u[0] * p[0] + basis.v[0] * p[1] + basis.n[0] * p[2],
    origin[1] + basis.u[1] * p[0] + basis.v[1] * p[1] + basis.n[1] * p[2],
    origin[2] + basis.u[2] * p[0] + basis.v[2] * p[1] + basis.n[2] * p[2],
  ];
}

/** Точка мира → координаты (u,v,z) локальной системы. */
export function worldPointToLocal(basis: Basis, origin: Vec3, p: Vec3): Vec3 {
  const d = sub(p, origin);
  return [dot(d, basis.u), dot(d, basis.v), dot(d, basis.n)];
}

/** Габарит набора точек. */
export function boundsOf(points: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

export const v2 = (a: Vec2) => a;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function centroid2(polygons: Vec2[][]): Vec2 {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const poly of polygons) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const f = a[0] * b[1] - b[0] * a[1];
      area += f;
      cx += (a[0] + b[0]) * f;
      cy += (a[1] + b[1]) * f;
    }
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) {
    // Вырожденный контур — берём середину габарита.
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const poly of polygons) for (const p of poly) {
      minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
      miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
    }
    if (!Number.isFinite(minx)) return [0, 0];
    return [(minx + maxx) / 2, (miny + maxy) / 2];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Тест «точка внутри набора контуров» по правилу чётности. */
export function pointInPolygons(polygons: Vec2[][], x: number, y: number): boolean {
  let inside = false;
  for (const poly of polygons) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if (yi > y !== yj > y) {
        const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (x < xCross) inside = !inside;
      }
    }
  }
  return inside;
}
