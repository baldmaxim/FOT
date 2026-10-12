import type { ITimesheetDateRange } from './timesheetApprovalPeriod';

interface IDepartmentRangeItem {
  department_id: string | null;
  start_date: string;
  end_date: string;
}

const nextDay = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/**
 * Отделы, чьи подачи покрывают диапазон целиком, без пропущенных дней.
 *
 * Раздел «Табели HR» работает с месяцем, а подачи почти всегда полумесячные: отдел
 * утверждён за месяц, когда утверждены обе половины (либо одна подача «весь месяц»).
 * Сравнение по точному совпадению дат такие отделы теряло. Персональные подачи
 * (без department_id) в дерево отделов не входят.
 */
export const collectDepartmentIdsCoveringRange = (
  items: readonly IDepartmentRangeItem[],
  range: ITimesheetDateRange,
): Set<string> => {
  const rangesByDepartment = new Map<string, ITimesheetDateRange[]>();
  for (const item of items) {
    if (!item.department_id) continue;
    if (item.end_date < range.startDate || item.start_date > range.endDate) continue;
    const list = rangesByDepartment.get(item.department_id) ?? [];
    list.push({ startDate: item.start_date, endDate: item.end_date });
    rangesByDepartment.set(item.department_id, list);
  }

  const covered = new Set<string>();
  for (const [departmentId, ranges] of rangesByDepartment) {
    ranges.sort((left, right) => left.startDate.localeCompare(right.startDate));
    // Первый ещё не покрытый день.
    let cursor = range.startDate;
    for (const item of ranges) {
      if (item.startDate > cursor) break;
      const after = nextDay(item.endDate);
      if (after > cursor) cursor = after;
    }
    if (cursor > range.endDate) covered.add(departmentId);
  }
  return covered;
};
