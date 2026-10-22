/**
 * Отбор сотрудников выгрузки «Аналитики дисциплины» — тем же правилом, что список на экране
 * (fot-app/src/utils/disciplineFilter.ts; случаи в тестах совпадают): выгрузка = экран.
 */
import { createFioTextMatcher } from '../utils/fio-search.utils.js';
import type { DisciplineExportEmployeeSummary, DisciplineViolationType } from './skud-export.service.js';

export type DisciplineTab = 'all' | DisciplineViolationType;

export function filterDisciplineEmployeeSummaries(
  employees: DisciplineExportEmployeeSummary[],
  filters: {
    departmentIds: string[];
    searchQuery: string;
    activeTab: DisciplineTab;
    onlyViolations: boolean;
  },
): DisciplineExportEmployeeSummary[] {
  let filtered = employees;

  if (filters.departmentIds.length > 0) {
    const set = new Set(filters.departmentIds);
    filtered = filtered.filter(employee => employee.departmentId !== null && set.has(employee.departmentId));
  }

  // ФИО — ё = е, раскладка; точных среди людей выбранных отделов нет — с одной ошибкой. Решение — по ним, до
  // вкладки и «только с нарушениями»: это виды одного набора, по нему же считаются счётчики вкладок на экране.
  const matcher = createFioTextMatcher(filters.searchQuery);
  if (matcher) {
    const base = filtered;
    filtered = base.filter(employee => matcher.matches(employee.name, 'exact'));
    if (filtered.length === 0 && matcher.hasFuzzy) {
      filtered = base.filter(employee => matcher.matches(employee.name, 'fuzzy'));
    }
  }

  if (filters.onlyViolations) {
    filtered = filtered.filter(employee => employee.total > 0);
  }

  if (filters.activeTab !== 'all') {
    const key = filters.activeTab as DisciplineViolationType;
    filtered = filtered
      .filter(employee => employee[key] > 0)
      .sort((left, right) => right[key] - left[key]);
  }

  return filtered;
}
