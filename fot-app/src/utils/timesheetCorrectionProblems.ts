import type { TimesheetEmployee, TimesheetEntry } from '../types';
import type { IResolvedSchedule } from '../types/schedule';
import type { IProductionCalendarMonth, IWeekendMissingDay } from '../types/timesheet';
import { getDayStatus } from './dayStatus';
import {
  getDayNormHoursForDay,
  getFullDayThresholdHoursForDay,
  getScheduleForTimesheetDay,
  isScheduleDayOff,
} from './scheduleUtils';
import { isDateInactiveForEmployee } from './timesheetEmployeeWindow';

/**
 * Рамки «Нужна корректировка» в сетке «Табеля» (по сотрудникам): где руководителю проставить часы.
 *
 * Будний день — «Неполный» / «Длинный перерыв» (целых часов меньше нормы графика — зарплата по часам заплатит меньше)
 * или «СКУД без пары» (проход есть, 0 ч), а корректировки нет; статус — тот же getDayStatus с тем же графиком, порогом
 * и нормой, что у клетки, поэтому рамка совпадает с цветом. Выходной — с сервера (weekend_missing_days): правила дня там же, где у вкладки «Выходные».
 * Без рамки: сегодня и будущее, вне окна строки, до ноября 2026 (зарплата по часам — с ноября; та же дата на сервере,
 * TIMESHEET_CORRECTION_FRAMES_FROM).
 */

export const CORRECTION_FRAMES_FROM = '2026-11-01';
export const CORRECTION_NEEDED_LABEL = 'Нужна корректировка';
export const UNDERWORK_TITLE = 'Неполный день — проставьте часы корректировкой';
export const WEEKEND_TITLE = 'Выход в выходной без корректировки';
export const ZERO_HOURS_TITLE = '0 часов — проставьте часы корректировкой';

export interface ICorrectionProblemBadge {
  text: string;
  title: string;
}

export interface ICorrectionProblems {
  /** Ключи клеток `${employeeId}_${YYYY-MM-DD}` — как у problemDates сетки. */
  keys: Set<string>;
  /** Подсказка клетки по ключу. */
  titles: Map<string, string>;
  /** Метки у ФИО: «N без корр.», «N без часов». */
  badges: Map<number, ICorrectionProblemBadge[]>;
}

interface ICorrectionProblemsInput {
  employees: ReadonlyArray<TimesheetEmployee>;
  entries: ReadonlyArray<TimesheetEntry>;
  weekendMissing: ReadonlyArray<IWeekendMissingDay>;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar: IProductionCalendarMonth | null;
  year: number;
  month: number;
  showActualHours: boolean;
  /** Сегодня по МСК, YYYY-MM-DD: этот день и дальше без рамки. */
  todayIso: string;
}

const PROBLEM_WEEKDAY_STATUSES = new Set(['underwork', 'long_break', 'incomplete_skud']);

const isoOf = (year: number, month: number, day: number): string => (
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

export const timesheetCorrectionProblems = ({
  employees, entries, weekendMissing, schedules, dailySchedules, calendar, year, month, showActualHours, todayIso,
}: ICorrectionProblemsInput): ICorrectionProblems => {
  const keys = new Set<string>();
  const titles = new Map<string, string>();
  const counts = new Map<number, { noCorrection: number; zeroHours: number }>();
  const lastDayIso = isoOf(year, month, new Date(year, month, 0).getDate());
  if (lastDayIso < CORRECTION_FRAMES_FROM) return { keys, titles, badges: new Map() };

  const employeeById = new Map(employees.map(employee => [employee.id, employee]));
  const entryByKey = new Map(entries.map(entry => [`${entry.employee_id}_${entry.work_date}`, entry]));
  const add = (employeeId: number, iso: string, title: string, zeroHours: boolean): void => {
    const key = `${employeeId}_${iso}`;
    if (keys.has(key)) return;
    keys.add(key);
    titles.set(key, title);
    const count = counts.get(employeeId) ?? { noCorrection: 0, zeroHours: 0 };
    if (zeroHours) count.zeroHours += 1;
    else count.noCorrection += 1;
    counts.set(employeeId, count);
  };
  const isFramedDate = (employee: TimesheetEmployee, iso: string): boolean => (
    iso >= CORRECTION_FRAMES_FROM && iso < todayIso && !isDateInactiveForEmployee(employee, iso)
  );

  const daysInMonth = new Date(year, month, 0).getDate();
  for (const employee of employees) {
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = isoOf(year, month, day);
      if (!isFramedDate(employee, iso)) continue;
      const schedule = getScheduleForTimesheetDay(schedules, dailySchedules, employee.id, year, month, day);
      // Выходной — только с сервера: квота плановых суббот и заявления там.
      if (isScheduleDayOff(schedule, calendar, year, month, day)) continue;
      const entry = entryByKey.get(`${employee.id}_${iso}`) ?? null;
      if (!entry || entry.is_correction) continue;
      // Норма дня — как в зарплате по часам: целые часы не меньше неё — полный день, рамки нет.
      const status = getDayStatus(entry, {
        showActualHours,
        fullDayThresholdHours: getFullDayThresholdHoursForDay(schedule, calendar, year, month, day),
        dayNormHours: getDayNormHoursForDay(schedule, calendar, year, month, day),
        isScheduledDayOff: false,
        isFuture: false,
      });
      if (!PROBLEM_WEEKDAY_STATUSES.has(status)) continue;
      const zeroHours = status === 'incomplete_skud';
      add(employee.id, iso, zeroHours ? ZERO_HOURS_TITLE : UNDERWORK_TITLE, zeroHours);
    }
  }

  for (const day of weekendMissing) {
    const employee = employeeById.get(day.employee_id);
    if (!employee || !day.date.startsWith(`${year}-${String(month).padStart(2, '0')}-`)) continue;
    if (!isFramedDate(employee, day.date)) continue;
    add(day.employee_id, day.date, day.without_hours ? ZERO_HOURS_TITLE : WEEKEND_TITLE, day.without_hours);
  }

  const badges = new Map<number, ICorrectionProblemBadge[]>();
  for (const [employeeId, count] of counts) {
    badges.set(employeeId, [
      ...(count.noCorrection > 0 ? [{ text: `${count.noCorrection} без корр.`, title: CORRECTION_NEEDED_LABEL }] : []),
      ...(count.zeroHours > 0 ? [{ text: `${count.zeroHours} без часов`, title: ZERO_HOURS_TITLE }] : []),
    ]);
  }
  return { keys, titles, badges };
};
