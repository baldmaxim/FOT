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
import { housingAllowances, lastDayOfMonth } from './payroll-payslip.rules.js';

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
    housingDays: { from: '2026-09-01', to: '2026-09-30', workedDates: [], normDays: null, brigadeDates: [] },
    ...over,
  });
  const days = (over: Partial<IPayslipRateFacts['housingDays']>): IPayslipRateFacts['housingDays'] => ({
    from: '2026-09-01', to: '2026-09-30', workedDates: [], normDays: null, brigadeDates: [], ...over,
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

  /** Строка квартиры по ставке 630. */
  const housingLine = (housingDays: number, amount: string) => (
    [{ code: 'housing', amount, rate: '630.00', housing_days: housingDays }]
  );
  /** Квартира весь месяц: норма графика, отработано с 1-го по count. */
  const wholeMonth = (month: string, normDays: number | null, count: number) => housingAllowances(facts({
    housing: [apartment('2026-09-01')],
    housingDays: days({
      from: `${month}-01`, to: lastDayOfMonth(month), normDays, workedDates: dates(month, 1, count),
    }),
  }));

  it('квартира — 31 день, график 26: отработанные + 5 выходных; меньше недели — только отработанные', () => {
    expect(wholeMonth('2026-10', 26, 26)).toEqual(housingLine(31, '19530.00'));
    expect(wholeMonth('2026-10', 26, 15)).toEqual(housingLine(20, '12600.00'));
    expect(wholeMonth('2026-10', 26, 7)).toEqual(housingLine(12, '7560.00'));
    expect(wholeMonth('2026-10', 26, 6)).toEqual(housingLine(6, '3780.00'));
    expect(wholeMonth('2026-10', 26, 5)).toEqual(housingLine(5, '3150.00'));
    expect(wholeMonth('2026-10', 26, 3)).toEqual(housingLine(3, '1890.00'));
  });

  it('квартира — сентябрь 2026 как в 1С: выходные = дни месяца − график (6 при 24, 8 при 22)', () => {
    expect(wholeMonth('2026-09', 24, 24)).toEqual(housingLine(30, '18900.00'));
    // Антоненко: день без явки не оплачивается.
    expect(wholeMonth('2026-09', 24, 13)).toEqual(housingLine(19, '11970.00'));
    // Калязин.
    expect(wholeMonth('2026-09', 24, 15)).toEqual(housingLine(21, '13230.00'));
    // Крумина: 21 день отпуска не оплачивается, выходные — целиком.
    expect(wholeMonth('2026-09', 24, 8)).toEqual(housingLine(14, '8820.00'));
    // Гадоев: 26 + 6 = 32 — не больше дней месяца.
    expect(wholeMonth('2026-09', 24, 26)).toEqual(housingLine(30, '18900.00'));
    // Голуб: график 22.
    expect(wholeMonth('2026-09', 22, 17)).toEqual(housingLine(25, '15750.00'));
  });

  it('квартира — норма неизвестна, 0 или больше дней месяца: только отработанные', () => {
    expect(wholeMonth('2026-09', null, 20)).toEqual(housingLine(20, '12600.00'));
    expect(wholeMonth('2026-09', 0, 20)).toEqual(housingLine(20, '12600.00'));
    expect(wholeMonth('2026-09', 31, 20)).toEqual(housingLine(20, '12600.00'));
  });

  it('квартира — заселение и выезд внутри месяца: отработанные за время проживания, выходные целиком', () => {
    // Асроров: принят и заселён 08.09, в расчёте 19 дней (4 выхода без корректировки не считаются): 19 + 6 = 25.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-08')],
      housingDays: days({ from: '2026-09-08', normDays: 24, workedDates: dates('2026-09', 8, 26) }),
    }))).toEqual(housingLine(25, '15750.00'));
    // Выезд 11.09: дни после выезда не оплачиваются, 8 + 6 = 14.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01', '2026-09-11')],
      housingDays: days({ normDays: 24, workedDates: [...dates('2026-09', 1, 8), ...dates('2026-09', 15, 20)] }),
    }))).toEqual(housingLine(14, '8820.00'));
    // Порог — по месяцу: 10 отработанных, 3 из них после заселения 21.09, 3 + 6 = 9.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-21')],
      housingDays: days({ normDays: 24, workedDates: [...dates('2026-09', 1, 7), ...dates('2026-09', 21, 23)] }),
    }))).toEqual(housingLine(9, '5670.00'));
    // За месяц 5, 3 из них после заселения — только 3.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-21')],
      housingDays: days({ normDays: 24, workedDates: [...dates('2026-09', 1, 2), ...dates('2026-09', 21, 23)] }),
    }))).toEqual(housingLine(3, '1890.00'));
    // За время проживания ни одного отработанного дня — строки нет.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-25')],
      housingDays: days({ normDays: 24, workedDates: dates('2026-09', 1, 20) }),
    }))).toEqual([]);
  });

  it('квартира — окно: текущий месяц по вчера, дни за окном не считаются', () => {
    // 9 прошедших дней, 7 отработанных — выходные целиком, сумма предварительная.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ from: '2026-10-01', to: '2026-10-09', normDays: 26, workedDates: dates('2026-10', 1, 7) }),
    }))).toEqual(housingLine(12, '7560.00'));
    // Окно до 03.09: из 20 отработанных в счёт идут 3.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ to: '2026-09-03', normDays: 24, workedDates: dates('2026-09', 1, 20) }),
    }))).toEqual(housingLine(3, '1890.00'));
    // Пустое окно (будущий месяц, 1-е число текущего) — ничего.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ to: '0000-00-00', normDays: 24, workedDates: dates('2026-09', 1, 20) }),
    }))).toEqual([]);
  });

  it('квартира — день в двух подачах считается один раз, и для порога тоже', () => {
    const twice = (count: number) => [...dates('2026-09', 1, count), ...dates('2026-09', 1, count)];
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')], housingDays: days({ normDays: 24, workedDates: twice(6) }),
    }))).toEqual(housingLine(6, '3780.00'));
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01')], housingDays: days({ normDays: 24, workedDates: twice(8) }),
    }))).toEqual(housingLine(14, '8820.00'));
  });

  it('две ставки квартиры — отработанные по своей ставке, выходные пропорционально дням проживания; ставки в строке нет', () => {
    const half = [apartment('2026-09-01', '2026-09-16'), apartment('2026-09-16', null, '700.00')];
    // Весь месяц отработан: 15 × 630 + 15 × 700, выходным места нет.
    expect(housingAllowances(facts({
      housing: half, housingDays: days({ normDays: 24, workedDates: dates('2026-09', 1, 30) }),
    }))).toEqual([{ code: 'housing', amount: '19950.00', housing_days: 30 }]);
    // По 8 отработанных, 6 выходных поровну: 11 × 630 + 11 × 700.
    expect(housingAllowances(facts({
      housing: half,
      housingDays: days({ normDays: 24, workedDates: [...dates('2026-09', 1, 8), ...dates('2026-09', 16, 23)] }),
    }))).toEqual([{ code: 'housing', amount: '14630.00', housing_days: 22 }]);
    // 20 и 10 дней проживания, 5 выходных (3,33 и 1,67): остаток — большей дробной части, 3 и 2.
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-01', '2026-09-21'), apartment('2026-09-21', null, '700.00')],
      housingDays: days({ normDays: 25, workedDates: dates('2026-09', 1, 7) }),
    }))).toEqual([{ code: 'housing', amount: '7700.00', housing_days: 12 }]);
    // Дробные части равны — более поздней ставке: 8 × 630 + 1 × 700.
    expect(housingAllowances(facts({
      housing: half, housingDays: days({ normDays: 29, workedDates: dates('2026-09', 1, 8) }),
    }))).toEqual([{ code: 'housing', amount: '5740.00', housing_days: 9 }]);
  });

  it('доплата за общежитие — ставка × дни в бригаде, кроме дней в общежитии и квартире', () => {
    const brigadeDates = dates('2026-09', 1, 26);
    expect(housingAllowances(facts({ housingDays: days({ brigadeDates }) })))
      .toEqual([{ code: 'dormitory_allowance', amount: '4160.00', rate: '160.00', housing_days: 26 }]);
    // Заселён в общежитие 11.09: платятся только 1..10.
    expect(housingAllowances(facts({ housing: [dormitory('2026-09-11')], housingDays: days({ brigadeDates }) })))
      .toEqual([{ code: 'dormitory_allowance', amount: '1600.00', rate: '160.00', housing_days: 10 }]);
    // Живёт в общежитии весь месяц — ничего; квартира с 21.09 — 160 за 1..20, квартира: 6 отработанных + 6 выходных.
    expect(housingAllowances(facts({ housing: [dormitory('2026-08-01')], housingDays: days({ brigadeDates }) }))).toEqual([]);
    expect(housingAllowances(facts({
      housing: [apartment('2026-09-21')],
      housingDays: days({ brigadeDates, workedDates: brigadeDates, normDays: 24 }),
    }))).toEqual([
      { code: 'housing', amount: '7560.00', rate: '630.00', housing_days: 12 },
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
    expect(pickPayslipRateAllowances(facts({
      housing: [apartment('2026-09-01')],
      housingDays: days({ normDays: 24, workedDates: dates('2026-09', 1, 24) }),
    }))).toEqual([
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
