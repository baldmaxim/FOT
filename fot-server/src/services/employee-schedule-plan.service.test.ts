import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  resolveSchedulesForPeriod: vi.fn(),
  loadCalendarYear: vi.fn(),
  getKnownArchiveDepartment: vi.fn(),
}));

vi.mock('../config/postgres.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../config/postgres.js')>()),
  query: h.query,
  queryOne: h.queryOne,
}));
vi.mock('./schedule.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./schedule.service.js')>()),
  resolveSchedulesForPeriod: h.resolveSchedulesForPeriod,
  loadCalendarYear: h.loadCalendarYear,
}));
vi.mock('./employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: h.getKnownArchiveDepartment,
}));

const {
  buildEmployeeEmploymentPeriods,
  buildEmployeeSchedulePlan,
  buildSchedulePlanMonths,
  buildSchedulePlanPeriods,
  classifyPlanDay,
} = await import('./employee-schedule-plan.service.js');

const ARCHIVE = 'archive-dept';
const GPM = 'gpm-dept';

// «ЛИНИЯ 5дн +2суб с 01.02.22г 10 час»: цикл 7 дн. с якорем в понедельник, праздники РФ не учитывает.
const line10: IResolvedSchedule = {
  schedule_id: 'line-10',
  name: 'ЛИНИЯ 5дн +2суб с 01.02.22г 10 час',
  schedule_type: 'office',
  work_start: '08:00:00',
  work_end: '19:00:00',
  work_hours: 10,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  lunch_minutes: 60,
  respects_holidays: false,
  pattern_type: 'cycle',
  expected_saturdays_per_month: 2,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: 7,
  cycle_days: [
    ...Array.from({ length: 5 }, () => ({ work_hours: 10, work_start: '08:00', work_end: '19:00', lunch_minutes: 60 })),
    { work_hours: 0 },
    { work_hours: 0 },
  ],
  anchor_date: '2025-12-29',
  assignment_anchor_date: null,
  source: 'employee',
};

// «5+2» по 8 ч с праздниками РФ.
const office8: IResolvedSchedule = {
  ...line10,
  schedule_id: 'office-8',
  name: 'ОФИС пятидневка',
  work_hours: 8,
  respects_holidays: true,
  pattern_type: 'custom',
  expected_saturdays_per_month: 0,
  cycle_length: null,
  cycle_days: null,
  anchor_date: null,
};

const month = (m: number, patch: Partial<IProductionCalendarMonth> = {}): IProductionCalendarMonth => ({
  year: 2026, month: m, norm_days: 0, norm_hours: 0, holidays: [], mandatory_holidays: [], pre_holidays: [], ...patch,
});

// Календарь 2026 как на проде: обязательные — 1 и 7 января; 31.12 — праздник, но не обязательный.
const calendars2026 = new Map<number, IProductionCalendarMonth>([
  [1, month(1, {
    holidays: ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'],
    mandatory_holidays: ['2026-01-01', '2026-01-07'],
  })],
  [2, month(2, { holidays: ['2026-02-23'] })],
  [4, month(4, { pre_holidays: ['2026-04-30'] })],
  [11, month(11, { holidays: ['2026-11-04'], pre_holidays: ['2026-11-03', '2026-11-07'] })],
  [12, month(12, { holidays: ['2026-12-31'] })],
]);

const yearDates = (year: number): string[] => {
  const dates: string[] = [];
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
};

const scheduleMap = (pick: (date: string) => IResolvedSchedule): Map<string, IResolvedSchedule> => (
  new Map(yearDates(2026).map(date => [date, pick(date)]))
);

const FULL_YEAR = [{ from: '2026-01-01', to: '2026-12-31' }];

describe('buildEmployeeEmploymentPeriods', () => {
  const base = { assignments: [], archiveDepartmentId: ARCHIVE, startDate: '2026-01-01', endDate: '2026-12-31' };

  it('нет истории — от приёма до увольнения в границах года', () => {
    expect(buildEmployeeEmploymentPeriods({ ...base, hireDate: '2026-03-15', dismissalDate: null }))
      .toEqual([{ from: '2026-03-15', to: '2026-12-31' }]);
    expect(buildEmployeeEmploymentPeriods({ ...base, hireDate: '2024-12-19', dismissalDate: '2026-03-20' }))
      .toEqual([{ from: '2026-01-01', to: '2026-03-20' }]);
    expect(buildEmployeeEmploymentPeriods({ ...base, hireDate: '2027-01-10', dismissalDate: null })).toEqual([]);
  });

  it('восстановленный (как Шералиев 2128): время в «Уволенных» вычитается', () => {
    expect(buildEmployeeEmploymentPeriods({
      ...base,
      hireDate: '2024-12-19',
      dismissalDate: null,
      assignments: [
        { org_department_id: GPM, effective_from: '2025-12-31', effective_to: '2025-12-31' },
        { org_department_id: ARCHIVE, effective_from: '2026-01-01', effective_to: '2026-07-02' },
        { org_department_id: GPM, effective_from: '2026-07-03', effective_to: null },
      ],
    })).toEqual([{ from: '2026-07-03', to: '2026-12-31' }]);
  });

  it('уволен и восстановлен внутри года (как Саидов 1560): два периода, «грязное» первое назначение не мешает', () => {
    expect(buildEmployeeEmploymentPeriods({
      ...base,
      hireDate: '2026-02-18',
      dismissalDate: null,
      assignments: [
        { org_department_id: GPM, effective_from: '2025-12-31', effective_to: '2026-06-30' },
        { org_department_id: ARCHIVE, effective_from: '2026-07-01', effective_to: '2026-09-24' },
        { org_department_id: GPM, effective_from: '2026-09-25', effective_to: null },
      ],
    })).toEqual([{ from: '2026-02-18', to: '2026-06-30' }, { from: '2026-09-25', to: '2026-12-31' }]);
  });

  it('активный с запланированным увольнением — режет дата увольнения', () => {
    expect(buildEmployeeEmploymentPeriods({ ...base, hireDate: '2025-05-01', dismissalDate: '2026-09-20' }))
      .toEqual([{ from: '2026-01-01', to: '2026-09-20' }]);
  });

  it('уволенный с открытым назначением в «Уволенные»', () => {
    expect(buildEmployeeEmploymentPeriods({
      ...base,
      hireDate: '2025-05-01',
      dismissalDate: '2026-05-10',
      assignments: [{ org_department_id: ARCHIVE, effective_from: '2026-05-11', effective_to: null }],
    })).toEqual([{ from: '2026-01-01', to: '2026-05-10' }]);
  });

  it('архив не определён — только приём и увольнение', () => {
    expect(buildEmployeeEmploymentPeriods({
      ...base,
      archiveDepartmentId: null,
      hireDate: '2024-12-19',
      dismissalDate: null,
      assignments: [{ org_department_id: ARCHIVE, effective_from: '2026-01-01', effective_to: '2026-07-02' }],
    })).toEqual([{ from: '2026-01-01', to: '2026-12-31' }]);
  });
});

describe('classifyPlanDay', () => {
  const nov = calendars2026.get(11)!;

  it('график с праздниками: предпраздничный рабочий −1 ч, праздник, предпраздничная суббота — выходной', () => {
    expect(classifyPlanDay(office8, new Date(2026, 10, 3), nov)).toBe('pre_holiday');
    expect(classifyPlanDay(office8, new Date(2026, 10, 4), nov)).toBe('holiday');
    expect(classifyPlanDay(office8, new Date(2026, 10, 7), nov)).toBe('off');
    expect(classifyPlanDay(office8, new Date(2026, 10, 5), nov)).toBe('work');
  });

  it('график без праздников: предпраздничный и необязательный праздник — обычные рабочие', () => {
    expect(classifyPlanDay(line10, new Date(2026, 10, 3), nov)).toBe('work');
    expect(classifyPlanDay(line10, new Date(2026, 10, 4), nov)).toBe('work');
    expect(classifyPlanDay(line10, new Date(2026, 0, 7), calendars2026.get(1)!)).toBe('holiday');
  });
});

describe('buildSchedulePlanMonths', () => {
  it('ЛИНИЯ 10 ч + 2 Сб за 2026 — как форма графика 1С, кроме декабря (31.12 у графика без праздников рабочий)', () => {
    const months = buildSchedulePlanMonths({
      year: 2026, schedules: scheduleMap(() => line10), calendars: calendars2026, employment: FULL_YEAR,
    });
    expect(months.map(m => m.norm_days)).toEqual([22, 22, 24, 24, 23, 24, 25, 23, 24, 24, 23, 25]);
    expect(months.map(m => m.norm_minutes)).toEqual([22, 22, 24, 24, 23, 24, 25, 23, 24, 24, 23, 25].map(d => d * 600));
    expect(months.every(m => m.saturdays === 2 && m.sundays === 0 && m.employed)).toBe(true);

    const day = (m: number, d: number) => months[m - 1].days.find(item => item.day === d);
    expect(day(1, 7)).toEqual({ day: 7, hours: 0, kind: 'holiday' });
    expect(day(1, 3)).toEqual({ day: 3, hours: 0, kind: 'off' });
    expect(day(1, 2)).toEqual({ day: 2, hours: 10, kind: 'work' });
    expect(day(2, 23)).toEqual({ day: 23, hours: 10, kind: 'work' });
    expect(day(4, 30)).toEqual({ day: 30, hours: 10, kind: 'work' });
    expect(months[1].days).toHaveLength(28);
  });

  it('график с праздниками: предпраздничный день 7 ч, праздник 0', () => {
    const months = buildSchedulePlanMonths({
      year: 2026, schedules: scheduleMap(() => office8), calendars: calendars2026, employment: FULL_YEAR,
    });
    const nov = months[10];
    expect(nov.days.find(d => d.day === 3)).toEqual({ day: 3, hours: 7, kind: 'pre_holiday' });
    expect(nov.days.find(d => d.day === 4)).toEqual({ day: 4, hours: 0, kind: 'holiday' });
    expect(nov.norm_days).toBe(20);
    expect(nov.norm_minutes).toBe(159 * 60);
  });

  it('приём 15-го и увольнение 20-го: месяц целиком с полной нормой, соседние — нет', () => {
    const months = buildSchedulePlanMonths({
      year: 2026,
      schedules: scheduleMap(() => line10),
      calendars: calendars2026,
      employment: [{ from: '2026-03-15', to: '2026-03-20' }],
    });
    expect(months[2]).toMatchObject({ employed: true, norm_days: 24, norm_minutes: 240 * 60 });
    expect(months[2].days).toHaveLength(31);
    expect(months[1]).toEqual({
      month: 2, employed: false, norm_days: null, norm_minutes: null, saturdays: 0, sundays: 0, days: [],
    });
    expect(months[3].employed).toBe(false);
  });
});

describe('buildSchedulePlanPeriods', () => {
  it('смена графика и якоря цикла — новые периоды; разрыв работы делит период', () => {
    const reAnchored = { ...line10, assignment_anchor_date: '2026-10-06' };
    const schedules = scheduleMap(date => (
      date < '2026-07-01' ? office8 : date < '2026-10-06' ? line10 : reAnchored
    ));
    expect(buildSchedulePlanPeriods(schedules, FULL_YEAR, '2026-01-01', '2026-12-31')).toEqual([
      { schedule_name: 'ОФИС пятидневка', from: '2026-01-01', to: '2026-06-30' },
      { schedule_name: line10.name, from: '2026-07-01', to: '2026-10-05' },
      { schedule_name: line10.name, from: '2026-10-06', to: '2026-12-31' },
    ]);
    expect(buildSchedulePlanPeriods(
      scheduleMap(() => line10),
      [{ from: '2026-02-18', to: '2026-06-30' }, { from: '2026-09-25', to: '2026-12-31' }],
      '2026-01-01',
      '2026-12-31',
    )).toEqual([
      { schedule_name: line10.name, from: '2026-02-18', to: '2026-06-30' },
      { schedule_name: line10.name, from: '2026-09-25', to: '2026-12-31' },
    ]);
  });
});

describe('buildEmployeeSchedulePlan', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
  });

  it('нет сотрудника — null, график по умолчанию не подставляется', async () => {
    h.queryOne.mockResolvedValue(null);
    expect(await buildEmployeeSchedulePlan(999999, 2026)).toBeNull();
    expect(h.resolveSchedulesForPeriod).not.toHaveBeenCalled();
  });

  it('восстановленный: месяцы в «Уволенных» — без графика, с месяца восстановления — график', async () => {
    h.queryOne.mockResolvedValue({ hire_date: '2024-12-19', dismissal_date: null });
    h.resolveSchedulesForPeriod.mockResolvedValue(new Map([[2128, scheduleMap(() => line10)]]));
    h.loadCalendarYear.mockResolvedValue(calendars2026);
    h.query.mockResolvedValue([
      { org_department_id: GPM, effective_from: '2025-12-31', effective_to: '2025-12-31' },
      { org_department_id: ARCHIVE, effective_from: '2026-01-01', effective_to: '2026-07-02' },
      { org_department_id: GPM, effective_from: '2026-07-03', effective_to: null },
    ]);
    h.getKnownArchiveDepartment.mockResolvedValue({ id: ARCHIVE });

    const plan = await buildEmployeeSchedulePlan(2128, 2026);
    expect(h.resolveSchedulesForPeriod).toHaveBeenCalledWith([{ id: 2128 }], '2026-01-01', '2026-12-31');
    expect(plan?.months.map(m => m.employed)).toEqual([
      false, false, false, false, false, false, true, true, true, true, true, true,
    ]);
    expect(plan?.months[6]).toMatchObject({ norm_days: 25, norm_minutes: 250 * 60 });
    expect(plan?.periods).toEqual([{ schedule_name: line10.name, from: '2026-07-03', to: '2026-12-31' }]);
  });

  it('отдел «Уволенные» не определился — блок не падает, считаем по приёму и увольнению', async () => {
    h.queryOne.mockResolvedValue({ hire_date: '2026-03-02', dismissal_date: null });
    h.resolveSchedulesForPeriod.mockResolvedValue(new Map([[7, scheduleMap(() => line10)]]));
    h.loadCalendarYear.mockResolvedValue(new Map());
    h.query.mockResolvedValue([]);
    h.getKnownArchiveDepartment.mockRejectedValue(new Error('sigur down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const plan = await buildEmployeeSchedulePlan(7, 2026);
    expect(plan?.months.map(m => m.employed).slice(0, 3)).toEqual([false, false, true]);
    warn.mockRestore();
  });
});
