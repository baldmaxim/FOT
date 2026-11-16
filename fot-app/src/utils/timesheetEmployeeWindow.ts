import type { TimesheetEmployee } from '../types';

/**
 * Окно строки табеля: дни вне периода сотрудника в отделе (до прихода, после перевода или исключения) сетка гасит
 * серым. Одно правило на сетку и рамки «Нужна корректировка» — тот же фильтр на сервере (filterWeekendMissingForGrid).
 */
type IWindowEmployee = Pick<TimesheetEmployee, 'transferred_out_date' | 'excluded_from_timesheet_date' | 'joined_date'>;

/** Дата выхода из табеля (с неё — вне окна): раньшая из даты перевода и даты исключения. */
export const getInactiveFromDate = (employee: IWindowEmployee): string | null => {
  const a = employee.transferred_out_date ?? null;
  const b = employee.excluded_from_timesheet_date ?? null;
  if (a && b) return a < b ? a : b;
  return a || b || null;
};

/** День YYYY-MM-DD вне окна строки. Нижняя граница — только если бэк её прислал (перевод, уволенный). */
export const isDateInactiveForEmployee = (employee: IWindowEmployee, isoDate: string): boolean => {
  const cutoff = getInactiveFromDate(employee);
  if (cutoff && isoDate >= cutoff) return true;
  const joined = employee.joined_date ?? null;
  return Boolean(joined && isoDate < joined);
};

export const isDayInactiveForEmployee = (employee: IWindowEmployee, year: number, month: number, day: number): boolean => (
  isDateInactiveForEmployee(employee, `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
);
