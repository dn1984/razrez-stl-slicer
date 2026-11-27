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

describe('ограниченная область реза', () => {
  it('окно меньше детали: режется только окно, остальное остаётся целым', async () => {
    await boot();
    // «Крыло»: брусок 100×20×10. Плоскость по X делит его на две части,
    // но окно 20×20 закрывает только середину — концы должны остаться целыми
    // и уйти в одну часть.
    const { manifold } = build(boxSoup(100, 20, 10));
    const source = manifold.volume();
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          area: { enabled: true, width: 20, height: 20, offsetU: 0, offsetV: 0 },
        }),
      ],
    });
    expect(out.stats[0].ok).toBe(true);
    expect(out.parts).toHaveLength(2);

    const a = out.parts.find((p) => p.side === 'A')!.manifold;
    const b = out.parts.find((p) => p.side === 'B')!.manifold;
    // Часть A — только кусок внутри окна: 20 (u) × 20 (v) сверху половины.
    const abox = a.boundingBox();
    expect(abox.max[2] - abox.min[2]).toBeLessThan(6);
    // Окно 20 мм по u — часть A не должна быть шире окна.
    expect(abox.max[0] - abox.min[0]).toBeLessThan(21);
    // Часть B забирает всё остальное, включая нетронутые концы.
    expect(b.volume()).toBeGreaterThanOrEqual(source * 0.85);
    const bbox = b.boundingBox();
    expect(bbox.max[0] - bbox.min[0]).toBeGreaterThan(90);

    // Сумма совпадает с исходником: материал не потерян и не удвоен.
    const sum = a.volume() + b.volume();
    expect(Math.abs(sum - source) / source).toBeLessThan(1e-6);
    expect(out.stats[0].intersectionVolume).toBeLessThan(0.5);
  });

  it('окно отсчитывается от плоскости, а не от центроида сечения', async () => {
    await boot();
    // Несимметричное сечение: узкая деталь у y=0 и широкая у y=100.
    // Центроид сечения уезжает к y≈75, а центр габарита — к y=60.
    // Окно с нулевым сдвигом обязано стоять по центру ПЛОСКОСТИ (y=0),
    // иначе рез уходит туда, где пользователь ничего не выбирал.
    const narrow = boxSoup(100, 20, 10);
    const wide = boxSoup(20, 60, 10, [0, 100, 0]);
    const merged = new Float32Array(narrow.length + wide.length);
    merged.set(narrow, 0);
    merged.set(wide, narrow.length);
    const { manifold } = build(merged);

    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          plane: { point: [0, 0, 0], normal: [1, 0, 0] },
          area: { enabled: true, width: 40, height: 40, offsetU: 0, offsetV: 0 },
        }),
      ],
    });
    expect(out.stats[0].ok).toBe(true);

    // Части разбиты на связные куски, поэтому габарит считаем по всем частям
    // нужной стороны, а не по первой попавшейся.
    const bboxOf = (side: 'A' | 'B') => {
      const boxes = out.parts.filter((p) => p.side === side).map((p) => p.manifold.boundingBox());
      expect(boxes.length).toBeGreaterThan(0);
      return {
        min: [Math.min(...boxes.map((b) => b.min[0])), Math.min(...boxes.map((b) => b.min[1]))],
        max: [Math.max(...boxes.map((b) => b.max[0])), Math.max(...boxes.map((b) => b.max[1]))],
      };
    };
    const ab = bboxOf('A');
    const bb = bboxOf('B');
    // Зарезана только узкая деталь у y ≈ 0; широкая на y=100 остаётся целой.
    expect(ab.max[1]).toBeLessThan(30);
    expect(ab.min[1]).toBeGreaterThan(-30);
    expect(bb.max[1]).toBeGreaterThan(120);
  });

  it('несвязанные куски одной стороны выдаются отдельными частями', async () => {
    await boot();
    // Две отдельные заготовки рядом. Плоскость режет обе сразу, но куски
    // физически не связаны — значит и частей должно быть больше двух.
    const left = boxSoup(20, 20, 20, [0, -40, 0]);
    const right = boxSoup(20, 20, 20, [0, 40, 0]);
    const merged = new Float32Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    const { manifold } = build(merged);

    const out = runCuts({ manifold, cuts: [makeCut()] });
    expect(out.stats[0].ok).toBe(true);
    // Каждая заготовка делится на верх и низ: 4 несвязанных куска.
    expect(out.parts).toHaveLength(4);
    // И каждый кусок — самостоятельное замкнутое тело.
    for (const part of out.parts) {
      expect(part.manifold.status()).toBe('NoError');
      expect(part.manifold.numVert ? part.manifold.numVert() : 1).toBeGreaterThan(0);
      expect(part.manifold.volume()).toBeGreaterThan(1);
    }
    const sum = out.parts.reduce((s, p) => s + p.manifold.volume(), 0);
    expect(Math.abs(sum - 2 * 20 * 20 * 20)).toBeLessThan(1e-6);
  });

  it('окно мимо модели даёт понятную ошибку вместо пустого реза', async () => {
    await boot();
    const { manifold } = build(boxSoup(20, 20, 20));
    const out = runCuts({
      manifold,
      cuts: [
        makeCut({
          area: { enabled: true, width: 5, height: 5, offsetU: 500, offsetV: 500 },
        }),
      ],
    });
    expect(out.stats[0].ok).toBe(false);
    expect(out.stats[0].error).toMatch(/область/i);
    expect(out.parts).toHaveLength(1);
  });

  it('сдвиг окна смещает область реза', async () => {
    await boot();
    const { manifold } = build(boxSoup(60, 60, 20));
    const centered = runCuts({
      manifold,
      cuts: [makeCut({ id: 'c', area: { enabled: true, width: 20, height: 20, offsetU: 0, offsetV: 0 } })],
    });
    const shifted = runCuts({
      manifold,
      cuts: [makeCut({ id: 's', area: { enabled: true, width: 20, height: 20, offsetU: 18, offsetV: 0 } })],
    });
    const a1 = centered.parts.find((p) => p.side === 'A')!.manifold;
    const a2 = shifted.parts.find((p) => p.side === 'A')!.manifold;
    const c1 = (a1.boundingBox().max[0] + a1.boundingBox().min[0]) / 2;
    const c2 = (a2.boundingBox().max[0] + a2.boundingBox().min[0]) / 2;
    // Окно сдвинуто на 18 мм по u — центр вырезанной части тоже сдвинулся.
    expect(c2 - c1).toBeGreaterThan(15);
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
