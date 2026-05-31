import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUnified1CWorkbook } from './timesheet-1c-unified.service.js';
import type { IResolvedSchedule } from '../types/index.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';

// Мокаем postgres: buildUnified1CWorkbook читает адреса объектов и список отделов
// в режиме «текущая деятельность» из БД. vi.hoisted — чтобы mock-фабрика видела queryMock.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
}));

const ONE_C_DATA_START_ROW = 4;
const COL_FIO = 2;
const COL_DAY1 = 3;
const COL_TOTAL = 34;
const COL_ADDRESS = 36;

const makeSchedule = (): IResolvedSchedule => ({
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
});

const makeDept = (
  departmentName: string,
  departmentId: string,
  employee: { id: number; full_name: string; org_department_id: string },
  dayHours: number,
  objects: Array<{ object_key: string; object_id: string; object_name: string; hours: number }>,
): IDepartmentTimesheetData => {
  const schedule = makeSchedule();
  return {
    departmentName,
    departmentId,
    isBrigade: false,
    employees: [{
      id: employee.id,
      full_name: employee.full_name,
      position_id: null,
      org_department_id: employee.org_department_id,
      sigur_employee_id: null,
    }],
    schedulesMap: new Map([[employee.id, schedule]]),
    dailySchedulesMap: new Map([[employee.id, new Map([['2026-04-01', schedule]])]]),
    calendarMonth: null,
    entries: [],
    dataMap: new Map([[employee.id, new Map([['2026-04-01', { status: 'work', hours: dayHours, corrected: false }]])]]),
    objectEntries: objects.map(o => ({
      adjustment_id: null,
      employee_id: employee.id,
      work_date: '2026-04-01',
      object_key: o.object_key,
      object_id: o.object_id,
      object_name: o.object_name,
      hours_worked: o.hours,
      display_hours_worked: o.hours,
      base_hours_worked: o.hours,
      is_correction: false,
    })),
    skudMap: new Map(),
    posMap: new Map(),
    year: 2026,
    mon: 4,
    daysInMonth: 30,
    exportHalf: 'FULL',
    exportDays: [1],
    showActualHours: false,
  };
};

describe('buildUnified1CWorkbook — режим «текущая деятельность»', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation((sql: string) => {
      // Отделы в режиме «текущая деятельность» (назначен объект с таким адресом).
      if (sql.includes('FROM department_object_assignment')) {
        return Promise.resolve([{ org_department_id: 'dept-cur' }]);
      }
      // Персональные назначения объектов сотрудникам (override отдела).
      if (sql.includes('FROM employee_object_assignment')) {
        return Promise.resolve([]);
      }
      // Карта адресов объектов для обычной разбивки (fetchObjectAddressMap).
      if (sql.includes('FROM skud_objects')) {
        return Promise.resolve([
          { id: 'obj-a', alt_name: null, name: 'ЖК Сад 69' },
          { id: 'obj-b', alt_name: null, name: 'Склад 7' },
          { id: 'obj-c', alt_name: null, name: 'Башня A' },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it('помеченный отдел: одна строка на сотрудника, адрес «Текущая деятельность», без разбивки по объектам', async () => {
    const deptNormal = makeDept('Обычный', 'dept-norm',
      { id: 1, full_name: 'Иван Иванов', org_department_id: 'dept-norm' },
      5, [{ object_key: 'obj-a', object_id: 'obj-a', object_name: 'ЖК Сад 69', hours: 5 }]);
    // Пётр ездил на два объекта (8+7), но дневной итог = 8ч (dataMap).
    const deptCurrent = makeDept('Текущий', 'dept-cur',
      { id: 2, full_name: 'Петр Петров', org_department_id: 'dept-cur' },
      8, [
        { object_key: 'obj-b', object_id: 'obj-b', object_name: 'Склад 7', hours: 8 },
        { object_key: 'obj-c', object_id: 'obj-c', object_name: 'Башня A', hours: 7 },
      ]);

    const wb = await buildUnified1CWorkbook(4, 2026, [deptNormal, deptCurrent]);
    const ws = wb.getWorksheet(1)!;

    const dataRows: Array<{ fio: string; address: string; total: unknown; day1: unknown }> = [];
    for (let r = ONE_C_DATA_START_ROW; r <= ws.rowCount; r++) {
      const fio = ws.getCell(r, COL_FIO).value;
      if (typeof fio !== 'string' || !fio.trim()) continue;
      dataRows.push({
        fio,
        address: String(ws.getCell(r, COL_ADDRESS).value ?? ''),
        total: ws.getCell(r, COL_TOTAL).value,
        day1: ws.getCell(r, COL_DAY1).value,
      });
    }

    const petrRows = dataRows.filter(r => r.fio === 'Петр Петров');
    expect(petrRows).toHaveLength(1);
    expect(petrRows[0].address).toBe('Текущая деятельность');
    expect(petrRows[0].day1).toBe(8);
    expect(petrRows[0].total).toBe(8);

    // У Петра нет строк с адресами объектов.
    expect(dataRows.some(r => r.address === 'Склад 7')).toBe(false);
    expect(dataRows.some(r => r.address === 'Башня A')).toBe(false);

    // Обычный отдел не затронут — разбивка по объекту сохранена.
    const ivanRows = dataRows.filter(r => r.fio === 'Иван Иванов');
    expect(ivanRows).toHaveLength(1);
    expect(ivanRows[0].address).toBe('ЖК Сад 69');
    expect(ivanRows[0].day1).toBe(5);
  });

  it('персональный обычный объект переопределяет «текущую деятельность» отдела → разбивка по объекту', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM department_object_assignment')) {
        return Promise.resolve([{ org_department_id: 'dept-cur' }]);
      }
      if (sql.includes('FROM employee_object_assignment')) {
        // У Петра персональный обычный объект → override: НЕ «текущая деятельность».
        return Promise.resolve([{ employee_id: 2, is_current: false }]);
      }
      if (sql.includes('FROM skud_objects')) {
        return Promise.resolve([{ id: 'obj-b', alt_name: null, name: 'Склад 7' }]);
      }
      return Promise.resolve([]);
    });

    const deptCurrent = makeDept('Текущий', 'dept-cur',
      { id: 2, full_name: 'Петр Петров', org_department_id: 'dept-cur' },
      8, [{ object_key: 'obj-b', object_id: 'obj-b', object_name: 'Склад 7', hours: 8 }]);

    const wb = await buildUnified1CWorkbook(4, 2026, [deptCurrent]);
    const ws = wb.getWorksheet(1)!;
    const addresses: string[] = [];
    for (let r = ONE_C_DATA_START_ROW; r <= ws.rowCount; r++) {
      const fio = ws.getCell(r, COL_FIO).value;
      if (typeof fio !== 'string' || !fio.trim()) continue;
      addresses.push(String(ws.getCell(r, COL_ADDRESS).value ?? ''));
    }
    expect(addresses).toContain('Склад 7');
    expect(addresses).not.toContain('Текущая деятельность');
  });
});
