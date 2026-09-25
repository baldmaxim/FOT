import { describe, it, expect } from 'vitest';
import { distributeHours, syncAllocationsWithHours } from './correctionAllocations';

const sumHours = (items: Array<{ hours: number }>): number =>
  items.reduce((sum, item) => sum + Math.round(item.hours * 100), 0) / 100;

describe('syncAllocationsWithHours', () => {
  it('один объект выбран вручную, часы 8 → 10 — на объекте 10 (случай 17.09)', () => {
    const prev = [{ object_id: 'zhk', hours: 8 }];
    expect(syncAllocationsWithHours(prev, 10, 'single', true, [])).toEqual([{ object_id: 'zhk', hours: 10 }]);
  });

  it('один объект, часы не изменились — тот же массив', () => {
    const prev = [{ object_id: 'zhk', hours: 10 }];
    expect(syncAllocationsWithHours(prev, 10, 'single', true, [])).toBe(prev);
  });

  it('разбивку, которую правили вручную, не трогаем', () => {
    const prev = [{ object_id: 'a', hours: 3 }, { object_id: 'b', hours: 5 }];
    expect(syncAllocationsWithHours(prev, 10, 'split', true, [])).toBe(prev);
  });

  it('нетронутая разбивка пересчитывается по весам подсказки', () => {
    const prev = [{ object_id: 'a', hours: 2 }, { object_id: 'b', hours: 6 }];
    const suggested = [{ object_id: 'a', minutes: 60 }, { object_id: 'b', minutes: 180 }];
    const result = syncAllocationsWithHours(prev, 10, 'split', false, suggested);
    expect(result).toEqual([{ object_id: 'a', hours: 2.5 }, { object_id: 'b', hours: 7.5 }]);
  });

  it('пустое распределение остаётся пустым', () => {
    const prev: Array<{ object_id: string; hours: number }> = [];
    expect(syncAllocationsWithHours(prev, 10, 'single', true, [])).toBe(prev);
    expect(syncAllocationsWithHours(prev, 10, 'split', false, [])).toBe(prev);
  });
});

describe('distributeHours', () => {
  it('сумма долей точно равна итогу', () => {
    const result = distributeHours(
      [{ object_id: 'a', minutes: 1 }, { object_id: 'b', minutes: 1 }, { object_id: 'c', minutes: 1 }],
      10,
    );
    expect(sumHours(result)).toBe(10);
  });

  it('нулевые веса делят часы поровну', () => {
    expect(distributeHours([{ object_id: 'a', minutes: 0 }, { object_id: 'b', minutes: 0 }], 8))
      .toEqual([{ object_id: 'a', hours: 4 }, { object_id: 'b', hours: 4 }]);
  });
});
