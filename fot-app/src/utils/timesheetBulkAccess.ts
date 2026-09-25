import type { TimesheetEmployee } from '../types';

interface IBulkCorrectionsAccessInput {
  /** Право на запись в открытый отдел: edit страницы + серверный department_writable. */
  canWriteActiveDept: boolean;
  /** Право edit на страницу табеля. */
  canEditTimesheet: boolean;
  /** Открыта сетка «Мои сотрудники» — прямые подчинённые без отдела. */
  isDirectReportsGrid: boolean;
  employees: ReadonlyArray<Pick<TimesheetEmployee, 'editable'>>;
}

/**
 * Можно ли включить «Режим корректировок».
 *
 * Для отдела право считает сервер (department_writable). В «Мои сотрудники» отдела
 * нет, и этот признак там всегда false — поэтому опираемся на серверный editable
 * строк: массовое выделение его уважает (isBulkDayReadOnly), а запись сервер
 * проверяет по каждой паре сотрудник–дата.
 */
export const canUseBulkCorrections = ({
  canWriteActiveDept,
  canEditTimesheet,
  isDirectReportsGrid,
  employees,
}: IBulkCorrectionsAccessInput): boolean => canWriteActiveDept
  || (canEditTimesheet && isDirectReportsGrid && employees.some(employee => employee.editable !== false));
