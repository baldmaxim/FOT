import type { StaffSortKey } from '../services/employeeService';

/** Что поменялось в строке «Текущих сотрудников» после правки на странице. */
export type StaffRowChange = 'comment' | 'department' | 'position' | 'schedule';

/** Столбцы, чьё значение зависит от изменения («Признак» считается от отдела). */
const COLUMNS_BY_CHANGE: Record<StaffRowChange, readonly StaffSortKey[]> = {
  comment: ['comment'],
  department: ['department', 'sign'],
  position: ['position'],
  schedule: ['schedule'],
};

/** Столбцы, значения которых изменились. */
export const affectedColumns = (changes: readonly StaffRowChange[]): StaffSortKey[] =>
  [...new Set(changes.flatMap(change => COLUMNS_BY_CHANGE[change]))];

/**
 * Правка затронула активную сортировку: строка могла сменить место в выдаче — список нужно
 * перечитать с первой порции. Иначе достаточно поправить строку на месте.
 */
export const affectsActiveSort = (changes: readonly StaffRowChange[], sort: StaffSortKey): boolean =>
  affectedColumns(changes).includes(sort);

/** Правка столбца с активным фильтром: строка могла выпасть из выдачи или попасть в неё. */
export const affectsActiveFilters = (
  changes: readonly StaffRowChange[],
  isFilterActive: (column: StaffSortKey) => boolean,
): boolean => affectedColumns(changes).some(isFilterActive);
