import { describe, expect, it, vi } from 'vitest';

/**
 * Ночной авторасчёт объекта табелирования (миграция 288): кого трогаем, что меняем,
 * что считается повтором.
 */

vi.mock('../config/postgres.js', () => ({ pool: vi.fn(), query: vi.fn() }));

const {
  isAutoCandidate,
  planAutoChanges,
  summarizeAutoChanges,
  targetFromTop,
} = await import('./employee-timesheet-object-auto.service.js');

type Row = Parameters<typeof planAutoChanges>[0][number];
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id, full_name: `Сотрудник ${id}`, mode: null, object_id: null, set_by: null,
  office_department: false, personal_office: false, ...over,
});
const top = (value: string, hours: number, label = value) => ({
  value, label, objectId: value === 'office' ? null : value, hours,
});

describe('isAutoCandidate', () => {
  it('выбор сотрудника и ведущего табель ночь не трогает никогда', () => {
    expect(isAutoCandidate({ mode: 'object', set_by: 'employee' }, true)).toBe(false);
    expect(isAutoCandidate({ mode: 'object', set_by: 'manager' }, true)).toBe(false);
  });
  it('авто и «ничего не задано» — всегда', () => {
    expect(isAutoCandidate({ mode: 'object', set_by: 'auto' }, false)).toBe(true);
    expect(isAutoCandidate({ mode: null, set_by: null }, false)).toBe(true);
  });
  it('личный «Офис» из окна «Режим табелирования» — никогда, даже с all', () => {
    expect(isAutoCandidate({ mode: 'current_activity', set_by: null, personal_office: true }, false)).toBe(false);
    expect(isAutoCandidate({ mode: 'current_activity', set_by: null, personal_office: true }, true)).toBe(false);
  });
  it('ручной режим админа — только с all (первый запуск)', () => {
    expect(isAutoCandidate({ mode: 'skud', set_by: null }, false)).toBe(false);
    expect(isAutoCandidate({ mode: 'object', set_by: null }, false)).toBe(false);
    expect(isAutoCandidate({ mode: 'skud', set_by: null }, true)).toBe(true);
    expect(isAutoCandidate({ mode: 'current_activity', set_by: null }, true)).toBe(true);
  });
});

describe('targetFromTop', () => {
  it('«Офис» — current_activity без объекта; объект — object + id', () => {
    expect(targetFromTop(top('office', 30))).toEqual({ mode: 'current_activity', objectId: null });
    expect(targetFromTop(top('o-dom', 30))).toEqual({ mode: 'object', objectId: 'o-dom' });
  });
});

describe('planAutoChanges', () => {
  const tops = new Map([
    [1, [top('o-dom', 200, 'ЖК Дом 56'), top('o-zil', 30)]],
    [2, [top('office', 28.5, 'Офис')]],
    [3, [top('o-dom', 50)]],
    [4, [top('o-zil', 10)]],
    [5, [top('o-zil', 10)]],
  ]);

  it('без режима → объект с максимумом часов; «Офис» → current_activity', () => {
    const changes = planAutoChanges([row(1), row(2)], tops, false);
    expect(changes.map(c => [c.employeeId, c.toMode, c.toObjectId, c.label])).toEqual([
      [1, 'object', 'o-dom', 'ЖК Дом 56'],
      [2, 'current_activity', null, 'Офис'],
    ]);
  });

  it('тот же объект с тем же источником — не изменение (повтор — no-op)', () => {
    expect(planAutoChanges([row(3, { mode: 'object', object_id: 'o-dom', set_by: 'auto' })], tops, false)).toEqual([]);
  });

  it('тот же объект у ручного режима при all — изменение источника на auto', () => {
    const changes = planAutoChanges([row(3, { mode: 'object', object_id: 'o-dom', set_by: null })], tops, true);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromSetBy: null, toMode: 'object', toObjectId: 'o-dom' });
  });

  it('выбор сотрудника/табеля и (без all) ручной админа — не трогаем', () => {
    const rows = [
      row(4, { mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
      row(5, { mode: 'object', object_id: 'o-dom', set_by: 'manager' }),
      row(3, { mode: 'skud', set_by: null }),
    ];
    expect(planAutoChanges(rows, tops, false)).toEqual([]);
  });

  it('сотрудники отдела с «Офисом» в расчёт по часам не идут — их ведёт правило отдела', () => {
    const rows = [
      row(1, { office_department: true }),
      row(2, { office_department: true, mode: 'object', object_id: 'o-zil', set_by: 'auto' }),
      row(4, { office_department: true, mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
    ];
    expect(planAutoChanges(rows, tops, false)).toEqual([]);
    expect(planAutoChanges(rows, tops, true)).toEqual([]);
  });

  it('нет часов за период — объект прежний', () => {
    expect(planAutoChanges([row(9, { mode: 'object', object_id: 'o-dom', set_by: 'auto' })], tops, false)).toEqual([]);
  });

  it('сводка переходов', () => {
    const rows = [
      row(1),
      row(2, { mode: 'skud', set_by: null }),
      row(3, { mode: 'object', object_id: 'o-zil', set_by: null }),
      row(4, { mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
      row(9),
      row(10, { mode: 'object', object_id: 'o-zil', set_by: null }),
    ];
    const changes = planAutoChanges(rows, tops, true);
    const report = summarizeAutoChanges(rows, tops, changes, true);
    // Без изменений — 9 и 10 (нет часов); выбор сотрудника (4) с часами сюда не входит.
    expect(report).toMatchObject({
      employees: 6, withHours: 4, changed: 3, toOffice: 1, toObject: 2,
      fromNone: 1, fromSkud: 1, fromAdminObject: 1, skippedManual: 1, unchanged: 2,
    });
    expect(report.changed + report.unchanged + report.skippedManual).toBe(report.employees);
  });

  it('сводка: отделы с «Офисом» — отдельной строкой, в «без изменений» и «не трогаем» не входят', () => {
    const rows = [
      row(1),
      row(2, { office_department: true }),
      row(4, { office_department: true, mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
      row(5, { mode: 'object', object_id: 'o-dom', set_by: 'manager' }),
    ];
    const changes = planAutoChanges(rows, tops, false);
    const report = summarizeAutoChanges(rows, tops, changes, false);
    expect(report).toMatchObject({ employees: 4, changed: 1, officeDepartment: 2, skippedManual: 1, unchanged: 0 });
    expect(report.changed + report.unchanged + report.skippedManual + report.officeDepartment).toBe(report.employees);
  });
});
