import { beforeEach, describe, expect, it, vi } from 'vitest';
import type ExcelJS from 'exceljs';
import { buildUnified1CRows, buildUnified1CWorkbook } from './timesheet-1c-unified.service.js';
import type { IResolvedSchedule } from '../types/index.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import type { IDayWindow } from './timesheet-day-windows.service.js';

// Единый файл 1С: сотрудник переведён внутри периода (Пулатов: бр.Зулфикаров по 14.09,
// бр.Хайдаров с 15.09). Дни, отдел, руководитель и режим строки — по отделу этих дней.

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./access-control.service.js', () => ({ hasPageEdit: vi.fn(async () => true) }));
vi.mock('../config/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
}));

const ONE_C_DATA_START_ROW = 4;
const COL_FIO = 2;
const COL_DAY1 = 3;
const COL_TOTAL = 34;
const COL_DEPT = 36;
const COL_ADDRESS = 37;
const COL_MANAGER = 38;

const ZULF = 'dept-zulf';
const HAYD = 'dept-hayd';

const schedule = {
  schedule_id: 's', schedule_type: 'office', work_start: '08:00:00', work_end: '18:00:00', work_hours: 10,
  work_days: [1, 2, 3, 4, 5, 6, 0], office_days: null, late_threshold_minutes: 0, day_overrides: null,
  lunch_minutes: 0, respects_holidays: false, pattern_type: 'custom', expected_saturdays_per_month: 0,
  expected_sundays_per_month: 0, full_day_threshold_minutes: null, weekend_full_day_threshold_minutes: null,
  cycle_length: null, cycle_days: null, anchor_date: null, assignment_anchor_date: null, source: 'default',
} as IResolvedSchedule;

interface IEmp {
  id: number;
  full_name: string;
  currentDept: string;
  days: number[];
  objects?: Array<{ day: number; object_id: string; object_name: string; hours: number }>;
  cutoff?: string;
}

const iso = (day: number): string => `2026-09-${String(day).padStart(2, '0')}`;

const makeSlice = (
  departmentName: string,
  departmentId: string | null,
  emps: IEmp[],
  windows?: Map<number, IDayWindow[]>,
): IDepartmentTimesheetData => ({
  departmentName,
  departmentId,
  isBrigade: true,
  employees: emps.map(e => ({
    id: e.id, full_name: e.full_name, position_id: null, org_department_id: e.currentDept, sigur_employee_id: null,
  })),
  schedulesMap: new Map(emps.map(e => [e.id, schedule])),
  dailySchedulesMap: new Map(emps.map(e => [e.id, new Map<string, IResolvedSchedule>()])),
  calendarMonth: null,
  entries: [],
  dataMap: new Map(emps.map(e => [e.id, new Map(e.days.map(d => [iso(d), { status: 'work', hours: 10, corrected: false }]))])),
  objectEntries: emps.flatMap(e => (e.objects ?? []).map(o => ({
    adjustment_id: null,
    employee_id: e.id,
    work_date: iso(o.day),
    object_key: o.object_id,
    object_id: o.object_id,
    object_name: o.object_name,
    hours_worked: o.hours,
    display_hours_worked: o.hours,
    base_hours_worked: o.hours,
    is_correction: false,
  }))),
  skudMap: new Map(),
  posMap: new Map(),
  year: 2026,
  mon: 9,
  daysInMonth: 30,
  exportHalf: 'FULL',
  exportDays: Array.from({ length: 16 }, (_, i) => i + 1),
  showActualHours: false,
  cutoffByEmployeeId: new Map(emps.filter(e => e.cutoff).map(e => [e.id, e.cutoff!])),
  dayWindowsByEmployeeId: windows,
});

type ModeByDept = Record<string, Record<string, unknown>>;

const mockDb = (deptModes: ModeByDept = {}): void => {
  queryMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('unnest($1::int[], $2::uuid[])')) {
      const [empIds, deptIds] = params as [number[], Array<string | null>];
      return Promise.resolve(empIds.map((employee_id, i) => ({
        employee_id,
        pair_dept_id: deptIds[i],
        emp_mode: null,
        emp_object_id: null,
        dept_mode: null,
        dept_object_id: null,
        dept_current_activity: false,
        ...(deptModes[deptIds[i] ?? ''] ?? {}),
      })));
    }
    if (sql.includes('FROM employee_department_access')) {
      return Promise.resolve([
        { employee_id: 100, department_id: ZULF, role_code: 'manager', is_admin: false },
        { employee_id: 200, department_id: HAYD, role_code: 'manager', is_admin: false },
      ]);
    }
    if (sql.includes('SELECT id, full_name FROM employees')) {
      return Promise.resolve([
        { id: 100, full_name: 'Хусайнов Довуд' },
        { id: 200, full_name: 'Остриогло Вадим Иванович' },
      ]);
    }
    if (sql.includes('FROM skud_objects')) {
      return Promise.resolve([
        { id: 'obj-13', alt_name: 'Волоколамское ш., вл. 71/13, ЖК', name: '71/13' },
        { id: 'obj-14', alt_name: 'Волоколамское ш., вл. 71/14, ЖК', name: '71/14' },
        { id: 'obj-93', alt_name: 'Волоколамское ш., вл. 93-97, ЖК', name: '93-97' },
      ]);
    }
    return Promise.resolve([]);
  });
};

interface ISheetRow {
  fio: string;
  dept: string;
  address: string;
  manager: string;
  total: unknown;
  days: unknown[];
}

const readRows = (ws: ExcelJS.Worksheet): ISheetRow[] => {
  const rows: ISheetRow[] = [];
  for (let r = ONE_C_DATA_START_ROW; r <= ws.rowCount; r++) {
    const fio = ws.getCell(r, COL_FIO).value;
    if (typeof fio !== 'string' || !fio.trim()) continue;
    rows.push({
      fio,
      dept: String(ws.getCell(r, COL_DEPT).value ?? ''),
      address: String(ws.getCell(r, COL_ADDRESS).value ?? ''),
      manager: String(ws.getCell(r, COL_MANAGER).value ?? ''),
      total: ws.getCell(r, COL_TOTAL).value,
      days: Array.from({ length: 16 }, (_, i) => ws.getCell(r, COL_DAY1 + i).value),
    });
  }
  return rows;
};

const PULATOV: IEmp = {
  id: 2588,
  full_name: 'Пулатов Аскар Тиничбаевич',
  currentDept: HAYD,
  days: [1, 2, 14, 15, 16],
  objects: [
    { day: 1, object_id: 'obj-13', object_name: '71/13', hours: 10 },
    { day: 2, object_id: 'obj-13', object_name: '71/13', hours: 10 },
    { day: 14, object_id: 'obj-13', object_name: '71/13', hours: 10 },
    { day: 15, object_id: 'obj-93', object_name: '93-97', hours: 10 },
    { day: 16, object_id: 'obj-93', object_name: '93-97', hours: 6 },
  ],
};

const BEFORE = new Map([[PULATOV.id, [{ from: null, toExclusive: '2026-09-15' }]]]);
const AFTER = new Map([[PULATOV.id, [{ from: '2026-09-15', toExclusive: null }]]]);

beforeEach(() => {
  queryMock.mockReset();
});

describe('единый 1С: перевод внутри периода', () => {
  it('файл старого участка: только дни до перевода, отдел и руководитель старого отдела', async () => {
    mockDb();
    const ws = (await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV], BEFORE),
    ])).getWorksheet(1)!;
    const rows = readRows(ws);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dept: 'бр.Зулфикаров Т.Т.',
      address: 'Волоколамское ш., вл. 71/13, ЖК',
      manager: 'Хусайнов Довуд',
      total: 30,
    });
    expect(rows[0].days[14]).toBeNull();
    expect(rows[0].days[15]).toBeNull();
  });

  it('файл нового участка: только дни после перевода, руководитель нового отдела', async () => {
    mockDb();
    const rows = readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Хайдаров Н.И.', HAYD, [PULATOV], AFTER),
    ])).getWorksheet(1)!);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dept: 'бр.Хайдаров Н.И.',
      address: 'Волоколамское ш., вл. 93-97, ЖК',
      manager: 'Остриогло Вадим Иванович',
      total: 16,
    });
    expect(rows[0].days[0]).toBeNull();
    expect(rows[0].days[13]).toBeNull();
  });

  it('A + B = A∪B: сумма часов двух файлов равна одному общему, дни не задваиваются', async () => {
    mockDb();
    const totalOf = async (slices: IDepartmentTimesheetData[]): Promise<number> =>
      readRows((await buildUnified1CWorkbook(9, 2026, slices)).getWorksheet(1)!)
        .reduce((sum, r) => sum + Number(r.total ?? 0), 0);

    const a = await totalOf([makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV], BEFORE)]);
    const b = await totalOf([makeSlice('бр.Хайдаров Н.И.', HAYD, [PULATOV], AFTER)]);
    const both = await totalOf([
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV], BEFORE),
      makeSlice('бр.Хайдаров Н.И.', HAYD, [PULATOV], AFTER),
    ]);
    const unsplit = await totalOf([makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV])]);

    expect(a + b).toBe(both);
    expect(both).toBe(unsplit);
  });

  it('режим — по отделу строки: старый отдел «текущая деятельность», новый — разбивка по объектам', async () => {
    mockDb({ [ZULF]: { dept_mode: 'current_activity' } });
    const rows = readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV], BEFORE),
      makeSlice('бр.Хайдаров Н.И.', HAYD, [PULATOV], AFTER),
    ])).getWorksheet(1)!);

    expect(rows.map(r => [r.dept, r.address])).toEqual([
      ['бр.Зулфикаров Т.Т.', 'Текущая деятельность'],
      ['бр.Хайдаров Н.И.', 'Волоколамское ш., вл. 93-97, ЖК'],
    ]);
  });

  it('A→B→A: одна запись в отделе A с днями обоих интервалов', async () => {
    mockDb();
    const emp: IEmp = { id: 7, full_name: 'Возвратный', currentDept: ZULF, days: [1, 8, 12] };
    const rows = readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [emp], new Map([[7, [
        { from: null, toExclusive: '2026-09-05' },
        { from: '2026-09-10', toExclusive: null },
      ]]])),
    ])).getWorksheet(1)!);

    expect(rows).toHaveLength(1);
    expect(rows[0].days[0]).toBe(10);
    expect(rows[0].days[7]).toBeNull();
    expect(rows[0].days[11]).toBe(10);
    expect(rows[0].total).toBe(20);
  });

  it('окно + cutoff уволенного: действуют оба ограничения', async () => {
    mockDb();
    const emp: IEmp = { id: 8, full_name: 'Уволенный', currentDept: HAYD, days: [1, 3, 5], cutoff: '2026-09-04' };
    const rows = readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [emp], new Map([[8, [{ from: '2026-09-02', toExclusive: null }]]])),
    ])).getWorksheet(1)!);

    expect(rows[0].days[0]).toBeNull(); // до окна
    expect(rows[0].days[2]).toBe(10);   // в окне, до cutoff
    expect(rows[0].days[4]).toBeNull(); // после cutoff
    expect(rows[0].total).toBe(10);
  });

  it('пустой массив окон → у сотрудника ни одного дня, строки нет', async () => {
    mockDb();
    const rows = readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV], new Map([[PULATOV.id, []]])),
    ])).getWorksheet(1)!);
    expect(rows).toHaveLength(0);
  });

  it('skud с окнами: несколько объектных строк внутри окна сохраняются', async () => {
    mockDb();
    const emp: IEmp = {
      id: 9, full_name: 'Двухобъектный', currentDept: HAYD, days: [1, 2, 20],
      objects: [
        { day: 1, object_id: 'obj-13', object_name: '71/13', hours: 10 },
        { day: 2, object_id: 'obj-14', object_name: '71/14', hours: 10 },
      ],
    };
    const rows = readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [emp], new Map([[9, [{ from: null, toExclusive: '2026-09-15' }]]])),
    ])).getWorksheet(1)!);

    expect(rows.map(r => r.address)).toEqual([
      'Волоколамское ш., вл. 71/13, ЖК',
      'Волоколамское ш., вл. 71/14, ЖК',
    ]);
    expect(rows.every(r => r.manager === 'Хусайнов Довуд')).toBe(true);
  });
});

describe('единый 1С: стабильный порядок строк', () => {
  it('однофамильцы и отделы с одинаковым названием — порядок не зависит от входа', async () => {
    mockDb();
    const twin = (id: number, dept: string): IEmp => ({
      id, full_name: 'Уринов Улугбек', currentDept: dept, days: [1],
      objects: [{ day: 1, object_id: 'obj-13', object_name: '71/13', hours: 10 }],
    });
    const slices = [
      makeSlice('бр.Одинаковая', HAYD, [twin(12, HAYD), twin(11, HAYD)]),
      makeSlice('бр.Одинаковая', ZULF, [twin(22, ZULF), twin(21, ZULF)]),
    ];
    const reversed = [
      makeSlice('бр.Одинаковая', ZULF, [twin(21, ZULF), twin(22, ZULF)]),
      makeSlice('бр.Одинаковая', HAYD, [twin(11, HAYD), twin(12, HAYD)]),
    ];

    const order = async (input: IDepartmentTimesheetData[]) =>
      (await buildUnified1CRows(input)).map(r => [r.departmentIdSort, r.employeeIdSort]);

    const expected = [[HAYD, 11], [HAYD, 12], [ZULF, 21], [ZULF, 22]];
    expect(await order(slices)).toEqual(expected);
    expect(await order(reversed)).toEqual(expected);
  });

  it('повторная сборка при тех же данных — те же строки и значения ячеек', async () => {
    mockDb();
    const build = async () => readRows((await buildUnified1CWorkbook(9, 2026, [
      makeSlice('бр.Зулфикаров Т.Т.', ZULF, [PULATOV], BEFORE),
      makeSlice('бр.Хайдаров Н.И.', HAYD, [PULATOV], AFTER),
    ])).getWorksheet(1)!);
    expect(await build()).toEqual(await build());
  });
});
