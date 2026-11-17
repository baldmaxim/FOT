/**
 * Блок «График работы» под табелем «По сотруднику»: год по графику сотрудника, как форма графика в 1С —
 * у месяца «Дней / Часов» нормы и квота суббот, у дня — плановые часы и вид дня.
 *
 * Норма месяца — то же правило, что у зарплаты по часам (countMonthNormDays / countScheduleMonthNormMinutes):
 * график каждой даты, квота Сб/Вс — графика последнего дня, приём и увольнение норму не режут. Квота суббот к датам
 * не привязана (в норму идут первые отработанные), поэтому в днях субботы — выходные, а квота — числом.
 *
 * Месяц показывается, если хоть один его день попал в период работы (buildEmployeeEmploymentPeriods); такой месяц —
 * целиком, с полной нормой.
 */
import { query, queryOne } from '../config/postgres.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import {
  getDayNormHours,
  isHoliday,
  isPreHoliday,
  isWorkingDay,
  loadCalendarYear,
  resolveSchedulesForPeriod,
} from './schedule.service.js';
import { countMonthNormDays, countScheduleMonthNormMinutes } from './payroll/payroll-basis.service.js';

export type SchedulePlanDayKind = 'work' | 'off' | 'holiday' | 'pre_holiday';

export interface ISchedulePlanDay {
  /** Число месяца, 1–31. */
  day: number;
  /** Плановые часы дня (норма графика): 0 у выходного и праздника. */
  hours: number;
  kind: SchedulePlanDayKind;
}

export interface ISchedulePlanMonth {
  /** 1–12. */
  month: number;
  /** Хоть один день месяца — в периоде работы. Нет — дней и нормы нет. */
  employed: boolean;
  norm_days: number | null;
  norm_minutes: number | null;
  /** Квота обязательных суббот / воскресений графика последнего дня месяца. */
  saturdays: number;
  sundays: number;
  days: ISchedulePlanDay[];
}

export interface ISchedulePlanPeriod {
  schedule_name: string | null;
  /** YYYY-MM-DD, включительно, в границах года и работы. */
  from: string;
  to: string;
}

export interface IEmployeeSchedulePlan {
  employee_id: number;
  year: number;
  periods: ISchedulePlanPeriod[];
  months: ISchedulePlanMonth[];
}

export interface IEmploymentAssignment {
  org_department_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

export interface IDateRange {
  from: string;
  to: string;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const shiftIsoDate = (iso: string, days: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Периоды работы сотрудника в диапазоне. Не listEmployeeDepartmentPeriods: тот делает период и из назначения
 * в «Уволенные», режет по dismissal_date только уволенных и отдаёт архивный промежуток соседнему отделу.
 * 1) База — [приём, увольнение] при любом статусе (запланированное увольнение у активного тоже режет).
 * 2) Минус назначения в архивный отдел «Уволенные» (открытое — до конца диапазона): восстановление чистит
 *    dismissal_date, а архивное назначение в истории остаётся.
 * Неархивные назначения границ не задают: у большинства активных истории назначений нет, а первое назначение
 * бывает «грязным» (раньше приёма). Нет истории или архив не определён — остаётся база.
 */
export const buildEmployeeEmploymentPeriods = (params: {
  hireDate: string | null;
  dismissalDate: string | null;
  assignments: readonly IEmploymentAssignment[];
  archiveDepartmentId: string | null;
  startDate: string;
  endDate: string;
}): IDateRange[] => {
  const { hireDate, dismissalDate, assignments, archiveDepartmentId, startDate, endDate } = params;
  const from = hireDate && hireDate > startDate ? hireDate : startDate;
  const to = dismissalDate && dismissalDate < endDate ? dismissalDate : endDate;
  if (from > to) return [];

  const cuts = archiveDepartmentId
    ? assignments
      .filter(a => a.org_department_id === archiveDepartmentId && Boolean(a.effective_from))
      .map(a => ({ from: a.effective_from, to: a.effective_to ?? endDate }))
      .filter(cut => cut.from <= cut.to)
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    : [];

  let segments: IDateRange[] = [{ from, to }];
  for (const cut of cuts) {
    const next: IDateRange[] = [];
    for (const segment of segments) {
      if (cut.to < segment.from || cut.from > segment.to) {
        next.push(segment);
        continue;
      }
      if (cut.from > segment.from) next.push({ from: segment.from, to: shiftIsoDate(cut.from, -1) });
      if (cut.to < segment.to) next.push({ from: shiftIsoDate(cut.to, 1), to: segment.to });
    }
    segments = next;
  }
  return segments;
};

const overlaps = (ranges: readonly IDateRange[], from: string, to: string): boolean =>
  ranges.some(range => range.from <= to && range.to >= from);

const isInRanges = (ranges: readonly IDateRange[], date: string): boolean =>
  ranges.some(range => range.from <= date && date <= range.to);

/** Вид дня: праздник → предпраздничный рабочий → рабочий → выходной (предпраздничный выходной — выходной). */
export const classifyPlanDay = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null,
): SchedulePlanDayKind => {
  if (isHoliday(date, schedule, calendar)) return 'holiday';
  const working = isWorkingDay(schedule, date, calendar);
  if (working && isPreHoliday(date, schedule, calendar)) return 'pre_holiday';
  return working ? 'work' : 'off';
};

/** Подряд идущие дни работы с одним графиком и якорем цикла → период; разрыв работы тоже делит период. */
export const buildSchedulePlanPeriods = (
  schedules: ReadonlyMap<string, IResolvedSchedule>,
  employment: readonly IDateRange[],
  startDate: string,
  endDate: string,
): ISchedulePlanPeriod[] => {
  const periods: ISchedulePlanPeriod[] = [];
  let currentKey: string | null = null;
  let previousDate: string | null = null;
  for (let date = startDate; date <= endDate; date = shiftIsoDate(date, 1)) {
    const schedule = schedules.get(date);
    if (!schedule || !isInRanges(employment, date)) {
      currentKey = null;
      continue;
    }
    const key = `${schedule.schedule_id}|${schedule.assignment_anchor_date ?? ''}`;
    const last = periods[periods.length - 1];
    if (key === currentKey && last && previousDate === shiftIsoDate(date, -1)) {
      last.to = date;
    } else {
      periods.push({ schedule_name: schedule.name ?? null, from: date, to: date });
      currentKey = key;
    }
    previousDate = date;
  }
  return periods;
};

/** Чистая сборка года (без БД): месяцы, дни, нормы. */
export const buildSchedulePlanMonths = (params: {
  year: number;
  schedules: ReadonlyMap<string, IResolvedSchedule>;
  calendars: ReadonlyMap<number, IProductionCalendarMonth>;
  employment: readonly IDateRange[];
}): ISchedulePlanMonth[] => {
  const { year, schedules, calendars, employment } = params;
  const months: ISchedulePlanMonth[] = [];
  for (let month = 1; month <= 12; month++) {
    const monthKey = `${year}-${pad2(month)}`;
    const total = daysInMonth(year, month);
    const employed = overlaps(employment, `${monthKey}-01`, `${monthKey}-${pad2(total)}`);
    if (!employed) {
      months.push({ month, employed, norm_days: null, norm_minutes: null, saturdays: 0, sundays: 0, days: [] });
      continue;
    }
    const calendar = calendars.get(month) ?? null;
    const days: ISchedulePlanDay[] = [];
    for (let day = 1; day <= total; day++) {
      const schedule = schedules.get(`${monthKey}-${pad2(day)}`);
      if (!schedule) continue;
      const date = new Date(year, month - 1, day);
      days.push({
        day,
        hours: getDayNormHours(schedule, date, calendar),
        kind: classifyPlanDay(schedule, date, calendar),
      });
    }
    const last = schedules.get(`${monthKey}-${pad2(total)}`);
    months.push({
      month,
      employed,
      norm_days: countMonthNormDays(schedules, monthKey, calendar),
      norm_minutes: countScheduleMonthNormMinutes(schedules, monthKey, calendar),
      saturdays: last?.expected_saturdays_per_month ?? 0,
      sundays: last?.expected_sundays_per_month ?? 0,
      days,
    });
  }
  return months;
};

/** Отдел «Уволенные». Не нашёлся или ошибка — null: исключать нечего, блок не падает. */
const resolveArchiveDepartmentId = async (): Promise<string | null> => {
  try {
    // Динамически: сервис архива тянет Sigur-модули (как resolvePayrollArchiveDepartmentId).
    const { getKnownArchiveDepartment } = await import('./employee-archive-department.service.js');
    return (await getKnownArchiveDepartment())?.id ?? null;
  } catch (error) {
    console.warn('[employee-schedule-plan] отдел «Уволенные» не определён:', error);
    return null;
  }
};

/** План графика сотрудника на год. Нет сотрудника — null (иначе резолвер подставил бы график по умолчанию). */
export const buildEmployeeSchedulePlan = async (
  employeeId: number,
  year: number,
): Promise<IEmployeeSchedulePlan | null> => {
  const employee = await queryOne<{ hire_date: string | null; dismissal_date: string | null }>(
    `SELECT hire_date::text AS hire_date, dismissal_date::text AS dismissal_date
       FROM employees
      WHERE id = $1`,
    [employeeId],
  );
  if (!employee) return null;

  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const [schedulesByEmployee, calendars, assignments, archiveDepartmentId] = await Promise.all([
    resolveSchedulesForPeriod([{ id: employeeId }], startDate, endDate),
    loadCalendarYear(year),
    query<IEmploymentAssignment>(
      `SELECT org_department_id,
              effective_from::text AS effective_from,
              effective_to::text AS effective_to
         FROM employee_assignments
        WHERE employee_id = $1`,
      [employeeId],
    ),
    resolveArchiveDepartmentId(),
  ]);

  const schedules = schedulesByEmployee.get(employeeId) ?? new Map<string, IResolvedSchedule>();
  const employment = buildEmployeeEmploymentPeriods({
    hireDate: employee.hire_date,
    dismissalDate: employee.dismissal_date,
    assignments,
    archiveDepartmentId,
    startDate,
    endDate,
  });

  return {
    employee_id: employeeId,
    year,
    periods: buildSchedulePlanPeriods(schedules, employment, startDate, endDate),
    months: buildSchedulePlanMonths({ year, schedules, calendars, employment }),
  };
};
