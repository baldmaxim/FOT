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
