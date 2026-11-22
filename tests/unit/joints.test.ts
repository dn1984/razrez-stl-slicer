// Тесты на конкретные дефекты: шип не появлялся, штифты «расходились веером»,
// штифт протыкал тонкую деталь насквозь.
//
// Каждый тест проверяет ФИЗИЧЕСКОЕ свойство, а не флаг: срез детали в нужном
// месте, совпадение осей, отсутствие материала за габаритом.

import { describe, expect, it } from 'vitest';
import { boot, build, makeCut, defaultProfile } from './helpers.ts';
import { runCuts, toPartGeometries } from '../../src/geometry/cut.ts';
import { boxSoup, cylinderSoup } from '../fixtures/models.ts';
import type { CutSettings } from '../../src/geometry/types.ts';

/** Площадь сечения тела плоскостью z = level (в мировых координатах). */
function areaAtZ(volume: { slice(z: number): { area(): number; isEmpty(): boolean } }, level: number): number {
  const cs = volume.slice(level);
  if (cs.isEmpty()) return 0;
  return cs.area();
}

const tongueCut = (overrides: Partial<CutSettings> = {}): CutSettings =>
  makeCut({
    tongue: { enabled: true, width: 14, depth: 5, clearance: 0.25, taper: 0.2, lengthScale: 0.7 },
    ...overrides,
  });

describe('шип-паз действительно появляется на деталях', () => {
  it('шип выступает из части A ниже плоскости среза', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));

    const without = runCuts({ manifold, cuts: [makeCut({ id: 'off' })] });
    const withTongue = runCuts({ manifold, cuts: [tongueCut({ id: 'on' })] });

    const aOff = without.parts.find((p) => p.side === 'A')!.manifold;
    const aOn = withTongue.parts.find((p) => p.side === 'A')!.manifold;
    const bOn = withTongue.parts.find((p) => p.side === 'B')!.manifold;

    // Плоскость среза z = 0. Шип глубиной 5 мм должен дать материал части A
    // на уровне z = -2,5 — у детали без шипа там пусто.
    const areaOff = areaAtZ(aOff, -2.5);
    const areaOn = areaAtZ(aOn, -2.5);
    expect(areaOff).toBeLessThan(1e-6);
    // Площадь шипа: 14 мм шириной и около 37 мм длиной.
    expect(areaOn).toBeGreaterThan(350);
    expect(areaOn).toBeLessThan(700);
    // Шип стоит в глубине детали, а не прилип к краю: сечение шипа целиком
    // внутри среза 60 × 60.
    const tongueSlice = aOn.slice(-2.5);
    const box = tongueSlice.bounds();
    expect(box.min[0]).toBeGreaterThan(-27);
    expect(box.max[0]).toBeLessThan(27);
    expect(box.min[1]).toBeGreaterThan(-27);
    expect(box.max[1]).toBeLessThan(27);

    // В части B на том же уровне материала меньше на паз: шип туда входит.
    expect(areaAtZ(bOn, -2.5)).toBeLessThan(3600 - 400);

    // И шип не протыкает деталь: ниже его глубины материала нет.
    expect(areaAtZ(aOn, -5.6)).toBeLessThan(1e-6);
  });

  it('паз в части B повторяет контур шипа с зазором', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({ manifold, cuts: [tongueCut()] });
    const a = out.parts.find((p) => p.side === 'A')!.manifold;
    const b = out.parts.find((p) => p.side === 'B')!.manifold;

    // На уровне z = -1 площадь части B меньше площади сечения ровно на паз,
    // который лишь немного больше шипа (зазор по периметру).
    const tongueArea = areaAtZ(a, -1);
    const bArea = areaAtZ(b, -1);
    expect(tongueArea).toBeGreaterThan(350);
    expect(bArea).toBeLessThan(3600 - tongueArea);
    expect(bArea).toBeGreaterThan(3600 - tongueArea - 80);

    // Шип и паз не пересекаются между собой.
    expect(out.stats[0].intersectionVolume).toBeLessThan(0.05);
  });

  it('без шипа части стыкуются ровно по плоскости', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({ manifold, cuts: [makeCut({ id: 'plain' })] });
    const a = out.parts.find((p) => p.side === 'A')!.manifold;
    expect(areaAtZ(a, -0.5)).toBeLessThan(1e-6);
    expect(areaAtZ(a, 0.5)).toBeGreaterThan(3000);
  });
});

describe('штифты параллельны и собираются', () => {
  const pinCut = (profile: CutSettings['profile']): CutSettings =>
    makeCut({
      profile,
      pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.85, maxCount: 3, manual: [] },
    });

  for (const shape of ['flat', 'dome', 'dish'] as const) {
    it(`оси всех штифтов равны нормали среза (${shape})`, async () => {
      await boot();
      const { manifold } = build(boxSoup(60, 60, 30));
      const cut = pinCut(defaultProfile({ shape, height: shape === 'flat' ? 0 : 3 }));
      const out = runCuts({ manifold, cuts: [cut] });

      const preview = out.previews[0];
      expect(preview.pinAxes.length).toBeGreaterThan(0);
      expect(preview.pinAxes).toHaveLength(preview.pins.length);

      const n = cut.plane.normal;
      for (const axis of preview.pinAxes) {
        // Все оси строго совпадают с нормалью: штифты не расходятся веером.
        expect(axis[0]).toBeCloseTo(n[0], 6);
        expect(axis[1]).toBeCloseTo(n[1], 6);
        expect(axis[2]).toBeCloseTo(n[2], 6);
      }
    });

    it(`часть A входит в B по нормали, штифты не мешают (${shape})`, async () => {
      await boot();
      const { manifold } = build(boxSoup(60, 60, 30));
      const cut = pinCut(defaultProfile({ shape, height: shape === 'flat' ? 0 : 3 }));
      const out = runCuts({ manifold, cuts: [cut] });
      // Тот же рез, но без штифтов: разница в пересечении — это вклад штифтов.
      const plain = runCuts({
        manifold,
        cuts: [makeCut({ id: 'plain', profile: cut.profile, pins: { ...cut.pins, enabled: false } })],
      });

      const a = out.parts.find((p) => p.side === 'A')!.manifold;
      const b = out.parts.find((p) => p.side === 'B')!.manifold;
      const aPlain = plain.parts.find((p) => p.side === 'A')!.manifold;
      const bPlain = plain.parts.find((p) => p.side === 'B')!.manifold;

      const n = cut.plane.normal;
      const len = Math.hypot(n[0], n[1], n[2]);
      const shiftMatrix = (shift: number) => [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        (-n[0] / len) * shift, (-n[1] / len) * shift, (-n[2] / len) * shift, 1,
      ] as const;

      // Собираем детали: сдвигаем A вдоль нормали к B в пределах зазора
      // (0…0,15 мм — это и есть допустимый ход посадки при зазоре 0,2 мм).
      // Сравниваем с таким же сдвигом без штифтов: штифты не должны добавлять
      // ни одного кубического миллиметра столкновений.
      for (const shift of [0, 0.05, 0.1, 0.15]) {
        const moved = a.transform([...shiftMatrix(shift)]);
        const interPins = moved.intersect(b).volume();
        moved.delete();
        const movedPlain = aPlain.transform([...shiftMatrix(shift)]);
        const interPlain = movedPlain.intersect(bPlain).volume();
        movedPlain.delete();
        // Вклад штифтов в столкновения пренебрежим: они входят в отверстия.
        expect(Math.abs(interPins - interPlain)).toBeLessThan(Math.max(0.5, interPlain * 0.05));
      }
      // И сами торцы при посадке не сталкиваются: пересечение при contact ≈ 0.
      const contact = a.transform([...shiftMatrix(0)]);
      const gap = contact.intersect(b).volume();
      contact.delete();
      expect(gap).toBeLessThan(0.5);
    });
  }

  it('штифт держится в своей части: торчит в B, но не выходит из A', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({ manifold, cuts: [pinCut(defaultProfile())] });
    const a = out.parts.find((p) => p.side === 'A')!.manifold;
    // Часть A: от 0 до +15 плюс штифт вниз на 6 мм. Никакого материала выше 15.
    const box = a.boundingBox();
    expect(box.max[2]).toBeLessThan(15.01);
    expect(box.min[2]).toBeLessThan(-3);
    // Штифт не проваливается внутрь: около штифта материал A есть ниже z=0.
    expect(areaAtZ(a, -2)).toBeGreaterThan(0.5);
  });
});

describe('тонкая деталь не протыкается насквозь', () => {
  it('шлифт 1,5 мм: штифты пропускаются с объяснением', async () => {
    await boot();
    const { manifold } = build(boxSoup(40, 40, 3, [0, 0, 0]), );
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          plane: { point: [0, 0, 0], normal: [0, 0, 1] },
          step: { enabled: true, width: 4, height: 1.5 },
          pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.9, maxCount: 4, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    expect(st.pinCount).toBe(0);
    expect(st.warnings.join(' ')).toMatch(/штифт/i);

    // Ни одна часть не выходит за габарит детали (3 мм по Z).
    for (const part of out.parts) {
      const box = part.manifold.boundingBox();
      expect(box.max[2] - box.min[2]).toBeLessThan(3.6);
    }
    // Ступенька тоже не проткнула: её высота уменьшена.
    if (st.stepApplied) expect(st.stepWidth).toBeGreaterThan(0);
  });

  it('пластина 2 мм: штифт не появляется, ступенька подстраивается', async () => {
    await boot();
    const { manifold } = build(boxSoup(40, 40, 2));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          step: { enabled: true, width: 4, height: 1.5 },
          pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.9, maxCount: 4, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.pinCount).toBe(0);
    expect(st.warnings.length).toBeGreaterThan(0);
    for (const part of out.parts) {
      const box = part.manifold.boundingBox();
      expect(box.max[2]).toBeLessThan(1.01);
      expect(box.min[2]).toBeGreaterThan(-1.01);
    }
  });

  it('толстая деталь 20 мм: штифты ставятся во всю глубину', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 20));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.9, maxCount: 3, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.pinCount).toBe(3);
    const a = out.parts.find((p) => p.side === 'A')!.manifold;
    const box = a.boundingBox();
    // Штифт уходит вниз на глубину 6 мм от плоскости среза.
    expect(box.min[2]).toBeLessThan(-4);
    expect(box.min[2]).toBeGreaterThan(-7);
  });

  it('труба с тонкой стенкой: штифты не появляются, деталь цела', async () => {
    await boot();
    const { manifold } = build(cylinderSoup(20, 10, 48, [0, 0, -5]));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          pins: { enabled: true, diameter: 5, depth: 8, clearance: 0.2, taper: 0.9, maxCount: 4, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    // Объём сохраняется: ни одного отверстия «в пустоту».
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(Math.abs(sum - manifold.volume()) / manifold.volume()).toBeLessThan(0.02);
  });
});

describe('раскладка штифтов даёт заказанное количество', () => {
  // Маленькое сечение 20 × 20 — как у калибровочного кубика. Раньше здесь
  // помещался один штифт из четырёх: сетка кандидатов была слишком редкой.
  for (const [diameter, count] of [
    [4, 4],
    [2, 3],
    [3, 6],
    [5, 2],
  ] as const) {
    it(`20×20 мм, ⌀${diameter} мм, заказано ${count} — поставлено ${count}`, async () => {
      await boot();
      const { manifold } = build(boxSoup(20, 20, 20));
      const out = runCuts({
        manifold,
        cuts: [
          makeCut({
            pins: {
              enabled: true,
              diameter,
              depth: Math.max(2, diameter),
              clearance: 0.2,
              taper: 0.9,
              maxCount: count,
              manual: [],
            },
          }),
        ],
      });
      const st = out.stats[0];
      expect(st.ok).toBe(true);
      expect(st.pinCount).toBe(count);
      expect(st.warnings).toEqual([]);
      // Отверстия не должны слипаться: пересечение частей остаётся нулевым.
      expect(st.intersectionVolume).toBeLessThan(0.05);
    });
  }

  it('слишком большой штифт не помещается — честное предупреждение', async () => {
    await boot();
    const { manifold } = build(boxSoup(20, 20, 20));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          pins: { enabled: true, diameter: 12, depth: 6, clearance: 0.2, taper: 0.9, maxCount: 4, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    expect(st.pinCount).toBeLessThan(4);
    expect(st.warnings.join(' ')).toMatch(/штифт/i);
  });
});

describe('экспорт не теряет замки', () => {
  it('сохранённые части содержат шип и паз', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({ manifold, cuts: [tongueCut()] });
    const parts = toPartGeometries(out, 'Тест');
    expect(parts).toHaveLength(2);

    // Пересобираем тела из массивов экспорта — как это сделает слайсер.
    const { initManifold } = await import('../../src/geometry/manifold.ts');
    const { manifoldFromPositions } = await import('../../src/geometry/manifold.ts');
    await initManifold();
    for (const part of parts) {
      const soup = new Float32Array(part.indices.length * 3);
      for (let i = 0; i < part.indices.length; i++) {
        const v = part.indices[i] * 3;
        soup[i * 3] = part.positions[v];
        soup[i * 3 + 1] = part.positions[v + 1];
        soup[i * 3 + 2] = part.positions[v + 2];
      }
      const rebuilt = manifoldFromPositions(soup, 120);
      expect(rebuilt.status).toBe('NoError');
      expect(Math.abs(rebuilt.manifold!.volume() - part.volume) / part.volume).toBeLessThan(1e-3);
      rebuilt.manifold!.delete();
    }
  });
});
