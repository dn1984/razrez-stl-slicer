// Состояние приложения и расчёт параметров реза из него.

import type { CutSettings, Vec3 } from '../geometry/types.ts';

export type Axis = 'x' | 'y' | 'z';

export interface ModelInfo {
  name: string;
  triangles: number;
  weldedVertices: number;
  degenerate: number;
  duplicate: number;
  volume: number;
  bboxMin: Vec3;
  bboxMax: Vec3;
  format: 'binary' | 'ascii';
}

export interface AppState {
  model: ModelInfo | null;

  axis: Axis;
  /** Смещение плоскости вдоль оси, мм от центра габарита. */
  planePos: number;
  /** Наклон плоскости, градусы. */
  planeAngle: number;
  planeVisible: boolean;

  profileShape: 'flat' | 'dome' | 'dish';
  profileHeight: number;
  falloff: 'smooth' | 'sphere';

  stepEnabled: boolean;
  stepWidth: number;
  stepHeight: number;

  pinsEnabled: boolean;
  pinDiameter: number;
  pinDepth: number;
  pinCount: number;
  pinClearance: number;
  manualPins: [number, number][];

  tongueEnabled: boolean;
  tongueWidth: number;
  tongueDepth: number;

  extraEnabled: boolean;
  /** Ось второго реза. */
  extraAxis: Axis;
  extraPos: number;
  /** Наклон второго реза, градусы. */
  extraAngle: number;
  /** Держать второй рез параллельно первому (повторять его наклон). */
  extraParallel: boolean;
  extraVisible: boolean;

  explode: number;
  tableLayout: boolean;
}

export function initialState(): AppState {
  return {
    model: null,
    axis: 'z',
    planePos: 0,
    planeAngle: 0,
    planeVisible: true,
    profileShape: 'flat',
    profileHeight: 3,
    falloff: 'smooth',
    stepEnabled: true,
    stepWidth: 4,
    stepHeight: 1.5,
    pinsEnabled: false,
    pinDiameter: 4,
    pinDepth: 6,
    pinCount: 4,
    pinClearance: 0.2,
    manualPins: [],
    tongueEnabled: false,
    tongueWidth: 14,
    tongueDepth: 5,
    extraEnabled: false,
    extraAxis: 'x',
    extraPos: 0,
    extraAngle: 0,
    extraParallel: false,
    extraVisible: true,
    explode: 0,
    tableLayout: false,
  };
}

const AXIS_VECTORS: Record<Axis, Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Вектор, перпендикулярный оси, — вокруг него наклоняем плоскость. */
const AXIS_TANGENTS: Record<Axis, Vec3> = {
  x: [0, 0, 1],
  y: [0, 0, 1],
  z: [1, 0, 0],
};

export function centerOf(state: AppState): Vec3 {
  const m = state.model;
  if (!m) return [0, 0, 0];
  return [
    (m.bboxMin[0] + m.bboxMax[0]) / 2,
    (m.bboxMin[1] + m.bboxMax[1]) / 2,
    (m.bboxMin[2] + m.bboxMax[2]) / 2,
  ];
}

export function sizeOf(state: AppState): Vec3 {
  const m = state.model;
  if (!m) return [100, 100, 100];
  return [m.bboxMax[0] - m.bboxMin[0], m.bboxMax[1] - m.bboxMin[1], m.bboxMax[2] - m.bboxMin[2]];
}

/** Допустимый диапазон положения плоскости вдоль оси (по габариту). */
export function planeRange(state: AppState, axis: Axis = state.axis): { min: number; max: number } {
  const size = sizeOf(state);
  const half = size[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] / 2;
  if (!(half > 0)) return { min: -50, max: 50 };
  // Не даём плоскости выйти точно на грань: сечение станет вырожденным.
  return { min: -half * 0.98, max: half * 0.98 };
}

export interface PlaneSpecResolved {
  point: Vec3;
  normal: Vec3;
}

/**
 * Точка и нормаль плоскости по состоянию.
 *
 * Точка — центр габарита, сдвинутый по оси на pos. Нормаль — вдоль оси,
 * повёрнутая на angle градусов вокруг перпендикуляра к оси.
 */
export function resolvePlane(
  state: AppState,
  axis: Axis = state.axis,
  pos = state.planePos,
  angleDeg: number | null = null,
): PlaneSpecResolved {
  const center = centerOf(state);
  const dir = AXIS_VECTORS[axis];
  const point: Vec3 = [
    center[0] + dir[0] * pos,
    center[1] + dir[1] * pos,
    center[2] + dir[2] * pos,
  ];

  const angle = ((angleDeg ?? state.planeAngle) * Math.PI) / 180;
  if (Math.abs(angle) < 1e-9) return { point, normal: [dir[0], dir[1], dir[2]] };

  // Поворот нормали вокруг оси-перпендикуляра (формула Родригеса).
  const t = AXIS_TANGENTS[axis];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dir[0] * t[0] + dir[1] * t[1] + dir[2] * t[2];
  const cross: Vec3 = [
    t[1] * dir[2] - t[2] * dir[1],
    t[2] * dir[0] - t[0] * dir[2],
    t[0] * dir[1] - t[1] * dir[0],
  ];
  const normal: Vec3 = [
    dir[0] * c + cross[0] * s + t[0] * d * (1 - c),
    dir[1] * c + cross[1] * s + t[1] * d * (1 - c),
    dir[2] * c + cross[2] * s + t[2] * d * (1 - c),
  ];
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return { point, normal: [normal[0] / len, normal[1] / len, normal[2] / len] };
}

/** Настройки первого (основного) реза. */
export function primaryCut(state: AppState): CutSettings {
  return {
    id: 'cut-1',
    name: 'Рез 1',
    plane: resolvePlane(state),
    profile: {
      shape: state.profileShape,
      height: state.profileShape === 'flat' ? 0 : state.profileHeight,
      radius: null,
      falloff: state.falloff,
    },
    step: { enabled: state.stepEnabled, width: state.stepWidth, height: state.stepHeight },
    pins: {
      enabled: state.pinsEnabled,
      diameter: state.pinDiameter,
      depth: state.pinDepth,
      clearance: state.pinClearance,
      taper: 0.85,
      maxCount: state.pinCount,
      manual: state.manualPins.map(([u, v]) => [u, v]),
    },
    tongue: {
      enabled: state.tongueEnabled,
      width: state.tongueWidth,
      depth: state.tongueDepth,
      clearance: state.pinClearance,
      taper: 0.22,
      lengthScale: 0.7,
    },
  };
}

/**
 * Настройки второго реза.
 *
 * Два режима:
 * - независимый (по умолчанию): своя ось и свой наклон — так деталь делится
 *   на четыре части;
 * - параллельный первому: нормаль копируется у первой плоскости, ползунок
 *   положения сдвигает вторую плоскость вдоль этой нормали. Получается
 *   параллельный отрез (тонкая пластина), а не деление на четыре части.
 */
export function secondaryCut(state: AppState): CutSettings {
  const base = primaryCut(state);
  if (state.extraParallel) {
    // Нормаль берём у первого реза, точку отсчитываем от центра габарита.
    const first = base.plane;
    const center = centerOf(state);
    const point: Vec3 = [
      center[0] + first.normal[0] * state.extraPos,
      center[1] + first.normal[1] * state.extraPos,
      center[2] + first.normal[2] * state.extraPos,
    ];
    return {
      ...base,
      id: 'cut-2',
      name: 'Рез 2',
      plane: { point, normal: [first.normal[0], first.normal[1], first.normal[2]] },
      profile: { shape: 'flat', height: 0, radius: null, falloff: 'smooth' },
    };
  }
  return {
    ...base,
    id: 'cut-2',
    name: 'Рез 2',
    plane: resolvePlane(state, state.extraAxis, state.extraPos, state.extraAngle),
    // Второй рез всегда плоский: иначе замки двух резов могут пересечься.
    profile: { shape: 'flat', height: 0, radius: null, falloff: 'smooth' },
  };
}

export function allCuts(state: AppState): CutSettings[] {
  const cuts: CutSettings[] = [];
  if (!state.model) return cuts;
  cuts.push(primaryCut(state));
  if (state.extraEnabled) cuts.push(secondaryCut(state));
  return cuts;
}
