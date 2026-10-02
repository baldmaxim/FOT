import { describe, expect, it, vi } from 'vitest';

/**
 * Пересчёт фиксации зафиксированного месяца для отдела: цель — объект с наибольшими
 * часами за месяц, как ночная фиксация без «Офиса» отдела.
 */

const db = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ pool: vi.fn(), query: vi.fn(), withTransaction: db.withTransaction }));

const {
  MonthRefreezeError,
  planMonthRefreeze,
  refreezeDepartmentMonth,
} = await import('./timesheet-object-month-refreeze.service.js');

type Row = Parameters<typeof planMonthRefreeze>[0][number];
const row = (id: number, over: Partial<Row> = {}): Row => ({
  employee_id: id, full_name: `Сотрудник ${id}`, mode: 'current_activity', object_id: null, set_by: 'auto',
  personal_office: false, ...over,
});
const top = (value: string, hours: number, label = value) => ({
  value, label, objectId: value === 'office' ? null : value, hours,
});

describe('planMonthRefreeze', () => {
  const tops = new Map([
    [1, [top('o-dom', 196.5, 'ЖК Дом 56'), top('office', 20, 'Офис')]],
    [2, [top('office', 167.46, 'Офис'), top('o-zil', 12)]],
    [3, [top('o-zil', 40)]],
    [4, [top('o-sad', 150)]],
  ]);

  it('«Офис» отдела в фиксации → объект с наибольшими часами', () => {
    expect(planMonthRefreeze([row(1)], tops)).toEqual([{
      employeeId: 1, fullName: 'Сотрудник 1',
      fromMode: 'current_activity', fromObjectId: null, fromSetBy: 'auto',
      toMode: 'object', toObjectId: 'o-dom', label: 'ЖК Дом 56', hours: 196.5,
    }]);
  });

  it('больше всего часов в офисе — «Офис» остаётся, изменения нет', () => {
    expect(planMonthRefreeze([row(2)], tops)).toEqual([]);
  });

  it('нет часов — фиксация прежняя', () => {
    expect(planMonthRefreeze([row(9)], tops)).toEqual([]);
  });

  it('личный «Офис» из окна — не трогаем даже при часах на объекте', () => {
    expect(planMonthRefreeze([row(3, { set_by: null, personal_office: true })], tops)).toEqual([]);
  });

  it('объект уже тот же и источник auto — повтор no-op', () => {
    expect(planMonthRefreeze([row(4, { mode: 'object', object_id: 'o-sad' })], tops)).toEqual([]);
  });

  it('объект тот же, но источник не auto — источник выравнивается', () => {
    const changes = planMonthRefreeze([row(4, { mode: 'object', object_id: 'o-sad', set_by: 'employee' })], tops);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ toMode: 'object', toObjectId: 'o-sad', fromSetBy: 'employee' });
  });

  it('рабочему — «По СКУД» независимо от часов; уже skud/auto — no-op; личный «Офис» главнее', () => {
    const changes = planMonthRefreeze([
      row(1, { worker: true, mode: 'object', object_id: 'o-dom' }),
      row(9, { worker: true, mode: null, set_by: null }),
      row(5, { worker: true, mode: 'skud' }),
      row(3, { worker: true, set_by: null, personal_office: true }),
    ], tops);
    expect(changes.map(c => [c.employeeId, c.toMode, c.toObjectId, c.label])).toEqual([
      [1, 'skud', null, 'По СКУД'],
      [9, 'skud', null, 'По СКУД'],
    ]);
  });
});

describe('refreezeDepartmentMonth: отказы до транзакции', () => {
  const now = new Date('2026-10-02T09:00:00Z');
  const base = { departmentId: '7d51d468-add3-4fe8-a613-69bc8210f887', dryRun: true, now };

  it('текущий месяц — отказ, его считает ночь', async () => {
    await expect(refreezeDepartmentMonth({ ...base, month: '2026-10' })).rejects.toBeInstanceOf(MonthRefreezeError);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('мусор вместо месяца — отказ', async () => {
    await expect(refreezeDepartmentMonth({ ...base, month: 'сентябрь' })).rejects.toBeInstanceOf(MonthRefreezeError);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});
