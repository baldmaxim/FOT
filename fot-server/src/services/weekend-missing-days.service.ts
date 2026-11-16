import { validateCorrectionAttachments } from './timesheet-approval-correction-validation.service.js';
import type { ITimesheetDateRange } from './timesheet-range.service.js';

/**
 * Выходы в выходной без корректировки — одно место для вкладки кадров «Выходные» и рамок «Нужна корректировка»
 * в «Табеле». Правила дня (личный график, плановые субботы, СКУД, корректировка, заявление на согласовании) — из
 * проверки подачи табеля (validateCorrectionAttachments), своей копии правил здесь нет. Проход без часов (и короче
 * получаса) — тоже выход без корректировки: часы надо проставить.
 *
 * Состав и окна отдела — забота вызывающего: здесь проверка «по людям» за весь период, квота плановых суббот — на
 * человека за месяц, а не на его отрезок в отделе.
 */

export interface IWeekendMissingDay {
  employee_id: number;
  /** YYYY-MM-DD */
  date: string;
  /** Проход без часов или короче получаса: в табеле 0 — подсказка «проставьте часы». */
  without_hours: boolean;
}

export const listWeekendMissingDays = async (
  employeeIds: readonly number[],
  range: ITimesheetDateRange,
): Promise<IWeekendMissingDay[]> => {
  if (employeeIds.length === 0) return [];
  const validation = await validateCorrectionAttachments(
    { kind: 'personal', employeeIds: [...employeeIds] }, range, { includePassWithoutHours: true },
  );
  if (validation.ok) return [];
  return validation.missing
    .filter(day => day.kind === 'weekend_no_correction')
    .map(day => ({ employee_id: Number(day.employee_id), date: day.date, without_hours: day.without_hours === true }));
};

/**
 * С какого дня «Табель» рисует рамки «Нужна корректировка»: с ноября 2026 зарплата считается по часам, раньше —
 * закрытые месяцы, где рамки были бы шумом. Та же дата — на фронте (timesheetCorrectionProblems).
 */
export const TIMESHEET_CORRECTION_FRAMES_FROM = '2026-11-01';

export interface IGridEmployeeWindow {
  id: number | string;
  transferred_out_date?: string | null;
  joined_date?: string | null;
  excluded_from_timesheet_date?: string | null;
}

/**
 * Выходы без корректировки для сетки табеля: только люди сетки (после всех её фильтров), только дни диапазона сетки
 * не раньше TIMESHEET_CORRECTION_FRAMES_FROM и только дни в окне человека — то же окно, что серые дни сетки
 * (isDayInactiveForEmployee на фронте): с даты перевода или исключения — вне, до даты входа — вне.
 */
export const filterWeekendMissingForGrid = (
  days: ReadonlyArray<IWeekendMissingDay>,
  employees: ReadonlyArray<IGridEmployeeWindow>,
  startDate: string,
  endDate: string,
): IWeekendMissingDay[] => {
  const byId = new Map(employees.map(employee => [Number(employee.id), employee]));
  const from = startDate > TIMESHEET_CORRECTION_FRAMES_FROM ? startDate : TIMESHEET_CORRECTION_FRAMES_FROM;
  return days.filter((day) => {
    if (day.date < from || day.date > endDate) return false;
    const employee = byId.get(day.employee_id);
    if (!employee) return false;
    const transferred = employee.transferred_out_date ?? null;
    const excluded = employee.excluded_from_timesheet_date ?? null;
    const cutoff = transferred && excluded ? (transferred < excluded ? transferred : excluded) : (transferred ?? excluded);
    if (cutoff && day.date >= cutoff) return false;
    const joined = employee.joined_date ?? null;
    return !(joined && day.date < joined);
  });
};
