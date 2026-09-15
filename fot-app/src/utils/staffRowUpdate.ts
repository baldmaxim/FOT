import type { StaffSortKey } from '../services/employeeService';

/** Что поменялось в строке «Текущих сотрудников» после правки на странице. */
export type StaffRowChange = 'comment' | 'department' | 'position' | 'schedule';

/** Столбцы сортировки, чьё значение зависит от изменения («Признак» считается от отдела). */
const SORT_KEYS_BY_CHANGE: Record<StaffRowChange, readonly StaffSortKey[]> = {
  comment: ['comment'],
  department: ['department', 'sign'],
  position: ['position'],
  schedule: ['schedule'],
};

/**
 * Правка затронула активную сортировку: строка могла сменить место в выдаче — список нужно
 * перечитать с первой порции. Иначе достаточно поправить строку на месте.
 */
export const affectsActiveSort = (changes: readonly StaffRowChange[], sort: StaffSortKey): boolean =>
  changes.some(change => SORT_KEYS_BY_CHANGE[change].includes(sort));
