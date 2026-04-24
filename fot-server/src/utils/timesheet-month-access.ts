/**
 * Политика доступа к месяцам табеля для scope='department' (руководитель):
 * разрешён только текущий и предыдущий месяц. Для scope='all' (админ) ограничений нет —
 * вызывающий код просто не должен звать эту функцию.
 */
export function toMonthIndex(year: number, month: number): number {
  return year * 12 + month - 1;
}

export function isDepartmentMonthAllowed(
  year: number,
  month: number,
  referenceDate: Date = new Date(),
): boolean {
  const requested = toMonthIndex(year, month);
  const current = toMonthIndex(referenceDate.getFullYear(), referenceDate.getMonth() + 1);
  return requested >= current - 1 && requested <= current;
}

export const DEPARTMENT_MONTH_FORBIDDEN_MESSAGE =
  'Руководителю доступен только текущий и предыдущий месяц табеля';
