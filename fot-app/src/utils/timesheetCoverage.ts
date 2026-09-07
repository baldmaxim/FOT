import type { TimesheetEmployee } from '../types';

/**
 * «День ведёт руководитель отдела» — сотрудник виден в табеле личного руководителя,
 * но правка и подача этого дня принадлежат руководителю его отдела.
 *
 * У полностью покрытых бэк отдаёт `source: 'direct_report_covered'` и
 * `editable: false` — вся строка read-only. Массив `covered_dates` нужен частично
 * покрытым: переведённым внутри периода, у которых часть дней своя, а часть — нет.
 */
export const COVERED_DAY_MESSAGE = 'Табель ведёт руководитель отдела';

/** Почему строка только для просмотра — текст тоста при попытке правки. */
export const resolveReadOnlyReason = (employee: TimesheetEmployee): string => {
  if (employee.is_restricted_period) {
    return 'Этот период сотрудник работал в отделе, к которому у вас нет доступа';
  }
  if (employee.source === 'direct_report_covered') return COVERED_DAY_MESSAGE;
  return 'Сотрудник доступен только для просмотра';
};

export const isDateCoveredByDepartment = (
  employee: Pick<TimesheetEmployee, 'covered_dates'>,
  isoDate: string,
): boolean => (employee.covered_dates ?? []).includes(isoDate);

export const isDayCoveredByDepartment = (
  employee: Pick<TimesheetEmployee, 'covered_dates'>,
  year: number,
  month: number,
  day: number,
): boolean => {
  const covered = employee.covered_dates;
  if (!covered || covered.length === 0) return false;
  return covered.includes(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
};
