// Оркестрация реза: плоскости → режущие тела → части → замки → проверки.

import type { Manifold } from './manifold.ts';
import { getAPI, manifoldToPart, safeVolume } from './manifold.ts';
import { buildCutters, buildProfile } from './profile.ts';
import type { ProfileFunction } from './profile.ts';
import {
  buildPinBodies,
  buildStepBody,
  buildTongueBodies,
  materialDepth,
  planPins,
  planStep,
  planTongue,
  surfaceHeight,
  surfaceSlope,
} from './joints.ts';
import type { SectionInfo } from './joints.ts';
import {
  basisFromNormal,
  centroid2,
  localPointToWorld,
  localToWorldMatrix,
  pointInPolygons,
  worldToLocalMatrix,
} from './math.ts';
import type { CutAreaSpec, CutPreview, CutSettings, CutStats, PartGeometry, Vec2 } from './types.ts';

export interface CutInput {
  manifold: Manifold;
  cuts: CutSettings[];
  /** Проверять пересечение частей булевой операцией (дорого на больших сетках). */
  verify?: boolean;
  verifyLimit?: number;
  /** Допуск упрощения сетки после булевых операций, мм. */
  simplifyTolerance?: number;
}

export interface CutOutput {
  parts: { manifold: Manifold; side: 'A' | 'B' }[];
  stats: CutStats[];
  previews: CutPreview[];
}

interface SectionResult {
  polygons: Vec2[][];
  area: number;
  center: Vec2;
  maxRadius: number;
  bounds: { min: Vec2; max: Vec2 };
}

function sectionFromSlice(m: Manifold): SectionResult {
  let cs = m.slice(0.0001);
  if (cs.isEmpty() || cs.numContour() === 0) cs = m.slice(-0.0001);
  if (cs.isEmpty() || cs.numContour() === 0) cs = m.slice(0);
  if (cs.isEmpty() || cs.numContour() === 0) {
    return { polygons: [], area: 0, center: [0, 0], maxRadius: 0, bounds: { min: [0, 0], max: [0, 0] } };
  }
  const polygons = (cs.toPolygons() as Vec2[][]).map((p) => p.map(([x, y]) => [x, y] as Vec2));
  const area = cs.area();
  const b = cs.bounds();
  const bounds = { min: [b.min[0], b.min[1]] as Vec2, max: [b.max[0], b.max[1]] as Vec2 };
  const center = centroid2(polygons);
  let maxRadius = 0;
  for (const poly of polygons) {
    for (const p of poly) {
      const r = Math.hypot(p[0] - center[0], p[1] - center[1]);
      if (r > maxRadius) maxRadius = r;
    }
  }
  return { polygons, area, center, maxRadius, bounds };
}

const toSectionInfo = (s: SectionResult): SectionInfo => ({ polygons: s.polygons, area: s.area, bounds: s.bounds });

/** Форматирование миллиметров в предупреждениях. */
const fmtMm = (v: number): string => `${v.toFixed(1).replace('.', ',')} мм`;

/** Точки внутри сечения для зондирования толщины: центр плюс сетка. */
function samplePoints(section: SectionInfo, count: number): Vec2[] {
  const points: Vec2[] = [centroid2(section.polygons)];
  const side = Math.max(2, Math.round(Math.sqrt(count)));
  const { min, max } = section.bounds;
  const dx = (max[0] - min[0]) / (side + 1);
  const dy = (max[1] - min[1]) / (side + 1);
  for (let i = 1; i <= side; i++) {
    for (let j = 1; j <= side; j++) {
      const x = min[0] + dx * i;
      const y = min[1] + dy * j;
      if (pointInPolygons(section.polygons, x, y)) points.push([x, y]);
    }
  }
  return points;
}

/**
 * Толщина материала по набору точек сечения — по нижнему процентилю, а не по
 * абсолютному минимуму: отдельная точка может попасть в гравировку или в
 * узкий паз, где материала вниз нет вообще, и тогда «минимум» обнулял бы
 * оценку для всей детали.
 */
function minMaterialDepth(
  m: Manifold,
  points: Vec2[],
  profile: ProfileFunction,
  center: Vec2,
  dir: [number, number, number],
  maxDist: number,
): number {
  const depths: number[] = [];
  for (const p of points) {
    const z = surfaceHeight(profile, center, p);
    const d = materialDepth(m, [p[0], p[1], z], dir, maxDist);
    if (d > 0) depths.push(d);
  }
  if (depths.length === 0) return 0;
  depths.sort((a, b) => a - b);
  const index = Math.min(depths.length - 1, Math.floor(depths.length * 0.15));
  return depths[index];
}

/** Допустимая зона для замков: сечение, сжатое на отступ от края. */
function allowedRegion(section: SectionResult, margin: number): SectionInfo {
  const { CrossSection } = getAPI();
  if (section.polygons.length === 0) return toSectionInfo(section);
  try {
    const cs = new CrossSection(section.polygons, 'NonZero');
    const eroded = cs.offset(-Math.max(0.5, margin), 'Round');
    if (eroded.isEmpty() || eroded.numContour() === 0) return { polygons: [], area: 0, bounds: section.bounds };
    const b = eroded.bounds();
    return {
      polygons: eroded.toPolygons() as Vec2[][],
      area: eroded.area(),
      bounds: { min: [b.min[0], b.min[1]] as Vec2, max: [b.max[0], b.max[1]] as Vec2 },
    };
  } catch {
    return { polygons: [], area: 0, bounds: section.bounds };
  }
}

/** Пересекает ли плоскость габарит части (быстрая отсечка). */
function planeCrosses(m: Manifold, cut: CutSettings): boolean {
  const box = m.boundingBox();
  const n = cut.plane.normal;
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
  const d = nx * cut.plane.point[0] + ny * cut.plane.point[1] + nz * cut.plane.point[2];
  let minS = Infinity;
  let maxS = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max[0] : box.min[0];
    const y = i & 2 ? box.max[1] : box.min[1];
    const z = i & 4 ? box.max[2] : box.min[2];
    const s = nx * x + ny * y + nz * z - d;
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
  }
  const eps = 1e-4;
  return minS < -eps && maxS > eps;
}

/** Упрощение сетки: убирает лишние вершины на плоских участках. */
function simplify(m: Manifold, tolerance: number): Manifold {
  if (!(tolerance > 0)) return m;
  try {
    const s = m.simplify(tolerance);
    if (s.status() !== 'NoError') {
      s.delete();
      return m;
    }
    m.delete();
    return s;
  } catch {
    return m;
  }
}

interface SplitPair {
  a: Manifold;
  b: Manifold;
}

/** Прямоугольник ограниченной области реза в координатах сечения. */
/**
 * Прямоугольник ограниченной области реза в координатах сечения.
 *
 * Сдвиг отсчитывается от начала координат плоскости (точки, вокруг которой
 * строится базис сечения), а НЕ от центроида сечения. Так окно совпадает с тем
 * прямоугольником, который рисуется в сцене: у несимметричной модели (крыло,
 * фюзеляж, хвост) центроид уезжает в сторону, и окно резало совсем не там,
 * где его видел пользователь.
 */
function areaRect(area: CutAreaSpec | undefined, _center: Vec2): { min: Vec2; max: Vec2 } | null {
  if (!area?.enabled) return null;
  const w = Math.max(0.5, area.width);
  const h = Math.max(0.5, area.height);
  const cx = area.offsetU ?? 0;
  const cy = area.offsetV ?? 0;
  return { min: [cx - w / 2, cy - h / 2], max: [cx + w / 2, cy + h / 2] };
}

const rectPolygon = (r: { min: Vec2; max: Vec2 }): Vec2[] => [
  [r.min[0], r.min[1]],
  [r.max[0], r.min[1]],
  [r.max[0], r.max[1]],
  [r.min[0], r.max[1]],
];

/**
 * Обрезает сечение прямоугольным окном. Возвращает обрезанные контуры и их
 * площадь — по ним ставятся замки и рисуется контур среза, чтобы всё это
 * оставалось внутри реально разрезаемой области.
 */
function clipSection(
  section: SectionResult,
  rect: { min: Vec2; max: Vec2 },
): { polygons: Vec2[][]; area: number; bounds: { min: Vec2; max: Vec2 } } {
  const { CrossSection } = getAPI();
  try {
    const region = new CrossSection(section.polygons, 'NonZero');
    const window = new CrossSection([rectPolygon(rect)], 'NonZero');
    const clipped = region.intersect(window);
    if (clipped.isEmpty() || clipped.numContour() === 0) {
      return { polygons: [], area: 0, bounds: rect };
    }
    return {
      polygons: clipped.toPolygons() as Vec2[][],
      area: clipped.area(),
      bounds: rect,
    };
  } catch {
    return { polygons: [], area: 0, bounds: rect };
  }
}

function splitAndJoin(
  world: Manifold,
  cut: CutSettings,
  stats: CutStats,
  preview: CutPreview,
  tolerance: number,
): SplitPair | null {
  const basis = basisFromNormal(cut.plane.normal);
  const origin = cut.plane.point;
  const toWorld = localToWorldMatrix(basis, origin);
  const toLocal = worldToLocalMatrix(basis, origin);

  const local = world.transform(toLocal);
  if (local.status() !== 'NoError') {
    local.delete();
    stats.error = 'Не удалось перевести модель в систему плоскости среза.';
    return null;
  }

  const section = sectionFromSlice(local);
  if (section.polygons.length === 0) {
    local.delete();
    stats.error = 'Плоскость касается модели по касательной — сечения нет.';
    return null;
  }
  stats.sectionArea = section.area;
  stats.sectionContours = section.polygons.length;

  const profile: ProfileFunction = buildProfile(cut.profile, section.maxRadius);
  const box = local.boundingBox();
  const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  // Режущее тело — тело вращения вокруг центра профиля. Если ось пустить через
  // начало координат, а сечение лежит в стороне (рез мимо центра детали), тело
  // не накрывает сечение целиком и куски «чужой» стороны уезжают в другую
  // часть: рез получается выгрызенным по дуге, с выступающими углами.
  const cutters = buildCutters(profile, {
    radius: Math.max(section.maxRadius * 1.05 + 1, 1),
    height: diag + Math.abs(profile.peak) * 2 + 10,
    center: section.center,
  });

  // Ограниченная область: режем не всю плоскость, а прямоугольное окно в ней.
  // Всё, что за окном, остаётся нетронутым и уходит в часть B целиком — именно
  // это нужно, когда пилишь крыло, а плоскость задевает ещё и хвост.
  const rect = areaRect(cut.area, section.center);
  let cutterA = cutters.cutterA;
  if (rect) {
    const { Manifold } = getAPI();
    const w = rect.max[0] - rect.min[0];
    const h = rect.max[1] - rect.min[1];
    const zFrom = -(diag + 12);
    const zTo = diag + 12;
    const windowPrism = Manifold.cube([w, h, zTo - zFrom], false).translate(rect.min[0], rect.min[1], zFrom);
    const bounded = cutterA.intersect(windowPrism);
    windowPrism.delete();
    if (bounded.status() !== 'NoError' || bounded.isEmpty()) {
      bounded.delete();
      cutters.cutterA.delete();
      cutters.cutterB.delete();
      local.delete();
      stats.error = 'Ограниченная область реза не задевает модель — увеличьте окно или сдвиньте его.';
      return null;
    }
    cutters.cutterA.delete();
    cutterA = bounded;
    stats.sectionArea = clipSection(section, rect).area;
  }

  const split = local.split(cutterA);
  local.delete();
  cutterA.delete();
  cutters.cutterB.delete();

  let [aLocal, bLocal] = split;
  if (aLocal.status() !== 'NoError' || bLocal.status() !== 'NoError') {
    stats.error = `Ядро не смогло разрезать: ${aLocal.status()} / ${bLocal.status()}.`;
    aLocal.delete();
    bLocal.delete();
    return null;
  }
  if (aLocal.isEmpty() || bLocal.isEmpty()) {
    stats.error = 'Плоскость не пересекает эту часть модели.';
    aLocal.delete();
    bLocal.delete();
    return null;
  }

  // Булевы операции с телом вращения дают много лишних треугольников —
  // упрощаем сразу, пока сетка ещё в локальной системе.
  const tol = Math.max(tolerance, diag * 1e-5);
  aLocal = simplify(aLocal, tol);
  bLocal = simplify(bLocal, tol);

  const warnings = stats.warnings;
  const clearance = cut.pins.clearance;
  const margin = cut.pins.diameter / 2 + clearance + 1.5;
  // Если рез ограничен окном, замки и замеры толщины делаем только внутри него:
  // штифт, поставленный за окном, попал бы в неразрезанный материал и оставил
  // бы дырку в глубине детали.
  const jointSection: SectionResult = rect
    ? (() => {
        const clipped = clipSection(section, rect);
        return { ...section, polygons: clipped.polygons, area: clipped.area, bounds: clipped.bounds };
      })()
    : section;
  const allowed = allowedRegion(jointSection, margin);
  const sectionInfo = toSectionInfo(jointSection);

  const applyPair = (male: Manifold, female: Manifold): boolean => {
    if (male.status() !== 'NoError' || female.status() !== 'NoError') {
      male.delete();
      female.delete();
      return false;
    }
    stats.jointVolumeAdded += safeVolume(male);
    stats.jointVolumeRemoved += safeVolume(female);
    aLocal = aLocal.add(male);
    bLocal = bLocal.subtract(female);
    male.delete();
    female.delete();
    return true;
  };

  // --- Сколько материала есть по обе стороны среза ---
  // Всё, что выступает за деталь, бесполезно или вредно: штифт, торчащий с
  // обратной стороны, и отверстие насквозь. Поэтому толщину измеряем лучами.
  // ВАЖНО: измерять нужно до применения замков — иначе полость ступеньки
  // читается как «пустота» и все штифты отбраковываются.
  const probes = samplePoints(sectionInfo, 24);
  const maxProbe = Math.max(cut.step.height, cut.tongue.depth, cut.pins.depth) + 6;
  const thicknessA = minMaterialDepth(aLocal, probes, profile, section.center, [0, 0, 1], maxProbe);
  const thicknessB = minMaterialDepth(bLocal, probes, profile, section.center, [0, 0, -1], maxProbe);
  const skin = 0.8; // сколько материала обязано остаться за концом замка

  // План штифтов и глубины по каждому кандидату — тоже до замков.
  const pinPlan = cut.pins.enabled ? planPins(allowed, cut.pins, margin) : null;
  const pinWall = pinPlan ? Math.max(skin, pinPlan.radius * 0.8) : skin;
  const pinSlots = pinPlan
    ? pinPlan.points.map((p) => {
        const slope = surfaceSlope(profile, section.center, p);
        const surfaceZ = surfaceHeight(profile, section.center, p);
        const availB = materialDepth(bLocal, [p[0], p[1], surfaceZ], [0, 0, -1], pinPlan.depth + pinWall + 2);
        const availA = materialDepth(aLocal, [p[0], p[1], surfaceZ], [0, 0, 1], pinPlan.rootDepth + pinWall + 2);
        return { p, slope, surfaceZ, availB, availA };
      })
    : [];

  // --- Ступенька ---
  let stepHeight = 0;
  let stepInner: Vec2[][] | null = null;
  if (cut.step.enabled) {
    const allowedHeight = thicknessB - skin;
    if (allowedHeight < 0.4) {
      warnings.push(
        `Ступенька не сделана: деталь в этом месте толщиной ${fmtMm(thicknessB)} — выступ ${fmtMm(cut.step.height)} проткнул бы её насквозь.`,
      );
    } else {
      const step = planStep(sectionInfo, { ...cut.step, height: Math.min(cut.step.height, allowedHeight) }, 4);
      if (!step.applied) {
        warnings.push('Ступенька не поместилась: сечение слишком узкое или мелкое.');
      } else {
        const bodies = buildStepBody(step, profile, clearance, section.maxRadius, section.center);
        if (bodies && applyPair(bodies.male, bodies.female)) {
          stats.stepApplied = true;
          stats.stepWidth = step.width;
          stepHeight = step.height;
          stepInner = step.innerPolygons;
          if (step.height < cut.step.height - 1e-6) {
            warnings.push(
              `Высота ступеньки уменьшена до ${fmtMm(step.height)}: деталь толщиной ${fmtMm(thicknessB)}.`,
            );
          }
        } else {
          warnings.push('Не удалось построить ступеньку на этом сечении.');
        }
      }
    }
  }

  // --- Шип-паз ---
  if (cut.tongue.enabled) {
    const availableDepth = thicknessB - skin;
    if (availableDepth < 1) {
      warnings.push(
        `Шип не сделан: деталь толщиной ${fmtMm(thicknessB)} тоньше, чем нужно для шипа глубиной ${fmtMm(cut.tongue.depth)}.`,
      );
    } else {
      const tongue = planTongue(allowed, { ...cut.tongue, depth: Math.min(cut.tongue.depth, availableDepth) }, section.center);
      if (!tongue.applied) {
        for (const w of tongue.warnings) warnings.push(w);
      } else {
        const bodies = buildTongueBodies(tongue, profile, section.maxRadius, availableDepth, section.center);
        if (bodies && applyPair(bodies.male, bodies.female)) {
          stats.tongueApplied = true;
          if (tongue.depth < cut.tongue.depth - 1e-6) {
            warnings.push(`Глубина шипа уменьшена до ${fmtMm(tongue.depth)} по толщине детали.`);
          }
        } else {
          warnings.push('Не удалось построить шип на этом сечении.');
        }
      }
    }
  }

  // --- Штифты ---
  if (pinPlan) {
    for (const w of pinPlan.warnings) warnings.push(w);
    const minEngagement = Math.max(1.0, pinPlan.radius * 1.2);
    // Свободный запас до края сечения: тот же отступ, что заложен в допустимую зону.
    const lateralRoom = clearance + 1.5;
    let skippedThin = 0;
    let skippedSteep = 0;
    for (const slot of pinSlots) {
      // Крутой склон: штифт, идущий по нормали, вышел бы через боковую стенку.
      if (slot.slope > 1.0) {
        skippedSteep++;
        continue;
      }
      // Если в этом месте есть ступенька, штифт растёт от её подошвы, а не от
      // поверхности среза: там уже стоит выступ части A.
      const inStep = stepInner !== null && stepHeight > 0 && pointInPolygons(stepInner, slot.p[0], slot.p[1]);
      const baseZ = inStep ? slot.surfaceZ - stepHeight : slot.surfaceZ;
      const roomB = inStep ? slot.availB - stepHeight - clearance : slot.availB;
      const roomA = inStep ? slot.availA + stepHeight : slot.availA;
      // На склоне стенка уходит в сторону: чем круче, тем короче должен быть
      // штифт, иначе он пробьёт боковину.
      const slopeLimit = lateralRoom / Math.max(slot.slope, 0.02);
      const engagement = Math.min(pinPlan.depth, roomB - pinWall, slopeLimit);
      const root = Math.min(pinPlan.rootDepth, roomA - pinWall);
      if (engagement < minEngagement || root < 0.5) {
        if (engagement < minEngagement && slot.slope > 0.25) skippedSteep++;
        else skippedThin++;
        continue;
      }
      const bodies = buildPinBodies(pinPlan, slot.p, baseZ, engagement, root);
      if (!bodies) {
        skippedThin++;
        continue;
      }
      if (!applyPair(bodies.pin, bodies.hole)) continue;
      preview.pins.push(localPointToWorld(basis, origin, [slot.p[0], slot.p[1], baseZ]));
      preview.pinAxes.push([basis.n[0], basis.n[1], basis.n[2]]);
      stats.pinCount++;
    }
    if (skippedThin > 0) {
      warnings.push(
        `Штифтов не поставлено: ${skippedThin}. Деталь толщиной ${fmtMm(Math.min(thicknessA, thicknessB))} — для штифта диаметром ${fmtMm(pinPlan.radius * 2)} нужно больше материала (толщина не меньше диаметра плюс ${fmtMm(pinWall * 2)}).`,
      );
    }
    if (skippedSteep > 0) {
      warnings.push(`Штифтов не поставлено на крутом склоне среза: ${skippedSteep}. Уменьшите высоту скругления.`);
    }
  }

  // --- Назад в мир ---
  // После добавления мелких штифтов/отверстий не упрощаем сетку: simplify()
  // может схлопнуть тонкие треугольники на границе цилиндра и дать видимые
  // «веера»/тёмные треугольники вокруг замка. Для чистого плоского реза
  // упрощение остаётся включённым.
  const hasFineJoints = cut.pins.enabled || cut.step.enabled || cut.tongue.enabled;
  const outputTolerance = hasFineJoints ? 0 : tol;
  const aWorld = simplify(aLocal.transform(toWorld), outputTolerance);
  const bWorld = simplify(bLocal.transform(toWorld), outputTolerance);
  aLocal.delete();
  bLocal.delete();

  if (aWorld.status() !== 'NoError' || bWorld.status() !== 'NoError') {
    stats.error = 'Ошибка при возврате частей в исходные координаты.';
    aWorld.delete();
    bWorld.delete();
    return null;
  }

  preview.profileCenter = localPointToWorld(basis, origin, [section.center[0], section.center[1], 0]);
  preview.profileRadius = profile.radius;
  preview.profilePeak = profile.peak;
  // Контур среза рисуем только там, где действительно режем.
  preview.section = jointSection.polygons.map((poly) =>
    poly.map(([u, v]) =>
      localPointToWorld(basis, origin, [
        u,
        v,
        profile.height(Math.hypot(u - section.center[0], v - section.center[1])),
      ]),
    ),
  );
  preview.area = rect
    ? {
        width: rect.max[0] - rect.min[0],
        height: rect.max[1] - rect.min[1],
        center: localPointToWorld(basis, origin, [
          (rect.min[0] + rect.max[0]) / 2,
          (rect.min[1] + rect.max[1]) / 2,
          0,
        ]),
      }
    : null;

  return { a: aWorld, b: bWorld };
}

export function runCuts(input: CutInput): CutOutput {
  const stats: CutStats[] = [];
  const previews: CutPreview[] = [];
  const source = input.manifold;
  let current: { manifold: Manifold; side: 'A' | 'B' }[] = [{ manifold: source, side: 'A' }];
  // Тела, которые создали мы; исходное тело не наше и не удаляется.
  const owned = new Set<Manifold>();

  for (const cut of input.cuts) {
    const cutStats: CutStats = {
      id: cut.id,
      name: cut.name,
      ok: false,
      warnings: [],
      volumeBefore: 0,
      volumeAfter: 0,
      volumeA: 0,
      volumeB: 0,
      jointVolumeAdded: 0,
      jointVolumeRemoved: 0,
      intersectionVolume: 0,
      sectionArea: 0,
      sectionContours: 0,
      pinCount: 0,
      splitCount: 0,
      stepApplied: false,
      stepWidth: 0,
      tongueApplied: false,
      ms: 0,
    };
    const preview: CutPreview = {
      id: cut.id,
      section: [],
      pins: [],
      pinAxes: [],
      profileCenter: cut.plane.point,
      profileRadius: 0,
      profilePeak: 0,
      planeDistance: { min: -1, max: 1 },
      area: null,
      ok: false,
    };
    const started = performance.now();

    const next: { manifold: Manifold; side: 'A' | 'B' }[] = [];
    const pairs: SplitPair[] = [];
    let anySplit = false;

    for (const part of current) {
      cutStats.volumeBefore += safeVolume(part.manifold);
      if (!planeCrosses(part.manifold, cut)) {
        next.push(part);
        continue;
      }
      const pair = splitAndJoin(part.manifold, cut, cutStats, preview, input.simplifyTolerance ?? 0);
      if (!pair) {
        next.push(part);
        continue;
      }
      anySplit = true;
      pairs.push(pair);
      owned.add(pair.a);
      owned.add(pair.b);
      owned.delete(part.manifold);
      next.push({ manifold: pair.a, side: 'A' });
      next.push({ manifold: pair.b, side: 'B' });
    }

    for (const n of next) cutStats.volumeAfter += safeVolume(n.manifold);
    for (const p of pairs) {
      cutStats.volumeA += safeVolume(p.a);
      cutStats.volumeB += safeVolume(p.b);
    }

    if (!anySplit) {
      if (!cutStats.error) cutStats.error = 'Плоскость не пересекает модель.';
      stats.push(cutStats);
      previews.push(preview);
      continue;
    }

    const verify = input.verify !== false;
    const totalTris = pairs.reduce((s, p) => s + p.a.numTri() + p.b.numTri(), 0);
    if (verify && totalTris <= (input.verifyLimit ?? 600_000)) {
      let inter = 0;
      for (const p of pairs) {
        const both = p.a.intersect(p.b);
        inter += safeVolume(both);
        both.delete();
      }
      cutStats.intersectionVolume = inter;
    }

    // Замки намеренно добавляют (выступы) и убирают (выемки) материал, поэтому
    // «объём сохранился» проверяется как двусторонняя граница: нельзя набрать
    // больше, чем добавили, и потерять больше, чем вырезали. Всё, что выходит за
    // эти пределы, — потеря или лишний материал, то есть дефект реза.
    const actual = cutStats.volumeAfter - cutStats.volumeBefore;
    const eps = Math.max(0.05, cutStats.volumeBefore * 1e-4);
    if (actual > cutStats.jointVolumeAdded + eps || actual < -cutStats.jointVolumeRemoved - eps) {
      cutStats.warnings.push(
        `Объём изменился на ${actual >= 0 ? '+' : ''}${actual.toFixed(1)} мм³, хотя замки добавляют ${cutStats.jointVolumeAdded.toFixed(1)} и убирают ${cutStats.jointVolumeRemoved.toFixed(1)} мм³ — проверьте срез.`,
      );
    }
    if (cutStats.intersectionVolume > Math.max(0.01, cutStats.volumeBefore * 1e-6)) {
      cutStats.warnings.push(
        `Части пересекаются на ${cutStats.intersectionVolume.toFixed(2)} мм³ — уменьшите ступеньку или увеличьте зазор.`,
      );
    }

    cutStats.ok = true;
    cutStats.ms = performance.now() - started;
    cutStats.splitCount = pairs.length;
    preview.ok = true;
    stats.push(cutStats);
    previews.push(preview);

    // Отбрасываем «пылинки»: у границы окна иногда получается обрезок в доли
    // кубического миллиметра. Он засоряет список частей и даёт пустой STL.
    // Делаем это последним — раньше pairs ещё нужны для проверок.
    const minPartVolume = Math.max(2, cutStats.volumeBefore * 1e-5);
    let dropped = 0;
    for (let i = next.length - 1; i >= 0; i--) {
      const candidate = next[i];
      if (owned.has(candidate.manifold) && safeVolume(candidate.manifold) < minPartVolume) {
        candidate.manifold.delete();
        owned.delete(candidate.manifold);
        next.splice(i, 1);
        dropped++;
      }
    }
    if (dropped > 0) {
      cutStats.warnings.push(
        `Отброшено пустых обрезков: ${dropped}. Область реза почти не задевает эту часть — сдвиньте окно или плоскость.`,
      );
    }

    current = next;
  }

  // Удаляем промежуточные тела (исходное тело остаётся у вызывающего).
  for (const m of owned) {
    if (!current.some((p) => p.manifold === m)) m.delete();
  }

  return { parts: current, stats, previews };
}

/** Превращает результат в плоские части для передачи в главный поток. */
export function toPartGeometries(output: CutOutput, modelName: string): PartGeometry[] {
  const result: PartGeometry[] = [];
  let a = 0;
  let b = 0;
  for (const part of output.parts) {
    const idx = part.side === 'A' ? ++a : ++b;
    const label = `${modelName} ${part.side}${idx}`;
    result.push(manifoldToPart(part.manifold, `${part.side}${idx}`, label, part.side));
  }
  return result;
}
