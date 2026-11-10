import type { IStaffWeekendRow } from '../services/staffWeekendService';
import type { TimesheetEntry } from '../types';
import type { IEmployeeApprovalLock, TimesheetResponse } from '../types/timesheet';
import { selectVisibleHours } from './hoursDisplay';
import { shiftMonth } from './moscowDate';

/** Сетка вкладки «Выходные»: чистые правила поверх ответа табеля и списка дней без корректировки. */

/** На вкладке — текущий месяц и столько прошлых. */
const WEEKEND_MONTHS_BACK = 11;

export const canGoToPreviousWeekendMonth = (month: string, currentMonth: string): boolean => (
  month > shiftMonth(currentMonth, -WEEKEND_MONTHS_BACK)
);

export const canGoToNextWeekendMonth = (month: string, currentMonth: string): boolean => month < currentMonth;

/** Рамка у обоих видов дня красная; различаются метка у ФИО и подсказка клетки. */
export const WEEKEND_NO_CORRECTION_LABEL = 'Выход без корректировки';
export const WEEKEND_ZERO_HOURS_LABEL = '0 часов — проставьте часы корректировкой';

/** Ключ дня — тот же, что у клетки сетки. */
const dayKey = (employeeId: number, day: string): string => `${employeeId}_${day}`;

/** Ключи дней с рамкой — те же, что у клеток сетки. */
export const weekendProblemKeys = (rows: ReadonlyArray<IStaffWeekendRow>): Set<string> => (
  new Set(rows.flatMap(row => row.days.map(day => dayKey(row.employee_id, day))))
);

/**
 * Дни списка, где в клетке сетки нет часов: записи нет или видимые часы округляются до 0 — клетка «0».
 * Например, вход по СКУД без пары или проход на 9 минут.
 */
export const weekendZeroHourKeys = (
  entries: ReadonlyArray<TimesheetEntry>,
  rows: ReadonlyArray<IStaffWeekendRow>,
  showActualHours: boolean,
): Set<string> => {
  const entryByKey = new Map(entries.map(entry => [dayKey(entry.employee_id, entry.work_date), entry]));
  return new Set(rows.flatMap(row => row.days
    .map(day => dayKey(row.employee_id, day))
    .filter(key => Math.round(selectVisibleHours(entryByKey.get(key), showActualHours) ?? 0) <= 0)));
};

export interface IWeekendBadge {
  text: string;
  title: string;
}

/**
 * Метки у ФИО: «N без корр.» — выходы с часами, «N без часов» — дни, где в клетке 0. Пустые не показываем.
 * Не «7 дн.»: так сетка уже подписывает отработанные дни.
 */
export const weekendRowBadges = (row: IStaffWeekendRow, zeroHourKeys: ReadonlySet<string>): IWeekendBadge[] => {
  const zeroHours = row.days.filter(day => zeroHourKeys.has(dayKey(row.employee_id, day))).length;
  const withHours = row.days.length - zeroHours;
  return [
    ...(withHours > 0 ? [{ text: `${withHours} без корр.`, title: WEEKEND_NO_CORRECTION_LABEL }] : []),
    ...(zeroHours > 0 ? [{ text: `${zeroHours} без часов`, title: WEEKEND_ZERO_HOURS_LABEL }] : []),
  ];
};

/** Ответ табеля отдела, суженный до людей из списка, в порядке списка. Графики и календарь нужны как есть. */
export const pickWeekendGridData = (
  data: TimesheetResponse,
  rows: ReadonlyArray<IStaffWeekendRow>,
): Pick<TimesheetResponse, 'employees' | 'entries' | 'object_entries' | 'employee_stats'> => {
  const ids = new Set(rows.map(row => row.employee_id));
  const employeeById = new Map(data.employees.map(employee => [employee.id, employee]));
  return {
    employees: rows.flatMap(row => {
      const employee = employeeById.get(row.employee_id);
      return employee ? [employee] : [];
    }),
    entries: data.entries.filter(entry => ids.has(entry.employee_id)),
    object_entries: data.object_entries.filter(entry => ids.has(entry.employee_id)),
    employee_stats: data.employee_stats?.filter(stat => ids.has(stat.employee_id)),
  };
};

/** Статус замка дня: утверждённая подача важнее поданной, как в «Табеле». */
export const weekendLockStatus = (
  locks: ReadonlyArray<IEmployeeApprovalLock>,
  employeeId: number,
  date: string,
): IEmployeeApprovalLock['status'] | undefined => {
  let best: IEmployeeApprovalLock['status'] | undefined;
  for (const lock of locks) {
    if (lock.employee_id !== employeeId) continue;
    if (lock.start_date > date || lock.end_date < date) continue;
    if (lock.status === 'approved') return 'approved';
    best = best ?? lock.status;
  }
  return best;
};

/** Часы за дни из списка — те же значения, что в клетках сетки, с поправкой на роль (show_actual_hours). */
export const weekendVisibleHours = (
  entries: ReadonlyArray<TimesheetEntry>,
  row: IStaffWeekendRow,
  showActualHours: boolean,
): number => {
  const days = new Set(row.days);
  return entries.reduce((sum, entry) => (
    entry.employee_id === row.employee_id && days.has(entry.work_date)
      ? sum + (selectVisibleHours(entry, showActualHours) ?? 0)
      : sum
  ), 0);
};
