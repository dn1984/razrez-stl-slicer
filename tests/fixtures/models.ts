// Генерация тестовых моделей прямо в памяти (без внешних файлов).
// Каждая модель строится из треугольников с гарантированно наружной
// ориентацией: нормаль каждого треугольника сверяется с направлением от центра
// и при необходимости треугольник переворачивается.

import type { Vec3 } from '../../src/geometry/types.ts';

interface Tri {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  /** Направление «наружу» для этого треугольника. */
  out: Vec3;
}

function toSoup(tris: Tri[]): Float32Array {
  const out = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) {
    let { a, b, c } = t;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * t.out[0] + ny * t.out[1] + nz * t.out[2] < 0) {
      const tmp = b;
      b = c;
      c = tmp;
    }
    for (const p of [a, b, c]) {
      out[o++] = p[0];
      out[o++] = p[1];
      out[o++] = p[2];
    }
  }
  return out;
}

const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, out: Vec3): Tri[] => [
  { a, b, c, out },
  { a, b: c, c: d, out },
];

/** Прямоугольный параллелепипед с центром в center. */
export function boxSoup(sx: number, sy: number, sz: number, center: Vec3 = [0, 0, 0]): Float32Array {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const [cx, cy, cz] = center;
  const p = (x: number, y: number, z: number): Vec3 => [cx + x * hx, cy + y * hy, cz + z * hz];
  const tris: Tri[] = [
    ...quad(p(-1, -1, -1), p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1), [0, 0, -1]),
    ...quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), [0, 0, 1]),
    ...quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), [0, -1, 0]),
    ...quad(p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1), [0, 1, 0]),
    ...quad(p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), p(1, -1, 1), [1, 0, 0]),
    ...quad(p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1), p(-1, -1, 1), [-1, 0, 0]),
  ];
  return toSoup(tris);
}

/** Сфера (UV), радиуса r с центром c. */
export function sphereSoup(r: number, segments = 32, rings = 16, center: Vec3 = [0, 0, 0]): Float32Array {
  const tris: Tri[] = [];
  const at = (iy: number, ix: number): Vec3 => {
    const v0 = (iy / rings) * Math.PI;
    const u0 = (ix / segments) * Math.PI * 2;
    return [
      center[0] + r * Math.sin(v0) * Math.cos(u0),
      center[1] + r * Math.sin(v0) * Math.sin(u0),
      center[2] + r * Math.cos(v0),
    ];
  };
  for (let iy = 0; iy < rings; iy++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = at(iy, ix);
      const b = at(iy + 1, ix);
      const c = at(iy, ix + 1);
      const d = at(iy + 1, ix + 1);
      const mid = (q: Vec3): Vec3 => [q[0] - center[0], q[1] - center[1], q[2] - center[2]];
      const out = mid([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
      tris.push({ a, b, c, out });
      const out2 = mid([(b[0] + d[0] + c[0]) / 3, (b[1] + d[1] + c[1]) / 3, (b[2] + d[2] + c[2]) / 3]);
      tris.push({ a: b, b: d, c, out: out2 });
    }
  }
  return toSoup(tris);
}

/** Цилиндр вдоль +Z от z=0 до z=h. */
export function cylinderSoup(r: number, h: number, segments = 32, center: Vec3 = [0, 0, 0]): Float32Array {
  const tris: Tri[] = [];
  const ring = (z: number, ix: number): Vec3 => {
    const a = (ix / segments) * Math.PI * 2;
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a), center[2] + z];
  };
  const axis = (z: number): Vec3 => [center[0], center[1], center[2] + z];
  for (let i = 0; i < segments; i++) {
    const a0 = ring(0, i), a1 = ring(0, i + 1), b0 = ring(h, i), b1 = ring(h, i + 1);
    const out = (p: Vec3): Vec3 => [p[0] - center[0], p[1] - center[1], 0];
    tris.push({ a: a0, b: a1, c: b0, out: out(a0) });
    tris.push({ a: a1, b: b1, c: b0, out: out(a1) });
    // Крышки.
    tris.push({ a: axis(0), b: a1, c: a0, out: [0, 0, -1] });
    tris.push({ a: axis(h), b: b0, c: b1, out: [0, 0, 1] });
  }
  return toSoup(tris);
}

/** Тонкостенный полый стакан (труба с дном) — для тестов тонких стенок. */
export function tubeSoup(rOuter: number, rInner: number, h: number, segments = 48): Float32Array {
  const tris: Tri[] = [];
  const ring = (r: number, z: number, ix: number): Vec3 => {
    const a = (ix / segments) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  for (let i = 0; i < segments; i++) {
    const o0 = ring(rOuter, 0, i), o1 = ring(rOuter, 0, i + 1);
    const o0t = ring(rOuter, h, i), o1t = ring(rOuter, h, i + 1);
    const i0 = ring(rInner, 0, i), i1 = ring(rInner, 0, i + 1);
    const i0t = ring(rInner, h, i), i1t = ring(rInner, h, i + 1);
    const radial = (p: Vec3): Vec3 => [p[0], p[1], 0];
    // Наружная стенка.
    tris.push({ a: o0, b: o1, c: o0t, out: radial(o0) });
    tris.push({ a: o1, b: o1t, c: o0t, out: radial(o1) });
    // Внутренняя стенка (нормаль к оси).
    tris.push({ a: i0, b: i0t, c: i1, out: [-i0[0], -i0[1], 0] });
    tris.push({ a: i1, b: i0t, c: i1t, out: [-i1[0], -i1[1], 0] });
    // Дно (кольцо, нормаль -z).
    tris.push({ a: o0, b: i0, c: o1, out: [0, 0, -1] });
    tris.push({ a: o1, b: i0, c: i1, out: [0, 0, -1] });
    // Верх (кольцо, нормаль +z).
    tris.push({ a: o0t, b: o1t, c: i0t, out: [0, 0, 1] });
    tris.push({ a: o1t, b: i1t, c: i0t, out: [0, 0, 1] });
  }
  return toSoup(tris);
}
