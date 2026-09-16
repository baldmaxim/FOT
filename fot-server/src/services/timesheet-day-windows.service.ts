/**
 * Окна дней сотрудника внутри набора данных табеля (перевод внутри периода: дни до
 * перевода — в старом отделе, после — в новом). Отдельный модуль без зависимостей:
 * его используют и сборка данных, и Excel-билдеры, а timesheet-export.service в тестах мокается.
 */

/** Полуинтервал [from, toExclusive); null — край периода. */
export interface IDayWindow {
  from: string | null;
  toExclusive: string | null;
}

/**
 * Семантика:
 *  - карты нет или ключа нет → сотрудник не ограничен;
 *  - ключ есть, массив [] → ни одного дня;
 *  - { from: null, toExclusive: null } → весь период.
 */
export function isDateInEmployeeWindows(
  data: { dayWindowsByEmployeeId?: Map<number, IDayWindow[]> },
  employeeId: number,
  iso: string,
): boolean {
  const windows = data.dayWindowsByEmployeeId?.get(employeeId);
  if (!windows) return true;
  return windows.some(w => (w.from == null || iso >= w.from) && (w.toExclusive == null || iso < w.toExclusive));
}
