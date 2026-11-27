// Тестовый помощник: инициализация ядра и базовые настройки реза.

import { initManifold, manifoldFromPositions } from '../../src/geometry/manifold.ts';
import type { CutSettings, ProfileSpec } from '../../src/geometry/types.ts';

export async function boot() {
  return initManifold();
}

export function defaultProfile(overrides: Partial<ProfileSpec> = {}): ProfileSpec {
  return { shape: 'flat', height: 0, radius: null, falloff: 'smooth', ...overrides };
}

export function makeCut(overrides: Partial<CutSettings> = {}): CutSettings {
  const base: CutSettings = {
    id: 'cut-1',
    name: 'Рез 1',
    plane: { point: [0, 0, 0], normal: [0, 0, 1] },
    area: { enabled: false, width: 100, height: 100, offsetU: 0, offsetV: 0 },
    profile: defaultProfile(),
    step: { enabled: false, width: 4, height: 1.2 },
    pins: { enabled: false, diameter: 4, depth: 6, clearance: 0.2, taper: 0.85, maxCount: 4, manual: [] },
    tongue: { enabled: false, width: 12, depth: 5, clearance: 0.2, taper: 0.25, lengthScale: 0.7 },
  };
  return { ...base, ...overrides };
}

export function build(soup: Float32Array) {
  let size = 0;
  for (let i = 0; i < soup.length; i += 3) size = Math.max(size, Math.abs(soup[i]), Math.abs(soup[i + 1]), Math.abs(soup[i + 2]));
  const { manifold, status, report } = manifoldFromPositions(soup, Math.max(1, size * 2));
  if (!manifold) throw new Error(`Модель не собралась: ${status}`);
  return { manifold, report };
}
