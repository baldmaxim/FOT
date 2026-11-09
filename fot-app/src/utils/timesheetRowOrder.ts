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

interface ISortTimesheetRowsOptions {
  /** Отдел табеля: члены секции «отдел» из другого отдела — переведённые. */
  departmentId?: string | null;
}

/**
 * Место внутри секции: свои → переведённые в другой отдел → уволенные. Заголовок секции
 * в гриде ставится при смене отдела строки, а у переведённых и уволенных он уже другой
 * (новый отдел, папка «Уволенные») — вперемешку по ФИО заголовки повторялись бы.
 */
const membershipRank = (row: TimesheetEmployee, departmentId: string | null): number => {
  if (row.employment_status === 'fired') return 2;
  const transferred = departmentId != null
    && (row.source ?? 'department') === 'department'
    && row.org_department_id != null
    && row.org_department_id !== departmentId;
  return transferred ? 1 : 0;
};

const compareDepartments = (left: TimesheetEmployee, right: TimesheetEmployee): number => (
  (left.department_name ?? '').localeCompare(right.department_name ?? '', 'ru')
);

/**
 * Порядок строк грида. Внутри секции — свои, переведённые (блоками по новому отделу),
 * уволенные; в каждом блоке — порядок ответа (бэк сортирует по ФИО). «Только просмотр»
 * («Просмотр табеля», миграция 309) — по отделу, затем по ФИО: люди приходят из разных
 * отделов, и подзаголовки отделов должны идти блоками, а не повторяться.
 */
export const sortTimesheetRows = (
  rows: readonly TimesheetEmployee[],
  { departmentId = null }: ISortTimesheetRowsOptions = {},
): TimesheetEmployee[] => (
  [...rows].sort((left, right) => {
    const bySource = sourceRank(left) - sourceRank(right);
    if (bySource !== 0) return bySource;
    const leftRank = membershipRank(left, departmentId);
    const rightRank = membershipRank(right, departmentId);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.source === 'view_only') {
      const byDepartment = compareDepartments(left, right);
      return byDepartment !== 0 ? byDepartment : left.full_name.localeCompare(right.full_name, 'ru');
    }
    return leftRank === 1 ? compareDepartments(left, right) : 0;
  })
);
