import type { StaffSortKey } from '../../services/employeeService';

/** Столбцы «Текущих сотрудников» с сортировкой — порядок как в таблице. */
export const STAFF_SORT_OPTIONS: ReadonlyArray<{ key: StaffSortKey; label: string }> = [
  { key: 'name', label: 'ФИО' },
  { key: 'department', label: 'Отдел' },
  { key: 'position', label: 'Должность' },
  { key: 'hire_date', label: 'Дата трудоустройства' },
  { key: 'birth_date', label: 'Дата рождения' },
  { key: 'schedule', label: 'График' },
  { key: 'main_object', label: 'Объект' },
  { key: 'comment', label: 'Комментарий' },
  { key: 'sign', label: 'Признак' },
];

export const isStaffSortKey = (value: unknown): value is StaffSortKey =>
  typeof value === 'string' && STAFF_SORT_OPTIONS.some(option => option.key === value);
