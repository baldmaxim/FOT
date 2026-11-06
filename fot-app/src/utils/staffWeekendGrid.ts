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

/** Ключи дней с рамкой — те же, что у клеток сетки. */
export const weekendProblemKeys = (rows: ReadonlyArray<IStaffWeekendRow>): Set<string> => (
  new Set(rows.flatMap(row => row.days.map(day => `${row.employee_id}_${day}`)))
);

/** Метка у ФИО. Не «7 дн.»: так сетка уже подписывает отработанные дни. */
export const weekendBadgeText = (daysCount: number): string => `${daysCount} без корр.`;

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
