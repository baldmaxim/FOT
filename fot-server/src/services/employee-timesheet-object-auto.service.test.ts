import { describe, expect, it, vi } from 'vitest';

/**
 * Авторасчёт объекта табелирования (миграция 288) — ночь, фиксация месяца и скрипт: кого
 * трогаем, что меняем, что считается повтором.
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
  office_department: false, personal_office: false, worker: false, ...over,
});
const top = (value: string, hours: number, label = value) => ({
  value, label, objectId: value === 'office' ? null : value, hours,
});

describe('isAutoCandidate', () => {
  it('считаются все: авто, без режима, прежний выбор в ЛК/табеле, ручной режим админа', () => {
    for (const candidate of [
      { mode: 'object', set_by: 'auto' },
      { mode: null, set_by: null },
      { mode: 'object', set_by: 'employee' },
      { mode: 'object', set_by: 'manager' },
      { mode: 'skud', set_by: null },
      { mode: 'object', set_by: null },
      { mode: 'current_activity', set_by: null, personal_office: false },
    ]) {
      expect(isAutoCandidate(candidate)).toBe(true);
    }
  });
  it('личный «Офис» из окна «Режим табелирования» — никогда', () => {
    expect(isAutoCandidate({ personal_office: true })).toBe(false);
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
    [6, [top('o-dom', 40)]],
  ]);

  it('без режима → объект с максимумом часов; «Офис» → current_activity', () => {
    const changes = planAutoChanges([row(1), row(2)], tops);
    expect(changes.map(c => [c.employeeId, c.toMode, c.toObjectId, c.label])).toEqual([
      [1, 'object', 'o-dom', 'ЖК Дом 56'],
      [2, 'current_activity', null, 'Офис'],
    ]);
  });

  it('тот же объект с тем же источником — не изменение (повтор — no-op)', () => {
    expect(planAutoChanges([row(3, { mode: 'object', object_id: 'o-dom', set_by: 'auto' })], tops)).toEqual([]);
  });

  it('тот же объект у ручного режима админа — изменение источника на auto', () => {
    const changes = planAutoChanges([row(3, { mode: 'object', object_id: 'o-dom', set_by: null })], tops);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromSetBy: null, toMode: 'object', toObjectId: 'o-dom' });
  });

  it('прежний выбор сотрудника/табеля и ручной режим админа — по часам', () => {
    const rows = [
      row(4, { mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
      row(5, { mode: 'object', object_id: 'o-dom', set_by: 'manager' }),
      row(3, { mode: 'skud', set_by: null }),
    ];
    expect(planAutoChanges(rows, tops).map(c => [c.employeeId, c.fromSetBy, c.toObjectId])).toEqual([
      [4, 'employee', 'o-zil'],
      [5, 'manager', 'o-zil'],
      [3, null, 'o-dom'],
    ]);
  });

  it('личный «Офис» из окна не трогаем даже при часах на объекте', () => {
    const rows = [row(6, { mode: 'current_activity', set_by: null, personal_office: true })];
    expect(planAutoChanges(rows, tops)).toEqual([]);
  });

  it('сотрудники отдела с «Офисом» в расчёт по часам не идут — их ведёт правило отдела', () => {
    const rows = [
      row(1, { office_department: true }),
      row(2, { office_department: true, mode: 'object', object_id: 'o-zil', set_by: 'auto' }),
      row(4, { office_department: true, mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
    ];
    expect(planAutoChanges(rows, tops)).toEqual([]);
  });

  it('нет часов за период — объект и источник прежние', () => {
    expect(planAutoChanges([row(9, { mode: 'object', object_id: 'o-dom', set_by: 'auto' })], tops)).toEqual([]);
    expect(planAutoChanges([row(9, { mode: 'object', object_id: 'o-dom', set_by: 'employee' })], tops)).toEqual([]);
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
    const changes = planAutoChanges(rows, tops);
    const report = summarizeAutoChanges(rows, tops, changes);
    // Без изменений — 9 и 10 (нет часов).
    expect(report).toMatchObject({
      employees: 6, withHours: 4, changed: 4, toOffice: 1, toObject: 3,
      fromNone: 1, fromSkud: 1, fromAdminObject: 1, fromChoice: 1, personalOffice: 0, unchanged: 2,
    });
    expect(report.changed + report.unchanged + report.personalOffice).toBe(report.employees);
  });

  it('сводка: отделы с «Офисом» и личный «Офис» — отдельными строками, в «без изменений» не входят', () => {
    const rows = [
      row(1),
      row(2, { office_department: true }),
      row(4, { office_department: true, mode: 'object', object_id: 'o-dom', set_by: 'employee' }),
      row(5, { mode: 'object', object_id: 'o-dom', set_by: 'manager' }),
      row(6, { mode: 'current_activity', set_by: null, personal_office: true }),
    ];
    const changes = planAutoChanges(rows, tops);
    const report = summarizeAutoChanges(rows, tops, changes);
    expect(report).toMatchObject({
      employees: 5, changed: 2, fromNone: 1, fromChoice: 1, officeDepartment: 2, personalOffice: 1, unchanged: 0,
    });
    expect(report.changed + report.unchanged + report.personalOffice + report.officeDepartment).toBe(report.employees);
  });
});

describe('planAutoChanges: рабочие — «По СКУД» вместо объекта по часам', () => {
  const tops = new Map([
    [1, [top('o-dom', 200, 'ЖК Дом 56'), top('o-zil', 30)]],
    [2, [top('office', 28.5, 'Офис')]],
  ]);

  it('объект по часам, «Офис» по часам, без режима и без часов — всем skud без объекта', () => {
    const rows = [
      row(1, { worker: true, mode: 'object', object_id: 'o-zil', set_by: 'auto' }),
      row(2, { worker: true, mode: 'current_activity', set_by: 'auto' }),
      row(3, { worker: true }),
      row(4, { worker: true, mode: 'skud', set_by: null }),
    ];
    expect(planAutoChanges(rows, tops).map(c => [c.employeeId, c.toMode, c.toObjectId, c.label, c.fromMode])).toEqual([
      [1, 'skud', null, 'По СКУД', 'object'],
      [2, 'skud', null, 'По СКУД', 'current_activity'],
      [3, 'skud', null, 'По СКУД', null],
      [4, 'skud', null, 'По СКУД', 'skud'],
    ]);
  });

  it('уже skud/auto — повтор не пишется', () => {
    expect(planAutoChanges([row(1, { worker: true, mode: 'skud', set_by: 'auto' })], tops)).toEqual([]);
  });

  it('личный «Офис» и отдел с «Офисом» главнее правила рабочих', () => {
    const rows = [
      row(1, { worker: true, mode: 'current_activity', set_by: null, personal_office: true }),
      row(2, { worker: true, office_department: true, mode: 'current_activity', set_by: 'auto' }),
    ];
    expect(planAutoChanges(rows, tops)).toEqual([]);
  });

  it('сводка: рабочие и переход в «По СКУД» — отдельными строками', () => {
    const rows = [
      row(1, { worker: true, mode: 'object', object_id: 'o-dom', set_by: 'auto' }),
      row(5, { worker: true, mode: 'skud', set_by: 'auto' }),
      row(6, { worker: true, office_department: true }),
      row(2),
    ];
    const changes = planAutoChanges(rows, tops);
    const report = summarizeAutoChanges(rows, tops, changes);
    expect(report).toMatchObject({
      employees: 4, workers: 2, changed: 2, toSkud: 1, toOffice: 1, toObject: 0, fromAuto: 1, unchanged: 1,
    });
  });
});
