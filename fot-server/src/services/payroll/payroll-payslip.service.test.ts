import { describe, expect, it, vi } from 'vitest';

import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import type { IDepartmentTimesheetData, IExportDayValue } from '../timesheet-export.service.js';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  countPayslipNormDays,
  payslipPeriod,
  pickPayslipRateAllowances,
  proratedTravel,
  splitWorkedDays,
  type IPayslipRateFacts,
} from './payroll-payslip.service.js';
import { housingAllowances } from './payroll-payslip.rules.js';

// «5+2» с двумя плановыми субботами в месяц — как у прорабов в июле 2026.
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
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
  assignment_anchor_date: null,
  source: 'default',
};

const julyDates = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);

const makeData = (
  days: Record<string, IExportDayValue>,
  over: Partial<IDepartmentTimesheetData> = {},
): IDepartmentTimesheetData => ({
  departmentName: 'Payroll',
  departmentId: null,
  isBrigade: false,
  employees: [{ id: 60, full_name: 'Прораб', position_id: null, org_department_id: 'dept-1', sigur_employee_id: 1 }],
  schedulesMap: new Map([[60, schedule]]),
  dailySchedulesMap: new Map([[60, new Map(julyDates.map(date => [date, schedule]))]]),
  calendarMonth: null,
  entries: [],
  dataMap: new Map([[60, new Map(Object.entries(days))]]),
  objectEntries: [],
  skudMap: new Map(),
  posMap: new Map(),
  year: 2026,
  mon: 7,
  daysInMonth: 31,
  exportHalf: 'FULL',
  exportDays: julyDates.map((_, i) => i + 1),
  showActualHours: true,
  plannedWeekendDays: new Set(),
  ...over,
});

const work = (hours: number): IExportDayValue => ({ status: 'work', hours });

describe('расчётный листок: дни табеля рабочие / выходные', () => {
  it('будни и плановая суббота — рабочие, согласованное воскресенье — выходной', () => {
    const data = makeData(
      {
        '2026-07-01': work(8), // ср
        '2026-07-02': work(8), // чт
        '2026-07-04': work(8), // сб, в квоте графика
        '2026-07-05': work(8), // вс, согласованный выход
      },
      { plannedWeekendDays: new Set(['60|2026-07-04']) },
    );

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 3, dayoff: 1 });
  });

  it('обнулённый выходной, отпуск и «Н» не считаются; удалёнка без часов — рабочий', () => {
    const data = makeData({
      '2026-07-06': { status: 'remote', hours: 0 }, // пн, УУ
      '2026-07-07': { status: 'vacation', hours: 8 },
      '2026-07-08': { status: 'absent', hours: 0 },
      '2026-07-11': { status: 'work', hours: 0, hoursDropped: true }, // сб вне квоты
    });

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 1, dayoff: 0 });
  });

  it('дни после увольнения не считаются', () => {
    const data = makeData(
      { '2026-07-01': work(8), '2026-07-21': work(8) },
      { cutoffByEmployeeId: new Map([[60, '2026-07-21']]) },
    );

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 1, dayoff: 0 });
  });

  it('без графика на день — рабочий, как в выгрузке', () => {
    const data = makeData({ '2026-07-05': work(8) }, { dailySchedulesMap: new Map() });

    expect(splitWorkedDays(data, 60)).toEqual({ workday: 1, dayoff: 0 });
  });

  it('сотрудника нет в табеле — null', () => {
    expect(splitWorkedDays(makeData({}, { employees: [] }), 60)).toBeNull();
  });
});

describe('расчётный листок: период', () => {
  it('весь месяц', () => {
    expect(payslipPeriod('2026-07', '2024-03-01', null)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('принят в середине месяца — с даты приёма', () => {
    expect(payslipPeriod('2026-07', '2026-07-15', null)).toEqual({ from: '2026-07-15', to: '2026-07-31' });
  });

  it('уволен — по день увольнения (cutoff — следующий день)', () => {
    expect(payslipPeriod('2026-07', null, '2026-07-21')).toEqual({ from: '2026-07-01', to: '2026-07-20' });
    expect(payslipPeriod('2026-02', null, '2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('уволен до месяца — периода нет', () => {
    expect(payslipPeriod('2026-07', null, '2026-07-01')).toBeNull();
  });

  it('дата приёма позже месяца не режет период: суммы из 1С за месяц есть — значит, работал', () => {
    expect(payslipPeriod('2026-07', '2026-08-03', null)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
});

describe('pickPayslipRateAllowances — «По ставкам ФОТ»', () => {
  // Сентябрь 2026 целиком, без отсутствий и дней бригады; авто-доплата за общежитие с сентября.
  const facts = (over: Partial<IPayslipRateFacts> = {}): IPayslipRateFacts => ({
    category: 'office',
    travelRate: '2730.00',
    travelStopped: false,
    travelDays: { worked: 21, norm: 21 },
    dormitoryAllowanceRate: '160.00',
    dormitoryAllowanceFrom: '2026-09-01',
    housing: [],
    housingDays: { from: '2026-09-01', to: '2026-09-30', absenceDates: [], brigadeDates: [] },
    ...over,
  });
  const days = (over: Partial<IPayslipRateFacts['housingDays']>): IPayslipRateFacts['housingDays'] => ({
    from: '2026-09-01', to: '2026-09-30', absenceDates: [], brigadeDates: [], ...over,
  });
  const apartment = (start: string, end: string | null = null, amount = '630.00') => (
    { kind: 'apartment' as const, start, end, amount }
  );
  const dormitory = (start: string, end: string | null = null) => ({ kind: 'dormitory' as const, start, end, amount: null });
  /** Дни с 01 по n месяца YYYY-MM. */
  const dates = (month: string, from: number, to: number): string[] => Array.from(
    { length: to - from + 1 },
    (_, index) => `${month}-${String(from + index).padStart(2, '0')}`,
  );

  const fullTravel = { code: 'travel', amount: '2730.00', days: { worked: 21, norm: 21 }, rate: '2730.00' };

  it('проезд — офису и ИТР по ставке месяца; рабочим, «Без проезда» в месяце и без ставки — нет', () => {
    expect(pickPayslipRateAllowances(facts())).toEqual([fullTravel]);
    expect(pickPayslipRateAllowances(facts({ category: 'itr' }))).toEqual([fullTravel]);
    expect(pickPayslipRateAllowances(facts({ category: 'worker' }))).toEqual([]);
    expect(pickPayslipRateAllowances(facts({ travelStopped: true }))).toEqual([]);
    expect(pickPayslipRateAllowances(facts({ travelRate: null }))).toEqual([]);
    expect(pickPayslipRateAllowances(facts({ travelRate: '0.00' }))).toEqual([]);
  });

  it('проезд — по отработанным дням из нормы; дни сверх нормы в подписи не считаются', () => {
    expect(pickPayslipRateAllowances(facts({ travelDays: { worked: 22, norm: 23 } })))
      .toEqual([{ code: 'travel', amount: '2611.00', days: { worked: 22, norm: 23 }, rate: '2730.00' }]);
    // Назархудоев, август 2026: 22 рабочих + 8 выходных при норме 23 — ЗУП дал полную ставку.
    expect(pickPayslipRateAllowances(facts({ travelDays: { worked: 30, norm: 23 } })))
      .toEqual([{ code: 'travel', amount: '2730.00', days: { worked: 23, norm: 23 }, rate: '2730.00' }]);
  });

  it('нет в табеле, ни одного дня или норма 0 — строки проезда нет', () => {
    expect(pickPayslipRateAllowances(facts({ travelDays: null }))).toEqual([]);
    expect(pickPayslipRateAllowances(facts({ travelDays: { worked: 0, norm: 23 } }))).toEqual([]);
    expect(pickPayslipRateAllowances(facts({ travelDays: { worked: 5, norm: 0 } }))).toEqual([]);
  });

  it('квартира — ставка × календарные дни проживания: полный месяц 30 и 31 день', () => {
    expect(housingAllowances(facts({ housing: [apartment('2026-09-01')] })))
      .toEqual([{ code: 'housing', amount: '18900.00', rate: '630.00', housing_days: 30 }]);
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ from: '2026-10-01', to: '2026-10-31' }),
    }))).toEqual([{ code: 'housing', amount: '19530.00', rate: '630.00', housing_days: 31 }]);
  });

  it('квартира — без дней отсутствий (Крумина, сентябрь: отпуск 1–21 → 9 дн. = 5 670)', () => {
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ absenceDates: dates('2026-09', 1, 21) }),
    }))).toEqual([{ code: 'housing', amount: '5670.00', rate: '630.00', housing_days: 9 }]);
  });

  it('квартира — въезд и выезд внутри месяца, окно периода (принят 08.09, уволен — по отсечку)', () => {
    // Выезд 21.09 — 21-го уже не живёт: 10..20 = 11 дн.
    expect(housingAllowances(facts({ housing: [apartment('2026-09-10', '2026-09-21')] })))
      .toEqual([{ code: 'housing', amount: '6930.00', rate: '630.00', housing_days: 11 }]);
    // Асроров: принят 08.09 — окно с 08.09, 23 дн. = 14 490.
    expect(housingAllowances(facts({ housing: [apartment('2026-09-01')], housingDays: days({ from: '2026-09-08' }) })))
      .toEqual([{ code: 'housing', amount: '14490.00', rate: '630.00', housing_days: 23 }]);
    // Текущий месяц — по вчера: окно до 29.10.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ from: '2026-10-01', to: '2026-10-29' }),
    }))).toEqual([{ code: 'housing', amount: '18270.00', rate: '630.00', housing_days: 29 }]);
    // Пустое окно (будущий месяц, 1-е число текущего) — ничего.
    expect(housingAllowances(facts({ housing: [apartment('2026-09-01')], housingDays: days({ to: '0000-00-00' }) }))).toEqual([]);
  });

  it('две ставки квартиры в месяце — сумма по дням, ставки в строке нет', () => {
    const housing = [apartment('2026-09-01', '2026-09-16'), apartment('2026-09-16', null, '700.00')];
    // 15 × 630 + 15 × 700 = 9 450 + 10 500.
    expect(housingAllowances(facts({ housing }))).toEqual([{ code: 'housing', amount: '19950.00', housing_days: 30 }]);
  });

  it('доплата за общежитие — ставка × дни в бригаде, кроме дней в общежитии и квартире', () => {
    const brigadeDates = dates('2026-09', 1, 26);
    expect(housingAllowances(facts({ housingDays: days({ brigadeDates }) })))
      .toEqual([{ code: 'dormitory_allowance', amount: '4160.00', rate: '160.00', housing_days: 26 }]);
    // Заселён в общежитие 11.09: платятся только 1..10.
    expect(housingAllowances(facts({ housing: [dormitory('2026-09-11')], housingDays: days({ brigadeDates }) })))
      .toEqual([{ code: 'dormitory_allowance', amount: '1600.00', rate: '160.00', housing_days: 10 }]);
    // Живёт в общежитии весь месяц — ничего; квартира с 21.09 — 160 за 1..20, квартира за 21..30.
    expect(housingAllowances(facts({ housing: [dormitory('2026-08-01')], housingDays: days({ brigadeDates }) }))).toEqual([]);
    expect(housingAllowances(facts({ housing: [apartment('2026-09-21')], housingDays: days({ brigadeDates }) }))).toEqual([
      { code: 'housing', amount: '6300.00', rate: '630.00', housing_days: 10 },
      { code: 'dormitory_allowance', amount: '3200.00', rate: '160.00', housing_days: 20 },
    ]);
  });

  it('доплата за общежитие — только с месяца включателя, со ставкой и днями бригады; дни вне окна не считаются', () => {
    const brigadeDates = dates('2026-08', 1, 31);
    const august = days({ from: '2026-08-01', to: '2026-08-31', brigadeDates });
    expect(housingAllowances(facts({ housingDays: august }))).toEqual([]);
    expect(housingAllowances(facts({ housingDays: august, dormitoryAllowanceFrom: '2026-08-01' })))
      .toEqual([{ code: 'dormitory_allowance', amount: '4960.00', rate: '160.00', housing_days: 31 }]);
    expect(housingAllowances(facts({ housingDays: days({ brigadeDates: dates('2026-09', 1, 5) }), dormitoryAllowanceFrom: null })))
      .toEqual([]);
    expect(housingAllowances(facts({ housingDays: days({ brigadeDates: dates('2026-09', 1, 5) }), dormitoryAllowanceRate: null })))
      .toEqual([]);
    expect(housingAllowances(facts({ housingDays: days({ to: '2026-09-03', brigadeDates: dates('2026-09', 1, 5) }) })))
      .toEqual([{ code: 'dormitory_allowance', amount: '480.00', rate: '160.00', housing_days: 3 }]);
  });

  it('проезд и проживание — обе строки', () => {
    expect(pickPayslipRateAllowances(facts({ housing: [apartment('2026-09-01')] }))).toEqual([
      fullTravel,
      { code: 'housing', amount: '18900.00', rate: '630.00', housing_days: 30 },
    ]);
  });
});

describe('proratedTravel — проезд пропорционально дням, как ЗУП', () => {
  it('до рубля, половина — вверх (август 2026, «Оплачено» ЗУП)', () => {
    expect(proratedTravel('2730.00', { worked: 22, norm: 23 })).toBe('2611.00'); // 2 611,30
    expect(proratedTravel('2730.00', { worked: 18, norm: 23 })).toBe('2137.00'); // 2 136,52
    expect(proratedTravel('2730.00', { worked: 11, norm: 21 })).toBe('1430.00'); // 11 × 130
    expect(proratedTravel('2730.00', { worked: 1, norm: 4 })).toBe('683.00'); // ровно 682,50
  });

  it('отработал норму — ставка как есть, с копейками', () => {
    expect(proratedTravel('2730.00', { worked: 21, norm: 21 })).toBe('2730.00');
    expect(proratedTravel('2730.50', { worked: 21, norm: 21 })).toBe('2730.50');
    expect(proratedTravel('2730.50', { worked: 25, norm: 21 })).toBe('2730.50');
  });

  it('ни одного дня или норма 0 — null', () => {
    expect(proratedTravel('2730.00', { worked: 0, norm: 21 })).toBeNull();
    expect(proratedTravel('2730.00', { worked: 3, norm: 0 })).toBeNull();
  });
});

describe('countPayslipNormDays — норма дней графика за месяц', () => {
  const calendar = (over: Partial<IProductionCalendarMonth> = {}): IProductionCalendarMonth => ({
    year: 2026,
    month: 7,
    norm_days: 23,
    norm_hours: 184,
    holidays: [],
    mandatory_holidays: [],
    pre_holidays: [],
    ...over,
  });
  // «6+0 (11 ч)»: цикл пн–сб, воскресенье — выходной (якорь — понедельник).
  const sixDays: IResolvedSchedule = {
    ...schedule,
    schedule_id: 'sched-6',
    pattern_type: 'cycle',
    expected_saturdays_per_month: 0,
    cycle_length: 7,
    cycle_days: [...Array.from({ length: 6 }, () => ({ work_hours: 11 })), { work_hours: 0 }],
    anchor_date: '2026-06-29',
  };
  const scheduleMap = (pick: (date: string) => IResolvedSchedule) => (
    new Map([[60, new Map(julyDates.map(date => [date, pick(date)]))]])
  );

  it('«5+2» с двумя плановыми субботами: 23 будних июля + 2 = 25', () => {
    expect(countPayslipNormDays(makeData({}), 60)).toBe(25);
  });

  it('цикл «6+0»: все дни, кроме воскресений, — 27 (июль 2026, как ЗУП)', () => {
    expect(countPayslipNormDays(makeData({}, { dailySchedulesMap: scheduleMap(() => sixDays) }), 60)).toBe(27);
  });

  it('праздник в будний день графика нормы не даёт', () => {
    const data = makeData({}, { calendarMonth: calendar({ holidays: ['2026-07-15'] }) });
    expect(countPayslipNormDays(data, 60)).toBe(24);
  });

  it('смена графика в месяце: рабочие дни — по графику дня, квота суббот — графика последнего дня', () => {
    // 1–15 — «6+0»: 13 дней; 16–31 — «5+2»: 12 будних; квота «5+2» на 31-е — 2.
    const data = makeData({}, { dailySchedulesMap: scheduleMap(date => (date < '2026-07-16' ? sixDays : schedule)) });
    expect(countPayslipNormDays(data, 60)).toBe(27);
  });

  it('увольнение в месяце норму не режет', () => {
    const data = makeData({}, { cutoffByEmployeeId: new Map([[60, '2026-07-21']]) });
    expect(countPayslipNormDays(data, 60)).toBe(25);
  });

  it('графика нет хоть на один день — норма производственного календаря', () => {
    const partial = new Map([[60, new Map(julyDates.slice(0, 10).map(date => [date, schedule]))]]);
    expect(countPayslipNormDays(makeData({}, { dailySchedulesMap: partial, calendarMonth: calendar() }), 60)).toBe(23);
    expect(countPayslipNormDays(makeData({}, { dailySchedulesMap: new Map(), calendarMonth: calendar() }), 60)).toBe(23);
    expect(countPayslipNormDays(makeData({}, { dailySchedulesMap: new Map() }), 60)).toBe(0);
  });
});
