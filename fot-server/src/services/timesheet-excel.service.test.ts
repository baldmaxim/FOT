import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import {
  build1CObjectTimesheetWorkbook,
  build1CTimesheetWorkbook,
  buildEmployeeRowsForOneC,
  buildObjectRowsForOneC,
  buildObjectTimesheetSheet,
  buildTimesheetSheet,
  buildUnified1CWorkbookFromTemplate,
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

  it('HR-выгрузка: study_day идёт часами (8:00), считается в «Дней»/«Часов» и подсвечен фиолетовым', () => {
    const wb = new ExcelJS.Workbook();
    const data = makeBaseData();
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'study_day', hours: 8, corrected: false }]])],
      [2, new Map([['2026-04-01', { status: 'work', hours: 8, corrected: false }]])],
    ]);

    buildTimesheetSheet(wb, 'Табель', data);

    const ws = wb.getWorksheet('Табель');
    const dayCell = ws!.getCell(7, 5);
    expect(dayCell.value).toBe('8:00');
    expect(dayCell.fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFCE93D8' } });
    // exportDays=[1] → «Дней» в колонке 6, «Часов» в колонке 8.
    expect(ws!.getCell(7, 6).value).toBe(1);
    expect(ws!.getCell(7, 8).value).toBe('8:00');
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

  // «Учебный день» (УД): своей буквы в выгрузках нет — день уходит как обычный
  // рабочий, часами по норме графика (в 1С — целое число).
  it('1C export: study_day выводит часы нормы, а не букву', async () => {
    const data = makeBaseData();
    data.dataMap = new Map([
      [1, new Map([['2026-04-01', { status: 'study_day', hours: 8, corrected: false }]])],
    ]);

    const wb = await build1CTimesheetWorkbook('Табель 1С', data);
    const ws = wb.getWorksheet('Табель 1С');
    expect(ws!.getCell(4, 3).value).toBe(8);
    expect(ws!.getCell(4, 34).value).toBe(8); // итог строки учитывает учебный день
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

// «Дни» — колонка 35 единого файла для 1С: отработанные дни строки. Правило
// зеркалит UI: ячейка с часами > 0, либо статус УУ/РБ/УД (даже с нулём часов).
describe('timesheet-excel.service — колонка «Дни» единого файла 1С', () => {
  const COL_TOTAL = 34;
  const COL_DAYS = 35;

  // Один сотрудник, без объектных строк, дневные статусы задаются явно.
  const makeStatusData = (
    days: Array<[string, { status: string; hours: number }]>,
    exportDays: number[] = [1],
  ): IDepartmentTimesheetData => {
    const data = makeBaseData();
    data.employees = [data.employees[0]];
    data.objectEntries = [];
    data.exportDays = exportDays;
    data.dataMap = new Map([
      [1, new Map(days.map(([date, value]) => [date, { ...value, corrected: false }]))],
    ]);
    return data;
  };

  const buildUnifiedSheet = async (data: IDepartmentTimesheetData) => {
    const rows = buildEmployeeRowsForOneC(data).map(oneCRow => ({
      oneCRow,
      departmentName: data.departmentName,
      objectAddress: '',
      managerName: '',
      position: '',
    }));
    const wb = await buildUnified1CWorkbookFromTemplate('Табель 1С', rows);
    return wb.getWorksheet(1)!;
  };

  it('шапка: «Дни» в 35, «ч/часы» остаётся в 34, служебные колонки в 36–39, дальше пусто', async () => {
    const ws = await buildUnifiedSheet(makeStatusData([['2026-04-01', { status: 'work', hours: 8 }]]));

    expect(ws.getCell(3, COL_TOTAL).value).toBe('ч/часы');
    expect(ws.getCell(3, COL_DAYS).value).toBe('Дни');
    expect(ws.getCell(3, 36).value).toBe('Отдел');
    expect(ws.getCell(3, 37).value).toBe('Адрес объекта');
    expect(ws.getCell(3, 38).value).toBe('Руководитель');
    expect(ws.getCell(3, 39).value).toBe('Должность');
    // Загрузка в 1С читает колонки по номерам — новая колонка в середине её ломает.
    expect(ws.getCell(3, 40).value).toBeNull();
  });

  it('три отработанных дня по 8 ч → «Дни» = 3, часы = 24', async () => {
    const ws = await buildUnifiedSheet(makeStatusData(
      [
        ['2026-04-01', { status: 'work', hours: 8 }],
        ['2026-04-02', { status: 'work', hours: 8 }],
        ['2026-04-03', { status: 'work', hours: 8 }],
      ],
      [1, 2, 3],
    ));

    expect(ws.getCell(4, COL_DAYS).value).toBe(3);
    expect(ws.getCell(4, COL_TOTAL).value).toBe(24);
  });

  it('От/Б с часами в исходных данных в «Дни» не идут (считаются экспортируемые часы, не факт)', async () => {
    const ws = await buildUnifiedSheet(makeStatusData(
      [
        ['2026-04-01', { status: 'vacation', hours: 8 }],
        ['2026-04-02', { status: 'sick', hours: 8 }],
      ],
      [1, 2],
    ));

    expect(ws.getCell(4, 3).value).toBe('От');
    expect(ws.getCell(4, 4).value).toBe('Б');
    expect(ws.getCell(4, COL_DAYS).value).toBeNull();
    expect(ws.getCell(4, COL_TOTAL).value).toBeNull();
  });

  it('удалёнка (УУ) без часов — отработанный день, хотя в ячейке буква', async () => {
    const ws = await buildUnifiedSheet(makeStatusData([['2026-04-01', { status: 'remote', hours: 0 }]]));

    expect(ws.getCell(4, 3).value).toBe('УУ');
    expect(ws.getCell(4, COL_DAYS).value).toBe(1);
    expect(ws.getCell(4, COL_TOTAL).value).toBeNull();
  });

  it('нулевые УД и РБ — отработанные дни при пустой дневной ячейке', async () => {
    const ws = await buildUnifiedSheet(makeStatusData(
      [
        ['2026-04-01', { status: 'study_day', hours: 0 }],
        ['2026-04-02', { status: 'sick_worked', hours: 0 }],
      ],
      [1, 2],
    ));

    expect(ws.getCell(4, 3).value).toBeNull();
    expect(ws.getCell(4, 4).value).toBeNull();
    expect(ws.getCell(4, COL_DAYS).value).toBe(2);
    expect(ws.getCell(4, COL_TOTAL).value).toBeNull();
  });

  it('УД/РБ с часами дают +1 день, а не +2', async () => {
    const ws = await buildUnifiedSheet(makeStatusData(
      [
        ['2026-04-01', { status: 'study_day', hours: 8 }],
        ['2026-04-02', { status: 'sick_worked', hours: 8 }],
      ],
      [1, 2],
    ));

    expect(ws.getCell(4, COL_DAYS).value).toBe(2);
    expect(ws.getCell(4, COL_TOTAL).value).toBe(16);
  });

  it('объектные строки: дни считаются по часам на объекте', () => {
    const data = makeBaseData();
    const target = listObjectExportTargets(data).find(item => item.object_key === 'obj-b');

    const rows = buildObjectRowsForOneC(data, target!);
    expect(rows).toHaveLength(1);
    expect(rows[0].workedDays).toBe(1);
    expect(rows[0].totalHours).toBe(8);
  });

  it('объектные строки: нулевой УД идёт в «Дни» при пустой дневной ячейке', () => {
    const data = makeBaseData();
    data.exportDays = [1, 2];
    data.dataMap = new Map([
      [1, new Map([
        ['2026-04-01', { status: 'work', hours: 5, corrected: false }],
        ['2026-04-02', { status: 'study_day', hours: 0, corrected: false }],
      ])],
    ]);
    const target = listObjectExportTargets(data).find(item => item.object_key === 'obj-a');

    const rows = buildObjectRowsForOneC(data, target!);
    expect(rows[0].dayValues.get(2)?.hours ?? 0).toBe(0);
    // День 1 — по объектным часам, день 2 — по статусу УД.
    expect(rows[0].workedDays).toBe(2);
    expect(rows[0].totalHours).toBe(5);
  });
});

// Часы объектной строки берутся из objectEntries, минуя includeExportDayHours. Для дня,
// который держится на корректировке и был обнулён фильтром выходных, объектная строка
// обязана показать тот же ноль, что и общая строка сотрудника.
describe('timesheet-excel.service — объектные строки уважают обнуление выходного', () => {
  // 04.04.2026 — суббота; график 5/2, норма дня 0.
  const SATURDAY = '2026-04-04';

  const makeWeekendData = (
    day: { hours: number; corrected: boolean; hoursDropped: boolean },
    date = SATURDAY,
  ): IDepartmentTimesheetData => {
    const [year, mon, dayOfMonth] = date.split('-').map(Number);
    const data = makeBaseData();
    data.year = year;
    data.mon = mon;
    data.exportDays = [dayOfMonth];
    data.dailySchedulesMap = new Map([[1, new Map([[date, makeSchedule()]])]]);
    data.employees = [data.employees[0]];
    data.dataMap = new Map([[1, new Map([[date, {
      status: 'work', hours: day.hours, corrected: day.corrected,
      hoursOverridden: day.corrected, hoursDropped: day.hoursDropped,
    }]])]]);
    data.objectEntries = [{
      adjustment_id: day.corrected ? 1090038 : null,
      employee_id: 1,
      work_date: date,
      object_key: 'obj-a',
      object_id: 'obj-a',
      object_name: 'ЖК Сад 69',
      hours_worked: 8,
      display_hours_worked: 8,
      base_hours_worked: 8,
      is_correction: day.corrected,
    }];
    return data;
  };

  const objectRowFor = (data: IDepartmentTimesheetData) => {
    const target = listObjectExportTargets(data).find(item => item.object_key === 'obj-a');
    return buildObjectRowsForOneC(data, target!)[0];
  };

  it('согласованная объектная правка в субботу → часы на объекте выгружаются', () => {
    const row = objectRowFor(makeWeekendData({ hours: 8, corrected: true, hoursDropped: false }));
    expect(row.dayValues.get(4)?.hours).toBe(8);
    expect(row.totalHours).toBe(8);
    expect(row.workedDays).toBe(1);
  });

  it('несогласованная объектная правка в субботу → объектная строка тоже даёт ноль', () => {
    const row = objectRowFor(makeWeekendData({ hours: 0, corrected: true, hoursDropped: true }));
    expect(row.dayValues.get(4)?.hours ?? 0).toBe(0);
    expect(row.totalHours).toBe(0);
    expect(row.workedDays).toBe(0);
  });

  it('сырое СКУД-присутствие до 01.10.2026 остаётся: старые месяцы уже загружены в 1С', () => {
    const row = objectRowFor(makeWeekendData({ hours: 0, corrected: false, hoursDropped: true }));
    expect(row.dayValues.get(4)?.hours).toBe(8);
    expect(row.totalHours).toBe(8);
    expect(row.hasFilteredWeekendHours).toBe(false);
  });

  it('сырое СКУД-присутствие с 01.10.2026 обнуляется, как в общей строке сотрудника', () => {
    const row = objectRowFor(makeWeekendData({ hours: 0, corrected: false, hoursDropped: true }, '2026-10-17'));
    expect(row.dayValues.get(17)?.hours ?? 0).toBe(0);
    expect(row.totalHours).toBe(0);
    expect(row.workedDays).toBe(0);
    expect(row.hasFilteredWeekendHours).toBe(true);
  });

  it('граница правила: 30.09 остаётся, 01.10 обнуляется', () => {
    const day = { hours: 0, corrected: false, hoursDropped: true };
    expect(objectRowFor(makeWeekendData(day, '2026-09-30')).totalHours).toBe(8);
    expect(objectRowFor(makeWeekendData(day, '2026-10-01')).totalHours).toBe(0);
  });

  it('день, который фильтр не обнулил, с 01.10.2026 остаётся и признака не даёт', () => {
    const row = objectRowFor(makeWeekendData({ hours: 8, corrected: false, hoursDropped: false }, '2026-10-17'));
    expect(row.totalHours).toBe(8);
    expect(row.hasFilteredWeekendHours).toBe(false);
  });
});

// Суббота в квоте графика: день нерабочий, норма 0, но это работа по графику — предел равен смене.
describe('timesheet-excel.service — суббота в квоте графика не выше смены', () => {
  // 04.04.2026 — суббота, 03.04.2026 — пятница. График как на проде: цикл со слотом субботы 0 ч.
  const SATURDAY = '2026-04-04';
  const FRIDAY = '2026-04-03';
  const KEY = `1|${SATURDAY}`;

  const makeQuotaSchedule = (): IResolvedSchedule => ({
    ...makeSchedule(),
    work_start: '08:00:00',
    work_end: '19:00:00',
    work_hours: 10,
    lunch_minutes: 60,
    pattern_type: 'cycle',
    expected_saturdays_per_month: 2,
    cycle_length: 7,
    cycle_days: [
      ...Array.from({ length: 5 }, () => ({ work_start: '08:00', work_end: '19:00', work_hours: 10, lunch_minutes: 60 })),
      { work_hours: 0 },
      { work_hours: 0 },
    ],
    anchor_date: '2026-03-30',
  });

  const objectEntry = (objectKey: string, hours: number, workDate = SATURDAY) => ({
    adjustment_id: null,
    employee_id: 1,
    work_date: workDate,
    object_key: objectKey,
    object_id: objectKey,
    object_name: objectKey,
    hours_worked: hours,
    display_hours_worked: hours,
    base_hours_worked: hours,
    is_correction: false,
  });

  const makeQuotaData = (
    hours: number,
    options: {
      date?: string;
      overridden?: boolean;
      scheduled?: boolean;
      objects?: Array<[string, number]>;
      limits?: Array<[string, number]>;
    } = {},
  ): IDepartmentTimesheetData => {
    const date = options.date ?? SATURDAY;
    const schedule = makeQuotaSchedule();
    const data = makeBaseData();
    data.exportDays = [Number(date.slice(-2))];
    data.employees = [data.employees[0]];
    data.schedulesMap = new Map([[1, schedule]]);
    data.dailySchedulesMap = new Map([[1, new Map([[date, schedule]])]]);
    data.dataMap = new Map([[1, new Map([[date, {
      status: options.overridden ? 'manual' : 'work',
      hours,
      corrected: Boolean(options.overridden),
      hoursOverridden: Boolean(options.overridden),
      hoursDropped: false,
    }]])]]);
    data.objectEntries = (options.objects ?? [['obj-a', hours]]).map(([key, value]) => objectEntry(key, value, date));
    data.scheduledWeekendDays = new Set(options.scheduled === false ? [] : [`1|${date}`]);
    data.scheduledWeekendObjectLimits = new Map(options.limits ?? []);
    return data;
  };

  const employeeRow = (data: IDepartmentTimesheetData) => buildEmployeeRowsForOneC(data)[0];
  const objectRow = (data: IDepartmentTimesheetData, objectKey = 'obj-a') => {
    const target = listObjectExportTargets(data).find(item => item.object_key === objectKey);
    return buildObjectRowsForOneC(data, target!)[0];
  };

  it('выше графика → часы графика в строке сотрудника и объекта, итог и «Дни»', () => {
    const data = makeQuotaData(16.45);
    for (const row of [employeeRow(data), objectRow(data)]) {
      expect(row.dayValues.get(4)?.hours).toBe(10);
      expect(row.totalHours).toBe(10);
      expect(row.workedDays).toBe(1);
    }
  });

  it('меньше графика → факт, как на буднях', () => {
    const data = makeQuotaData(8);
    expect(employeeRow(data).dayValues.get(4)?.hours).toBe(8);
    expect(objectRow(data).dayValues.get(4)?.hours).toBe(8);
  });

  it('ручная правка выше графика → как есть', () => {
    const data = makeQuotaData(11, { overridden: true });
    expect(employeeRow(data).dayValues.get(4)?.hours).toBe(11);
    expect(objectRow(data).dayValues.get(4)?.hours).toBe(11);
  });

  it('выход сверх квоты → факт, предел не применяется', () => {
    const data = makeQuotaData(12.4, { scheduled: false });
    expect(employeeRow(data).dayValues.get(4)?.hours).toBe(12);
    expect(objectRow(data).dayValues.get(4)?.hours).toBe(12);
  });

  it('будний день не меняется', () => {
    const before = makeQuotaData(11.5, { date: FRIDAY, scheduled: false });
    const after = makeQuotaData(11.5, { date: FRIDAY });
    expect(employeeRow(before).dayValues.get(3)?.hours).toBe(10);
    expect(employeeRow(after).dayValues.get(3)?.hours).toBe(10);
  });

  it('два объекта: лимиты держат сумму строк в пределах смены', () => {
    const data = makeQuotaData(13, {
      objects: [['obj-a', 6], ['obj-b', 7]],
      limits: [[`${KEY}|obj-a`, 5], [`${KEY}|obj-b`, 5]],
    });
    expect(objectRow(data, 'obj-a').dayValues.get(4)?.hours).toBe(5);
    expect(objectRow(data, 'obj-b').dayValues.get(4)?.hours).toBe(5);
  });

  it('файл по одному объекту получает ту же долю', () => {
    const data = makeQuotaData(13, {
      objects: [['obj-a', 6], ['obj-b', 7]],
      limits: [[`${KEY}|obj-a`, 5], [`${KEY}|obj-b`, 5]],
    });
    data.objectEntries = data.objectEntries.filter(entry => entry.object_key === 'obj-b');
    expect(objectRow(data, 'obj-b').totalHours).toBe(5);
  });

  it('доля, округлившаяся до нуля: ячейка пустая, день в этой строке не считается', () => {
    const data = makeQuotaData(14, {
      objects: [['obj-a', 13.6], ['obj-b', 0.4]],
      limits: [[`${KEY}|obj-a`, 10], [`${KEY}|obj-b`, 0]],
    });
    const row = objectRow(data, 'obj-b');
    expect(row.dayValues.get(4)?.hours ?? 0).toBe(0);
    expect(row.workedDays).toBe(0);
    expect(objectRow(data, 'obj-a').totalHours).toBe(10);
  });

  describe('праздник без вычета обеда (с 01.11.2026)', () => {
    const inMonth = (
      date: string,
      hours: number,
      options: { respects: boolean; scheduled: boolean; overridden?: boolean },
    ): IDepartmentTimesheetData => {
      const data = makeQuotaData(hours, { date, scheduled: options.scheduled, overridden: options.overridden });
      data.dailySchedulesMap.get(1)!.get(date)!.respects_holidays = options.respects;
      data.mon = Number(date.slice(5, 7));
      data.calendarMonth = {
        year: 2026,
        month: data.mon,
        norm_days: 20,
        norm_hours: 159,
        holidays: ['2026-11-04', '2026-06-12'],
        mandatory_holidays: [],
        pre_holidays: ['2026-11-03'],
      };
      return data;
    };
    const dayOf = (date: string): number => Number(date.slice(-2));

    it('график «игнорирует»: предел норма + обед в строке сотрудника и объекта', () => {
      const data = inMonth('2026-11-04', 12.4, { respects: false, scheduled: false });
      expect(employeeRow(data).dayValues.get(4)?.hours).toBe(11);
      expect(objectRow(data).dayValues.get(4)?.hours).toBe(11);
    });

    it('график «игнорирует»: день без лишних часов — факт', () => {
      const data = inMonth('2026-11-04', 11, { respects: false, scheduled: false });
      expect(employeeRow(data).dayValues.get(4)?.hours).toBe(11);
    });

    it.each([
      ['2026-11-03', 'предпраздничный', 10],
      ['2026-11-05', 'обычный', 10],
      ['2026-06-12', 'праздник до 01.11', 10],
    ])('%s (%s): предел прежний', (date, _label, expected) => {
      const data = inMonth(date, 12.4, { respects: false, scheduled: false });
      expect(employeeRow(data).dayValues.get(dayOf(date))?.hours).toBe(expected);
    });

    it('график «учитывает», день в квоте: предел смена + обед', () => {
      const data = inMonth('2026-11-04', 12.4, { respects: true, scheduled: true });
      expect(employeeRow(data).dayValues.get(4)?.hours).toBe(11);
    });

    it('график «учитывает», день вне квоты: факт, без предела', () => {
      const data = inMonth('2026-11-04', 12.4, { respects: true, scheduled: false });
      expect(employeeRow(data).dayValues.get(4)?.hours).toBe(12);
    });

    it('ручная правка выше предела — как есть', () => {
      const data = inMonth('2026-11-04', 13, { respects: false, scheduled: false, overridden: true });
      expect(employeeRow(data).dayValues.get(4)?.hours).toBe(13);
    });
  });
});
