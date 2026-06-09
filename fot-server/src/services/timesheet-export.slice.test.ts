import { describe, it, expect } from 'vitest';
import {
  sliceTimesheetDataByEmployees,
  type IDepartmentTimesheetData,
} from './timesheet-export.service.js';
import type { IResolvedSchedule } from '../types/index.js';
import type { IAttendanceEntry } from './attendance.service.js';
import type { IAttendanceObjectEntry } from './timesheet-object.service.js';

// Минимальный bulk-результат с тремя сотрудниками (id 1,2,3). Для проверки
// нарезки достаточно полей employee_id / ключей Map; остальное — заглушки.
const makeBulk = (): IDepartmentTimesheetData => {
  const sched = {} as IResolvedSchedule;
  const entry = (employee_id: number): IAttendanceEntry =>
    ({ employee_id, work_date: '2026-06-01', status: 'work' } as unknown as IAttendanceEntry);
  const objEntry = (employee_id: number): IAttendanceObjectEntry =>
    ({ employee_id, work_date: '2026-06-01', object_key: 'o1' } as unknown as IAttendanceObjectEntry);
  const calendarMonth = { year: 2026, month: 6 } as IDepartmentTimesheetData['calendarMonth'];

  return {
    departmentName: 'Все отделы',
    departmentId: null,
    isBrigade: false,
    employees: [
      { id: 1, full_name: 'A', position_id: null, org_department_id: null, sigur_employee_id: null },
      { id: 2, full_name: 'B', position_id: null, org_department_id: null, sigur_employee_id: null },
      { id: 3, full_name: 'C', position_id: null, org_department_id: null, sigur_employee_id: null },
    ],
    schedulesMap: new Map([[1, sched], [2, sched], [3, sched]]),
    dailySchedulesMap: new Map([
      [1, new Map([['2026-06-01', sched]])],
      [2, new Map([['2026-06-01', sched]])],
      [3, new Map([['2026-06-01', sched]])],
    ]),
    calendarMonth,
    entries: [entry(1), entry(2), entry(3), entry(1)],
    dataMap: new Map([
      [1, new Map([['2026-06-01', { status: 'work', hours: 8 }]])],
      [2, new Map([['2026-06-01', { status: 'work', hours: 8 }]])],
      [3, new Map([['2026-06-01', { status: 'work', hours: 8 }]])],
    ]),
    objectEntries: [objEntry(1), objEntry(2), objEntry(3)],
    skudMap: new Map([
      [1, new Map([['2026-06-01', { hours: 8, corrected: false }]])],
      [2, new Map([['2026-06-01', { hours: 8, corrected: false }]])],
    ]),
    posMap: new Map([['p1', 'Должность']]),
    year: 2026,
    mon: 6,
    daysInMonth: 30,
    exportHalf: 'FULL',
    exportDays: [1, 2, 3],
    showActualHours: true,
    cutoffByEmployeeId: new Map([[2, '2026-06-10']]),
  };
};

describe('sliceTimesheetDataByEmployees', () => {
  it('оставляет только указанных сотрудников во всех массивах и Map', () => {
    const bulk = makeBulk();
    const sliced = sliceTimesheetDataByEmployees(bulk, [1, 3], 'бр.Иванов', 'dept-1');

    expect(sliced.employees.map(e => e.id)).toEqual([1, 3]);
    expect(sliced.entries.every(e => e.employee_id === 1 || e.employee_id === 3)).toBe(true);
    expect(sliced.entries).toHaveLength(3); // entry(1) x2 + entry(3)
    expect(sliced.objectEntries.map(e => e.employee_id)).toEqual([1, 3]);
    expect([...sliced.dataMap.keys()]).toEqual([1, 3]);
    expect([...sliced.schedulesMap.keys()]).toEqual([1, 3]);
    expect([...sliced.dailySchedulesMap.keys()]).toEqual([1, 3]);
    // id 2 был в skudMap/cutoff — после нарезки по [1,3] исчезает.
    expect([...sliced.skudMap.keys()]).toEqual([1]);
    expect([...(sliced.cutoffByEmployeeId?.keys() ?? [])]).toEqual([]);
  });

  it('проставляет имя/идентификатор отдела и флаг бригады', () => {
    const bulk = makeBulk();
    expect(sliceTimesheetDataByEmployees(bulk, [1], 'бр.Петров', 'd').isBrigade).toBe(true);
    const dept = sliceTimesheetDataByEmployees(bulk, [1], 'Отдел кадров', 'd2');
    expect(dept.isBrigade).toBe(false);
    expect(dept.departmentName).toBe('Отдел кадров');
    expect(dept.departmentId).toBe('d2');
  });

  it('сохраняет общие поля по ссылке и не мутирует исходный bulk', () => {
    const bulk = makeBulk();
    const sliced = sliceTimesheetDataByEmployees(bulk, [1], 'X', 'd');

    expect(sliced.calendarMonth).toBe(bulk.calendarMonth);
    expect(sliced.posMap).toBe(bulk.posMap);
    expect(sliced.exportDays).toBe(bulk.exportDays);
    expect(sliced.year).toBe(2026);
    expect(sliced.showActualHours).toBe(true);
    // исходный bulk не тронут
    expect(bulk.employees).toHaveLength(3);
    expect([...bulk.dataMap.keys()]).toEqual([1, 2, 3]);
  });
});
