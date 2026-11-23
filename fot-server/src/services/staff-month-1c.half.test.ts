import { describe, expect, it } from 'vitest';

import { buildStaffMonthHalves, type IHalfBuildInput } from './staff-month-1c.half.js';
import { monthBoundsOf } from './staff-month-1c.load.js';
import { UNKNOWN_OBJECT, type IApiObject, type IDayRecord } from './staff-month-1c.rules.js';
import type { ISummaryBreakdownRow } from './payroll/payroll-summary.attribution.js';
import type { IStaffMonthDay, IStaffMonthRow } from './staff-month-1c.snapshot.js';

// Половины месяца из снимка без БД: открытый месяц (15-е и 16-е), состав половины (принят 16-го, уволен 15-го),
// отдел при равных часах, подача на месяц, запасной объект половины. PG-сценарий — staff-month-1c.pg.test.ts.

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const dict = new Map<string, IApiObject>([
  [A, { key: A, id: A, name: 'ЖК Ситибэй', address: null }],
  [B, { key: B, id: B, name: 'ЖК Примавера К14', address: null }],
]);
const MONTH = '2026-11';
const date = (day: number): string => `${MONTH}-${String(day).padStart(2, '0')}`;

const record = (day: number, over: Partial<IDayRecord> = {}): IDayRecord => ({
  date: date(day), source: 'closed', status: 'work', timesheetCenti: 800, parts: [{ key: A, centi: 800 }],
  worked: true, versionId: 1, departmentId: D1, frozen: true, preliminary: false, ...over,
});

const monthRow = (id: number, over: Partial<IStaffMonthRow> = {}): IStaffMonthRow => ({
  employee_id: id, full_name: `Сотрудник ${id}`, department: { id: D1, name: 'Отдел 1' }, category: 'itr', is_worker: false,
  object: dict.get(B)!, object_source: 'hours', timesheet_object: { mode: 'skud', object: null }, objects: [], hours: 0,
  norm: { hours: null, days: null, complete: false, weekend_quota: { saturdays: 0, sundays: 0, hours: 0 } },
  brigade: null, preliminary: false, object_config_error: false, object_frozen: true,
  days: Array.from({ length: 30 }, (_, index): IStaffMonthDay => ({
    date: date(index + 1), employed: true, day_kind: 'work', working_day: true, plan_hours: 8, status_code: null,
    timesheet_hours: 0, hours: 0, objects: [], source: null,
  })),
  ...over,
});

/** Разбивка «Свода» из дней — как toBreakdownRows снимка. */
const breakdownOf = (days: Iterable<IDayRecord>): ISummaryBreakdownRow[] => [...days].flatMap(day => day.parts.map(part => ({
  version_id: day.versionId ?? 0, department_id: day.departmentId, object_key: part.key, object_id: part.key,
  object_name: dict.get(part.key)?.name ?? null, object_address: null, hours: part.centi / 100,
})));

const build = (now: string, rows: Array<[IStaffMonthRow, IDayRecord[]]>): ReturnType<typeof buildStaffMonthHalves> => {
  const input: IHalfBuildInput = {
    bounds: monthBoundsOf(MONTH, new Date(now)),
    monthRows: rows.map(([row]) => row),
    dayRecords: new Map(rows.map(([row, records]) => [row.employee_id, new Map(records.map(item => [item.date, item]))])),
    dict,
    breakdownOf,
    shares: [],
    brigadeIds: [],
    departmentName: new Map([[D1, 'Отдел 1'], [D2, 'Отдел 2']]),
    apiObject: key => dict.get(key) ?? UNKNOWN_OBJECT,
  };
  return buildStaffMonthHalves(input);
};

describe('staff-month-1c.half — половины месяца', () => {
  it('15-е: табель 1–15 закрыт, но половина идёт — не готова; вторая не началась — строк нет', () => {
    const halves = build('2026-11-15T12:00:00Z', [[monthRow(1), [record(1), record(15)]]]);
    expect(halves[1].bounds).toMatchObject({ started: true, ended: false });
    expect(halves[1].rows[0]).toMatchObject({ employee_id: 1, hours: 16, preliminary: true });
    expect(halves[1].preliminary).toBe(true);
    expect(halves[2].bounds.started).toBe(false);
    expect(halves[2].rows).toEqual([]);
  });

  it('16-е по Москве: 1–15 закрыта — готова; вторая идёт — не готова', () => {
    const halves = build('2026-11-15T21:30:00Z', [[monthRow(1), [record(1), record(15), record(16, { source: 'live', preliminary: true, versionId: null })]]]);
    expect(halves[1].rows[0]).toMatchObject({ hours: 16, preliminary: false });
    expect(halves[1].preliminary).toBe(false);
    expect(halves[2].rows[0]).toMatchObject({ hours: 8, preliminary: true });
  });

  it('состав: принят 16-го — только во второй, уволен 15-го — только в первой', () => {
    const halves = build('2026-12-05T10:00:00Z', [
      [monthRow(1), [record(16), record(20)]],
      [monthRow(2), [record(3), record(15)]],
    ]);
    expect(halves[1].rows.map(row => row.employee_id)).toEqual([2]);
    expect(halves[2].rows.map(row => row.employee_id)).toEqual([1]);
    expect(halves[1].index.has(1)).toBe(false);
  });

  it('отдел половины: при равных часах — подача с бóльшей редакцией; перевод на границе — у половин свой отдел', () => {
    const halves = build('2026-12-05T10:00:00Z', [[monthRow(1), [
      record(2, { versionId: 10, departmentId: D1 }),
      record(3, { versionId: 11, departmentId: D2 }),
      record(16, { versionId: 12, departmentId: D1 }),
    ]]]);
    expect(halves[1].rows[0].department).toEqual({ id: D2, name: 'Отдел 2' });
    expect(halves[2].rows[0].department).toEqual({ id: D1, name: 'Отдел 1' });
  });

  it('подача на месяц не закрыта — дни живые, обе половины не готовы, хотя половины прошли', () => {
    const live = (day: number) => record(day, { source: 'live', preliminary: true, versionId: null, departmentId: null });
    const halves = build('2026-12-05T10:00:00Z', [[monthRow(1), [live(5), live(20)]]]);
    expect(halves[1].rows[0].preliminary).toBe(true);
    expect(halves[2].rows[0].preliminary).toBe(true);
    // Отдела у живых дней нет — отдел месяца.
    expect(halves[1].rows[0].department).toEqual({ id: D1, name: 'Отдел 1' });
  });

  it('объект половины: часы → объект табелирования → объект месяца; ошибка режима — «Не определён»', () => {
    const vacation = (day: number) => record(day, { status: 'vacation', worked: false, parts: [] });
    const halves = build('2026-12-05T10:00:00Z', [
      [monthRow(1), [record(2, { parts: [{ key: B, centi: 800 }] }), record(16)]],
      [monthRow(2, { timesheet_object: { mode: 'object', object: dict.get(A)! } }), [vacation(3)]],
      [monthRow(3), [vacation(3)]],
      [monthRow(4, { object_config_error: true, object: UNKNOWN_OBJECT }), [record(3)]],
    ]);
    const first = new Map(halves[1].rows.map(row => [row.employee_id, row]));
    expect(first.get(1)).toMatchObject({ object: { key: B }, object_source: 'hours' });
    expect(halves[2].rows[0]).toMatchObject({ employee_id: 1, object: { key: A }, object_source: 'hours' });
    expect(first.get(2)).toMatchObject({ object: { key: A }, object_source: 'timesheet_object', hours: 0 });
    expect(first.get(3)).toMatchObject({ object: { key: B }, object_source: 'month' });
    expect(first.get(4)).toMatchObject({ object: UNKNOWN_OBJECT, object_source: 'unknown' });
    // Отбор по объекту — индекс половины.
    expect(halves[1].index.get(1)?.mainKey).toBe(B);
    expect(halves[2].index.get(1)?.mainKey).toBe(A);
  });
});
