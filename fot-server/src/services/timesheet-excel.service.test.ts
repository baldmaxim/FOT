import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import {
  build1CObjectTimesheetWorkbook,
  build1CTimesheetWorkbook,
  buildEmployeeRowsForOneC,
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
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
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
    showActualHours: false,
  };
};

describe('timesheet-excel.service — 1С: явная правка часов не режется под норму', () => {
  // График 12ч; день 2026-04-01 (ср) — рабочий, норма 12.
  const makeData = (hours: number, hoursOverridden: boolean): IDepartmentTimesheetData => {
    const schedule = { ...makeSchedule(), work_hours: 12 };
    return {
      ...makeBaseData(),
      employees: [{ id: 1, full_name: 'Тошев А.Х.', position_id: null, org_department_id: 'dept-1', sigur_employee_id: 101 }],
      schedulesMap: new Map([[1, schedule]]),
      dailySchedulesMap: new Map([[1, new Map([['2026-04-01', schedule]])]]),
      dataMap: new Map([[1, new Map([['2026-04-01', { status: 'work', hours, corrected: hoursOverridden, hoursOverridden }]])]]),
      objectEntries: [],
    };
  };

  it('явная правка 13ч на графике 12ч → в 1С остаётся 13', () => {
    const rows = buildEmployeeRowsForOneC(makeData(13, true));
    expect(rows[0].dayValues.get(1)?.hours).toBe(13);
    expect(rows[0].totalHours).toBe(13);
  });

  it('контроль: СКУД 13ч без правки → режется под норму 12', () => {
    const rows = buildEmployeeRowsForOneC(makeData(13, false));
    expect(rows[0].dayValues.get(1)?.hours).toBe(12);
  });
});

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

  it('1C export: студенческий график 6 ч/день при выполнении нормы выгружает стандартные 8 ч', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      name: '(студенты) 6/0',
      work_hours: 6,
    };
    data.schedulesMap = new Map([[1, sched], [2, sched]]);
    data.dailySchedulesMap = new Map([
      [1, new Map([['2026-04-01', sched]])],
      [2, new Map([['2026-04-01', sched]])],
    ]);
    // Иван отработал ровно 6 ч (норма) → студенту 8
    // Пётр отработал 4 ч (меньше нормы) → 4 (round) + underwork
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

  it('1C export: студенческий 6 ч, предпраздничный день → выгружается 7 ч', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      name: '(студенты)',
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

  it('1C export: не-студенческий 11 ч график при выполнении нормы → 11 ч в 1С', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      name: '6/0 12 часов',
      work_hours: 11,
      work_days: [1, 2, 3, 4, 5, 6],
    };
    data.schedulesMap = new Map([[1, sched], [2, sched]]);
    data.dailySchedulesMap = new Map([
      [1, new Map([['2026-04-01', sched]])],
      [2, new Map([['2026-04-01', sched]])],
    ]);
    // Иван отработал ровно 11 ч (норма) → 11 (round(11)).
    // Пётр отработал 10:45 (10.75) — на минуты меньше нормы → round = 11.
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 11, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 10.75, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 3).value).toBe(11);
    expect(ws!.getCell(5, 3).value).toBe(11);
  });

  it('1C export: не-студенческий 5+0 в предпраздник → норма дня 7, факт 7 → 7 в 1С', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      name: 'Стандартный 5/2',
      work_hours: 8,
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
      [1, new Map([['2026-04-01', { status: 'work', hours: 7, corrected: false }]])],
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

  it('1C export: при факте < нормы дня округляет факт арифметически', async () => {
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
    // Иван: факт 7.4833 (= 7:29) — на минуту меньше нормы 7:30 → round = 7
    // Пётр: факт 6.5 — ровно посередине → round = 7 (.5 вверх)
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 7.4833, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 6.5, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 3).value).toBe(7);
    expect(ws!.getCell(5, 3).value).toBe(7);
  });

  it('экспорт: работа в выходной видна, пустой выходной — серый (без текста)', () => {
    const wb = new ExcelJS.Workbook();
    const data = makeBaseData();
    // 2026-04-04 — суббота (работал 6ч), 2026-04-05 — воскресенье (нет данных).
    data.exportDays = [4, 5];
    data.dataMap = new Map([
      [1, new Map([['2026-04-04', { status: 'work', hours: 6, corrected: false }]])],
      [2, new Map()],
    ]);

    buildTimesheetSheet(wb, 'Табель', data);

    const ws = wb.getWorksheet('Табель')!;
    // emp1 summary = строка 7; день 4 → col 5, день 5 → col 6.
    expect(ws.getCell(7, 5).value).toBe('6:00'); // работа в субботу теперь показывается
    expect((ws.getCell(7, 5).fill as ExcelJS.FillPattern)?.fgColor?.argb).not.toBe('FFE0E0E0');
    expect(ws.getCell(7, 6).value).toBe(''); // воскресенье без работы — пусто
    expect(ws.getCell(7, 6).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFE0E0E0' } });
    // emp2 без данных (строка 8) — обе ячейки выходных серые
    expect(ws.getCell(8, 5).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFE0E0E0' } });
    expect(ws.getCell(8, 6).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFE0E0E0' } });
  });

  it('экспорт: праздник производственного календаря в будний день — серый', () => {
    const wb = new ExcelJS.Workbook();
    const data = makeBaseData();
    // 2026-04-02 — четверг (будний), объявлен праздником. Объектных строк нет
    // (objectEntries за 2026-04-01 вне диапазона) → emp1=строка7, emp2=строка8.
    data.exportDays = [2];
    data.calendarMonth = {
      year: 2026, month: 4, norm_days: 22, norm_hours: 175,
      holidays: ['2026-04-02'], mandatory_holidays: [], pre_holidays: [],
    };
    data.dataMap = new Map([
      [1, new Map([['2026-04-02', { status: 'work', hours: 8, corrected: false }]])],
      [2, new Map()],
    ]);

    buildTimesheetSheet(wb, 'Табель', data);

    const ws = wb.getWorksheet('Табель')!;
    expect(ws.getCell(7, 5).value).toBe('8:00'); // факт в праздник виден (данные важнее)
    expect((ws.getCell(7, 5).fill as ExcelJS.FillPattern)?.fgColor?.argb).not.toBe('FFE0E0E0');
    expect(ws.getCell(8, 5).value).toBe(''); // emp2 без данных
    expect(ws.getCell(8, 5).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFE0E0E0' } });
  });

  it('1C export: работа в выходной выгружается, пустой выходной — серый без текста', async () => {
    const data = makeBaseData();
    data.exportDays = [4, 5]; // Сб 2026-04-04 (работал), Вс 2026-04-05 (пусто)
    data.dataMap = new Map([
      [1, new Map([['2026-04-04', { status: 'work', hours: 6, corrected: false }]])],
      [2, new Map()],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С')!;
    // emp1 = строка 4; день 4 → col 6, день 5 → col 7.
    expect(ws.getCell(4, 6).value).toBe(6); // суббота отработана — часы есть
    expect(ws.getCell(4, 7).value).toBeNull(); // воскресенье — пусто
    expect(ws.getCell(4, 7).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFE0E0E0' } });
    // emp2 без данных (строка 5) — выходные серые, без текста
    expect(ws.getCell(5, 6).value).toBeNull();
    expect(ws.getCell(5, 6).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFE0E0E0' } });
  });

  it('1C export: 7:46 при норме 8 → 8 (регресс: было floor → 7)', async () => {
    const data = makeBaseData();
    const sched: IResolvedSchedule = {
      ...makeSchedule(),
      work_hours: 8,
    };
    data.schedulesMap = new Map([[1, sched]]);
    data.dailySchedulesMap = new Map([[1, new Map([['2026-04-01', sched]])]]);
    // Факт 7.7667 ч (= 7:46) — меньше нормы 8 → round = 8 (раньше floor давал 7).
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'work', hours: 7.7667, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws).toBeTruthy();
    expect(ws!.getCell(4, 3).value).toBe(8);
  });
});
