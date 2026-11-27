// Общие типы геометрического ядра.
// Здесь нет импорта WASM: ядро принимает api параметром, поэтому одни и те же
// функции работают и в воркере браузера, и в юнит-тестах Node.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type ProfileShape = 'flat' | 'dome' | 'dish';
export type ProfileFalloff = 'smooth' | 'sphere';

export interface PlaneSpec {
  point: Vec3;
  normal: Vec3;
}

export interface ProfileSpec {
  shape: ProfileShape;
  /** Глубина/высота искривления в мм (положительное число). */
  height: number;
  /** Радиус кривизны в мм; null — подобрать по сечению. */
  radius: number | null;
  falloff: ProfileFalloff;
}

export interface StepSpec {
  enabled: boolean;
  /** Ширина ступеньки от контура, мм. */
  width: number;
  /** Высота ступеньки, мм. */
  height: number;
}

export interface PinSpec {
  enabled: boolean;
  diameter: number;
  /** Глубина посадки в соседнюю часть, мм. */
  depth: number;
  clearance: number;
  /** Отношение диаметра на конце штифта к диаметру у основания. */
  taper: number;
  maxCount: number;
  /** Ручные позиции в координатах сечения (u,v), мм. */
  manual: Vec2[];
}

export interface TongueSpec {
  enabled: boolean;
  width: number;
  depth: number;
  clearance: number;
  taper: number;
  /** Доля длины хорды, которую занимает шип (0..1). */
  lengthScale: number;
}

export interface CutAreaSpec {
  /** Ограничить область действия реза прямоугольным окном в плоскости. */
  enabled: boolean;
  /** Размер окна по осям u и v плоскости, мм. */
  width: number;
  height: number;
  /** Сдвиг окна от центра сечения, мм. */
  offsetU: number;
  offsetV: number;
}

export interface CutSettings {
  id: string;
  name: string;
  plane: PlaneSpec;
  area?: CutAreaSpec;
  profile: ProfileSpec;
  step: StepSpec;
  pins: PinSpec;
  tongue: TongueSpec;
}

export interface CutStats {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  warnings: string[];
  /** Объёмы до реза (сумма по всем частям, которые режет эта плоскость). */
  volumeBefore: number;
  volumeAfter: number;
  volumeA: number;
  volumeB: number;
  /** Объём, добавленный выступами замков. */
  jointVolumeAdded: number;
  /** Объём, вычтенный выемками замков. */
  jointVolumeRemoved: number;
  /** Объём пересечения вышедших частей — должен быть 0. */
  intersectionVolume: number;
  sectionArea: number;
  sectionContours: number;
  pinCount: number;
  /** Сколько разрезов сделал этот рез (каждый добавляет одну часть). */
  splitCount: number;
  stepApplied: boolean;
  /** Фактическая ширина ступеньки (может быть меньше заданной). */
  stepWidth: number;
  tongueApplied: boolean;
  ms: number;
}

export interface PartGeometry {
  id: string;
  label: string;
  /** Исходная часть: 'A' (со стороны +нормали) или 'B'. */
  side: 'A' | 'B';
  positions: Float32Array;
  indices: Uint32Array;
  volume: number;
  triangles: number;
  bboxMin: Vec3;
  bboxMax: Vec3;
}

export interface CutPreview {
  id: string;
  /** Контуры сечения в мировых координатах (замкнутые ломаные). */
  section: Vec3[][];
  /** Позиции штифтов в мировых координатах. */
  pins: Vec3[];
  /** Оси штифтов (все параллельны нормали среза). */
  pinAxes: Vec3[];
  /** Центр профиля в мировых координатах (для индикатора кривизны). */
  profileCenter: Vec3;
  /** Радиус профиля в плане, мм. */
  profileRadius: number;
  /** Высота профиля со знаком, мм. */
  profilePeak: number;
  /** Расстояния от модели до плоскости по нормали: отрицательное — за плоскостью. */
  planeDistance: { min: number; max: number };
  /** Окно ограниченной области реза в мировых координатах (если включено). */
  area: { width: number; height: number; center: Vec3; coversSection?: boolean } | null;
  ok: boolean;
  error?: string;
}

export interface ComputeResult {
  parts: PartGeometry[];
  cuts: CutStats[];
  previews: CutPreview[];
  ms: number;
  sourceVolume: number;
}
