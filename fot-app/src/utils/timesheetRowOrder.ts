import type { TimesheetEmployee } from '../types/timesheet';

/**
 * Секции строк табеля: supervisor → self → direct_report → department → skud_presence →
 * direct_report_covered → view_only. Начальник участка — первой секцией; кого ведёт
 * руководитель отдела и «Только просмотр» — в конце: их только смотрят.
 */
const SOURCE_ORDER: Record<NonNullable<TimesheetEmployee['source']>, number> = {
  supervisor: 0,
  self: 1,
  direct_report: 2,
  department: 3,
  skud_presence: 4,
  direct_report_covered: 5,
  view_only: 6,
};

const sourceRank = (row: TimesheetEmployee): number => SOURCE_ORDER[row.source ?? 'department'];

/**
 * Порядок строк грида. Внутри секции — порядок ответа (бэк сортирует по ФИО). «Только
 * просмотр» («Просмотр табеля», миграция 309) — по отделу, затем по ФИО: люди приходят из
 * разных отделов, и подзаголовки отделов должны идти блоками, а не повторяться.
 */
export const sortTimesheetRows = (rows: readonly TimesheetEmployee[]): TimesheetEmployee[] => (
  [...rows].sort((left, right) => {
    const bySource = sourceRank(left) - sourceRank(right);
    if (bySource !== 0 || left.source !== 'view_only') return bySource;
    const byDepartment = (left.department_name ?? '').localeCompare(right.department_name ?? '', 'ru');
    return byDepartment !== 0 ? byDepartment : left.full_name.localeCompare(right.full_name, 'ru');
  })
);
