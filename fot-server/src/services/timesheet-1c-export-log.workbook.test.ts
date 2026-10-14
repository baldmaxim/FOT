import { beforeEach, describe, expect, it, vi } from 'vitest';
import type ExcelJS from 'exceljs';
import type { IResolvedSchedule } from '../types/index.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';

// Журнал выгрузок обязан хранить ровно то, что в файле: собираем настоящий workbook из
// шаблона 1С и сверяем каждую ячейку строки со снимком журнала (serializeUnifiedRowsForLog).

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./access-control.service.js', () => ({ hasPageEdit: vi.fn(async () => true) }));
// Режимы резолвятся по парам «сотрудник + отдел строки» (unnest) — размножаем строки моков.
vi.mock('../config/postgres.js', () => ({
  query: async (sql: string, params?: unknown[]) => {
    const rows = await queryMock(sql, params);
    if (!sql.includes('unnest($1::int[], $2::uuid[])') || !Array.isArray(rows)) return rows;
    const [empIds, deptIds] = params as [number[], Array<string | null>];
    return empIds.flatMap((empId, index) => rows
      .filter((row: { employee_id: number }) => Number(row.employee_id) === empId)
      .map((row: Record<string, unknown>) => ({ ...row, pair_dept_id: deptIds[index] })));
  },
  withTransaction: vi.fn(),
}));

import { buildUnified1CWorkbookWithRows } from './timesheet-1c-unified.service.js';
import { serializeUnifiedRowsForLog } from './timesheet-1c-export-log.service.js';

const DEPT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const DEPT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const OBJ_A = 'cccccccc-0000-4000-8000-00000000000c';
const OBJ_PIN = 'dddddddd-0000-4000-8000-00000000000d';

const COL_NUM = 1;
const COL_FIO = 2;
const COL_DAY1 = 3;
const COL_TOTAL = 34;
const COL_DAYS = 35;
const COL_DEPARTMENT = 36;
const COL_ADDRESS = 37;
const COL_MANAGER = 38;
const COL_POSITION = 39;

const schedule: IResolvedSchedule = {
  schedule_id: 'sched-1',
  schedule_type: 'office',
  work_start: '09:00:00',
  work_end: '18:00:00',
  work_hours: 8,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 0,
  respects_holidays: true,
  pattern_type: 'custom',
  expected_saturdays_per_month: 0,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
  source: 'default',
};

interface IFixtureEmployee {
  id: number;
  fullName: string;
  orgDepartmentId: string;
  positionId?: string;
  days: Array<{ date: string; status: string; hours: number }>;
  objects?: Array<{ date: string; objectId: string; objectName: string; hours: number }>;
}

const makeData = (
  departmentName: string,
  departmentId: string | null,
  employees: IFixtureEmployee[],
): IDepartmentTimesheetData => ({
  departmentName,
  departmentId,
  isBrigade: false,
  employees: employees.map(e => ({
    id: e.id,
    full_name: e.fullName,
    position_id: e.positionId ?? null,
    org_department_id: e.orgDepartmentId,
    sigur_employee_id: null,
    employment_status: 'active',
  })),
  schedulesMap: new Map(employees.map(e => [e.id, schedule])),
  dailySchedulesMap: new Map(employees.map(e => [e.id, new Map<string, IResolvedSchedule>()])),
  calendarMonth: null,
  entries: [],
  dataMap: new Map(employees.map(e => [
    e.id,
    new Map(e.days.map(d => [d.date, { status: d.status, hours: d.hours, corrected: false }])),
  ])),
  objectEntries: employees.flatMap(e => (e.objects ?? []).map(o => ({
    adjustment_id: null,
    employee_id: e.id,
    work_date: o.date,
    object_key: o.objectId,
    object_id: o.objectId,
    object_name: o.objectName,
    hours_worked: o.hours,
    display_hours_worked: o.hours,
    base_hours_worked: o.hours,
    is_correction: false,
  }))),
  skudMap: new Map(),
  posMap: new Map([['pos-1', 'Монтажник']]),
  year: 2026,
  mon: 4,
  daysInMonth: 30,
  exportHalf: 'FULL',
  // 04.04.2026 — суббота: пустой выходной в файле без значения.
  exportDays: [1, 2, 3, 4],
  showActualHours: false,
});

const readCell = (ws: ExcelJS.Worksheet, row: number, col: number): unknown => ws.getCell(row, col).value ?? null;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('timesheet_export_mode')) {
      return Promise.resolve([
        { employee_id: 1, emp_mode: 'skud', emp_object_id: null, dept_current_activity: false },
        { employee_id: 2, emp_mode: 'object', emp_object_id: OBJ_PIN, emp_window_pin: true, dept_current_activity: false },
        { employee_id: 3, emp_mode: 'current_activity', emp_object_id: null, dept_current_activity: false },
      ]);
    }
    if (sql.includes('FROM skud_objects')) {
      return Promise.resolve([
        { id: OBJ_A, alt_name: null, name: 'ЖК Сад 69' },
        { id: OBJ_PIN, alt_name: 'Автозаводская ул., вл. 23/2', name: 'ЖК Зил' },
      ]);
    }
    return Promise.resolve([]);
  });
});

describe('журнал выгрузок = ячейки «Единого файла для 1С»', () => {
  it('каждая строка журнала совпадает с ячейками своей строки Excel', async () => {
    const departmentData = makeData('Отдел А', DEPT_A, [{
      // Формула в начале ФИО экранируется — журнал хранит экранированное значение.
      id: 1,
      fullName: '=Иванов Иван',
      orgDepartmentId: DEPT_A,
      positionId: 'pos-1',
      days: [
        { date: '2026-04-01', status: 'work', hours: 8 },
        { date: '2026-04-02', status: 'sick', hours: 0 },
        { date: '2026-04-03', status: 'absent', hours: 0 },
      ],
      objects: [{ date: '2026-04-01', objectId: OBJ_A, objectName: 'ЖК Сад 69', hours: 8 }],
    }]);
    // Набор без отдела (как в выгрузке по объектам): отдел строки — текущий отдел сотрудника.
    const objectsLikeData = makeData('Отдел Б', null, [
      {
        // Назначен в окне без часов: строка остаётся, итог и «Дни» — пустые ячейки.
        id: 2,
        fullName: 'Петров Пётр',
        orgDepartmentId: DEPT_B,
        days: [{ date: '2026-04-01', status: 'work', hours: 0 }],
      },
      {
        id: 3,
        fullName: 'Сидоров Семён',
        orgDepartmentId: DEPT_B,
        days: [
          { date: '2026-04-01', status: 'work', hours: 6 },
          { date: '2026-04-02', status: 'vacation', hours: 0 },
        ],
      },
    ]);

    const { workbook, rows } = await buildUnified1CWorkbookWithRows(4, 2026, [departmentData, objectsLikeData]);
    const ws = workbook.getWorksheet(1)!;
    const logRows = serializeUnifiedRowsForLog(rows);

    expect(logRows.map(r => r.employee_id)).toEqual([1, 2, 3]);
    for (const logRow of logRows) {
      const r = logRow.excel_row;
      expect(readCell(ws, r, COL_NUM)).toBe(r - 3);
      expect(readCell(ws, r, COL_FIO)).toBe(logRow.full_name);
      for (let day = 1; day <= 31; day++) {
        expect(readCell(ws, r, COL_DAY1 + day - 1)).toBe(logRow.days[String(day)] ?? null);
      }
      expect(readCell(ws, r, COL_TOTAL)).toBe(logRow.total_hours);
      expect(readCell(ws, r, COL_DAYS)).toBe(logRow.worked_days);
      expect(readCell(ws, r, COL_DEPARTMENT)).toBe(logRow.department_name);
      expect(readCell(ws, r, COL_ADDRESS)).toBe(logRow.object_address);
      expect(readCell(ws, r, COL_MANAGER)).toBe(logRow.manager_name);
      expect(readCell(ws, r, COL_POSITION)).toBe(logRow.position);
    }
    // Строк в листе ровно столько, сколько в журнале.
    expect(readCell(ws, logRows[logRows.length - 1].excel_row + 1, COL_FIO)).toBeNull();

    const [ivanov, petrov, sidorov] = logRows;
    expect(ivanov).toMatchObject({
      excel_row: 4,
      full_name: "'=Иванов Иван",
      department_id: DEPT_A,
      object_id: OBJ_A,
      object_address: 'ЖК Сад 69',
      position: 'Монтажник',
    });
    // «Н» в файл не выводится, буква больничного — выводится, суббота пустая.
    expect(ivanov.days['3']).toBeUndefined();
    expect(ivanov.days['4']).toBeUndefined();
    expect(Object.values(ivanov.days)).toContain('Б');

    expect(petrov).toMatchObject({
      department_id: DEPT_B,
      object_id: OBJ_PIN,
      object_address: 'Автозаводская ул., вл. 23/2',
      total_hours: null,
      worked_days: null,
    });
    expect(sidorov).toMatchObject({
      department_id: DEPT_B,
      object_id: null,
      object_address: 'Текущая деятельность',
      total_hours: 6,
    });
  });
});
