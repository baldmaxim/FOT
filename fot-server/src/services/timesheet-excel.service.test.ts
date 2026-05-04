import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import {
  build1CObjectTimesheetWorkbook,
  build1CTimesheetWorkbook,
  buildObjectTimesheetSheet,
  buildTimesheetSheet,
  listObjectExportTargets,
} from './timesheet-excel.service.js';

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
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  source: 'default',
});

const makeBaseData = (): IDepartmentTimesheetData => {
  const schedule = makeSchedule();
  return {
    departmentName: 'бр. Тест',
    departmentId: 'dept-1',
    isBrigade: true,
    employees: [
      {
        id: 1,
        full_name: 'Иван Иванов',
        position_id: null,
        org_department_id: 'dept-1',
        sigur_employee_id: 101,
      },
      {
        id: 2,
        full_name: 'Петр Петров',
        position_id: null,
        org_department_id: 'dept-1',
        sigur_employee_id: 102,
      },
    ],
    schedulesMap: new Map([
      [1, schedule],
      [2, schedule],
    ]),
    dailySchedulesMap: new Map([
      [1, new Map([['2026-04-01', schedule]])],
      [2, new Map([['2026-04-01', schedule]])],
    ]),
    calendarMonth: null as IProductionCalendarMonth | null,
    entries: [
      {
        id: null,
        employee_id: 1,
        work_date: '2026-04-01',
        status: 'work',
        hours_worked: 5,
        display_hours_worked: 5,
        base_hours_worked: 5,
        travel_minutes_credited: 0,
        travel_hours_credited: 0,
        travel_delay_minutes: 0,
        travel_segments_count: 0,
        travel_problematic_segments: 0,
        is_correction: false,
        first_entry: '09:05:00',
        last_exit: '18:00:00',
      },
      {
        id: null,
        employee_id: 2,
        work_date: '2026-04-01',
        status: 'work',
        hours_worked: 8,
        display_hours_worked: 8,
        base_hours_worked: 8,
        travel_minutes_credited: 0,
        travel_hours_credited: 0,
        travel_delay_minutes: 0,
        travel_segments_count: 0,
        travel_problematic_segments: 0,
        is_correction: false,
        first_entry: '08:55:00',
        last_exit: '18:00:00',
      },
    ],
    dataMap: new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 5, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 8, corrected: false }]])],
    ]),
    objectEntries: [
      {
        adjustment_id: null,
        employee_id: 1,
        work_date: '2026-04-01',
        object_key: 'obj-a',
        object_id: 'obj-a',
        object_name: 'ЖК Сад 69',
        hours_worked: 5,
        display_hours_worked: 5,
        base_hours_worked: 5,
        is_correction: false,
      },
      {
        adjustment_id: null,
        employee_id: 2,
        work_date: '2026-04-01',
        object_key: 'obj-b',
        object_id: 'obj-b',
        object_name: 'Склад 7',
        hours_worked: 8,
        display_hours_worked: 8,
        base_hours_worked: 8,
        is_correction: false,
      },
      {
        adjustment_id: null,
        employee_id: 2,
        work_date: '2026-04-01',
        object_key: 'obj-c',
        object_id: 'obj-c',
        object_name: 'Башня A',
        hours_worked: 7,
        display_hours_worked: 7,
        base_hours_worked: 7,
        is_correction: false,
      },
      {
        adjustment_id: null,
        employee_id: 2,
        work_date: '2026-04-01',
        object_key: 'obj-zero',
        object_id: 'obj-zero',
        object_name: 'Пустой объект',
        hours_worked: 0,
        display_hours_worked: 0,
        base_hours_worked: 0,
        is_correction: false,
      },
    ],
    skudMap: new Map(),
    posMap: new Map(),
    year: 2026,
    mon: 4,
    daysInMonth: 30,
    exportHalf: 'FULL',
    exportDays: [1],
  };
};

describe('timesheet-excel.service', () => {
  it('highlights underwork hours in employee export', () => {
    const wb = new ExcelJS.Workbook();
    const data = makeBaseData();

    buildTimesheetSheet(wb, 'Табель', data);

    const ws = wb.getWorksheet('Табель');
    expect(ws).toBeTruthy();
    const dayCell = ws!.getCell(7, 5);
    expect(dayCell.value).toBe('5:00');
    expect(dayCell.fill).toMatchObject({
      type: 'pattern',
      fgColor: { argb: 'FFFFF59D' },
    });
  });

  it('returns only non-empty object targets and builds a dedicated object sheet', () => {
    const data = makeBaseData();
    const targets = listObjectExportTargets(data);

    expect(targets.map(target => target.object_name)).toEqual(['Башня A', 'ЖК Сад 69', 'Склад 7']);

    const wb = new ExcelJS.Workbook();
    const target = targets.find(item => item.object_key === 'obj-a');
    expect(target).toBeTruthy();
    buildObjectTimesheetSheet(wb, 'ЖК Сад 69', data, target!);

    const ws = wb.getWorksheet('ЖК Сад 69');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(2, 1).value).toBe('Объект: ЖК Сад 69');
    expect(ws!.getCell(8, 2).value).toBe('Иван Иванов');
    expect(ws!.getCell(8, 5).value).toBe('5:00');
    expect(ws!.getCell(8, 5).fill).toMatchObject({
      type: 'pattern',
      fgColor: { argb: 'FFFFF59D' },
    });
  });

  it('builds a 1C employee workbook with template headers and integer hours', async () => {
    const data = makeBaseData();
    const wb = await build1CTimesheetWorkbook('Табель 1С', data);

    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(1, 7).value).toBe('табель учёта рабочего времени');
    expect(ws!.getCell(3, 1).value).toBe('№');
    expect(ws!.getCell(3, 2).value).toBe('Ф.И.О.');
    expect(ws!.getCell(3, 3).value).toBe(1);
    expect(ws!.getCell(3, 34).value).toBe('ч/часы');
    expect(ws!.getCell(4, 1).value).toBe(1);
    expect(ws!.getCell(4, 2).value).toBe('Иван Иванов');
    expect(ws!.getCell(4, 3).value).toBe(5);
    expect(typeof ws!.getCell(4, 3).value).toBe('number');
    expect(ws!.getCell(4, 34).value).toBe(5);
    expect(ws!.getCell(5, 1).value).toBe(2);
    expect(ws!.getCell(5, 2).value).toBe('Петр Петров');
    expect(ws!.getCell(5, 3).value).toBe(8);
    expect(ws!.getCell(4, 3).fill).toMatchObject({
      type: 'pattern',
      fgColor: { argb: 'FFFFF59D' },
    });
  });

  it('builds a 1C object workbook with the same template and separate object rows', async () => {
    const data = makeBaseData();
    const targets = listObjectExportTargets(data);
    const target = targets.find(item => item.object_key === 'obj-a');

    expect(target).toBeTruthy();
    const wb = await build1CObjectTimesheetWorkbook('ЖК Сад 69', data, target!);

    const ws = wb.getWorksheet('ЖК Сад 69');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 1).value).toBe(1);
    expect(ws!.getCell(4, 2).value).toBe('Иван Иванов');
    expect(ws!.getCell(4, 3).value).toBe(5);
    expect(ws!.getCell(4, 34).value).toBe(5);
    expect(ws!.getCell(5, 2).value).toBeNull();
  });

  it('1C export: при факте ≥ нормы дня ставит round(work_hours), даже если переработка', async () => {
    const data = makeBaseData();
    // График дефолта 5+0 после миграции: смена 9–18 (брутто 9ч), обед 90 мин → нетто 7.5ч.
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      work_hours: 7.5,
      lunch_minutes: 90,
    };
    data.schedulesMap = new Map([[1, sched], [2, sched]]);
    data.dailySchedulesMap = new Map([
      [1, new Map([['2026-04-01', sched]])],
      [2, new Map([['2026-04-01', sched]])],
    ]);
    // Иван: факт 8.84 (= 8:51) — выше нормы → должно стать 8 (round(7.5))
    // Пётр: факт 9.50 (= 9:30) — переработка → всё равно 8
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 8.84, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 9.5, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 3).value).toBe(8);
    expect(ws!.getCell(5, 3).value).toBe(8);
  });

  it('1C export: график 6 ч/день при выполнении нормы выгружает стандартные 8 ч', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      work_hours: 6,
    };
    data.schedulesMap = new Map([[1, sched], [2, sched]]);
    data.dailySchedulesMap = new Map([
      [1, new Map([['2026-04-01', sched]])],
      [2, new Map([['2026-04-01', sched]])],
    ]);
    // Иван отработал ровно 6 ч (норма) → должно быть 8
    // Пётр отработал 4 ч (меньше нормы) → должно быть 4 (floor) + underwork
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 6, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 4, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 3).value).toBe(8);
    expect(ws!.getCell(5, 3).value).toBe(4);
    expect(ws!.getCell(5, 3).fill).toMatchObject({
      type: 'pattern',
      fgColor: { argb: 'FFFFF59D' },
    });
  });

  it('1C export: предпраздничный день при норме 6 ч → выгружается 7 ч', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      work_hours: 6,
    };
    data.schedulesMap = new Map([[1, sched]]);
    data.dailySchedulesMap = new Map([[1, new Map([['2026-04-01', sched]])]]);
    data.calendarMonth = {
      year: 2026,
      month: 4,
      norm_days: 22,
      norm_hours: 175,
      holidays: [],
      mandatory_holidays: [],
      pre_holidays: ['2026-04-01'],
    };
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 6, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws!.getCell(4, 3).value).toBe(7);
  });

  it('1C export: статус-отсутствие (sick) выводит букву Б, не часы', async () => {
    const data = makeBaseData();
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'sick', hours: 0, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 8, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws!.getCell(4, 3).value).toBe('Б');
    expect(ws!.getCell(4, 34).value).toBeNull(); // total = 0, ячейка не заполняется
    expect(ws!.getCell(5, 3).value).toBe(8);
  });

  it('1C export: удалённая работа (remote, 8 ч) выводит букву УУ', async () => {
    const data = makeBaseData();
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'remote', hours: 8, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws!.getCell(4, 3).value).toBe('УУ');
  });

  it('1C export: корректировка не добавляет * к значению', async () => {
    const data = makeBaseData();
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 8, corrected: true }]])],
      [2, new Map([['2026-04-01', { status: 'sick', hours: 0, corrected: true }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws!.getCell(4, 3).value).toBe(8);
    expect(ws!.getCell(5, 3).value).toBe('Б');
  });

  it('1C export: при факте < нормы дня округляет факт ВНИЗ', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      work_hours: 7.5,
      lunch_minutes: 90,
    };
    data.schedulesMap = new Map([[1, sched], [2, sched]]);
    data.dailySchedulesMap = new Map([
      [1, new Map([['2026-04-01', sched]])],
      [2, new Map([['2026-04-01', sched]])],
    ]);
    // Иван: факт 7.4833 (= 7:29) — на минуту меньше нормы 7:30 → floor = 7
    // Пётр: факт 6.5 — между 6 и 7 → floor = 6
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 7.4833, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 6.5, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 3).value).toBe(7);
    expect(ws!.getCell(5, 3).value).toBe(6);
  });
});
