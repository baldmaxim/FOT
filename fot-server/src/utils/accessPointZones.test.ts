import { describe, it, expect } from 'vitest';
import { alwaysInternalPoints, buildInternalPoints } from './accessPointZones.js';

// «кпп ASTERUS»: внутренняя по 30.09.2026, внешняя с 01.10.2026; «Коридор» — внутренняя всегда.
const zones = buildInternalPoints([
  { access_point_name: 'Коридор', is_internal: true, effective_from: '2000-01-01' },
  { access_point_name: 'кпп ASTERUS', is_internal: true, effective_from: '2000-01-01' },
  { access_point_name: 'кпп ASTERUS', is_internal: false, effective_from: '2026-10-01' },
]);

describe('buildInternalPoints', () => {
  it('тип зоны берётся по рабочей дате', () => {
    expect(zones.has('кпп ASTERUS', '2026-09-30')).toBe(true);
    expect(zones.has('кпп ASTERUS', '2026-10-01')).toBe(false);
    expect(zones.has('Коридор', '2026-10-01')).toBe(true);
  });

  it('точка без истории — внешняя, имя сравнивается без краевых пробелов', () => {
    expect(zones.has('ALIA', '2026-09-30')).toBe(false);
    expect(zones.has(' кпп ASTERUS ', '2026-09-30')).toBe(true);
    expect(zones.has(null, '2026-09-30')).toBe(false);
    expect(zones.has('', '2026-09-30')).toBe(false);
  });

  it('до первой записи истории точка внешняя', () => {
    const late = buildInternalPoints([{ access_point_name: 'Склад', is_internal: true, effective_from: '2026-10-05' }]);
    expect(late.has('Склад', '2026-10-04')).toBe(false);
    expect(late.has('Склад', '2026-10-05')).toBe(true);
  });

  it('onDate отдаёт набор внутренних точек на день', () => {
    expect([...zones.onDate('2026-09-15')].sort()).toEqual(['Коридор', 'кпп ASTERUS']);
    expect([...zones.onDate('2026-10-15')]).toEqual(['Коридор']);
  });

  it('ranges режет период по дате смены типа', () => {
    const parts = zones.ranges('2026-09-16', '2026-10-15');
    expect(parts.map(part => [part.from, part.to])).toEqual([['2026-09-16', '2026-09-30'], ['2026-10-01', '2026-10-15']]);
    expect(parts[0].internal.has('кпп ASTERUS')).toBe(true);
    expect(parts[1].internal.has('кпп ASTERUS')).toBe(false);
  });

  it('ranges: период без смены типа — один отрезок', () => {
    expect(zones.ranges('2026-09-01', '2026-09-30').map(part => [part.from, part.to])).toEqual([['2026-09-01', '2026-09-30']]);
    expect(zones.ranges('2026-10-01', '2026-10-31').map(part => [part.from, part.to])).toEqual([['2026-10-01', '2026-10-31']]);
    expect(zones.ranges('2026-10-02', '2026-10-01')).toEqual([]);
  });

  it('возврат типа внутри месяца даёт три отрезка', () => {
    const flip = buildInternalPoints([
      { access_point_name: 'КПП', is_internal: true, effective_from: '2026-10-05' },
      { access_point_name: 'КПП', is_internal: false, effective_from: '2026-10-10' },
    ]);
    expect(flip.ranges('2026-10-01', '2026-10-31').map(part => [part.from, part.to, part.internal.has('КПП')])).toEqual([
      ['2026-10-01', '2026-10-04', false],
      ['2026-10-05', '2026-10-09', true],
      ['2026-10-10', '2026-10-31', false],
    ]);
  });

  it('alwaysInternalPoints — внутренние на любую дату', () => {
    const always = alwaysInternalPoints(['Серверная']);
    expect(always.has('Серверная', '2020-01-01')).toBe(true);
    expect(always.has('Серверная', '2030-01-01')).toBe(true);
  });
});
