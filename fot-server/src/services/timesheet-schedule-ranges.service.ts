/**
 * Периоды «По графику» (миграция 358) для расчёта табеля — buildAttendanceEntries. Только чтение и
 * чистые функции: модуль не тянет зависимостей окна (запись — timesheet-schedule-mode.service.ts).
 */
import { query, type DbExecutor } from '../config/postgres.js';

export interface IScheduleBasedRange {
  /** Первый день (YYYY-MM-DD), уже с учётом даты приёма. */
  from: string;
  /** Последний день включительно; null — без конца. */
  to: string | null;
}

/** Сотрудник → периоды «По графику» внутри запрошенного диапазона. */
export type ScheduleBasedRanges = ReadonlyMap<number, readonly IScheduleBasedRange[]>;

interface IPeriodRow {
  employee_id: number | string;
  date_from: string;
  date_to: string | null;
  hire_date: string | null;
  dismissal_date: string | null;
}

export const maxIso = (...values: Array<string | null | undefined>): string =>
  values.filter((value): value is string => !!value).reduce((max, value) => (value > max ? value : max));

export const minIso = (...values: Array<string | null | undefined>): string | null => {
  const present = values.filter((value): value is string => !!value);
  return present.length === 0 ? null : present.reduce((min, value) => (value < min ? value : min));
};

export const shiftIsoDay = (iso: string, days: number): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/**
 * Период строки, обрезанный датой приёма и датой увольнения: до приёма и после увольнения
 * норма не начисляется (восстановленному отметку ставят заново — старый период закрыт триггером).
 * null — от периода ничего не осталось.
 */
export function clipScheduleRange(row: Pick<IPeriodRow, 'date_from' | 'date_to' | 'hire_date' | 'dismissal_date'>): IScheduleBasedRange | null {
  const from = maxIso(row.date_from, row.hire_date);
  const to = minIso(row.date_to, row.dismissal_date);
  if (to !== null && to < from) return null;
  return { from, to };
}

/** День (YYYY-MM-DD) попадает в период «По графику» сотрудника. */
export function isScheduleBasedDate(ranges: ScheduleBasedRanges, employeeId: number, date: string): boolean {
  const list = ranges.get(employeeId);
  if (!list) return false;
  return list.some(range => range.from <= date && (range.to === null || date <= range.to));
}

/** Периоды «По графику», пересекающие [startDate, endDate], для расчёта табеля. */
export async function loadScheduleBasedRanges(
  employeeIds: readonly number[],
  startDate: string,
  endDate: string,
  exec?: DbExecutor,
): Promise<ScheduleBasedRanges> {
  const result = new Map<number, IScheduleBasedRange[]>();
  if (employeeIds.length === 0) return result;
  const sql = `SELECT p.employee_id,
                      p.date_from::text      AS date_from,
                      p.date_to::text        AS date_to,
                      e.hire_date::text      AS hire_date,
                      e.dismissal_date::text AS dismissal_date
                 FROM employee_schedule_timesheet_periods p
                 JOIN employees e ON e.id = p.employee_id
                WHERE p.employee_id = ANY($1::int[])
                  AND p.date_from <= $3::date
                  AND (p.date_to IS NULL OR p.date_to >= $2::date)`;
  const params = [[...employeeIds], startDate, endDate];
  const rows = exec ? (await exec.query<IPeriodRow>(sql, params)).rows : await query<IPeriodRow>(sql, params);
  for (const row of rows) {
    const range = clipScheduleRange(row);
    if (!range) continue;
    const employeeId = Number(row.employee_id);
    const list = result.get(employeeId) ?? [];
    list.push(range);
    result.set(employeeId, list);
  }
  return result;
}
