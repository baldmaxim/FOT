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
  /**
   * Имя отдела табеля — запасное для подписи ушедших после периода, когда своих строк нет.
   * Обычно имя берётся у своей строки ответа.
   */
  departmentName?: string | null;
  /** Последний показанный день (YYYY-MM-DD) — тот же, что у бейджа «Пер.» в сетке. */
  periodEnd?: string | null;
}

/**
 * Ушёл из отдела табеля (уволен или переведён) уже после показанного периода: весь период
 * он числился в отделе — стоит среди своих. Сервер отдаёт текущие статус и отдел, поэтому
 * уволенный в ноябре без этой проверки попадал в блок «Уволенные» и в октябре.
 * Дата ухода — день после увольнения, и у уволенного в последний день периода она уже
 * за периодом, хотя уволен он в нём, — поэтому у уволенных сверяем и саму дату увольнения.
 */
export const leftAfterPeriod = (
  row: TimesheetEmployee,
  periodEnd: string | null | undefined,
): boolean => {
  if (!periodEnd || (row.source ?? 'department') !== 'department') return false;
  const leftOn = row.transferred_out_date ?? null;
  if (!leftOn || leftOn <= periodEnd) return false;
  if (row.employment_status !== 'fired') return true;
  const dismissedOn = row.dismissal_date ?? null;
  return !dismissedOn || dismissedOn > periodEnd;
};

/**
 * Место внутри секции: свои → переведённые в другой отдел → уволенные. Заголовок секции
 * в гриде ставится при смене отдела строки, а у переведённых и уволенных он уже другой
 * (новый отдел, папка «Уволенные») — вперемешку по ФИО заголовки повторялись бы.
 * Ушедшие после показанного периода — свои (см. leftAfterPeriod).
 */
const membershipRank = (
  row: TimesheetEmployee,
  departmentId: string | null,
  periodEnd: string | null,
): number => {
  if (leftAfterPeriod(row, periodEnd)) return 0;
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
 *
 * Ушедшим после периода (leftAfterPeriod) подпись отдела — отдел табеля: сетка ставит
 * заголовок по `department_name`, и текущий отдел («Уволенные») разорвал бы список своих.
 * Остальные поля строки не трогаем.
 */
export const sortTimesheetRows = (
  rows: readonly TimesheetEmployee[],
  { departmentId = null, departmentName = null, periodEnd = null }: ISortTimesheetRowsOptions = {},
): TimesheetEmployee[] => {
  const sorted = [...rows].sort((left, right) => {
    const bySource = sourceRank(left) - sourceRank(right);
    if (bySource !== 0) return bySource;
    const leftRank = membershipRank(left, departmentId, periodEnd);
    const rightRank = membershipRank(right, departmentId, periodEnd);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.source === 'view_only') {
      const byDepartment = compareDepartments(left, right);
      return byDepartment !== 0 ? byDepartment : left.full_name.localeCompare(right.full_name, 'ru');
    }
    return leftRank === 1 ? compareDepartments(left, right) : 0;
  });
  if (!periodEnd) return sorted;
  const ownDepartmentName = (departmentId != null
    ? sorted.find(row => (row.source ?? 'department') === 'department'
      && row.org_department_id === departmentId)?.department_name
    : null) ?? departmentName;
  if (!ownDepartmentName) return sorted;
  return sorted.map(row => (
    leftAfterPeriod(row, periodEnd) && row.department_name !== ownDepartmentName
      ? { ...row, department_name: ownDepartmentName }
      : row
  ));
};
