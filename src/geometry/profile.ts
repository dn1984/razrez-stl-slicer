// Профиль среза: функция высоты f(r), режущие тела и «оболочка» между двумя
// профилями (используется замками, чтобы они повторяли форму среза).
//
// Соглашение: всё строится в локальной системе плоскости, где ось +Z — нормаль
// плоскости. Положительный f(r) означает, что граница раздела выступает в
// сторону +Z (в сторону части A), то есть A получает выпуклость.

import type { Manifold } from './manifold.ts';
import { getAPI } from './manifold.ts';
import type { ProfileSpec } from './types.ts';

export interface ProfileFunction {
  /** Высота профиля на расстоянии r от центра, мм. */
  height: (r: number) => number;
  /** Радиус, за которым профиль плоский (0). */
  radius: number;
  /** Радиус сферы, которой образован профиль (Infinity для «гладкого»). */
  sphereRadius: number;
  /** Наибольшая высота профиля со знаком. */
  peak: number;
}

/**
 * Строит профиль по настройкам и доступному радиусу.
 *
 * shape: flat — ровный срез; dome — у части A срез выпуклый наружу (купол
 * выступает из A в сторону B); dish — у части A срез вогнутый (тарелка).
 * falloff: smooth — дуга окружности, плавно сходящая к нулю на краю;
 * sphere — сферическая шапка с заданным радиусом в плане.
 *
 * Знак: f(r) — высота границы раздела вдоль +Z (в сторону A). Для выпуклого
 * среза A граница уходит вниз, поэтому f отрицательна в центре.
 */
export function buildProfile(spec: ProfileSpec, availableRadius: number): ProfileFunction {
  const sign = spec.shape === 'dish' ? 1 : -1;
  if (spec.shape === 'flat' || spec.height <= 0 || availableRadius <= 0) {
    return { height: () => 0, radius: 0, sphereRadius: Infinity, peak: 0 };
  }

  const R = Math.max(1e-3, Math.min(spec.radius && spec.radius > 0 ? spec.radius : availableRadius, availableRadius));
  const h = Math.max(1e-6, Math.min(spec.height, R));

  if (spec.falloff === 'sphere') {
    // Сферическая шапка: h — стрелка сегмента, R — радиус в плане.
    // Радиус сферы ρ = (R² + h²) / (2h).
    const rho = (R * R + h * h) / (2 * h);
    const height = (r: number) => {
      if (r >= R) return 0;
      const inside = rho * rho - r * r;
      if (inside <= 0) return 0;
      return sign * Math.max(0, Math.sqrt(inside) - (rho - h));
    };
    return { height, radius: R, sphereRadius: rho, peak: sign * h };
  }

  const height = (r: number) => {
    if (r >= R) return 0;
    const t = r / R;
    return sign * h * Math.sqrt(Math.max(0, 1 - t * t));
  };
  return { height, radius: R, sphereRadius: Infinity, peak: sign * h };
}

/** Производная профиля по r (центральная разность). */
export function profileSlope(profile: ProfileFunction, r: number): number {
  const eps = Math.max(1e-4, profile.radius * 1e-3);
  const r0 = Math.max(0, r - eps);
  const r1 = Math.min(profile.radius, r + eps);
  if (r1 - r0 < 1e-12) return 0;
  return (profile.height(r1) - profile.height(r0)) / (r1 - r0);
}

export interface Cutters {
  cutterA: Manifold;
  cutterB: Manifold;
  radius: number;
  peak: number;
}

export interface CutterOptions {
  radius: number;
  /** Полувысота режущих тел: должна превышать габарит модели. */
  height: number;
  /**
   * Центр профиля в координатах сечения. Режущее тело — тело вращения вокруг
   * своей оси, поэтому ось обязана проходить через центр профиля. Иначе при
   * срезе мимо центра детали тело не накрывает сечение целиком, и куски
   * «чужой» стороны уезжают в другую часть — рез получается выгрызенным по
   * дуге, с выступающими углами.
   */
  center?: [number, number];
  segments?: number;
  steps?: number;
}

/**
 * Тело вращения между двумя профилями: z ∈ [lower(r), upper(r)].
 * Так строятся и половинки среза, и «оболочки» для замков — они гарантированно
 * повторяют форму среза.
 */
export function shellBetween(
  upper: (r: number) => number,
  lower: (r: number) => number,
  R: number,
  segments = 128,
  steps = 96,
): Manifold | null {
  const { CrossSection } = getAPI();
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const r = (R * i) / steps;
    top.push([r, upper(r)]);
    bottom.push([r, lower(r)]);
  }
  const poly = [...top, ...bottom.reverse()];
  try {
    const cs = new CrossSection([poly], 'NonZero');
    if (cs.isEmpty() || cs.numContour() === 0) return null;
    const m = cs.revolve(segments);
    if (m.status() !== 'NoError' || m.isEmpty()) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Режущие тела: тело над границей раздела (для части A) и под ней (для B).
 *
 * Каждое тело — тело вращения замкнутого профиля в полуплоскости r≥0:
 * A: (0,f(0)) → кривая → (R,0) → (R,H) → (0,H);
 * B: (0,f(0)) → кривая → (R,0) → (R,−H) → (0,−H).
 *
 * Такой подход не требует булевых операций с полупространствами: граница
 * раздела одна и та же для обеих частей, поэтому A ∪ B = исходное тело и
 * A ∩ B = ∅ по построению.
 */
export function buildCutters(profile: ProfileFunction, opts: CutterOptions): Cutters {
  const { CrossSection } = getAPI();
  const R = Math.max(opts.radius, 1e-3);
  const H = Math.max(opts.height, 1);
  const seg = opts.segments ?? 128;
  const steps = opts.steps ?? 96;

  const curve: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const r = (R * i) / steps;
    curve.push([r, profile.height(r)]);
  }

  /** up=true — тело над границей раздела (часть A), up=false — под ней (B). */
  const make = (up: boolean, poly: [number, number][]): Manifold => {
    try {
      const cs = new CrossSection([poly], 'NonZero');
      if (cs.isEmpty() || cs.numContour() === 0) throw new Error('пустой контур профиля');
      const m = cs.revolve(seg);
      if (m.status() !== 'NoError' || m.isEmpty()) {
        m.delete();
        throw new Error('профиль не вращается');
      }
      return m;
    } catch {
      // Аварийный путь: плоский рез полупространством (не оставляем пользователя
      // без результата, если экзотический профиль не построился).
      const { Manifold } = getAPI();
      return Manifold.cube([2 * R + 4, 2 * R + 4, H], false).translate(-R - 2, -R - 2, up ? 0 : -H);
    }
  };

  const cutterA = make(true, [...curve, [R, H], [0, H]]);
  const cutterB = make(false, [...curve, [R, -H], [0, -H]]);
  // Ось вращения ведём через центр профиля.
  const cx = opts.center?.[0] ?? 0;
  const cy = opts.center?.[1] ?? 0;
  const placedA = Math.abs(cx) > 1e-9 || Math.abs(cy) > 1e-9 ? cutterA.translate(cx, cy, 0) : cutterA;
  const placedB = Math.abs(cx) > 1e-9 || Math.abs(cy) > 1e-9 ? cutterB.translate(cx, cy, 0) : cutterB;
  if (placedA !== cutterA) cutterA.delete();
  if (placedB !== cutterB) cutterB.delete();
  return { cutterA: placedA, cutterB: placedB, radius: R, peak: profile.peak };
}
