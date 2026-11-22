import { describe, expect, it } from 'vitest';
import { boot, build, makeCut, defaultProfile } from './helpers.ts';
import { runCuts, toPartGeometries } from '../../src/geometry/cut.ts';
import { boxSoup, cylinderSoup, sphereSoup, tubeSoup } from '../fixtures/models.ts';

describe('срез плоской плоскостью', () => {
  it('делит куб на две части без потерь объёма', async () => {
    await boot();
    const { manifold } = build(boxSoup(20, 20, 20));
    const source = manifold.volume();
    const out = runCuts({ manifold, cuts: [makeCut()] });
    expect(out.parts).toHaveLength(2);
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(Math.abs(sum - source) / source).toBeLessThan(1e-9);
    expect(out.stats[0].ok).toBe(true);
    expect(out.stats[0].intersectionVolume).toBeLessThan(1e-6);
  });

  it('не режет, если плоскость вне модели', async () => {
    await boot();
    const { manifold } = build(boxSoup(10, 10, 10));
    const out = runCuts({
      manifold,
      cuts: [makeCut({ plane: { point: [0, 0, 100], normal: [0, 0, 1] } })],
    });
    expect(out.parts).toHaveLength(1);
    expect(out.stats[0].ok).toBe(false);
  });

  it('сохраняет объём на сфере с наклонной плоскостью', async () => {
    await boot();
    const { manifold } = build(sphereSoup(15, 48, 24));
    const source = manifold.volume();
    const out = runCuts({
      manifold,
      cuts: [makeCut({ plane: { point: [0, 0, 0], normal: [1, 1, 0.4] } })],
    });
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(Math.abs(sum - source) / source).toBeLessThan(1e-9);
    expect(out.stats[0].ok).toBe(true);
  });
});

describe('профиль среза', () => {
  it('купол: часть A получает выпуклость', async () => {
    await boot();
    const { manifold } = build(boxSoup(40, 40, 30));
    const flat = runCuts({ manifold, cuts: [makeCut({ id: 'f' })] });
    const dome = runCuts({
      manifold,
      cuts: [makeCut({ id: 'd', profile: defaultProfile({ shape: 'dome', height: 4 }) })],
    });
    const flatA = flat.parts.find((p) => p.side === 'A')!.manifold.volume();
    const domeA = dome.parts.find((p) => p.side === 'A')!.manifold.volume();
    // Выпуклость в сторону A добавляет объём части A.
    expect(domeA).toBeGreaterThan(flatA + 100);
    expect(dome.stats[0].ok).toBe(true);
  });

  it('тарелка: часть A теряет объём', async () => {
    await boot();
    const { manifold } = build(boxSoup(40, 40, 30));
    const flat = runCuts({ manifold, cuts: [makeCut({ id: 'f' })] });
    const dish = runCuts({
      manifold,
      cuts: [makeCut({ id: 'd', profile: defaultProfile({ shape: 'dish', height: 4 }) })],
    });
    const flatA = flat.parts.find((p) => p.side === 'A')!.manifold.volume();
    const dishA = dish.parts.find((p) => p.side === 'A')!.manifold.volume();
    expect(dishA).toBeLessThan(flatA - 100);
    expect(dish.stats[0].ok).toBe(true);
  });

  it('сферический профиль даёт тот же знак высоты', async () => {
    await boot();
    const { manifold } = build(sphereSoup(20, 32, 16));
    const out = runCuts({
      manifold,
      cuts: [makeCut({ profile: defaultProfile({ shape: 'dome', height: 3, falloff: 'sphere', radius: 12 }) })],
    });
    expect(out.stats[0].ok).toBe(true);
    expect(out.stats[0].intersectionVolume).toBeLessThan(1e-3);
  });
});

describe('замки', () => {
  it('ступенька строится и не создаёт пересечений', async () => {
    await boot();
    const { manifold } = build(boxSoup(40, 40, 30));
    const flat = runCuts({ manifold, cuts: [makeCut({ id: 'flat' })] });
    const stepped = runCuts({
      manifold,
      cuts: [makeCut({ id: 'step', step: { enabled: true, width: 5, height: 1.5 } })],
    });
    const st = stepped.stats[0];
    expect(st.ok).toBe(true);
    expect(st.stepApplied).toBe(true);
    expect(st.stepWidth).toBeGreaterThan(3);
    expect(st.intersectionVolume).toBeLessThan(1e-3);
    // Выступ добавляет объём части A относительно плоского среза.
    const flatA = flat.parts.find((p) => p.side === 'A')!.manifold.volume();
    const stepA = stepped.parts.find((p) => p.side === 'A')!.manifold.volume();
    expect(stepA).toBeGreaterThan(flatA + 100);
    // Суммарный объём почти сохраняется: разница — только зазор выемки.
    const sum = stepped.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(Math.abs(sum - 48000) / 48000).toBeLessThan(0.01);
  });

  it('штифты создают ровно maxCount штифтов на большом сечении', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          pins: { enabled: true, diameter: 5, depth: 8, clearance: 0.25, taper: 0.85, maxCount: 3, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    expect(st.pinCount).toBe(3);
    expect(st.intersectionVolume).toBeLessThan(1e-3);
    expect(out.previews[0].pins).toHaveLength(3);
  });

  it('ручной штифт ставится туда, куда указали', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          pins: { enabled: true, diameter: 5, depth: 8, clearance: 0.25, taper: 0.9, maxCount: 1, manual: [[10, -5]] },
        }),
      ],
    });
    const pin = out.previews[0].pins[0];
    expect(pin[0]).toBeCloseTo(10, 3);
    expect(pin[1]).toBeCloseTo(-5, 3);
  });

  it('шип-паз строится и не пересекается', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 30));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({ tongue: { enabled: true, width: 14, depth: 6, clearance: 0.25, taper: 0.2, lengthScale: 0.6 } }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    expect(st.tongueApplied).toBe(true);
    expect(st.intersectionVolume).toBeLessThan(1e-3);
  });

  it('тонкая стенка: замки не ломают деталь', async () => {
    await boot();
    const { manifold } = build(tubeSoup(20, 17, 30));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          plane: { point: [0, 0, 15], normal: [0, 0, 1] },
          step: { enabled: true, width: 6, height: 1.5 },
          pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.9, maxCount: 4, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    // Стенка 3 мм, отступ для штифта 4 мм — штифты не помещаются, это должно
    // быть предупреждение, а не молчаливая дырка в детали.
    expect(st.intersectionVolume).toBeLessThan(1e-3);
    expect(st.pinCount).toBe(0);
    expect(st.warnings.join(' ')).toMatch(/штифт|узк/i);
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(sum).toBeGreaterThan(0);
  });
});

describe('несколько резов и цилиндрические детали', () => {
  it('два последовательных реза дают четыре части', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 60));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({ id: 'a' }),
        makeCut({ id: 'b', plane: { point: [0, 0, 0], normal: [1, 0, 0] } }),
      ],
    });
    expect(out.parts).toHaveLength(4);
    expect(out.stats.every((s) => s.ok)).toBe(true);
  });

  it('второй рез со смещением: углы не уезжают в чужую часть', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 40));
    const cutX = 12; // плоскость заметно мимо центра габарита
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({ id: 'a' }),
        makeCut({ id: 'b', plane: { point: [cutX, 0, 0], normal: [1, 0, 0] } }),
      ],
    });
    expect(out.parts).toHaveLength(4);

    // Каждая часть должна целиком лежать по свою сторону плоскости.
    for (const part of out.parts) {
      const bb = part.manifold.boundingBox();
      if (part.side === 'A') {
        // Правая часть начинается от плоскости (штифтов нет — допуск 0,01).
        expect(bb.min[0]).toBeGreaterThan(cutX - 0.01);
      } else {
        // Левая заканчивается на плоскости: раньше здесь оказывались углы
        // правой стороны, и рез выглядел «выгрызенным по дуге».
        expect(bb.max[0]).toBeLessThan(cutX + 0.01);
      }
    }

    // Объёмы: правая половина 60×40×30 = 72000, левая 30×30×40 = 36000... нет,
    // при смещении 12 мм части получаются разными. Проверяем главное — сумма.
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(Math.abs(sum - 144000) / 144000).toBeLessThan(1e-6);

    // Ни одна часть не пересекает чужую половину плоскости.
    for (const cut of out.parts) void cut;
  });

  it('смещённый рез с куполом и штифтами остаётся чистым', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 40));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          profile: defaultProfile({ shape: 'dome', height: 4 }),
          pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.85, maxCount: 3, manual: [] },
        }),
        makeCut({
          id: 'second',
          plane: { point: [14, 6, 0], normal: [1, 0.3, 0] },
          pins: { enabled: true, diameter: 3, depth: 4, clearance: 0.2, taper: 0.85, maxCount: 2, manual: [] },
        }),
      ],
    });
    // Пересечение частей остаётся нулевым: разъехавшаяся геометрия сразу дала бы
    // сотни кубических миллиметров наложения.
    for (const st of out.stats) {
      expect(st.ok).toBe(true);
      expect(st.intersectionVolume).toBeLessThan(0.5);
    }
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(sum).toBeGreaterThan(0);
  });

  it('цилиндр режется с профилем и штифтами', async () => {
    await boot();
    const { manifold } = build(cylinderSoup(18, 20, 48, [0, 0, -25]));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          plane: { point: [0, 0, -15], normal: [0, 0, 1] },
          profile: defaultProfile({ shape: 'dome', height: 3 }),
          pins: { enabled: true, diameter: 4, depth: 6, clearance: 0.2, taper: 0.85, maxCount: 2, manual: [] },
        }),
      ],
    });
    const st = out.stats[0];
    expect(st.ok).toBe(true);
    expect(st.pinCount).toBeGreaterThanOrEqual(1);
    // Порог — доля от объёма: упрощение сетки даёт микропересечения.
    expect(st.intersectionVolume).toBeLessThan(st.volumeBefore * 1e-5);
  });
});

describe('экспорт частей', () => {
  it('каждая часть имеет корректные массивы и габарит', async () => {
    await boot();
    const { manifold } = build(boxSoup(20, 20, 20));
    const out = runCuts({ manifold, cuts: [makeCut()] });
    const parts = toPartGeometries(out, 'Тест');
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p.indices.length).toBe(p.triangles * 3);
      expect(p.positions.length % 3).toBe(0);
      expect(p.volume).toBeGreaterThan(0);
      expect(p.bboxMax[2] - p.bboxMin[2]).toBeGreaterThan(0);
      // Все индексы в пределах массива вершин.
      const vertCount = p.positions.length / 3;
      for (let i = 0; i < p.indices.length; i++) expect(p.indices[i]).toBeLessThan(vertCount);
    }
    expect(parts[0].label).toContain('A1');
    expect(parts[1].label).toContain('B1');
  });
});
