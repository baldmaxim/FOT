import { describe, expect, it } from 'vitest';
import { isDateInEmployeeWindows } from './timesheet-day-windows.service.js';
import { sliceTimesheetDataByEmployees, type IDepartmentTimesheetData } from './timesheet-export.service.js';
import type { IAttendanceEntry } from './attendance.service.js';
import type { IAttendanceObjectEntry } from './timesheet-object.service.js';

describe('isDateInEmployeeWindows — семантика пустых значений', () => {
  it('карты нет → сотрудник не ограничен', () => {
    expect(isDateInEmployeeWindows({}, 1, '2026-09-20')).toBe(true);
  });

  it('ключа нет → не ограничен', () => {
    expect(isDateInEmployeeWindows({ dayWindowsByEmployeeId: new Map([[2, []]]) }, 1, '2026-09-20')).toBe(true);
  });

  it('пустой массив → ни одного дня (не утечка полного месяца)', () => {
    expect(isDateInEmployeeWindows({ dayWindowsByEmployeeId: new Map([[1, []]]) }, 1, '2026-09-20')).toBe(false);
  });

  it('{ null, null } → весь период', () => {
    const data = { dayWindowsByEmployeeId: new Map([[1, [{ from: null, toExclusive: null }]]]) };
    expect(isDateInEmployeeWindows(data, 1, '2026-09-01')).toBe(true);
    expect(isDateInEmployeeWindows(data, 1, '2026-09-30')).toBe(true);
  });

  it('полуинтервал [from, toExclusive): правая граница не входит', () => {
    const data = { dayWindowsByEmployeeId: new Map([[1, [{ from: '2026-09-10', toExclusive: '2026-09-15' }]]]) };
    expect(isDateInEmployeeWindows(data, 1, '2026-09-09')).toBe(false);
    expect(isDateInEmployeeWindows(data, 1, '2026-09-10')).toBe(true);
    expect(isDateInEmployeeWindows(data, 1, '2026-09-14')).toBe(true);
    expect(isDateInEmployeeWindows(data, 1, '2026-09-15')).toBe(false);
  });

  it('два интервала (A→B→A): дни между ними не входят', () => {
    const data = {
      dayWindowsByEmployeeId: new Map([[1, [
        { from: null, toExclusive: '2026-09-10' },
        { from: '2026-09-20', toExclusive: null },
      ]]]),
    };
    expect(isDateInEmployeeWindows(data, 1, '2026-09-05')).toBe(true);
    expect(isDateInEmployeeWindows(data, 1, '2026-09-15')).toBe(false);
    expect(isDateInEmployeeWindows(data, 1, '2026-09-25')).toBe(true);
  });
});

describe('sliceTimesheetDataByEmployees — окна дней', () => {
  const makeBulk = (): IDepartmentTimesheetData => {
    const dates = ['2026-09-14', '2026-09-15'];
    const byDate = <V>(value: V) => new Map(dates.map(d => [d, value]));
    return {
      departmentName: 'Сводный 1С',
      departmentId: null,
      isBrigade: false,
      employees: [
        { id: 1, full_name: 'Переведённый', position_id: null, org_department_id: 'B', sigur_employee_id: null },
        { id: 2, full_name: 'Сосед', position_id: null, org_department_id: 'A', sigur_employee_id: null },
      ],
      schedulesMap: new Map(),
      dailySchedulesMap: new Map(),
      calendarMonth: null,
      entries: [1, 2].flatMap(id => dates.map(d => ({ employee_id: id, work_date: d } as unknown as IAttendanceEntry))),
      dataMap: new Map([[1, byDate({ status: 'work', hours: 10 })], [2, byDate({ status: 'work', hours: 10 })]]),
      objectEntries: [1, 2].flatMap(id => dates.map(d => ({ employee_id: id, work_date: d, object_key: d } as unknown as IAttendanceObjectEntry))),
      skudMap: new Map([[1, byDate({ hours: 10, corrected: false })]]),
      posMap: new Map(),
      year: 2026,
      mon: 9,
      daysInMonth: 30,
      exportHalf: 'FULL',
      exportDays: [14, 15],
      showActualHours: true,
    };
  };

  it('дни вне окна вырезаются из entries/objectEntries/dataMap/skudMap, окно кладётся в срез', () => {
    const windows = new Map([[1, [{ from: null, toExclusive: '2026-09-15' }]]]);
    const slice = sliceTimesheetDataByEmployees(makeBulk(), [1, 2], 'бр.Зулфикаров', 'A', windows);

    expect(slice.entries.filter(e => e.employee_id === 1).map(e => e.work_date)).toEqual(['2026-09-14']);
    expect(slice.objectEntries.filter(e => e.employee_id === 1).map(e => e.work_date)).toEqual(['2026-09-14']);
    expect([...slice.dataMap.get(1)!.keys()]).toEqual(['2026-09-14']);
    expect([...slice.skudMap.get(1)!.keys()]).toEqual(['2026-09-14']);
    expect(slice.dayWindowsByEmployeeId).toEqual(windows);
    // Сосед без окна не тронут.
    expect([...slice.dataMap.get(2)!.keys()]).toEqual(['2026-09-14', '2026-09-15']);
  });

  it('окна сотрудников вне среза в срез не попадают; без окон поле не задаётся', () => {
    const bulk = makeBulk();
    const slice = sliceTimesheetDataByEmployees(bulk, [2], 'A', 'A', new Map([[1, []]]));
    expect(slice.dayWindowsByEmployeeId).toBeUndefined();
    expect(sliceTimesheetDataByEmployees(bulk, [2], 'A', 'A').dayWindowsByEmployeeId).toBeUndefined();
  });
});
