// Замки на срезе: ступенька по контуру, шип-паз, штифты с отверстиями.
// Всё строится в локальной системе плоскости (ось +Z — нормаль).
//
// Ключевой приём: каждый замок вырезается «оболочкой» между двумя копиями
// профиля среза, поэтому он повторяет форму среза (плоский, купол, тарелка) и
// никогда не вылезает за поверхность раздела.

import type { Manifold } from './manifold.ts';
import { getAPI } from './manifold.ts';
import type { ProfileFunction } from './profile.ts';
import { profileSlope, shellBetween } from './profile.ts';
import type { PinSpec, StepSpec, TongueSpec, Vec2, Vec3 } from './types.ts';
import { pointInPolygons } from './math.ts';

export interface SectionInfo {
  polygons: Vec2[][];
  area: number;
  bounds: { min: Vec2; max: Vec2 };
}

const SEGMENTS = 128;
const STEPS = 96;

/* ---------------------------------------------------------------- ступенька */

export interface StepPlan {
  applied: boolean;
  /** Внутренняя область ступеньки в координатах (u,v). */
  innerPolygons: Vec2[][];
  width: number;
  height: number;
}

/**
 * Ступенька по контуру: выступающий поясок внутрь на width и высотой height.
 * Ширина автоматически уменьшается, если эрозия съедает сечение.
 */
export function planStep(section: SectionInfo, spec: StepSpec, minArea: number): StepPlan {
  const empty: StepPlan = { applied: false, innerPolygons: [], width: 0, height: 0 };
  if (!spec.enabled || spec.width <= 0 || spec.height <= 0) return empty;
  if (section.polygons.length === 0) return empty;
  const { CrossSection } = getAPI();

  const attempt = (w: number): Vec2[][] | null => {
    try {
      const cs = new CrossSection(section.polygons, 'NonZero');
      if (cs.isEmpty()) return null;
      const inner = cs.offset(-w, 'Round');
      if (inner.isEmpty() || inner.numContour() === 0) return null;
      if (inner.area() < Math.max(minArea, section.area * 0.02)) return null;
      return inner.toPolygons() as Vec2[][];
    } catch {
      return null;
    }
  };

  for (const factor of [1, 0.75, 0.5, 0.35, 0.25]) {
    const w = spec.width * factor;
    if (w < 0.4) break;
    const inner = attempt(w);
    if (inner && inner.length > 0) return { applied: true, innerPolygons: inner, width: w, height: spec.height };
  }
  return empty;
}

/**
 * Тело ступеньки: внутренняя область, взятая слоем от профиля вниз на height.
 * Именно «вниз» — чтобы выступ принадлежал части A и входил в выемку B.
 */
export function buildStepBody(
  plan: StepPlan,
  profile: ProfileFunction,
  clearance: number,
  radius: number,
  center: Vec2,
): { male: Manifold; female: Manifold } | null {
  const { CrossSection } = getAPI();
  if (!plan.applied) return null;
  const R = Math.max(profile.radius, radius, 1);
  const h = plan.height;
  const peak = Math.abs(profile.peak);

  const make = (polygons: Vec2[][], grow: number, c: number): Manifold | null => {
    try {
      const cs = new CrossSection(polygons, 'NonZero');
      const shaped = grow > 0 ? cs.offset(grow, 'Round') : cs;
      if (shaped.isEmpty()) return null;
      const shell = shellBetween(
        (r) => profile.height(r) + c,
        (r) => profile.height(r) - h - c,
        R,
        SEGMENTS,
        STEPS,
      );
      if (!shell) return null;
      // Профиль радиальный вокруг центра сечения — ось оболочки должна идти
      // через него же, иначе ступенька съедет с формы среза.
      const placed = Math.abs(center[0]) > 1e-9 || Math.abs(center[1]) > 1e-9
        ? shell.translate(center[0], center[1], 0)
        : shell;
      if (placed !== shell) shell.delete();
      const prism = shaped.extrude(h + peak + 6).translate(0, 0, -h - peak - 3);
      const body = prism.intersect(placed);
      prism.delete();
      placed.delete();
      if (body.status() !== 'NoError' || body.isEmpty()) {
        body.delete();
        return null;
      }
      return body;
    } catch {
      return null;
    }
  };

  // Выступ A: точно по контуру. Выемка B: тот же контур, расширенный на зазор
  // по периметру, и с дополнительным зазором по высоте.
  const male = make(plan.innerPolygons, 0, 0);
  const female = make(plan.innerPolygons, clearance, clearance);
  if (!male || !female) {
    male?.delete();
    female?.delete();
    return null;
  }
  return { male, female };
}

/* ----------------------------------------------------------------- шип-паз */

export interface TonguePlan {
  applied: boolean;
  /** Полигоны шипа в координатах (u,v) — уже обрезаны по допустимой зоне. */
  polygons: Vec2[][];
  depth: number;
  clearance: number;
  dir: Vec2;
  warnings: string[];
}

interface Chord {
  x0: number;
  x1: number;
  y: number;
  len: number;
}

/** Горизонтальные хорды зоны: для каждой строки начало, конец и длина. */
function rowChords(allowed: SectionInfo, rows = 96): Chord[] {
  const { min, max } = allowed.bounds;
  const height = max[1] - min[1];
  const stepX = Math.max(0.2, (max[0] - min[0]) / 480);
  const chords: Chord[] = [];
  for (let i = 1; i < rows; i++) {
    const y = min[1] + (height * i) / rows;
    let start: number | null = null;
    let end = 0;
    let best: Chord = { x0: 0, x1: 0, y, len: 0 };
    for (let x = min[0]; x <= max[0]; x += stepX) {
      if (pointInPolygons(allowed.polygons, x, y)) {
        if (start === null) start = x;
        end = x;
      } else if (start !== null) {
        if (end - start > best.len) best = { x0: start, x1: end, y, len: end - start };
        start = null;
      }
    }
    if (start !== null && end - start > best.len) best = { x0: start, x1: end, y, len: end - start };
    if (best.len > 0) chords.push(best);
  }
  return chords;
}

/**
 * Шип-паз: широкая трапеция вдоль самой длинной хорды допустимой зоны.
 *
 * Строка выбирается не «где длиннее всего», а ближайшая к центру среди почти
 * максимальных: иначе шип прилипает к краю детали и наполовину срезается
 * границей. Размеры подгоняются под свободное место, поэтому шип никогда не
 * выходит за материал.
 *
 * Сечение постоянно вдоль нормали — поднутрений нет, детали собираются
 * движением по нормали.
 */
export function planTongue(allowed: SectionInfo, spec: TongueSpec, center: Vec2): TonguePlan {
  const { CrossSection } = getAPI();
  const warnings: string[] = [];
  const plan: TonguePlan = { applied: false, polygons: [], depth: 0, clearance: 0, dir: [1, 0], warnings };
  if (!spec.enabled) return plan;
  if (allowed.polygons.length === 0) {
    warnings.push('На срезе нет места для шипа.');
    return plan;
  }

  /** Выбор хорды: длинная и близкая к центру. Возвращает размеры в UV. */
  const pick = (
    regions: Chord[],
    perpBounds: { min: number; max: number },
    toUV: (chord: Chord) => Chord,
  ): { chord: Chord; halfWidth: number; halfLen: number } | null => {
    if (regions.length === 0) return null;
    const maxLen = Math.max(...regions.map((c) => c.len));
    if (maxLen < spec.width) return null;
    const near = regions.filter((c) => c.len >= maxLen * 0.85);
    // Ближайшая к центру сечения строка.
    const centerPerp = (perpBounds.min + perpBounds.max) / 2;
    let best = near[0];
    let bestDist = Math.abs(best.y - centerPerp);
    for (const c of near) {
      const d = Math.abs(c.y - centerPerp);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    // Свободное место по перпендикуляру с обеих сторон от выбранной строки.
    const room = Math.min(best.y - perpBounds.min, perpBounds.max - best.y);
    const halfWidth = Math.min(spec.width / 2, Math.max(0, room - 1));
    const usable = best.len * Math.min(1, Math.max(0.15, spec.lengthScale));
    const halfLen = Math.min(usable / 2, best.len / 2 - 1);
    if (halfWidth < 1.5 || halfLen < halfWidth * 0.6) return null;
    return { chord: toUV(best), halfWidth, halfLen };
  };

  const horiz = pick(rowChords(allowed), { min: allowed.bounds.min[1], max: allowed.bounds.max[1] }, (c) => c);
  const flipped = allowed.polygons.map((p) => p.map(([x, y]) => [y, x] as Vec2));
  const flippedBounds = {
    min: [allowed.bounds.min[1], allowed.bounds.min[0]] as Vec2,
    max: [allowed.bounds.max[1], allowed.bounds.max[0]] as Vec2,
  };
  const vert = pick(
    rowChords({ polygons: flipped, area: allowed.area, bounds: flippedBounds }),
    { min: flippedBounds.min[1], max: flippedBounds.max[1] },
    (c) => ({ ...c, x0: c.y, x1: c.y, y: 0 }),
  );

  // Берём вариант с большей площадью шипа.
  let chosen: { chord: Chord; halfWidth: number; halfLen: number } | null = null;
  let useHorizontal = true;
  const hArea = horiz ? horiz.halfWidth * 2 * horiz.halfLen * 2 : 0;
  const vArea = vert ? vert.halfWidth * 2 * vert.halfLen * 2 : 0;
  if (hArea >= vArea && horiz) {
    chosen = horiz;
    useHorizontal = true;
  } else if (vert) {
    chosen = vert;
    useHorizontal = false;
  }
  if (!chosen) {
    warnings.push(
      `Сечение слишком узкое для шипа шириной ${spec.width.toFixed(1)} мм — поставьте шип меньше или разрежьте деталь иначе.`,
    );
    return plan;
  }

  const { chord, halfWidth, halfLen: initialHalfLen } = chosen;
  const alongMid = (chord.x0 + chord.x1) / 2;
  const acrossMid = chord.y;

  /** Прямоугольник шипа нужной длины и сдвига вдоль хорды. */
  const rectOf = (halfLen: number, shift: number): Vec2[] => {
    const a = alongMid + shift;
    return useHorizontal
      ? [
          [a - halfLen, acrossMid - halfWidth],
          [a + halfLen, acrossMid - halfWidth],
          [a + halfLen, acrossMid + halfWidth],
          [a - halfLen, acrossMid + halfWidth],
        ]
      : [
          [acrossMid - halfWidth, a - halfLen],
          [acrossMid + halfWidth, a - halfLen],
          [acrossMid + halfWidth, a + halfLen],
          [acrossMid - halfWidth, a + halfLen],
        ];
  };

  // Обрезаем по допустимой зоне. На составных сечениях (кольцо, несколько
  // ветвей) шип посреди хорды рвётся на куски — тогда укорачиваем его и
  // сдвигаем вдоль хорды, пока он не уместится целиком в сплошном материале.
  try {
    const region = new CrossSection(allowed.polygons, 'NonZero');
    const slack = Math.max(0, chord.len / 2 - initialHalfLen);
    const shifts = [0, -0.35, 0.35, -0.6, 0.6, -0.85, 0.85].map((k) => k * slack);
    for (const factor of [1, 0.75, 0.55, 0.42, 0.3, 0.2]) {
      const halfLen = initialHalfLen * factor;
      if (halfLen < halfWidth * 0.5) break;
      for (const shift of shifts) {
        const rectCs = new CrossSection([rectOf(halfLen, shift)], 'NonZero');
        const clipped = rectCs.intersect(region);
        if (clipped.isEmpty() || clipped.numContour() === 0) continue;
        if (clipped.numContour() > 1) continue;
        if (clipped.area() < rectCs.area() * 0.9) continue;
        if (clipped.area() < spec.width * spec.width * 0.3) continue;
        plan.polygons = clipped.toPolygons() as Vec2[][];
        plan.dir = useHorizontal ? [1, 0] : [0, 1];
        plan.depth = Math.max(0.5, spec.depth);
        plan.clearance = Math.max(0, spec.clearance);
        plan.applied = true;
        void center;
        return plan;
      }
    }
    warnings.push(
      'Шип не поместился целиком в материал: сечение разорвано (кольцо или несколько ветвей). Уменьшите ширину шипа или сдвиньте рез.',
    );
    return plan;
  } catch {
    warnings.push('Не удалось построить контур шипа.');
    return plan;
  }
}

/**
 * Тела шипа и паза. Оба вырезаны оболочкой профиля, поэтому следуют форме
 * среза. Шип уходит от поверхности вниз (в сторону B), паз — тот же объём с
 * зазором.
 *
 * Сечение шипа постоянно вдоль нормали (без расширения кверху): только так
 * детали собираются движением по нормали. Расширяющийся «ласточкин хвост»
 * здесь недопустим — он запирает сборку.
 */
export function buildTongueBodies(
  plan: TonguePlan,
  profile: ProfileFunction,
  radius: number,
  maxDepth: number,
  center: Vec2,
): { male: Manifold; female: Manifold } | null {
  if (!plan.applied || plan.polygons.length === 0) return null;
  const { CrossSection } = getAPI();
  const R = Math.max(profile.radius, radius, 1);
  // Глубина ограничена толщиной материала: иначе шип проткнёт деталь насквозь.
  const depth = Math.min(plan.depth, Math.max(0, maxDepth));
  if (depth < 0.5) return null;
  const c = plan.clearance;
  const peak = Math.abs(profile.peak);
  // Призма должна перекрывать оболочку профиля целиком: строим её от верха
  // оболочки вниз, а не от нуля вверх.
  const total = depth + peak + 6;

  const make = (polygons: Vec2[][], grow: number, topOffset: number, bottomOffset: number): Manifold | null => {
    try {
      const cs = new CrossSection(polygons, 'NonZero');
      const shaped = grow > 0 ? cs.offset(grow, 'Round') : cs;
      if (shaped.isEmpty()) return null;
      const prism = shaped.extrude(total).translate(0, 0, -total + peak + 2);
      const shell = shellBetween(
        (r) => profile.height(r) + topOffset,
        (r) => profile.height(r) - depth + bottomOffset,
        R,
        SEGMENTS,
        STEPS,
      );
      if (!shell) {
        prism.delete();
        return null;
      }
      // Ось оболочки — через центр профиля, иначе шип съедет с формы среза.
      const placed = Math.abs(center[0]) > 1e-9 || Math.abs(center[1]) > 1e-9
        ? shell.translate(center[0], center[1], 0)
        : shell;
      if (placed !== shell) shell.delete();
      const body = prism.intersect(placed);
      prism.delete();
      placed.delete();
      if (body.status() !== 'NoError' || body.isEmpty()) {
        body.delete();
        return null;
      }
      return body;
    } catch {
      return null;
    }
  };

  const male = make(plan.polygons, 0, 0.6, 0);
  const female = make(plan.polygons, c, c + 0.6, -c);
  if (!male || !female) {
    male?.delete();
    female?.delete();
    return null;
  }
  return { male, female };
}

/* ------------------------------------------------------------------- штифты */

export interface PinPlan {
  points: Vec2[];
  radius: number;
  depth: number;
  rootDepth: number;
  clearance: number;
  taper: number;
  warnings: string[];
}

/** Раскладка штифтов внутри допустимой зоны. */
export function planPins(allowed: SectionInfo, spec: PinSpec, edgeMargin: number): PinPlan {
  const warnings: string[] = [];
  const radius = Math.max(0.4, spec.diameter / 2);
  const plan: PinPlan = {
    points: [],
    radius,
    depth: Math.max(0.5, spec.depth),
    rootDepth: Math.max(1.5, Math.min(3, spec.depth * 0.6)),
    clearance: Math.max(0, spec.clearance),
    taper: Math.min(1, Math.max(0.4, spec.taper)),
    warnings,
  };
  if (!spec.enabled) return plan;
  if (allowed.polygons.length === 0 || allowed.area <= 0) {
    warnings.push(
      `Сечение слишком узкое для штифтов диаметром ${spec.diameter.toFixed(1)} мм (нужен отступ ${edgeMargin.toFixed(1)} мм от края).`,
    );
    return plan;
  }

  const minDist = Math.max(radius * 2.2, spec.diameter * 2.2);
  const accepted: Vec2[] = [];

  // Ручные штифты имеют приоритет.
  for (const p of spec.manual) {
    if (pointInPolygons(allowed.polygons, p[0], p[1])) {
      if (accepted.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist)) {
        accepted.push([p[0], p[1]]);
      }
    }
  }

  if (accepted.length < spec.maxCount) {
    // Плотная сетка кандидатов. Допустимая зона уже сжата на отступ от края
    // (радиус штифта + зазор + стенка), поэтому второй раз отступать не нужно.
    const step = Math.max(0.8, spec.diameter * 0.4);
    const { min, max } = allowed.bounds;
    const candidates: Vec2[] = [];
    for (let x = min[0]; x <= max[0] + 1e-9; x += step) {
      for (let y = min[1]; y <= max[1] + 1e-9; y += step) {
        if (pointInPolygons(allowed.polygons, x, y)) candidates.push([x, y]);
      }
    }

    // «Дальняя точка»: каждый раз берём кандидата, наиболее удалённого от уже
    // поставленных. Так штифты расходятся по сечению равномерно.
    const grow = (seed: Vec2, into: Vec2[], limit: number): Vec2[] => {
      const picked = [...into, seed];
      while (picked.length < limit) {
        let best: Vec2 | null = null;
        let bestGap = -1;
        for (const c of candidates) {
          let nearest = Infinity;
          for (const q of picked) {
            const d = Math.hypot(c[0] - q[0], c[1] - q[1]);
            if (d < nearest) nearest = d;
          }
          if (nearest > bestGap) {
            bestGap = nearest;
            best = c;
          }
        }
        if (!best || bestGap < minDist) break;
        picked.push(best);
      }
      return picked;
    };

    if (candidates.length === 0) {
      if (accepted.length === 0) {
        warnings.push(
          `В сечении нет места для штифта диаметром ${spec.diameter.toFixed(1)} мм: нужно ${edgeMargin.toFixed(1)} мм отступа от края.`,
        );
      }
    } else {
      // Пробуем разные стартовые точки и оставляем раскладку, где штифтов
      // больше всего. Один старт «от центра» на компактном сечении даёт мало
      // штифтов: центр оказывается посреди площадки, и до края уже не хватает
      // минимального расстояния.
      let bestLayout: Vec2[] = accepted;
      const seeds: Vec2[] = [candidates[0]];
      const stride = Math.max(1, Math.floor(candidates.length / 48));
      for (let i = 0; i < candidates.length; i += stride) seeds.push(candidates[i]);
      if (accepted.length === 0) {
        // Плюс старт ближайший к центру сечения.
        const cx = (min[0] + max[0]) / 2;
        const cy = (min[1] + max[1]) / 2;
        let nearest = candidates[0];
        let nearestD = Infinity;
        for (const c of candidates) {
          const d = Math.hypot(c[0] - cx, c[1] - cy);
          if (d < nearestD) {
            nearestD = d;
            nearest = c;
          }
        }
        seeds.push(nearest);
      }

      for (const seed of seeds) {
        if (accepted.some((q) => Math.hypot(seed[0] - q[0], seed[1] - q[1]) < minDist)) continue;
        const layout = grow(seed, accepted, spec.maxCount);
        if (layout.length > bestLayout.length) bestLayout = layout;
        if (bestLayout.length >= spec.maxCount) break;
      }
      accepted.length = 0;
      accepted.push(...bestLayout);
    }

    if (accepted.length > 0 && accepted.length < spec.maxCount) {
      warnings.push(
        `Штифтов поставлено ${accepted.length} из ${spec.maxCount}: на таком сечении больше не помещается с расстоянием ${minDist.toFixed(1)} мм между штифтами. Уменьшите диаметр штифта, чтобы влезло больше.`,
      );
    }
  }

  if (accepted.length === 0) {
    warnings.push(`Сечение слишком узкое для штифтов диаметром ${spec.diameter.toFixed(1)} мм.`);
  }
  plan.points = accepted;
  return plan;
}

/**
 * Наклон поверхности среза в точке (u,v): 0 — плоско, 1 — 45°.
 * Нужен, чтобы не ставить штифт туда, где срез почти вертикален.
 */
export function surfaceSlope(profile: ProfileFunction, center: Vec2, point: Vec2): number {
  const r = Math.hypot(point[0] - center[0], point[1] - center[1]);
  return Math.abs(profileSlope(profile, r));
}

/** Высота профиля в точке (u,v). */
export function surfaceHeight(profile: ProfileFunction, center: Vec2, point: Vec2): number {
  return profile.height(Math.hypot(point[0] - center[0], point[1] - center[1]));
}

/**
 * Сколько материала есть вдоль направления dir, начиная от точки from.
 *
 * Считается не «лучом от поверхности», а полным сканированием линии: срез —
 * фасетированная поверхность, и реальная грань лежит на десятые доли
 * миллиметра выше идеальной кривой профиля. Луч, пущенный от идеальной
 * поверхности, стартовал бы вне материала и показывал ложный ноль. Поэтому
 * находим интервалы материала вдоль вертикали и берём тот, что содержит точку.
 *
 * @param dir направление внутрь детали: [0,0,1] — вверх (часть A), [0,0,-1] — вниз (B)
 * @param maxDist ограничение сверху; возвращается не больше него
 */
export function materialDepth(m: Manifold, from: Vec3, dir: Vec3, maxDist: number): number {
  if (maxDist <= 0) return 0;
  const sign = dir[2] >= 0 ? 1 : -1;
  let extent = 100;
  try {
    const box = m.boundingBox();
    extent = Math.max(
      10,
      Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) * 2,
    );
  } catch {
    /* оставляем значение по умолчанию */
  }
  const top = from[2] + extent;
  const bottom = from[2] - extent;
  try {
    const hits = m.rayCast([from[0], from[1], top], [from[0], from[1], bottom]);
    if (hits.length < 2) return 0;
    const span = top - bottom;
    // Пары «вход-выход»: луч начинает путь снаружи, поэтому 0-1, 2-3, ...
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const hi = top - hits[i].distance * span;
      const lo = top - hits[i + 1].distance * span;
      // Допуск на фасетирование: точка считается внутри интервала, даже если
      // идеальная поверхность чуть ниже реальной грани.
      const tol = 0.4;
      if (from[2] >= lo - tol && from[2] <= hi + tol) {
        const depth = sign > 0 ? hi - from[2] : from[2] - lo;
        return Math.max(0, Math.min(depth, maxDist));
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

export interface PinBodies {
  pin: Manifold;
  hole: Manifold;
}

/**
 * Штифт и отверстие в одной точке.
 *
 * Штифт всегда идёт вдоль нормали плоскости среза (+Z) — все штифты параллельны
 * друг другу, поэтому детали собираются движением по нормали. Наклонять штифт
 * по местной нормали нельзя: на куполе штифты «расходятся веером» и вставить их
 * невозможно.
 *
 * engagement — насколько штифт входит в соседнюю часть B;
 * root — насколько он утоплен в своей части A (чтобы держался).
 */
export function buildPinBodies(
  plan: PinPlan,
  point: Vec2,
  surfaceZ: number,
  engagement: number,
  root: number,
): PinBodies | null {
  const { Manifold } = getAPI();
  const rBase = plan.radius;
  const rTip = Math.max(0.2, plan.radius * plan.taper);
  const len = engagement + root;
  if (len <= 0.2 || engagement <= 0.2) return null;
  // Конус вдоль +Z: от z = surfaceZ - engagement (в B) до surfaceZ + root (в A).
  const make = (rLo: number, rHi: number, extra: number, extraRoot: number): Manifold => {
    const total = len + extra + extraRoot;
    return Manifold.cylinder(total, rLo, rHi, 48, false).translate(0, 0, -engagement - extra);
  };
  const pin = make(rTip, rBase, 0, 0).translate(point[0], point[1], surfaceZ);
  const hole = make(rTip + plan.clearance, rBase + plan.clearance, 0.8, 0.3).translate(
    point[0],
    point[1],
    surfaceZ,
  );
  if (pin.status() !== 'NoError' || hole.status() !== 'NoError') {
    pin.delete();
    hole.delete();
    return null;
  }
  return { pin, hole };
}
